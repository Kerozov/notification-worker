import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { asTenant, getSupabaseAdmin, Tenant } from "@/lib/db/supabase";

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
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("api_key_hash", apiKeyHash)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const tenant = asTenant(data);

  if (!safeEqual(tenant.api_key_hash, apiKeyHash)) {
    return null;
  }

  return tenant;
}

export function unauthorizedResponse() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
