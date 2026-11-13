import { getSupabaseAdmin } from "@/lib/db/supabase";
import { EMAIL_JOB_SELECT, SMS_JOB_SELECT } from "@/lib/admin/job-query";
import { DEAD_STEP_MS } from "@/lib/jobs/campaign";

const OVERDUE_GRACE_MS = 10 * 60_000;
const OVERDUE_LIMIT = 100;
export const FAILED_EMAIL_DISMISS_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

export type OverdueReason = "overdue" | "stuck" | "failed";

type EmailIssue = {
  id: string;
  reason: OverdueReason;
  issue_count: number;
};

type JobTable = "email_jobs" | "sms_jobs";

function cutoffs(now: number) {
  return {
    p_due_before: new Date(now - OVERDUE_GRACE_MS).toISOString(),
    p_stuck_before: new Date(now - DEAD_STEP_MS).toISOString(),
  };
}

function emailIssues(now: number, countOnly = false) {
  return getSupabaseAdmin().rpc(
    "admin_overdue_email_jobs",
    cutoffs(now),
    { head: countOnly, count: "exact" },
  );
}

function smsIssues(now: number, countOnly = false) {
  const { p_due_before: due, p_stuck_before: stuck } = cutoffs(now);
  return getSupabaseAdmin()
    .from("sms_jobs")
    .select(countOnly ? "id" : SMS_JOB_SELECT, { count: "exact", head: countOnly })
    .is("dismissed_at", null)
    .or(`and(status.eq.pending,send_at.lte.${due}),and(status.eq.processing,updated_at.lte.${stuck}),status.eq.failed`);
}

export async function fetchOverdueEmailJobs<TRow extends { id: string }>(now: number, reason?: OverdueReason, page = 1) {
  let query = emailIssues(now);
  if (reason) query = query.eq("reason", reason);
  const issues = await query
    .order("priority").order("sort_at").order("id").range((page - 1) * OVERDUE_LIMIT, page * OVERDUE_LIMIT - 1);
  if (issues.error) {
    return { rows: [], count: null, error: issues.error.message };
  }
  const entries = (issues.data ?? []) as EmailIssue[];
  if (entries.length === 0) {
    return { rows: [], count: issues.count, error: null };
  }

  const jobs = await getSupabaseAdmin().from("email_jobs").select(EMAIL_JOB_SELECT)
    .in("id", entries.map(({ id }) => id));
  if (jobs.error) {
    return { rows: [], count: issues.count, error: jobs.error.message };
  }
  const byId = new Map(((jobs.data ?? []) as unknown as TRow[]).map((job) => [job.id, job]));
  const rows = entries.flatMap(({ id, reason, issue_count }) => {
    const job = byId.get(id);
    return job ? [{ ...job, reason, issue_count }] : [];
  });
  return { rows, count: issues.count, error: null };
}

export async function fetchOverdueSmsJobs<TRow extends { status: string }>(now: number, reason?: OverdueReason, page = 1) {
  let query = smsIssues(now);
  if (reason) query = query.eq("status", reason === "overdue" ? "pending" : reason === "stuck" ? "processing" : "failed");
  const { data, error, count } = await query
    .order("updated_at", { ascending: false }).order("id").range((page - 1) * OVERDUE_LIMIT, page * OVERDUE_LIMIT - 1);
  const rows = ((data ?? []) as unknown as TRow[]).map((row) => {
    const reason: OverdueReason = row.status === "failed" ? "failed"
      : row.status === "processing" ? "stuck" : "overdue";
    return { ...row, reason };
  });
  return { rows, count, error: error?.message ?? null };
}

export async function countOverdueJobs(now = Date.now()): Promise<number> {
  const [email, sms] = await Promise.all([emailIssues(now, true), smsIssues(now, true)]);
  return (email.count ?? 0) + (sms.count ?? 0);
}

/** Acknowledge a failed, overdue or stuck notification. Leave its sending state alone. */
export async function dismissJob(
  table: JobTable,
  jobId: string,
): Promise<boolean> {
  const now = Date.now();
  const { p_stuck_before: stuck, p_due_before: due } = cutoffs(now);
  const { data, error } = await getSupabaseAdmin()
    .from(table)
    .update({ dismissed_at: new Date(now).toISOString() })
    .eq("id", jobId)
    .is("dismissed_at", null)
    .or(`status.eq.failed,and(status.eq.processing,updated_at.lte.${stuck}),and(status.eq.pending,send_at.lte.${due})`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

function oldFailedEmails(now: number) {
  const cutoff = new Date(now - FAILED_EMAIL_DISMISS_AGE_DAYS * DAY_MS).toISOString();
  const table = getSupabaseAdmin().from("email_jobs");
  return {
    count: () => table.select("id", { head: true, count: "exact" })
      .eq("kind", "send").eq("status", "failed").is("dismissed_at", null)
      .lt("updated_at", cutoff),
    dismiss: () => table.update({ dismissed_at: new Date(now).toISOString() }, { count: "exact" })
      .eq("kind", "send").eq("status", "failed").is("dismissed_at", null)
      .lt("updated_at", cutoff),
  };
}

export async function countOldFailedEmailJobs(now: number): Promise<number | null> {
  const { count, error } = await oldFailedEmails(now).count();
  return error ? null : count;
}

export async function dismissOldFailedEmailJobs(): Promise<number> {
  const { count, error } = await oldFailedEmails(Date.now()).dismiss();
  if (error) throw new Error(error.message);
  return count ?? 0;
}
