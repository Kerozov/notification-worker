import { getSupabaseAdmin } from "@/lib/db/supabase";

const MAX_JOBS_PER_MINUTE = 10;

export async function checkTenantJobRateLimit(
  tenantId: string,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const supabase = getSupabaseAdmin();
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();

  const [emailCount, smsCount] = await Promise.all([
    supabase
      .from("email_jobs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", oneMinuteAgo),
    supabase
      .from("sms_jobs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", oneMinuteAgo),
  ]);

  if (emailCount.error) {
    throw new Error(`Rate limit check failed: ${emailCount.error.message}`);
  }

  // sms_jobs may not exist before migration 006
  const smsTotal = smsCount.error ? 0 : (smsCount.count ?? 0);
  const total = (emailCount.count ?? 0) + smsTotal;

  if (total >= MAX_JOBS_PER_MINUTE) {
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
