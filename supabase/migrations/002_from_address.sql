-- Add per-tenant and per-job from addresses

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_from text;

ALTER TABLE email_jobs
  ADD COLUMN IF NOT EXISTS from_email text;
