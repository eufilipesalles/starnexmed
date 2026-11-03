import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

/* Funil onde os leads da LP entram, sempre na etapa de menor ordem ("Novo Lead").
   O CRM tem VÁRIOS funis e cada um tem a sua etapa 1, então o funil é escolhido pelo id
   (assim renomear o funil no CRM não quebra o envio). */
const FUNIL_CAPTACAO_ID = "9d0d73f6-2459-4ff4-90ad-9d2d51a693f6"; // Captação Odontológica (Tráfego Pago)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/* texto limpo: corta espaços e limita o tamanho; vazio vira null */
const txt = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t || null;
};

/* Etapa inicial do funil de captação. Se o funil não existir mais, usa a primeira etapa
   que houver, para nunca perder um lead por causa de configuração do CRM. */
async function etapaInicial(): Promise<string | null> {
  const alvo = await supabase
    .from("pipeline_estagios")
    .select("id")
    .eq("pipeline_id", FUNIL_CAPTACAO_ID)
    .order("ordem", { ascending: true })
    .limit(1);
  if (alvo.data && alvo.data.length) return alvo.data[0].id;

  console.error("ingest-lead: funil de captacao nao encontrado; usando a primeira etapa disponivel", alvo.error?.message ?? "");
  const qualquer = await supabase
    .from("pipeline_estagios")
    .select("id")
    .order("ordem", { ascending: true })
    .limit(1);
  return qualquer.data && qualquer.data.length ? qualquer.data[0].id : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (_) {
      return json({ error: "Corpo da requisicao invalido" }, 400);
    }

    const nome_completo = txt(body.nome_completo, 200);
    const email = txt(body.email, 200);
    const whatsapp = txt(body.whatsapp, 40);

    if (!nome_completo || !email || !whatsapp) {
      return json({ error: "Campos obrigatorios faltando: nome_completo, email, whatsapp" }, 400);
    }

    const estagio_id = await etapaInicial();
    if (!estagio_id) {
      console.error("ingest-lead: nenhuma etapa de pipeline encontrada");
      return json({ error: "Estagio inicial do pipeline nao encontrado" }, 500);
    }

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .insert({
        nome_completo,
        email,
        whatsapp,
        especialidade: txt(body.especialidade, 200),
        investimento_mensal_anuncios: txt(body.investimento_mensal_anuncios, 200),
        observacoes: txt(body.observacoes, 2000),
        origem: txt(body.origem, 120) ?? undefined, /* sem origem: vale o padrão da tabela */
        estagio_id,
        utm_source: txt(body.utm_source, 200),
        utm_campaign: txt(body.utm_campaign, 200),
        utm_medium: txt(body.utm_medium, 200),
        fbclid: txt(body.fbclid, 500),
      })
      .select("id")
      .single();

    if (leadError) {
      console.error("ingest-lead: erro ao gravar o lead", leadError.message);
      return json({ error: leadError.message }, 500);
    }

    return json({ success: true, lead_id: lead.id });
  } catch (err) {
    console.error("ingest-lead: erro inesperado", String(err));
    return json({ error: String(err) }, 500);
  }
});
