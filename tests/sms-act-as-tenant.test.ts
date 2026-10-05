import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Tenant } from "@/lib/db/supabase";

const tenant = (slug: string, extra: Partial<Tenant> = {}): Tenant => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  api_key_hash: `hash-${slug}`,
  default_from: null,
  default_reply_to: null,
  default_sms_sender: null,
  notifier_api_key: null,
  created_at: "2026-01-01T00:00:00Z",
  ...extra,
});

let caller: Tenant | null = null;
const bySlug = new Map<string, Tenant>();

mock.module("@/lib/auth/tenant", () => ({
  resolveTenantFromRequest: async () => caller,
  unauthorizedResponse: () =>
    Response.json({ error: "Unauthorized" }, { status: 401 }),
}));

mock.module("@/lib/tenants/store", () => ({
  getTenantBySlug: async (slug: string) => bySlug.get(slug) ?? null,
  normalizeTenantSlug: (raw: string) => raw.trim().toLowerCase(),
}));

const { resolveSmsTenant } = await import("@/lib/auth/sms-tenant");

const requestWith = (actAs?: string) =>
  ({
    headers: new Headers(actAs ? { "x-act-as-tenant": actAs } : {}),
  }) as unknown as Parameters<typeof resolveSmsTenant>[0];

describe("X-Act-As-Tenant", () => {
  beforeEach(() => {
    bySlug.clear();
    bySlug.set("vessie", tenant("vessie", { notifier_api_key: "k" }));
  });

  test("without the header the caller is the tenant", async () => {
    caller = tenant("platform");
    const result = await resolveSmsTenant(requestWith());
    expect(result.ok && result.tenant.slug).toBe("platform");
  });

  test("a plain client key cannot spend another client's balance", async () => {
    caller = tenant("other");
    const result = await resolveSmsTenant(requestWith("vessie"));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(403);
  });

  test("the platform key sends as the named client", async () => {
    caller = tenant("platform", { can_act_for_tenants: true });
    const result = await resolveSmsTenant(requestWith("Vessie"));
    expect(result.ok && result.tenant.slug).toBe("vessie");
    expect(result.ok && result.caller.slug).toBe("platform");
  });

  test("an unknown client is a 404, never a silent fallback to the caller", async () => {
    caller = tenant("platform", { can_act_for_tenants: true });
    const result = await resolveSmsTenant(requestWith("ghost"));
    expect(!result.ok && result.status).toBe(404);
  });

  test("no key is 401", async () => {
    caller = null;
    const result = await resolveSmsTenant(requestWith("vessie"));
    expect(!result.ok && result.status).toBe(401);
  });
});
