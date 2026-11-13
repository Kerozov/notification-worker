-- "Overdue" admin screen: a failed or stuck job the owner looked at and chose
-- not to send stays as it is (status, counts, error), but leaves the list.

alter table public.email_jobs add column if not exists dismissed_at timestamptz;
alter table public.sms_jobs add column if not exists dismissed_at timestamptz;

create index if not exists email_jobs_open_failed_idx
  on public.email_jobs (updated_at desc)
  where status = 'failed' and dismissed_at is null;

create index if not exists sms_jobs_open_failed_idx
  on public.sms_jobs (updated_at desc)
  where status = 'failed' and dismissed_at is null;
