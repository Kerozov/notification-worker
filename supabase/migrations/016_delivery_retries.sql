-- Temporary bounces (e.g. abv.bg "Host not reachable") and failed ZeptoMail
-- requests go back to the queue instead of staying failed for good.
--   bounce_type      soft / hard, from the ZeptoMail webhook event
--   retry_count      how many times the address was put back in the queue
--   next_attempt_at  a pending row is not sent before this time

alter table public.email_deliveries
  add column if not exists bounce_type text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz;

alter table public.email_deliveries
  drop constraint if exists email_deliveries_bounce_type_check;

alter table public.email_deliveries
  add constraint email_deliveries_bounce_type_check
  check (bounce_type is null or bounce_type in ('soft', 'hard'));
