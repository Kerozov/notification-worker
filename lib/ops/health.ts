import { getSupabaseAdmin } from "@/lib/db/supabase";
import { canRetryDelivery } from "@/lib/deliveries/retry";

/** A job counts as stuck when it is "processing" this long without an update. */
export const STUCK_MS = 10 * 60_000;
/** A pending job is overdue this long after send_at with nothing happening. */
export const OVERDUE_MS = 30 * 60_000;
/** The cron safety net is considered silent after this long. */
export const CRON_SILENT_MS = 3 * 60 * 60_000;
/** This many failed jobs in 24h is a real problem, not noise. */
export const FAILED_CRITICAL = 5;

export type JobRef = {
  id: string;
  channel: "email" | "sms";
  tenant: string;
  title: string;
  error: string | null;
  failed: number;
  sent: number;
  updatedAt: string;
};

export type HealthSnapshot = {
  failed: JobRef[];
  stuck: JobRef[];
  overdue: JobRef[];
  retryable: { jobId: string; tenant: string; count: number }[];
  lastCronRun: string | null;
};

export type Problem = {
  key: string;
  level: "warn" | "critical";
  text: string;
  jobIds: string[];
};

export type HealthReport = HealthSnapshot & {
  status: "ok" | "warn" | "critical";
  problems: Problem[];
  checkedAt: string;
};

const ids = (jobs: { id: string }[]) => jobs.map((job) => job.id);

/** Pure: turn what the database shows into problems an owner can act on. */
export function assessHealth(
  snapshot: HealthSnapshot,
  now = Date.now(),
): HealthReport {
  const problems: Problem[] = [];

  if (snapshot.stuck.length) {
    problems.push({
      key: `stuck:${ids(snapshot.stuck).sort().join(",")}`,
      level: "critical",
      text: `${snapshot.stuck.length} job(s) stuck in processing for over ${STUCK_MS / 60_000} min`,
      jobIds: ids(snapshot.stuck),
    });
  }

  if (snapshot.overdue.length) {
    problems.push({
      key: `overdue:${ids(snapshot.overdue).sort().join(",")}`,
      level: "critical",
      text: `${snapshot.overdue.length} job(s) should have gone out over ${OVERDUE_MS / 60_000} min ago and did not`,
      jobIds: ids(snapshot.overdue),
    });
  }

  if (snapshot.failed.length) {
    problems.push({
      key: `failed:${ids(snapshot.failed).sort().join(",")}`,
      level: snapshot.failed.length >= FAILED_CRITICAL ? "critical" : "warn",
      text: `${snapshot.failed.length} failed job(s) in the last 24h`,
      jobIds: ids(snapshot.failed),
    });
  }

  const retryable = snapshot.retryable.reduce((sum, row) => sum + row.count, 0);
  if (retryable) {
    problems.push({
      key: `retryable:${snapshot.retryable.map((row) => `${row.jobId}=${row.count}`).sort().join(",")}`,
      level: "warn",
      text: `${retryable} address(es) bounced for a temporary reason and can be sent again`,
      jobIds: snapshot.retryable.map((row) => row.jobId),
    });
  }

  const cronAt = snapshot.lastCronRun ? new Date(snapshot.lastCronRun).getTime() : NaN;
  if (snapshot.lastCronRun && !Number.isNaN(cronAt) && now - cronAt > CRON_SILENT_MS) {
    problems.push({
      key: "cron-silent",
      level: "warn",
      text: `The safety-net drain has not run since ${snapshot.lastCronRun}`,
      jobIds: [],
    });
  }

  const status = problems.some((p) => p.level === "critical")
    ? "critical"
    : problems.length
      ? "warn"
      : "ok";

  return { ...snapshot, status, problems, checkedAt: new Date(now).toISOString() };
}

type JobRow = {
  id: string;
  tenant_id: string;
  subject?: string | null;
  body?: string | null;
  error: string | null;
  failed_count: number | null;
  sent_count: number | null;
  updated_at: string;
};

function toRef(row: JobRow, channel: "email" | "sms", tenants: Map<string, string>): JobRef {
  const title = channel === "email" ? row.subject ?? "" : (row.body ?? "").slice(0, 80);
  return {
    id: row.id,
    channel,
    tenant: tenants.get(row.tenant_id) ?? row.tenant_id,
    title,
    error: row.error ? row.error.slice(0, 300) : null,
    failed: row.failed_count ?? 0,
    sent: row.sent_count ?? 0,
    updatedAt: row.updated_at,
  };
}

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return (result.data ?? []) as T;
}

