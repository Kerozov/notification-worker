-- Switch delivery tracking to a provider-agnostic model (ZeptoMail)
-- Opens/bounces are correlated by (job_id, recipient) via client_reference.

ALTER TABLE email_deliveries
  RENAME COLUMN resend_email_id TO provider_message_id;

ALTER INDEX email_deliveries_resend_email_id_idx
  RENAME TO email_deliveries_provider_message_id_idx;

ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'zeptomail';
