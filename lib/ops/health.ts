import { getSupabaseAdmin } from "@/lib/db/supabase";
import { canRetryDelivery } from "@/lib/deliveries/retry";

/** worker_meta key the safety-net drain writes on every run. */
export const LAST_DRAIN_KEY = "last_drain_run_at";

/**
 * A job counts as stuck when it is "processing" this long without an update.
 * The safety-net drain picks such a job up after 6 min and runs every 5 min,
 * so 20 min means the drain had its chances and still could not move it.
 */
export const STUCK_MS = 20 * 60_000;
/** A pending job is overdue this long after send_at with nothing happening. */
export const OVERDUE_MS = 30 * 60_000;
/** The 5-minute safety-net drain is considered silent after this long. */
export const CRON_SILENT_MS = 20 * 60_000;
/**
 * Stuck or overdue jobs older than this are leftovers, not today's mail: the
 * automatic drain does not touch them (SAFETY_NET_WINDOW_MS). They are listed
 * apart as "stale", a warning for the owner to send or cancel, never an alarm.
 */
export const STALE_AFTER_MS = 24 * 60 * 60_000;
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
  sendAt?: string | null;
};

export type HealthSnapshot = {
  failed: JobRef[];
  stuck: JobRef[];
  overdue: JobRef[];
  /** Stuck or overdue, but untouched for over a day: leftovers for the owner. */
  stale?: JobRef[];
  retryable: { jobId: string; tenant: string; count: number }[];
  /** Last time any run (per-job or drain) touched the queue. */
  lastCronRun: string | null;
  /** Last run of the 5-minute safety-net drain; null = it never ran. */
  lastDrainRun?: string | null;
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

  const stale = snapshot.stale ?? [];
  if (stale.length) {
    problems.push({
      // Same key while the leftovers stay: Jarvis reminds about them rarely.
      key: "stale",
      level: "warn",
      text: `${stale.length} old job(s) stuck or never sent, untouched for over ${STALE_AFTER_MS / 3_600_000}h (send again or cancel)`,
      jobIds: ids(stale),
    });
  }

  const retryable = snapshot.retryable.reduce((sum, row) => sum + row.count, 0);
  if (retryable) {
    problems.push({
      // Keyed by job, not by count: the count moves as retries land, the problem does not.
      key: `retryable:${snapshot.retryable.map((row) => row.jobId).sort().join(",")}`,
      level: "warn",
      text: `${retryable} address(es) bounced for a temporary reason and can be sent again`,
      jobIds: snapshot.retryable.map((row) => row.jobId),
    });
  }

  // Only the drain's own heartbeat counts: per-job runs also touch
  // lastCronRun, and a quiet day without scheduled mail is not a problem.
  if (snapshot.lastDrainRun === null) {
    problems.push({
      key: "drain-missing",
      level: "warn",
      text: "The 5-minute safety-net drain has never run (Trigger.dev schedule not deployed?)",
      jobIds: [],
    });
  } else if (snapshot.lastDrainRun) {
    const drainAt = new Date(snapshot.lastDrainRun).getTime();
    if (!Number.isNaN(drainAt) && now - drainAt > CRON_SILENT_MS) {
      problems.push({
        key: "cron-silent",
        level: "warn",
        text: `The safety-net drain has not run since ${snapshot.lastDrainRun}`,
        jobIds: [],
      });
    }
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
  send_at?: string | null;
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
    sendAt: row.send_at ?? null,
  };
}

/** Pure: stuck/overdue jobs untouched (and not due) within the window are leftovers. */
export function splitStale(jobs: JobRef[], now: number, windowMs = STALE_AFTER_MS) {
  const since = now - windowMs;
  const at = (v: string | null | undefined) => {
    const t = v ? new Date(v).getTime() : NaN;
    return Number.isNaN(t) ? 0 : t;
  };
  const fresh: JobRef[] = [];
  const stale: JobRef[] = [];
  for (const job of jobs) {
    (at(job.updatedAt) >= since || at(job.sendAt) >= since ? fresh : stale).push(job);
  }
  return { fresh, stale };
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
  const emailCols = "id, tenant_id, subject, error, failed_count, sent_count, updated_at, send_at";
  const smsCols = "id, tenant_id, body, error, failed_count, sent_count, updated_at, send_at";

  const [tenantRows, failedEmail, failedSms, stuckEmail, stuckSms, overdueEmail, overdueSms, bounced, meta, drainMeta] =
    await Promise.all([
      supabase.from("tenants").select("id, slug"),
      supabase.from("email_jobs").select(emailCols).is("dismissed_at", null).eq("status", "failed").eq("kind", "send")
        .gte("updated_at", since).order("updated_at", { ascending: false }).limit(20),
      supabase.from("sms_jobs").select(smsCols).is("dismissed_at", null).eq("status", "failed")
        .gte("updated_at", since).order("updated_at", { ascending: false }).limit(20),
      // Send jobs only: a campaign row is "processing" while its pockets work,
      // and a stuck pocket is reported on its own.
      supabase.from("email_jobs").select(emailCols).is("dismissed_at", null).eq("status", "processing").eq("kind", "send")
        .lt("updated_at", stuckBefore).limit(20),
      supabase.from("sms_jobs").select(smsCols).is("dismissed_at", null).eq("status", "processing").lt("updated_at", stuckBefore).limit(20),
      supabase.from("email_jobs").select(emailCols).is("dismissed_at", null).eq("status", "pending").eq("kind", "send")
        .lt("send_at", overdueBefore).lt("updated_at", overdueBefore).limit(50),
      supabase.from("sms_jobs").select(smsCols).is("dismissed_at", null).eq("status", "pending")
        .lt("send_at", overdueBefore).lt("updated_at", overdueBefore).limit(20),
      supabase.from("email_deliveries")
        .select("job_id, tenant_id, status, error, opened_at, clicked_at, complained_at, email_jobs!inner(dismissed_at)").is("email_jobs.dismissed_at", null)
        .in("status", ["bounced", "failed"]).gte("updated_at", since).limit(2000),
      supabase.from("worker_meta").select("value").eq("key", "last_cron_run_at").maybeSingle(),
      supabase.from("worker_meta").select("value").eq("key", LAST_DRAIN_KEY).maybeSingle(),
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

  const stuck = splitStale([
    ...(must(stuckEmail, "stuck email") as JobRow[]).map((r) => toRef(r, "email", tenants)),
    ...(stuckSms.error ? [] : (stuckSms.data as JobRow[])).map((r) => toRef(r, "sms", tenants)),
  ], now);
  const overdue = splitStale([
    ...overdueRows.map((r) => toRef(r, "email", tenants)),
    ...(overdueSms.error ? [] : (overdueSms.data as JobRow[])).map((r) => toRef(r, "sms", tenants)),
  ], now);

  return {
    failed: [
      ...(must(failedEmail, "failed email") as JobRow[]).map((r) => toRef(r, "email", tenants)),
      ...(failedSms.error ? [] : (failedSms.data as JobRow[])).map((r) => toRef(r, "sms", tenants)),
    ],
    stuck: stuck.fresh,
    overdue: overdue.fresh,
    stale: [...stuck.stale, ...overdue.stale],
    retryable: [...retryCounts].map(([jobId, v]) => ({ jobId, ...v })),
    lastCronRun: (meta.data as { value: string } | null)?.value ?? null,
    // A read error here must not look like "never ran": leave it undefined.
    lastDrainRun: drainMeta.error
      ? undefined
      : ((drainMeta.data as { value: string } | null)?.value ?? null),
  };
}
