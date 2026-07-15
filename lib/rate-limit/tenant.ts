import { getSupabaseAdmin } from "@/lib/db/supabase";

// Per-tenant guard against runaway loops. Campaigns create one job per
// personalized recipient, so the old default of 10 blocked any real send.
// Configurable via env; defaults high enough for first-party campaigns.
const DEFAULT_MAX_JOBS_PER_MINUTE = 500;

function getMaxJobsPerMinute(): number {
  const parsed = Number(process.env.MAX_JOBS_PER_MINUTE);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_JOBS_PER_MINUTE;
}

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

  if (total >= getMaxJobsPerMinute()) {
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
