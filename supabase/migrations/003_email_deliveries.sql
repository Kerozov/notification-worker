-- Per-recipient delivery and open tracking

CREATE TABLE email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES email_jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  resend_email_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'delivered', 'opened', 'bounced')),
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, recipient)
);

CREATE INDEX email_deliveries_job_id_idx ON email_deliveries (job_id);
CREATE INDEX email_deliveries_resend_email_id_idx ON email_deliveries (resend_email_id)
  WHERE resend_email_id IS NOT NULL;
