-- Where a client wants to hear about opens, clicks and bounces as they happen.
-- One address per client. Until now a client learned them only by asking for a
-- job report, so its numbers were as old as its last question — and most
-- clients grew a second open tracker of their own to avoid asking.

create table if not exists public.tenant_event_hooks (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  url text not null,
  token text not null,
  updated_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz
);

alter table public.tenant_event_hooks enable row level security;

grant select, insert, update, delete on public.tenant_event_hooks to service_role;
