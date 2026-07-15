import type { Tenant } from "@/lib/db/supabase";

/**
 * In-memory tenant cache to avoid hitting the `tenants` table on every request.
 *
 * A single email/SMS send resolves the tenant at least twice (Bearer auth +
 * job processing). During a campaign burst that is dozens of identical reads.
 * The cache lives only inside a warm serverless instance and is bounded by a
 * short TTL, so at worst a tenant edit takes `TTL_MS` to propagate. Admin
 * mutations call `clearTenantCache()` to drop staleness immediately.
 */
const TTL_MS = 60_000;

type CacheEntry = { tenant: Tenant; expiresAt: number };

const byHash = new Map<string, CacheEntry>();
const byId = new Map<string, CacheEntry>();

function readFresh(entry: CacheEntry | undefined): Tenant | null {
  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    return null;
  }

  return entry.tenant;
}

export function getCachedTenantByHash(apiKeyHash: string): Tenant | null {
  return readFresh(byHash.get(apiKeyHash));
}

export function getCachedTenantById(tenantId: string): Tenant | null {
  return readFresh(byId.get(tenantId));
}

export function cacheTenant(tenant: Tenant): void {
  const expiresAt = Date.now() + TTL_MS;
  byHash.set(tenant.api_key_hash, { tenant, expiresAt });
  byId.set(tenant.id, { tenant, expiresAt });
}

/** Drop all cached tenants. Called after any admin tenant mutation. */
export function clearTenantCache(): void {
  byHash.clear();
  byId.clear();
}
