/* Starnex Med: envio de eventos à Meta (Conversions API).
   Este arquivo só tem lógica pura (sem acesso a banco nem à rede por conta própria):
   o banco e o fetch entram por parâmetro, o que permite testar tudo sem a Meta. */

export const PIXEL_ID = "824532740340711";
export const GRAPH_VERSION = "v25.0";
export const LP_URL_PADRAO = "https://starnexmed.vercel.app/";

export interface Reservado {
  id: string;
  event_name: string;
  event_id: string;
  event_time: number; /* segundos (epoch) */
  tentativas: number;
  lead: {
    id: string;
    nome: string | null;
    email: string | null;
    whatsapp: string | null;
    especialidade: string | null;
  };
  meta: {
    mql?: boolean | null;
    fbc?: string | null;
    fbp?: string | null;
    ip?: string | null;
    ua?: string | null;
    url?: string | null;
    faturamento?: string | null;
    test_event_code?: string | null;
  } | null;
}

export interface Marcacao {
  status: "enviado" | "pendente" | "erro";
  ultimo_erro?: string | null;
  resposta?: unknown;
  enviado_em?: string | null;
  proximo_envio?: string;
}

export interface Db {
  reservar(limite: number): Promise<Reservado[]>;
  marcar(id: string, patch: Marcacao): Promise<void>;
}

/* ---------- normalização e hash (regras da Meta) ---------- */

export async function sha256(valor: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(valor));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

/* Só dígitos, com código do país. O formulário pede o número com DDD (10 ou 11 dígitos): entra o 55. */
export function normTelefone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let d = v.replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d.length >= 12 && d.length <= 15 ? d : null;
}

/* Minúsculas, sem pontuação. Primeiro nome = primeira palavra; sobrenome = última (se houver mais de uma). */
export function normNome(v: unknown): { fn: string | null; ln: string | null } {
  if (typeof v !== "string") return { fn: null, ln: null };
  const partes = v.toLowerCase().replace(/[^\p{L}\s-]/gu, "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return { fn: null, ln: null };
  return { fn: partes[0], ln: partes.length > 1 ? partes[partes.length - 1] : null };
}

/* ---------- montagem do evento ---------- */

type Obj = Record<string, unknown>;
const limpo = (o: Obj): Obj => {
  const r: Obj = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    r[k] = v;
  }
  return r;
};

export async function montarEvento(item: Reservado, agoraSeg: number): Promise<Obj> {
  const m = item.meta ?? {};
  const l = item.lead;

  const email = normEmail(l.email);
  const tel = normTelefone(l.whatsapp);
  const { fn, ln } = normNome(l.nome);

  const user_data = limpo({
    em: email ? [await sha256(email)] : null,
    ph: tel ? [await sha256(tel)] : null,
    fn: fn ? [await sha256(fn)] : null,
    ln: ln ? [await sha256(ln)] : null,
    country: [await sha256("br")],
    external_id: [await sha256(l.id)],
    client_ip_address: m.ip,
    client_user_agent: m.ua,
    fbc: m.fbc,
    fbp: m.fbp,
  });

  const ehLead = item.event_name === "Lead";
  /* "website" exige IP e navegador; sem eles a Meta recusa o evento, então cai para "system_generated" */
  const web = ehLead && !!m.ip && !!m.ua;

  const base = limpo({
    content_name: "Starnex Med",
    content_category: l.especialidade,
    faturamento: m.faturamento,
  });
  const custom_data = ehLead ? base : { ...base, event_source: "crm", lead_event_source: "Starnex CRM" };

  /* a Meta recusa horário no futuro e com mais de 7 dias */
  const event_time = Math.min(Math.floor(item.event_time), agoraSeg);

  return limpo({
    event_name: item.event_name,
    event_time,
    event_id: item.event_id,
    action_source: web ? "website" : "system_generated",
    event_source_url: web ? (m.url || LP_URL_PADRAO) : null,
    user_data,
    custom_data,
  });
}

/* ---------- resultado de cada envio ---------- */

export interface Decisao {
  status: "enviado" | "pendente" | "erro";
  minutos?: number; /* espera até a próxima tentativa (status pendente) */
  msg?: string;
}

const CODIGOS_TEMPORARIOS = [1, 2, 4, 17, 32, 341, 368, 613];
const CODIGOS_CONFIG = [10, 102, 190]; /* token/permissão: o dono corrige e o envio volta a funcionar */

const espera = (tentativas: number, teto: number) =>
  Math.min(5 * Math.pow(2, Math.max(0, tentativas - 1)), teto);

