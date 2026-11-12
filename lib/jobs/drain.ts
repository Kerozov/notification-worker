import { getSupabaseAdmin, type EmailJob } from "@/lib/db/supabase";
import { DEAD_STEP_MS, isMissingCampaignColumns } from "@/lib/jobs/campaign";

/**
 * The drain picks up send jobs whose own Trigger.dev run never came back: a
 * trigger call that failed, a step cut off by the Vercel timeout, a retry that
 * arrived too early. It runs every few minutes from a Trigger.dev schedule
 * (`drain-email-safety-net`) and on demand from the ops API.
 */

/** The automatic drain only touches jobs active this recently; older ones wait for the owner. */
export const SAFETY_NET_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A pending job counts as dropped only when its work has been due this long
 * with nobody touching it. A live chain touches its job every minute, and a
 * planned run normally arrives within seconds of its time.
 */
export const DRAIN_GRACE_MS = 5 * 60_000;

/** A "processing" job this long untouched has no live step (see DEAD_STEP_MS). */
export const DRAIN_STALE_PROCESSING_MS = DEAD_STEP_MS;

export type DrainJob = Pick<
  EmailJob,
  | "id"
  | "status"
  | "parent_id"
  | "sent_count"
  | "failed_count"
  | "send_at"
  | "updated_at"
>;

/**
 * Queue of a pending job, from its earliest pending address:
 * - `overdue`: due for longer than the grace period (or no address rows at all),
 * - `due-soon`: just became due, its planned run is on the way,
 * - `waiting`: the next address is due later (a planned retry),
 * - `empty`: no pending addresses; claiming it only closes the job.
 */
export type QueueState = "overdue" | "due-soon" | "waiting" | "empty";

const time = (value: string | null | undefined): number => {
  const at = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(at) ? 0 : at;
};

/** Pure: the queue state of one job from its earliest pending row. */
export function queueStateFor(
  earliest: { next_attempt_at: string | null } | null,
  hasRows: boolean,
  now: number,
  graceMs = DRAIN_GRACE_MS,
): QueueState {
  if (!earliest) return hasRows ? "empty" : "overdue";
  if (!earliest.next_attempt_at) return "overdue";
  const at = time(earliest.next_attempt_at);
  if (at > now) return "waiting";
  return now - at >= graceMs ? "overdue" : "due-soon";
}

/** Sent or touched within the window. */
export function isRecentJob(
  job: Pick<DrainJob, "send_at" | "updated_at">,
  now: number,
  windowMs: number,
): boolean {
  const since = now - windowMs;
  return time(job.send_at) >= since || time(job.updated_at) >= since;
}

/** A pocket nobody has picked up yet (same rule as the pocket chain). */
function isUnstarted(job: DrainJob): boolean {
  return (
    job.status === "pending" && job.sent_count === 0 && job.failed_count === 0
  );
}

export type DrainPlanInput = {
  /** Pending send jobs with send_at in the past, oldest first. */
  pending: DrainJob[];
  /** Processing send jobs untouched for DRAIN_STALE_PROCESSING_MS. */
  staleProcessing: DrainJob[];
  /** Queue state per pending job id; a job missing here counts as overdue. */
  queue: Map<string, QueueState>;
  /**
   * Other pockets of the same campaigns (pending or processing), to tell
   * whether a campaign is still sending on its own.
   */
  siblings: DrainJob[];
  now: number;
  /** null: no age limit (the owner asked for this drain). */
  windowMs: number | null;
  limit: number;
  graceMs?: number;
};

/**
 * Pure: which jobs the drain should run, in order. Stuck "processing" jobs
 * first, then pending jobs whose work is overdue. Pockets of one campaign go
 * out one after another, so the drain starts at most one unstarted pocket per
 * campaign, and none while another pocket of it is still sending.
 */
export function planDrain(input: DrainPlanInput): string[] {
  const grace = input.graceMs ?? DRAIN_GRACE_MS;
  const recent = (job: DrainJob) =>
    input.windowMs === null || isRecentJob(job, input.now, input.windowMs);

  const picked: string[] = [];
  const pickedIds = new Set<string>();
  const busyParents = new Set<string>();
  const pick = (job: DrainJob) => {
    if (pickedIds.has(job.id)) return;
    pickedIds.add(job.id);
    picked.push(job.id);
    if (job.parent_id) busyParents.add(job.parent_id);
  };

  // A pocket that is sending right now (or did a minute ago) starts the next
  // one itself when it is done.
  for (const sibling of input.siblings) {
    if (!sibling.parent_id || isUnstarted(sibling)) continue;
    if (
      sibling.status === "processing" ||
      input.now - time(sibling.updated_at) < grace
    ) {
      busyParents.add(sibling.parent_id);
    }
  }

  for (const job of input.staleProcessing) {
    if (recent(job)) pick(job);
  }

  const overdue = input.pending.filter((job) => {
    if (!recent(job)) return false;
    if (input.now - time(job.send_at) < grace) return false;
    if (input.now - time(job.updated_at) < grace) return false;
    const state = input.queue.get(job.id) ?? "overdue";
    return state === "overdue" || state === "empty";
  });

  for (const job of overdue) {
    if (job.parent_id && isUnstarted(job)) continue;
    pick(job);
  }

  for (const job of overdue) {
    if (!job.parent_id || !isUnstarted(job)) continue;
    if (busyParents.has(job.parent_id)) continue;
    pick(job);
  }

  return picked.slice(0, Math.max(0, input.limit));
}

