import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { enviarPendentes, type Db, type Marcacao, type Reservado } from "./capi.ts";

/* Envia à Meta (Conversions API) os eventos que estão na fila `meta_eventos`.
   Quem chama: o próprio banco (pg_net), logo depois de um lead MQL entrar ou de uma mudança de etapa
   no CRM, e o agendamento de 5 em 5 minutos para reenviar o que falhou.
   Não é pública: exige o cabeçalho x-flush-key, cuja chave só existe dentro do banco (tabela meta_config). */

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/* comparação sem pista de tempo */
const igual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

const db: Db = {
  async reservar(limite) {
    const { data, error } = await supabase.rpc("meta_eventos_reservar", { p_limite: limite, p_lead: null });
    if (error) throw new Error("reservar: " + error.message);
    return (data ?? []) as Reservado[];
  },
  async marcar(id, patch: Marcacao) {
    const { error } = await supabase.from("meta_eventos").update(patch).eq("id", id);
    if (error) throw new Error("marcar: " + error.message);
  },
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "metodo nao permitido" }, 405);

  const chave = req.headers.get("x-flush-key") ?? "";
  const { data: cfg } = await supabase.from("meta_config").select("valor").eq("chave", "flush_key").maybeSingle();
  if (!chave || !cfg || !igual(chave, cfg.valor)) return json({ error: "nao autorizado" }, 401);

  const token = Deno.env.get("META_CAPI_TOKEN");
  if (!token) {
    console.error("meta-capi-flush: secret META_CAPI_TOKEN nao encontrado; eventos continuam na fila");
    return json({ error: "token ausente" }, 500);
  }

  try {
    const resumo = await enviarPendentes({ db, token, fetchFn: fetch });
    console.log("meta-capi-flush:", JSON.stringify(resumo));
    return json(resumo);
  } catch (e) {
    console.error("meta-capi-flush: erro", String(e).split(token).join("***"));
    return json({ error: "falha ao processar a fila" }, 500);
  }
});
