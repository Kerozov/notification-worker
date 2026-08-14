-- Persist email attachments so scheduled jobs can still attach files at send time.
ALTER TABLE email_jobs
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
