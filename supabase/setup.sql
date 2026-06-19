-- Notification Worker — full database setup (fresh Supabase project)
-- Run in Supabase Dashboard → SQL Editor → New query → Paste → Run
-- Safe to re-run only if 001 tables do NOT exist yet. For existing DB use individual migrations 002–007.

-- ========== 001_init.sql ==========
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,
  default_from text,
  default_reply_to text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'canceled')),
  send_at timestamptz NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  from_email text,
  reply_to text,
  sent_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS email_jobs_tenant_idempotency_key_idx
  ON email_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_jobs_pending_send_at_idx
  ON email_jobs (send_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS worker_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========== 003_email_deliveries.sql (ZeptoMail-ready columns) ==========
CREATE TABLE IF NOT EXISTS email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES email_jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  provider_message_id text,
  provider text NOT NULL DEFAULT 'zeptomail',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'sent', 'failed', 'delivered', 'opened',
      'clicked', 'bounced', 'complained'
    )),
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  clicked_url text,
  complained_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, recipient)
);

CREATE INDEX IF NOT EXISTS email_deliveries_job_id_idx ON email_deliveries (job_id);
CREATE INDEX IF NOT EXISTS email_deliveries_provider_message_id_idx
  ON email_deliveries (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_deliveries_complained_at_idx
  ON email_deliveries (complained_at)
  WHERE complained_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_deliveries_clicked_at_idx
  ON email_deliveries (clicked_at)
  WHERE clicked_at IS NOT NULL;

-- ========== 006_sms.sql ==========
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_sms_sender text;

CREATE TABLE IF NOT EXISTS sms_jobs (
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

CREATE UNIQUE INDEX IF NOT EXISTS sms_jobs_tenant_idempotency_key_idx
  ON sms_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS sms_jobs_pending_send_at_idx
  ON sms_jobs (send_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS sms_deliveries (
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

CREATE INDEX IF NOT EXISTS sms_deliveries_job_id_idx ON sms_deliveries (job_id);

-- ========== 007_tenant_notifier_key.sql ==========
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notifier_api_key text;
