-- Extra API keys for a client, next to its main one.
--
-- The main key (tenants.api_key_hash) lives in the client's own site and
-- rotating it breaks that site. A client of the LaunchifyBG platform needs a
-- key it can paste into the platform's "СМС → Връзка" without touching the
-- main one: each extra key authenticates as the same client, can be revoked on
-- its own, and never acts for other clients (even on the platform's profile).

CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  -- Last four characters, so the admin can tell keys apart without seeing them.
  key_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS tenant_api_keys_tenant_idx ON tenant_api_keys (tenant_id);

ALTER TABLE tenant_api_keys ENABLE ROW LEVEL SECURITY;
