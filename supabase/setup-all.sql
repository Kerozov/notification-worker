-- =====================================================================
-- Notification Worker — пълна схема (обединява 001–008).
-- Пусни в Supabase → SQL Editor.
--
-- БЕЗОПАСНО ЗА ПОВТОРНО ПУСКАНЕ. Само създава и надгражда:
--   • не трие worker таблици и данни;
--   • не пипа tenant API ключове и job история.
--
-- Таблици: tenants, email_jobs, email_deliveries,
--          sms_jobs, sms_deliveries, worker_meta
--
-- Ако по грешка си пуснал website-zara setup тук:
--   първо CLEANUP_ZARA_SETUP.sql, после този файл.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 001 init
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 002 from address
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_from text;

ALTER TABLE email_jobs
  ADD COLUMN IF NOT EXISTS from_email text;


-- ---------------------------------------------------------------------
-- 003 + 004 + 005 email_deliveries (ZeptoMail)
-- ---------------------------------------------------------------------
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
      'clicked', 'bounced', 'complained', 'canceled'
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

-- 004 renamed resend_email_id → provider_message_id. CREATE IF NOT EXISTS cannot
-- rename, so a database that still has the old column would keep both and the
-- worker would write only the new one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'email_deliveries'
      AND column_name = 'resend_email_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'email_deliveries'
        AND column_name = 'provider_message_id'
    ) THEN
      ALTER TABLE email_deliveries RENAME COLUMN resend_email_id TO provider_message_id;
    ELSE
      UPDATE email_deliveries
        SET provider_message_id = resend_email_id
        WHERE provider_message_id IS NULL AND resend_email_id IS NOT NULL;
      ALTER TABLE email_deliveries DROP COLUMN resend_email_id;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'email_deliveries_resend_email_id_idx'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'email_deliveries_provider_message_id_idx'
  ) THEN
    ALTER INDEX email_deliveries_resend_email_id_idx
      RENAME TO email_deliveries_provider_message_id_idx;
  END IF;
END $$;

ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS provider_message_id text;

ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'zeptomail';

ALTER TABLE email_deliveries
  DROP CONSTRAINT IF EXISTS email_deliveries_status_check;

ALTER TABLE email_deliveries
  ADD CONSTRAINT email_deliveries_status_check
  CHECK (status IN (
    'pending', 'sent', 'failed', 'delivered', 'opened',
    'clicked', 'bounced', 'complained', 'canceled'
  ));

ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_url text,
  ADD COLUMN IF NOT EXISTS complained_at timestamptz;

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


-- ---------------------------------------------------------------------
-- 006 SMS
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 007 tenant notifier key
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notifier_api_key text;


-- ---------------------------------------------------------------------
-- 008 email job attachments
-- ---------------------------------------------------------------------
ALTER TABLE email_jobs
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;


-- ---------------------------------------------------------------------
-- 009 campaign jobs: merge fields + cancel one recipient
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 010 campaign parent + child send jobs
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- Проверка
-- ---------------------------------------------------------------------
SELECT
  'Setup complete: notification-worker schema ready (001–010).' AS result,
  (SELECT count(*) FROM tenants) AS tenants,
  (SELECT count(*) FROM email_jobs) AS email_jobs,
  (SELECT count(*) FROM sms_jobs) AS sms_jobs;
