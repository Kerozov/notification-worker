import { NextRequest } from "next/server";
import { resolveTenantFromRequest } from "@/lib/auth/tenant";
import type { Tenant } from "@/lib/db/supabase";
import { getTenantBySlug, normalizeTenantSlug } from "@/lib/tenants/store";

/**
 * Header the platform uses to send as one of its clients. The job, the short
 * link, the Notifier key and the sender name are then that client's.
 */
export const ACT_AS_TENANT_HEADER = "x-act-as-tenant";

export type SmsTenantResolution =
  | { ok: true; tenant: Tenant; caller: Tenant }
  | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Only the main key of a flagged tenant. An extra key handed to one of the
 * platform's clients must not inherit the platform's right to send as anyone.
 */
export function canActForTenants(tenant: Tenant): boolean {
  return tenant.can_act_for_tenants === true && !tenant.auth_key_id;
}

/**
 * The tenant an SMS request runs as. Without the header it is the caller.
 * With it, the caller must be allowed to act for others — otherwise any
 * client key could spend another client's Notifier balance.
 */
export async function resolveSmsTenant(
  request: NextRequest,
): Promise<SmsTenantResolution> {
  const caller = await resolveTenantFromRequest(request);

  if (!caller) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const raw = request.headers.get(ACT_AS_TENANT_HEADER)?.trim();

  if (!raw) {
    return { ok: true, tenant: caller, caller };
  }

  const slug = normalizeTenantSlug(raw);

  if (slug === caller.slug) {
    return { ok: true, tenant: caller, caller };
  }

  if (!canActForTenants(caller)) {
    return {
      ok: false,
      status: 403,
      error: "This API key may not send on behalf of other clients",
    };
  }

  const target = await getTenantBySlug(slug);

  if (!target) {
    return { ok: false, status: 404, error: `Client "${slug}" not found` };
  }

  return { ok: true, tenant: target, caller };
}

export function smsTenantErrorResponse(
  resolution: Extract<SmsTenantResolution, { ok: false }>,
) {
  return Response.json({ error: resolution.error }, { status: resolution.status });
}
