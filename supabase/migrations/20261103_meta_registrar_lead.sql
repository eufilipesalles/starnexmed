-- Chamada pelo ingest-lead logo depois de gravar o lead: guarda os sinais da Meta e, se o lead é MQL,
-- coloca o evento Lead na fila e avisa a função de envio. Nunca levanta erro: se algo falhar, devolve false
-- e o lead (já gravado) segue normalmente.
-- (Já aplicada no projeto gtnnqoebcudsnzqicrto; guardada aqui como registro.)
create or replace function public.meta_registrar_lead(
  p_lead_id         uuid,
  p_mql             boolean,
  p_event_id        text,
  p_fbc             text,
  p_fbp             text,
  p_ip              text,
  p_ua              text,
  p_url             text,
  p_faturamento     text,
  p_test_event_code text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id text := case when p_event_id ~ '^[A-Za-z0-9_.-]{6,80}$' then p_event_id else null end;
  v_test     text := case when p_test_event_code ~ '^[A-Za-z0-9_-]{3,40}$' then p_test_event_code else null end;
  v_mql      boolean := coalesce(p_mql, false) and v_event_id is not null;
begin
  insert into public.lead_meta (lead_id, mql, event_id, fbc, fbp, client_ip, client_user_agent, event_source_url, faturamento, test_event_code)
  values (p_lead_id, v_mql, v_event_id, left(p_fbc, 300), left(p_fbp, 300), left(p_ip, 80), left(p_ua, 500),
          left(p_url, 500), left(p_faturamento, 200), v_test)
  on conflict (lead_id) do nothing;

  -- só entra na fila o Lead de MQL com código de evento válido (é o mesmo código do pixel em /obrigado/)
  if v_mql then
    insert into public.meta_eventos (lead_id, event_name, event_id, event_time)
    values (p_lead_id, 'Lead', v_event_id, now())
    on conflict (event_name, event_id) do nothing;
    perform public.meta_disparar_flush();
  end if;

  return true;
exception when others then
  raise warning 'meta_registrar_lead: %', sqlerrm;
  return false;
end $$;

revoke execute on function public.meta_registrar_lead(uuid, boolean, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.meta_registrar_lead(uuid, boolean, text, text, text, text, text, text, text, text) to service_role;
