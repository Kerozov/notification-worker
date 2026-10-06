import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { asTenant, getSupabaseAdmin, Tenant } from "@/lib/db/supabase";
import {
  cacheTenant,
  cacheTenantForKeyHash,
  getCachedTenantByHash,
} from "@/lib/tenants/cache";

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);

  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return timingSafeEqual(aBuf, bBuf);
}

export function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");

  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function resolveTenantFromRequest(
  request: NextRequest,
): Promise<Tenant | null> {
  const apiKey = extractBearerToken(request);

  if (!apiKey) {
    return null;
  }

  const apiKeyHash = hashApiKey(apiKey);

  const cached = getCachedTenantByHash(apiKeyHash);
  if (cached) {
    // Cache is keyed by the exact hash, so the equality check already holds.
    return cached;
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("api_key_hash", apiKeyHash)
    .maybeSingle();

  if (error) {
    return null;
  }

  if (!data) {
    return resolveExtraKey(apiKeyHash);
  }

  const tenant = asTenant(data);

  if (!safeEqual(tenant.api_key_hash, apiKeyHash)) {
    return null;
  }

  cacheTenant(tenant);
  return tenant;
}

const isMissingTable = (error: { code?: string; message?: string }): boolean =>
  error.code === "42P01" ||
  error.code === "PGRST205" ||
  (error.message ?? "").includes("tenant_api_keys");

/**
 * An extra key (`tenant_api_keys`) authenticates as its tenant, marked with
 * `auth_key_id`. A revoked key is no key. Before migration 014 there are none.
 */
async function resolveExtraKey(apiKeyHash: string): Promise<Tenant | null> {
  const supabase = getSupabaseAdmin();

  const { data: key, error } = await supabase
    .from("tenant_api_keys")
    .select("id, tenant_id, key_hash")
    .eq("key_hash", apiKeyHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    if (!isMissingTable(error)) {
      console.error("[auth] extra key lookup failed:", error.message);
    }
    return null;
  }

  if (!key || !safeEqual(String(key.key_hash), apiKeyHash)) {
    return null;
  }

  const { data: row } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", key.tenant_id)
    .maybeSingle();

  if (!row) {
    return null;
  }

  const tenant: Tenant = { ...asTenant(row), auth_key_id: String(key.id) };
  cacheTenantForKeyHash(apiKeyHash, tenant);
  return tenant;
}

export function unauthorizedResponse() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