const SELECT =
  "id, status, parent_id, sent_count, failed_count, send_at, updated_at";
const QUEUE_CONCURRENCY = 8;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

function asDrainJob(row: Record<string, unknown>): DrainJob {
  return {
    id: String(row.id),
    status: row.status as DrainJob["status"],
    parent_id: (row.parent_id as string | null | undefined) ?? null,
    sent_count: Number(row.sent_count ?? 0),
    failed_count: Number(row.failed_count ?? 0),
    send_at: String(row.send_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

async function queueStateOf(jobId: string, now: number): Promise<QueueState> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_deliveries")
    .select("next_attempt_at")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .order("next_attempt_at", { ascending: true, nullsFirst: true })
    .limit(1);

  // Before migration 016 there is no next_attempt_at: let the claim decide.
  if (error) return "overdue";
  const earliest = (data ?? [])[0] as { next_attempt_at: string | null } | undefined;
  if (earliest) return queueStateFor(earliest, true, now);

  const rows = await supabase
    .from("email_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  return queueStateFor(null, (rows.count ?? 0) > 0, now);
}

/**
 * Reads what the drain should run now. Only selects; nothing changes here.
 * `windowMs` null = any age (a drain the owner asked for).
 */
export async function findDrainJobs(options: {
  limit: number;
  windowMs: number | null;
  now?: number;
}): Promise<string[]> {
  const now = options.now ?? Date.now();
  const supabase = getSupabaseAdmin();
  const nowIso = new Date(now).toISOString();
  const staleBefore = new Date(now - DRAIN_STALE_PROCESSING_MS).toISOString();
  const since =
    options.windowMs === null
      ? null
      : new Date(now - options.windowMs).toISOString();
  const recentFilter = since
    ? `send_at.gte.${since},updated_at.gte.${since}`
    : null;

  let pendingQuery = supabase
    .from("email_jobs")
    .select(SELECT)
    .eq("status", "pending")
    .eq("kind", "send")
    .lte("send_at", nowIso);
  if (recentFilter) pendingQuery = pendingQuery.or(recentFilter);

  let staleQuery = supabase
    .from("email_jobs")
    .select(SELECT)
    .eq("status", "processing")
    .eq("kind", "send")
    .lt("updated_at", staleBefore);
  if (since) staleQuery = staleQuery.gte("updated_at", since);

  const [pendingResult, staleResult] = await Promise.all([
    pendingQuery.order("send_at", { ascending: true }).limit(200),
    staleQuery.order("updated_at", { ascending: true }).limit(50),
  ]);

  if (pendingResult.error) {
    if (isMissingCampaignColumns(pendingResult.error)) return [];
    throw new Error(pendingResult.error.message);
  }
  if (staleResult.error) throw new Error(staleResult.error.message);

  const pending = (pendingResult.data ?? []).map(asDrainJob);
  const staleProcessing = (staleResult.data ?? []).map(asDrainJob);

  // Only jobs old enough to be overdue need their queue read.
  const candidates = pending.filter(
    (job) =>
      now - time(job.send_at) >= DRAIN_GRACE_MS &&
      now - time(job.updated_at) >= DRAIN_GRACE_MS,
  );
  const states = await mapLimit(candidates, QUEUE_CONCURRENCY, (job) =>
    queueStateOf(job.id, now),
  );
  const queue = new Map(candidates.map((job, i) => [job.id, states[i]]));

  const parents = [
    ...new Set(
      [...candidates, ...staleProcessing]
        .map((job) => job.parent_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  let siblings: DrainJob[] = [];
  if (parents.length > 0) {
    const { data, error } = await supabase
      .from("email_jobs")
      .select(SELECT)
      .in("parent_id", parents)
      .in("status", ["pending", "processing"])
      .limit(1000);
    if (error) throw new Error(error.message);
    siblings = (data ?? []).map(asDrainJob);
  }

  return planDrain({
    pending,
    staleProcessing,
    queue,
    siblings,
    now,
    windowMs: options.windowMs,
    limit: options.limit,
  });
}
