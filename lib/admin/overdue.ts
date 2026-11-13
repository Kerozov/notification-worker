import { getSupabaseAdmin } from "@/lib/db/supabase";
import { EMAIL_JOB_SELECT, SMS_JOB_SELECT } from "@/lib/admin/job-query";
import { DEAD_STEP_MS } from "@/lib/jobs/campaign";

/** A pending job this long past its send time should have gone out already. */
export const OVERDUE_GRACE_MS = 10 * 60_000;
const OVERDUE_LIMIT = 100;

/**
 * overdue = pending past its send time; stuck = "processing" with no live step;
 * failed = nothing (or not everything) went out and nobody has dismissed it yet.
 */
export type OverdueReason = "overdue" | "stuck" | "failed";

export type OverdueResult<TRow> = {
  rows: Array<TRow & { reason: OverdueReason }>;
  error: string | null;
};

type JobTable = "email_jobs" | "sms_jobs";

async function fetchOverdue<TRow>(
  table: JobTable,
  select: string,
  now = Date.now(),
): Promise<OverdueResult<TRow>> {
  const supabase = getSupabaseAdmin();
  const dueBefore = new Date(now - OVERDUE_GRACE_MS).toISOString();
  const deadBefore = new Date(now - DEAD_STEP_MS).toISOString();

  const base = () => {
    const query = supabase.from(table).select(select).is("dismissed_at", null);
    // Campaign pockets show up through their parent, like everywhere in admin.
    return table === "email_jobs" ? query.is("parent_id", null) : query;
  };

  const [overdue, stuck, failed] = await Promise.all([
    base()
      .eq("status", "pending")
      .lt("send_at", dueBefore)
      .order("send_at", { ascending: true })
      .limit(OVERDUE_LIMIT),
    base()
      .eq("status", "processing")
      .lt("updated_at", deadBefore)
      .order("updated_at", { ascending: true })
      .limit(OVERDUE_LIMIT),
    base()
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(OVERDUE_LIMIT),
  ]);

  const error = overdue.error ?? stuck.error ?? failed.error;
  if (error) {
    return {
      rows: [],
      error: error.message.includes("dismissed_at")
        ? "Column dismissed_at is missing — run migration 018_job_dismissed.sql"
        : error.message,
    };
  }

  const tag = (data: unknown, reason: OverdueReason) =>
    ((data ?? []) as TRow[]).map((row) => ({ ...row, reason }));

  return {
    rows: [
      ...tag(overdue.data, "overdue"),
      ...tag(stuck.data, "stuck"),
      ...tag(failed.data, "failed"),
    ],
    error: null,
  };
}

export function fetchOverdueEmailJobs<TRow>(): Promise<OverdueResult<TRow>> {
  return fetchOverdue<TRow>("email_jobs", EMAIL_JOB_SELECT);
}

export function fetchOverdueSmsJobs<TRow>(): Promise<OverdueResult<TRow>> {
  return fetchOverdue<TRow>("sms_jobs", SMS_JOB_SELECT);
}

/** Number shown on the nav tab; 0 when the column is not there yet. */
export async function countOverdueJobs(now = Date.now()): Promise<number> {
  const supabase = getSupabaseAdmin();
  const dueBefore = new Date(now - OVERDUE_GRACE_MS).toISOString();
  const deadBefore = new Date(now - DEAD_STEP_MS).toISOString();
  const open = `and(status.eq.pending,send_at.lt.${dueBefore}),and(status.eq.processing,updated_at.lt.${deadBefore}),status.eq.failed`;

  const [email, sms] = await Promise.all([
    supabase
      .from("email_jobs")
      .select("*", { count: "exact", head: true })
      .is("parent_id", null)
      .is("dismissed_at", null)
      .or(open),
    supabase
      .from("sms_jobs")
      .select("*", { count: "exact", head: true })
      .is("dismissed_at", null)
      .or(open),
  ]);

  return (email.error ? 0 : (email.count ?? 0)) + (sms.error ? 0 : (sms.count ?? 0));
}

/** Leaves the job as it is, only takes it off the overdue list. */
export async function dismissJob(
  table: JobTable,
  jobId: string,
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(table)
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["failed", "processing"])
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

/**
 * A failed SMS job goes back to pending and runs again. Only when nothing of it
 * went out, so no number gets the same message twice.
 */
export async function reopenFailedSmsJob(jobId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sms_jobs")
    .update({ status: "pending", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "failed")
    .eq("sent_count", 0)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}
