-- SMS jobs + per-recipient delivery tracking (Notifier)

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_sms_sender text;

CREATE TABLE sms_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'canceled')),
  send_at timestamptz NOT NULL,
  body text NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  sender text,
  sent_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE UNIQUE INDEX sms_jobs_tenant_idempotency_key_idx
  ON sms_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX sms_jobs_pending_send_at_idx
  ON sms_jobs (send_at)
  WHERE status = 'pending';

CREATE TABLE sms_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES sms_jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  provider text NOT NULL DEFAULT 'notifier',
  provider_message_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'delivered', 'bounced')),
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, recipient)
);

CREATE INDEX sms_deliveries_job_id_idx ON sms_deliveries (job_id);
