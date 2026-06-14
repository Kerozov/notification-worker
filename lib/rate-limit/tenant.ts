import { getSupabaseAdmin } from "@/lib/db/supabase";

const MAX_JOBS_PER_MINUTE = 10;

export async function checkTenantJobRateLimit(
  tenantId: string,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const supabase = getSupabaseAdmin();
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();

  const { count, error } = await supabase
    .from("email_jobs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("created_at", oneMinuteAgo);

  if (error) {
    throw new Error(`Rate limit check failed: ${error.message}`);
  }

  if ((count ?? 0) >= MAX_JOBS_PER_MINUTE) {
    return { allowed: false, retryAfterSeconds: 60 };
  }

  return { allowed: true };
}

export function rateLimitResponse(retryAfterSeconds = 60) {
  return Response.json(
    { error: "Rate limit exceeded", retryAfterSeconds },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}
