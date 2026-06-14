-- Email worker initial schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,
  default_reply_to text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'canceled')),
  send_at timestamptz NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to text,
  sent_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE UNIQUE INDEX email_jobs_tenant_idempotency_key_idx
  ON email_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX email_jobs_pending_send_at_idx
  ON email_jobs (send_at)
  WHERE status = 'pending';

CREATE TABLE worker_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
