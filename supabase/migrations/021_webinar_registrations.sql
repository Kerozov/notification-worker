-- History of webinar registrations handed to Notifier, per client — the same
-- way SMS jobs leave a row. One row per attempt: added, already there, or failed
-- (with Notifier's answer), so a "why didn't she get the SMS" has an answer.

create table if not exists public.webinar_registrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  webinar_id text not null,
  name text,
  email text,
  phone text,
  status text not null check (status in ('added', 'duplicate', 'failed')),
  http_status integer,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists webinar_registrations_tenant_created_idx
  on public.webinar_registrations (tenant_id, created_at desc);

alter table public.webinar_registrations enable row level security;

grant select, insert, update, delete on public.webinar_registrations to service_role;
