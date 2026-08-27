-- One campaign = one email_jobs row with every recipient listed.
-- Merge fields ({{name}}, {{unsubscribe_url}}, …) live on the job so ZeptoMail
-- can personalise a single html template. Canceled deliveries let an unsubscribe
-- drop one address from a pending campaign without cancelling the rest.

ALTER TABLE email_jobs
  ADD COLUMN IF NOT EXISTS merge jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE email_deliveries
  DROP CONSTRAINT IF EXISTS email_deliveries_status_check;

ALTER TABLE email_deliveries
  ADD CONSTRAINT email_deliveries_status_check
  CHECK (status IN (
    'pending', 'sent', 'failed', 'delivered', 'opened',
    'clicked', 'bounced', 'complained', 'canceled'
  ));
