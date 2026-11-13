import { getSupabaseAdmin } from "@/lib/db/supabase";
import { countOverdueJobs } from "@/lib/admin/overdue";

export async function getAdminChrome(): Promise<{
  emailPending: number;
  smsPending: number;
  overdue: number;
  lastCronRun: string | null;
}> {
  const supabase = getSupabaseAdmin();

  const [emailPending, smsPending, meta, overdue] = await Promise.all([
    supabase
      .from("email_jobs")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .is("parent_id", null),
    supabase
      .from("sms_jobs")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("worker_meta")
      .select("value")
      .eq("key", "last_cron_run_at")
      .maybeSingle(),
    countOverdueJobs().catch(() => 0),
  ]);

  return {
    emailPending: emailPending.count ?? 0,
    smsPending: smsPending.error ? 0 : (smsPending.count ?? 0),
    overdue,
    lastCronRun: (meta.data as { value: string } | null)?.value ?? null,
  };
}
