import { getSupabaseAdmin } from "@/lib/db/supabase";
import { canRetryDelivery } from "@/lib/deliveries/retry";
import { requeueDeliveries } from "@/lib/deliveries/store";
import {
  getDeliveriesForEmailJob,
  isCampaignJob,
  listChildJobs,
  refreshCampaignParent,
} from "@/lib/jobs/campaign";
import { getJobById } from "@/lib/jobs/query";

/**
 * A finished send job got addresses back in its queue (a temporary bounce):
 * make it claimable again. A job that is pending or processing right now
 * sees the queued rows on its own.
 */
export async function reopenSendJob(jobId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_jobs")
    .update({
      status: "pending",
      sent_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("kind", "send")
    .in("status", ["sent", "failed"])
    .select("id, parent_id")
    .maybeSingle();

  if (error) {
    console.error(`reopenSendJob ${jobId}:`, error.message);
    return false;
  }

  if (data?.parent_id) {
    try {
      await refreshCampaignParent(String(data.parent_id));
    } catch (refreshError) {
      console.error("reopenSendJob refreshCampaignParent:", refreshError);
    }
  }

  return Boolean(data);
}

/** Webhook side: the address is queued again, come back when it is due. */
export async function scheduleRetry(jobId: string, at: Date): Promise<void> {
  await reopenSendJob(jobId);
  const { scheduleEmailJobStep } = await import("@/lib/trigger/schedule");
  await scheduleEmailJobStep(jobId, at);
}

export type ManualRetryResult = {
  queued: number;
  jobs: number;
};

/**
 * Admin "Retry temporary bounces": every bounced or failed address of this
 * job (or campaign) whose error was temporary goes back in the same job's
 * queue and out again, paced per domain. Typos and dead mailboxes stay out.
 */
export async function retryTemporaryFailures(
  jobId: string,
): Promise<ManualRetryResult> {
  const job = await getJobById(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const deliveries = await getDeliveriesForEmailJob(job);
  const byJob = new Map<string, typeof deliveries>();
  for (const row of deliveries) {
    if (!canRetryDelivery(row)) continue;
    const list = byJob.get(row.job_id) ?? [];
    list.push(row);
    byJob.set(row.job_id, list);
  }

  if (byJob.size === 0) {
    return { queued: 0, jobs: 0 };
  }

  const reopened: string[] = [];
  let queued = 0;

  for (const [sendJobId, rows] of byJob) {
    const at = await requeueDeliveries(sendJobId, rows, {
      kind: "bounce",
      manual: true,
    });
    if (!at) {
      throw new Error(
        "Could not queue the addresses again — is migration 016_delivery_retries applied?",
      );
    }
    queued += rows.length;
    await reopenSendJob(sendJobId);
    reopened.push(sendJobId);
  }

  const schedule = await import("@/lib/trigger/schedule");
  const ordered = isCampaignJob(job)
    ? (await listChildJobs(job.id))
        .map((child) => child.id)
        .filter((id) => reopened.includes(id))
    : reopened;

  if (schedule.isPacingEnabled()) {
    // Every reopened pocket gets its own run; the per-domain quota keeps them
    // from flooding a provider together. (Not the pocket chain: a pocket
    // starts the chain only once, on its first pass.)
    const stamp = Date.now();
    for (const id of ordered) {
      const started = await schedule.scheduleEmailJobStep(id, new Date(), {
        idempotencyKey: `email-retry:${id}:${stamp}`,
      });
      if (!started) {
        throw new Error("Queued, but Trigger.dev did not accept the run");
      }
    }
  } else {
    const { processJobById } = await import("@/lib/jobs/process");
    for (const id of ordered) {
      await processJobById(id);
    }
  }

  if (isCampaignJob(job)) {
    await refreshCampaignParent(job.id);
  }

  return { queued, jobs: reopened.length };
}
