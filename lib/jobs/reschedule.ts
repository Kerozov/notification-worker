import { getSupabaseAdmin, type EmailJob, type EmailJobStatus } from "@/lib/db/supabase";
import { insertPendingDeliveries } from "@/lib/deliveries/store";
import { getJobForTenant } from "@/lib/jobs/query";
import { contentUpdateRefusal } from "@/lib/jobs/update-content";

/**
 * ## A scheduled job can move to another time until it starts sending
 *
 * An automation „на конкретна дата“ is one moment for everybody on it. When
 * the owner moves that date, the jobs already waiting for the old one must move
 * with it — otherwise the editor says 15:30 and 171 emails still go tomorrow at
 * 9:00, and nothing on either side says why.
 *
 * The time lives in two places and both move:
 *
 * - **the pending address rows** (`email_deliveries.next_attempt_at`). Moved
 *   first: the Trigger.dev run booked for the old time cannot be taken back, so
 *   when it wakes it must find nothing due. A claimed job with nothing due and
 *   a later address books its next step for that address and goes back to
 *   `pending` (`processClaimedJob` → `nextStepFor`). That is the whole trick —
 *   no run is cancelled, the old one simply has nothing to send.
 * - **the job** (`send_at`), which the drain and the admin read.
 *
 * Then one run is booked for the new time. Moved earlier, that run sends;
 * the old one finds the job sent. A time already behind us means „now“.
 *
 * Same door as the content update: only a standalone send job that is pending
 * and has sent nobody. A campaign is one broadcast; moving one pocket would
 * split it. A job that started keeps going at its own time.
 */

export type RescheduleOutcome =
  | { jobId: string; outcome: "moved"; sendAt: string }
  /** Claimed, sent, failed or cancelled — it keeps the time it had. */
  | { jobId: string; outcome: "not_pending"; status: EmailJobStatus }
  /** A campaign or one of its pockets. */
  | { jobId: string; outcome: "not_editable"; status: EmailJobStatus }
  | { jobId: string; outcome: "not_found" }
  | { jobId: string; outcome: "error"; error: string };

/** Pure: may this job move? `null` = yes, otherwise why not. */
export function rescheduleRefusal(
  jobId: string,
  job:
    | (Pick<EmailJob, "status" | "kind" | "parent_id"> & { sent_count?: number })
    | null,
): Exclude<RescheduleOutcome, { outcome: "moved" | "error" }> | null {
  if (
    job &&
    job.kind !== "campaign" &&
    !job.parent_id &&
    job.status === "pending" &&
    (job.sent_count ?? 0) === 0
  ) {
    return null;
  }
  // Same reasons, same words as the content update.
  return contentUpdateRefusal(jobId, job) as Exclude<
    RescheduleOutcome,
    { outcome: "moved" | "error" }
  >;
}

/** Pure: the run key for a moved job — one run per job per target minute. */
export function rescheduleRunKey(jobId: string, sendAt: Date): string {
  return `email-reschedule:${jobId}:${Math.floor(sendAt.getTime() / 60_000)}`;
}

async function moveDeliveries(job: EmailJob, sendAt: Date): Promise<void> {
  const supabase = getSupabaseAdmin();
  const at = sendAt.toISOString();

  // A job from before address rows existed sends its own list — give it rows,
  // or the old run sends everybody at the old time.
  const { count, error: countError } = await supabase
    .from("email_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) === 0 && job.recipients.length > 0) {
    await insertPendingDeliveries(job.id, job.tenant_id, job.recipients);
  }

  const { error } = await supabase
    .from("email_deliveries")
    .update({ next_attempt_at: at, updated_at: new Date().toISOString() })
    .eq("job_id", job.id)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
}

async function moveJob(job: EmailJob, sendAt: Date): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  // `processing` too: the old run may be holding it right now with nothing to
  // send — it puts it back to pending for the new time itself.
  const { data, error } = await supabase
    .from("email_jobs")
    .update({ send_at: sendAt.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("tenant_id", job.tenant_id)
    .eq("sent_count", 0)
    .in("status", ["pending", "processing"])
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

async function bookRun(jobId: string, sendAt: Date): Promise<void> {
  const schedule = await import("@/lib/trigger/schedule");
  const booked = await schedule.scheduleEmailJobStep(jobId, sendAt, {
    idempotencyKey: rescheduleRunKey(jobId, sendAt),
  });
  if (booked) return;
  // No Trigger.dev: only „now“ can be honoured (the route refuses later times).
  if (schedule.isImmediateSend(sendAt)) {
    const { processJobById } = await import("@/lib/jobs/process");
    await processJobById(jobId);
  }
}

export async function reschedulePendingJob(
  tenantId: string,
  jobId: string,
  sendAt: Date,
): Promise<RescheduleOutcome> {
  try {
    const job = await getJobForTenant(tenantId, jobId);
    const refusal = rescheduleRefusal(jobId, job);
    if (refusal || !job) return refusal ?? { jobId, outcome: "not_found" };

    await moveDeliveries(job, sendAt);
    if (!(await moveJob(job, sendAt))) {
      // It started between the read and the write: it keeps its own time.
      return rescheduleRefusal(jobId, await getJobForTenant(tenantId, jobId)) ?? {
        jobId,
        outcome: "error",
        error: "Job changed while moving",
      };
    }
    await bookRun(jobId, sendAt);
    return { jobId, outcome: "moved", sendAt: sendAt.toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reschedule failed";
    console.error(`reschedulePendingJob ${jobId}:`, message);
    return { jobId, outcome: "error", error: message };
  }
}

const RESCHEDULE_CONCURRENCY = 8;

export async function reschedulePendingJobs(
  tenantId: string,
  jobIds: string[],
  sendAt: Date,
): Promise<RescheduleOutcome[]> {
  const ids = [...new Set(jobIds.map((id) => id.trim()).filter(Boolean))];
  const results = new Array<RescheduleOutcome>(ids.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(RESCHEDULE_CONCURRENCY, ids.length));

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= ids.length) return;
        results[index] = await reschedulePendingJob(tenantId, ids[index], sendAt);
      }
    }),
  );

  return results;
}
