import { getTenantBySlug, listTenantsForAdmin } from "@/lib/tenants/store";
import {
  fetchFilteredEmailJobs,
  fetchFilteredSmsJobs,
  parseJobListFilters,
} from "@/lib/admin/job-query";
import { getJobById } from "@/lib/jobs/query";
import { getSmsJobById } from "@/lib/jobs/query-sms";
import { getDeliveriesForEmailJob } from "@/lib/jobs/campaign";
import { cancelPendingJobById } from "@/lib/jobs/process";
import { cancelPendingSmsJobById } from "@/lib/jobs/process-sms";
import { resendJobAsNew } from "@/lib/jobs/resend";
import { splitRecipients } from "@/lib/validation/recipient-import";

export type Channel = "email" | "sms";
const MAX_LISTED = 200;

/** A job without its HTML body and full recipient list: Jarvis reads many of these at once. */
export function summarizeJob(job: Record<string, unknown>, channel: Channel) {
  const recipients = Array.isArray(job.recipients) ? job.recipients : [];
  return {
    id: job.id,
    channel,
    tenantId: job.tenant_id,
    status: job.status,
    title: channel === "email" ? job.subject : String(job.body ?? "").slice(0, 160),
    recipients: recipients.length,
    sent: job.sent_count ?? 0,
    failed: job.failed_count ?? 0,
    error: job.error ?? null,
    kind: job.kind ?? null,
    parentId: job.parent_id ?? null,
    sendAt: job.send_at ?? null,
    createdAt: job.created_at ?? null,
    sentAt: job.sent_at ?? null,
    updatedAt: job.updated_at ?? null,
  };
}

/** Every client profile, without keys (only whether an SMS key is set). */
export async function listClients() {
  const rows = await listTenantsForAdmin();
  return rows.map((t) => ({
    slug: t.slug,
    name: t.name,
    from: t.default_from,
    replyTo: t.default_reply_to,
    smsSender: t.default_sms_sender,
    smsReady: t.notifier_configured,
    canActForClients: t.can_act_for_tenants,
    createdAt: t.created_at,
  }));
}

/** Same filters as the admin job list (status, client, period, search, page). */
export async function listJobs(params: Record<string, string | undefined>) {
  const channel: Channel = params.channel === "sms" ? "sms" : "email";
  const filters = parseJobListFilters(params);
  let tenantId: string | null = null;
  if (filters.tenant !== "all") {
    const tenant = await getTenantBySlug(filters.tenant);
    if (!tenant) throw new Error("Client not found");
    tenantId = tenant.id;
  }
  const result = channel === "sms"
    ? await fetchFilteredSmsJobs<Record<string, unknown>>(filters, tenantId)
    : await fetchFilteredEmailJobs<Record<string, unknown>>(filters, tenantId);
  if (result.error) throw new Error(result.error);
  return {
    channel,
    filters,
    total: result.total,
    statusCounts: result.statusCounts,
    jobs: result.jobs.map((job) => summarizeJob(job, channel)),
  };
}

/** One job with delivery counts and the failed addresses (capped). */
export async function jobDetail(jobId: string, channel: Channel) {
  if (channel === "sms") {
    const job = await getSmsJobById(jobId);
    if (!job) return null;
    return { job: { ...summarizeJob(job as unknown as Record<string, unknown>, "sms"), body: job.body } };
  }
  const job = await getJobById(jobId);
  if (!job) return null;
  const deliveries = await getDeliveriesForEmailJob(job);
  const byStatus: Record<string, number> = {};
  for (const row of deliveries) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  const failed = deliveries
    .filter((row) => row.status === "failed" || row.status === "bounced")
    .map((row) => ({ recipient: row.recipient, status: row.status, complained: Boolean(row.complained_at) }));
  return {
    job: summarizeJob(job as unknown as Record<string, unknown>, "email"),
    deliveries: { total: deliveries.length, byStatus },
    failed: failed.slice(0, MAX_LISTED),
    failedTotal: failed.length,
  };
}

export async function cancelJob(jobId: string, channel: Channel) {
  const job = channel === "sms" ? await cancelPendingSmsJobById(jobId) : await cancelPendingJobById(jobId);
  if (!job) return null;
  return summarizeJob(job as unknown as Record<string, unknown>, channel);
}

/**
 * New job with the same content. "failed" = the failed and bounced addresses of the
 * source (never ones that complained); otherwise the given list.
 */
export async function resendJob(jobId: string, mode: "failed" | "list", list: string[] = []) {
  let recipients: string[];
  let invalid: string[] = [];
  if (mode === "failed") {
    const job = await getJobById(jobId);
    if (!job) throw new Error("Job not found");
    const deliveries = await getDeliveriesForEmailJob(job);
    recipients = [...new Set(deliveries
      .filter((row) => (row.status === "failed" || row.status === "bounced") && !row.complained_at)
      .map((row) => row.recipient))];
  } else {
    const split = splitRecipients(list);
    recipients = split.valid;
    invalid = split.invalid;
  }
  if (recipients.length === 0) return { queued: 0, invalid, newJobId: null, processed: null };
  const result = await resendJobAsNew(jobId, recipients, { sendNow: true });
  return {
    queued: recipients.length,
    invalid: [...invalid, ...result.invalid],
    newJobId: result.job.id,
    processed: result.processed,
  };
}
