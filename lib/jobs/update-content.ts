import { getSupabaseAdmin, type EmailJob, type EmailJobStatus } from "@/lib/db/supabase";
import { getJobForTenant } from "@/lib/jobs/query";
import { isMissingCampaignColumns } from "@/lib/jobs/campaign";

/**
 * ## Content of a scheduled job can change until the moment it is claimed
 *
 * A scheduled job already stores its own subject and HTML and reads them only
 * when Trigger.dev fires it (`processClaimedJob` → `resolveSendContent`). So an
 * owner who fixes a typo in an automation does not need the job cancelled and
 * re-created — which would also need a new Trigger.dev run and a new id on the
 * caller's side. Rewriting the two columns is enough.
 *
 * The update is guarded by `status = 'pending'` in the same statement: the
 * claim flips the row to `processing` atomically, so a job either takes the new
 * text or has already started with the old one. There is no third state, and
 * nothing in the sending path is touched.
 *
 * Only standalone send jobs. A campaign parent's HTML is read by every pocket
 * at its own send time — rewriting it mid-campaign would split one broadcast
 * into two texts — and a pocket has no HTML of its own.
 */

export type ContentUpdate = {
  jobId: string;
  subject: string;
  html: string;
};

export type ContentUpdateOutcome =
  | { jobId: string; outcome: "updated" }
  /** Claimed, sent, failed or cancelled — the old text is what it had. */
  | { jobId: string; outcome: "not_pending"; status: EmailJobStatus }
  /** A campaign or one of its pockets. */
  | { jobId: string; outcome: "not_editable"; status: EmailJobStatus }
  | { jobId: string; outcome: "not_found" }
  /** The database refused this one row; the rest of the batch still ran. */
  | { jobId: string; outcome: "error"; error: string };

/**
 * Why a job the guarded update did not touch was left alone. Pure — the route
 * reads the row, this decides what to say about it.
 *
 * A standalone row that reads back as `pending` was claimed between the update
 * and the read, then released as stale — „not pending“ is still the honest
 * answer for this call, and the caller may simply try again.
 */
export function contentUpdateRefusal(
  jobId: string,
  job: Pick<EmailJob, "status" | "kind" | "parent_id"> | null,
): ContentUpdateOutcome {
  if (!job) return { jobId, outcome: "not_found" };
  if (job.kind === "campaign" || job.parent_id) {
    return { jobId, outcome: "not_editable", status: job.status };
  }
  return { jobId, outcome: "not_pending", status: job.status };
}

async function guardedUpdate(
  tenantId: string,
  update: ContentUpdate,
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const patch = {
    subject: update.subject,
    html: update.html,
    updated_at: new Date().toISOString(),
  };

  let { data, error } = await supabase
    .from("email_jobs")
    .update(patch)
    .eq("id", update.jobId)
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .eq("kind", "send")
    .is("parent_id", null)
    .select("id")
    .maybeSingle();

  if (error && isMissingCampaignColumns(error)) {
    ({ data, error } = await supabase
      .from("email_jobs")
      .update(patch)
      .eq("id", update.jobId)
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle());
  }

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

export async function updatePendingJobContent(
  tenantId: string,
  update: ContentUpdate,
): Promise<ContentUpdateOutcome> {
  try {
    if (await guardedUpdate(tenantId, update)) {
      return { jobId: update.jobId, outcome: "updated" };
    }
    return contentUpdateRefusal(
      update.jobId,
      await getJobForTenant(tenantId, update.jobId),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    console.error(`updatePendingJobContent ${update.jobId}:`, message);
    return { jobId: update.jobId, outcome: "error", error: message };
  }
}

const UPDATE_CONCURRENCY = 8;

export async function updatePendingJobsContent(
  tenantId: string,
  updates: ContentUpdate[],
): Promise<ContentUpdateOutcome[]> {
  const results = new Array<ContentUpdateOutcome>(updates.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(UPDATE_CONCURRENCY, updates.length));

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= updates.length) return;
        results[index] = await updatePendingJobContent(tenantId, updates[index]);
      }
    }),
  );

  return results;
}
