-- ============================================================================
-- Starnex Med: funil de captação + envio de eventos à Meta (Conversions API)
-- Regra de ouro: nada daqui pode impedir um lead de entrar ou de mudar de etapa no CRM.
-- (Já aplicada no projeto gtnnqoebcudsnzqicrto; guardada aqui como registro.)
-- ============================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- 1) Funil novo e etapas ------------------------------------------------------
do $$
declare v_pid uuid;
begin
  select id into v_pid from public.pipelines where nome = 'Captação Starnex Med (Tráfego Pago)';
  if v_pid is null then
    insert into public.pipelines (nome) values ('Captação Starnex Med (Tráfego Pago)') returning id into v_pid;
  end if;

  insert into public.pipeline_estagios (pipeline_id, nome, ordem, is_ganho, is_perdido)
  select v_pid, x.nome, x.ordem, x.g, x.p
  from (values
    ('Novo Lead',          1, false, false),
    ('Qualificado',        2, false, false),
    ('Call Agendada',      3, false, false),
    ('Call realizada',     4, false, false),
    ('Proposta Enviada',   5, false, false),
    ('Contrato fechado',   6, true,  false),
    ('Perdido',            7, false, true)
  ) as x(nome, ordem, g, p)
  where not exists (select 1 from public.pipeline_estagios e where e.pipeline_id = v_pid and e.nome = x.nome);
end $$;

-- 2) Tabelas ------------------------------------------------------------------
create table if not exists public.lead_meta (
  lead_id           uuid primary key references public.leads(id) on delete cascade,
  mql               boolean not null default false,
  event_id          text,
  fbc               text,
  fbp               text,
  client_ip         text,
  client_user_agent text,
  event_source_url  text,
  faturamento       text,
  test_event_code   text,
  criado_em         timestamptz not null default now()
);

create table if not exists public.meta_eventos (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  event_name    text not null,
  event_id      text not null,
  event_time    timestamptz not null default now(),
  status        text not null default 'pendente' check (status in ('pendente','enviando','enviado','erro','expirado')),
  tentativas    int  not null default 0,
  proximo_envio timestamptz not null default now(),
  ultimo_erro   text,
  resposta      jsonb,
  enviado_em    timestamptz,
  criado_em     timestamptz not null default now(),
  unique (event_name, event_id)
);
create index if not exists meta_eventos_fila_idx on public.meta_eventos (proximo_envio) where status in ('pendente','enviando');
create index if not exists meta_eventos_lead_idx on public.meta_eventos (lead_id);

create table if not exists public.meta_etapas (
  estagio_id uuid primary key references public.pipeline_estagios(id) on delete cascade,
  evento     text not null
);

create table if not exists public.meta_config (
  chave text primary key,
  valor text not null
);
insert into public.meta_config (chave, valor)
values ('flush_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (chave) do nothing;

alter table public.lead_meta    enable row level security;
alter table public.meta_eventos enable row level security;
alter table public.meta_etapas  enable row level security;
alter table public.meta_config  enable row level security;
revoke all on public.lead_meta, public.meta_eventos, public.meta_etapas, public.meta_config from anon, authenticated;
grant all on public.lead_meta, public.meta_eventos, public.meta_etapas, public.meta_config to service_role;

-- 3) Mapeamento das etapas do funil novo -------------------------------------
insert into public.meta_etapas (estagio_id, evento)
select e.id, m.evento
from public.pipeline_estagios e
join public.pipelines p on p.id = e.pipeline_id
join (values
  ('Qualificado',      'LeadQualificado'),
  ('Call Agendada',    'Schedule'),
  ('Call realizada',   'CallRealizada'),
  ('Proposta Enviada', 'PropostaEnviada'),
  ('Contrato fechado', 'ContratoFechado')
) as m(nome, evento) on m.nome = e.nome
where p.nome = 'Captação Starnex Med (Tráfego Pago)'
on conflict (estagio_id) do update set evento = excluded.evento;

