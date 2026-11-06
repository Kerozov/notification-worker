-- One send budget per mail domain per time window, shared by every pocket and
-- every client, so a campaign cannot flood one provider (abv.bg turned 250
-- addresses into "Host not reachable" when they all went out in a few seconds).

create table if not exists public.email_domain_send_windows (
  domain text not null,
  window_start timestamptz not null,
  sent integer not null default 0,
  primary key (domain, window_start)
);

alter table public.email_domain_send_windows enable row level security;

grant select, insert, update, delete on public.email_domain_send_windows to service_role;

-- p_requests: {"abv.bg": {"want": 120, "limit": 40}, "gmail.com": {...}}
-- Returns {"window_start": "...", "granted": {"abv.bg": 40, "gmail.com": 12}}.
-- Domains are locked in key order, so two parallel callers cannot deadlock.
create or replace function public.reserve_email_domain_quota(
  p_requests jsonb,
  p_window_seconds integer
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / greatest(p_window_seconds, 1))
      * greatest(p_window_seconds, 1)
  );
  v_domain text;
  v_request jsonb;
  v_want integer;
  v_limit integer;
  v_used integer;
  v_grant integer;
  v_granted jsonb := '{}'::jsonb;
begin
  for v_domain, v_request in
    select key, value from jsonb_each(p_requests) order by key
  loop
    v_want := greatest(0, coalesce((v_request ->> 'want')::integer, 0));
    v_limit := greatest(0, coalesce((v_request ->> 'limit')::integer, 0));

    insert into public.email_domain_send_windows (domain, window_start, sent)
    values (v_domain, v_window, 0)
    on conflict (domain, window_start) do nothing;

    select sent into v_used
    from public.email_domain_send_windows
    where domain = v_domain and window_start = v_window
    for update;

    v_grant := least(v_want, greatest(0, v_limit - v_used));

    if v_grant > 0 then
      update public.email_domain_send_windows
      set sent = sent + v_grant
      where domain = v_domain and window_start = v_window;
    end if;

    v_granted := v_granted || jsonb_build_object(v_domain, v_grant);
  end loop;

  if random() < 0.05 then
    delete from public.email_domain_send_windows
    where window_start < now() - interval '1 day';
  end if;

  return jsonb_build_object('window_start', v_window, 'granted', v_granted);
end;
$$;

revoke all on function public.reserve_email_domain_quota(jsonb, integer) from public, anon, authenticated;
grant execute on function public.reserve_email_domain_quota(jsonb, integer) to service_role;