/** Reads the current state. Only selects: nothing is changed here. */
export async function collectHealth(now = Date.now()): Promise<HealthSnapshot> {
  const supabase = getSupabaseAdmin();
  const since = new Date(now - 24 * 60 * 60_000).toISOString();
  const stuckBefore = new Date(now - STUCK_MS).toISOString();
  const overdueBefore = new Date(now - OVERDUE_MS).toISOString();
  const emailCols = "id, tenant_id, subject, error, failed_count, sent_count, updated_at";
  const smsCols = "id, tenant_id, body, error, failed_count, sent_count, updated_at";

  const [tenantRows, failedEmail, failedSms, stuckEmail, stuckSms, overdueEmail, overdueSms, bounced, meta] =
    await Promise.all([
      supabase.from("tenants").select("id, slug"),
      supabase.from("email_jobs").select(emailCols).eq("status", "failed").eq("kind", "send")
        .gte("updated_at", since).order("updated_at", { ascending: false }).limit(20),
      supabase.from("sms_jobs").select(smsCols).eq("status", "failed")
        .gte("updated_at", since).order("updated_at", { ascending: false }).limit(20),
      // Send jobs only: a campaign row is "processing" while its pockets work,
      // and a stuck pocket is reported on its own.
      supabase.from("email_jobs").select(emailCols).eq("status", "processing").eq("kind", "send")
        .lt("updated_at", stuckBefore).limit(20),
      supabase.from("sms_jobs").select(smsCols).eq("status", "processing").lt("updated_at", stuckBefore).limit(20),
      supabase.from("email_jobs").select(emailCols).eq("status", "pending").eq("kind", "send")
        .lt("send_at", overdueBefore).lt("updated_at", overdueBefore).limit(50),
      supabase.from("sms_jobs").select(smsCols).eq("status", "pending")
        .lt("send_at", overdueBefore).lt("updated_at", overdueBefore).limit(20),
      supabase.from("email_deliveries")
        .select("job_id, tenant_id, status, error, opened_at, clicked_at, complained_at")
        .in("status", ["bounced", "failed"]).gte("updated_at", since).limit(2000),
      supabase.from("worker_meta").select("value").eq("key", "last_cron_run_at").maybeSingle(),
    ]);

  const tenants = new Map(
    must(tenantRows, "tenants").map((t: { id: string; slug: string }) => [t.id, t.slug]),
  );

  // A pending job that waits for a planned retry (next_attempt_at in the future) is not overdue.
  let overdueRows = must(overdueEmail, "overdue email") as JobRow[];
  if (overdueRows.length) {
    const waiting = await supabase.from("email_deliveries").select("job_id")
      .in("job_id", overdueRows.map((row) => row.id))
      .gt("next_attempt_at", new Date(now).toISOString());
    if (!waiting.error) {
      const later = new Set((waiting.data ?? []).map((row: { job_id: string }) => row.job_id));
      overdueRows = overdueRows.filter((row) => !later.has(row.id));
    }
  }

  const retryCounts = new Map<string, { tenant: string; count: number }>();
  for (const row of must(bounced, "deliveries") as {
    job_id: string; tenant_id: string; status: string; error: string | null;
    opened_at: string | null; clicked_at: string | null; complained_at: string | null;
  }[]) {
    if (!canRetryDelivery(row)) continue;
    const cur = retryCounts.get(row.job_id) ?? { tenant: tenants.get(row.tenant_id) ?? row.tenant_id, count: 0 };
    cur.count += 1;
    retryCounts.set(row.job_id, cur);
  }

  return {
    failed: [
      ...(must(failedEmail, "failed email") as JobRow[]).map((r) => toRef(r, "email", tenants)),
      ...(failedSms.error ? [] : (failedSms.data as JobRow[])).map((r) => toRef(r, "sms", tenants)),
    ],
    stuck: [
      ...(must(stuckEmail, "stuck email") as JobRow[]).map((r) => toRef(r, "email", tenants)),
      ...(stuckSms.error ? [] : (stuckSms.data as JobRow[])).map((r) => toRef(r, "sms", tenants)),
    ],
    overdue: [
      ...overdueRows.map((r) => toRef(r, "email", tenants)),
      ...(overdueSms.error ? [] : (overdueSms.data as JobRow[])).map((r) => toRef(r, "sms", tenants)),
    ],
    retryable: [...retryCounts].map(([jobId, v]) => ({ jobId, ...v })),
    lastCronRun: (meta.data as { value: string } | null)?.value ?? null,
  };
}