-- 4) Funções ------------------------------------------------------------------
create or replace function public.meta_disparar_flush()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_key text;
begin
  select valor into v_key from public.meta_config where chave = 'flush_key';
  if v_key is null then return; end if;
  perform net.http_post(
    url := 'https://gtnnqoebcudsnzqicrto.supabase.co/functions/v1/meta-capi-flush',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-flush-key', v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
exception when others then
  raise warning 'meta_disparar_flush: %', sqlerrm;
end $$;

create or replace function public.meta_eventos_reservar(p_limite int default 20, p_lead uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r jsonb;
begin
  update public.meta_eventos
     set status = 'expirado',
         ultimo_erro = coalesce(ultimo_erro, 'não enviado dentro da janela de 6 dias da Meta')
   where status in ('pendente', 'enviando')
     and event_time < now() - interval '6 days';

  with sel as (
    select id
      from public.meta_eventos
     where status in ('pendente', 'enviando')
       and proximo_envio <= now()
       and (p_lead is null or lead_id = p_lead)
     order by event_time
     for update skip locked
     limit greatest(1, least(coalesce(p_limite, 20), 100))
  ), upd as (
    update public.meta_eventos m
       set status = 'enviando',
           tentativas = m.tentativas + 1,
           proximo_envio = now() + interval '3 minutes'
      from sel
     where m.id = sel.id
    returning m.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id,
           'event_name', u.event_name,
           'event_id', u.event_id,
           'event_time', extract(epoch from u.event_time)::bigint,
           'tentativas', u.tentativas,
           'lead', jsonb_build_object(
             'id', l.id,
             'nome', l.nome_completo,
             'email', l.email,
             'whatsapp', l.whatsapp,
             'especialidade', l.especialidade),
           'meta', jsonb_build_object(
             'mql', lm.mql,
             'fbc', lm.fbc,
             'fbp', lm.fbp,
             'ip', lm.client_ip,
             'ua', lm.client_user_agent,
             'url', lm.event_source_url,
             'faturamento', lm.faturamento,
             'test_event_code', lm.test_event_code)
         ) order by u.event_time), '[]'::jsonb)
    into r
    from upd u
    join public.leads l on l.id = u.lead_id
    left join public.lead_meta lm on lm.lead_id = u.lead_id;

  return r;
end $$;

create or replace function public.meta_enfileirar_etapa()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evento text;
  v_n int;
begin
  begin
    if new.estagio_id is distinct from old.estagio_id then
      select evento into v_evento from public.meta_etapas where estagio_id = new.estagio_id;
      if v_evento is not null and exists (select 1 from public.lead_meta where lead_id = new.id) then
        insert into public.meta_eventos (lead_id, event_name, event_id, event_time)
        values (new.id, v_evento, 'crm_' || new.id::text || '_' || v_evento, now())
        on conflict (event_name, event_id) do nothing;
        get diagnostics v_n = row_count;
        if v_n > 0 then
          perform public.meta_disparar_flush();
        end if;
      end if;
    end if;
  exception when others then
    raise warning 'meta_enfileirar_etapa: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists meta_enfileirar_etapa on public.leads;
create trigger meta_enfileirar_etapa
  after update of estagio_id on public.leads
  for each row execute function public.meta_enfileirar_etapa();

revoke execute on function public.meta_disparar_flush()               from public, anon, authenticated;
revoke execute on function public.meta_eventos_reservar(int, uuid)    from public, anon, authenticated;
revoke execute on function public.meta_enfileirar_etapa()             from public, anon, authenticated;
grant  execute on function public.meta_disparar_flush()               to service_role;
grant  execute on function public.meta_eventos_reservar(int, uuid)    to service_role;

-- 5) Reenvio automático a cada 5 minutos (só dispara se houver algo na fila) -----
select cron.schedule(
  'meta-capi-flush',
  '*/5 * * * *',
  $cron$ select public.meta_disparar_flush()
         where exists (select 1 from public.meta_eventos
                        where status in ('pendente','enviando') and proximo_envio <= now()) $cron$
);
