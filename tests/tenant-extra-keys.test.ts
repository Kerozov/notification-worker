import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canActForTenants } from "@/lib/auth/sms-tenant";
import type { Tenant } from "@/lib/db/supabase";

const platform: Tenant = {
  id: "id-platform",
  slug: "launchify",
  name: "Launchify",
  api_key_hash: "hash-main",
  default_from: null,
  default_reply_to: null,
  default_sms_sender: null,
  notifier_api_key: "k",
  can_act_for_tenants: true,
  created_at: "2026-01-01T00:00:00Z",
};

describe("extra API keys", () => {
  test("only the main key of a flagged tenant may act for others", () => {
    expect(canActForTenants(platform)).toBe(true);
    expect(canActForTenants({ ...platform, auth_key_id: "extra-1" })).toBe(false);
  });

  test("an extra key never rotates the main one", () => {
    const store = readFileSync("lib/tenants/store.ts", "utf8");
    const create = store.slice(store.indexOf("export async function createTenantExtraKey"));
    const body = create.slice(0, create.indexOf("\n}\n"));
    expect(body).toContain('from("tenant_api_keys")');
    expect(body).not.toContain("api_key_hash");
  });

  test("auth falls back to extra keys, ignoring revoked ones", () => {
    const auth = readFileSync("lib/auth/tenant.ts", "utf8");
    expect(auth).toContain('from("tenant_api_keys")');
    expect(auth).toContain('.is("revoked_at", null)');
    expect(auth).toContain("auth_key_id");
  });

  test("migration is idempotent", () => {
    const sql = readFileSync("supabase/migrations/014_tenant_extra_api_keys.sql", "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS tenant_api_keys/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });
});
