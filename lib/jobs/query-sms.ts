import { asSmsJob, SmsJob, getSupabaseAdmin } from "@/lib/db/supabase";

export async function getSmsJobForTenant(
  tenantId: string,
  jobId: string,
): Promise<SmsJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("sms_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asSmsJob(data) : null;
}

export async function getSmsJobById(jobId: string): Promise<SmsJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("sms_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asSmsJob(data) : null;
}