export function classificar(http: number | null, corpo: any, tentativas: number, rede?: string): Decisao {
  if (http === null) return { status: "pendente", minutos: espera(tentativas, 60), msg: "falha de rede: " + (rede ?? "?") };

  if (http >= 200 && http < 300) {
    if (corpo && Number(corpo.events_received) >= 1) return { status: "enviado" };
    return { status: "pendente", minutos: espera(tentativas, 60), msg: "resposta sem events_received" };
  }

  const err = corpo && corpo.error ? corpo.error : {};
  const code = Number(err.code);
  const msg = `HTTP ${http} codigo ${isNaN(code) ? "?" : code}: ${String(err.error_user_msg || err.message || "sem detalhe")}`;

  if (CODIGOS_CONFIG.includes(code) || (code >= 200 && code <= 299)) {
    return { status: "pendente", minutos: espera(tentativas, 180), msg };
  }
  if (http >= 500 || http === 429 || err.is_transient === true || CODIGOS_TEMPORARIOS.includes(code)) {
    return { status: "pendente", minutos: espera(tentativas, 60), msg };
  }
  /* pedido recusado por conteúdo: tenta 3 vezes (pode ser instabilidade) e desiste, deixando o motivo gravado */
  return tentativas >= 3 ? { status: "erro", msg } : { status: "pendente", minutos: espera(tentativas, 60), msg };
}

/* ---------- envio ---------- */

export interface Opcoes {
  db: Db;
  token: string;
  fetchFn: typeof fetch;
  versao?: string;
  pixelId?: string;
  porLote?: number;
  maxLotes?: number;
  agora?: () => number; /* ms */
}

export interface Resumo {
  reservados: number;
  enviados: number;
  reagendados: number;
  erros: number;
}

const sem = (txt: string, token: string) => (token ? txt.split(token).join("***") : txt).slice(0, 600);

export async function enviarPendentes(o: Opcoes): Promise<Resumo> {
  const agora = o.agora ?? (() => Date.now());
  const versao = o.versao ?? GRAPH_VERSION;
  const pixel = o.pixelId ?? PIXEL_ID;
  const resumo: Resumo = { reservados: 0, enviados: 0, reagendados: 0, erros: 0 };
  const porLote = o.porLote ?? 20;

  for (let lote = 0; lote < (o.maxLotes ?? 5); lote++) {
    const itens = await o.db.reservar(porLote);
    if (!itens.length) break;
    resumo.reservados += itens.length;

    for (const item of itens) {
      let decisao: Decisao;
      let resposta: unknown = null;
      try {
        const evento = await montarEvento(item, Math.floor(agora() / 1000));
        const corpo: Obj = { data: [evento], access_token: o.token };
        const teste = item.meta?.test_event_code;
        if (teste) corpo.test_event_code = teste;

        let http: number | null = null;
        let json: any = null;
        let rede: string | undefined;
        try {
          const r = await o.fetchFn(`https://graph.facebook.com/${versao}/${pixel}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(corpo),
            signal: AbortSignal.timeout(10000),
          });
          http = r.status;
          json = await r.json().catch(() => null);
        } catch (e) {
          rede = String(e);
        }
        resposta = json;
        decisao = classificar(http, json, item.tentativas, rede);
      } catch (e) {
        decisao = { status: "pendente", minutos: espera(item.tentativas, 60), msg: "erro ao montar/enviar: " + String(e) };
      }

      const msg = decisao.msg ? sem(decisao.msg, o.token) : null;
      try {
        if (decisao.status === "enviado") {
          await o.db.marcar(item.id, { status: "enviado", enviado_em: new Date(agora()).toISOString(), ultimo_erro: null, resposta });
          resumo.enviados++;
        } else if (decisao.status === "erro") {
          await o.db.marcar(item.id, { status: "erro", ultimo_erro: msg, resposta });
          resumo.erros++;
        } else {
          await o.db.marcar(item.id, {
            status: "pendente",
            ultimo_erro: msg,
            resposta,
            proximo_envio: new Date(agora() + (decisao.minutos ?? 5) * 60000).toISOString(),
          });
          resumo.reagendados++;
        }
      } catch (e) {
        /* se nem gravar o resultado deu, o evento fica "enviando" e volta à fila sozinho em 3 minutos */
        console.error("meta-capi-flush: falha ao gravar o resultado", item.id, sem(String(e), o.token));
      }
    }
    if (itens.length < porLote) break;
  }
  return resumo;
}
