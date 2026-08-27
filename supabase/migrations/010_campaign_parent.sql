-- A campaign is one parent row (the admin view: who gets this message)
-- plus child send jobs of 250. Cron / Trigger only process kind = 'send'.

ALTER TABLE email_jobs
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES email_jobs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'send';

ALTER TABLE email_jobs
  DROP CONSTRAINT IF EXISTS email_jobs_kind_check;

ALTER TABLE email_jobs
  ADD CONSTRAINT email_jobs_kind_check
  CHECK (kind IN ('send', 'campaign'));

CREATE INDEX IF NOT EXISTS email_jobs_parent_id_idx
  ON email_jobs (parent_id);

CREATE INDEX IF NOT EXISTS email_jobs_pending_send_kind_idx
  ON email_jobs (send_at)
  WHERE status = 'pending' AND kind = 'send';
