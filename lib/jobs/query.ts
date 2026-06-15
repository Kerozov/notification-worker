import { asEmailJob, EmailJob, getSupabaseAdmin } from "@/lib/db/supabase";

export async function getJobForTenant(
  tenantId: string,
  jobId: string,
): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}
