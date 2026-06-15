-- Per-tenant Notifier SMS API key (each client uses their own Notifier account)

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notifier_api_key text;
