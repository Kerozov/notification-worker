import {
  asEmailJob,
  asTenant,
  EmailJob,
  getSupabaseAdmin,
  Tenant,
} from "@/lib/db/supabase";
import { sendEmailBatch } from "@/lib/email/send";
import {
  getSendableRecipients,
  insertPendingDeliveries,
  markDeliveriesCanceled,
  recordDeliveryResults,
  recordInvalidRecipients,
  summarizeDeliveries,
  getDeliveriesForJob,
} from "@/lib/deliveries/store";
import { resolveDisplayStatus } from "@/lib/deliveries/stats";
import { getJobById } from "@/lib/jobs/query";
import {
  campaignInputFromJob,
  cancelEmailJob,
  createMissingChildren,
  emailJobNeedsDispatch,
  insertCampaignWithChildren,
  isCampaignJob,
  isMissingCampaignColumns,
  listChildJobs,
  refreshCampaignParent,
  removeRecipientsFromJob,
  resolveSendContent,
} from "@/lib/jobs/campaign";
import {
  normalizeRecipients,
  parseJobMerge,
  SEND_CHUNK_SIZE,
  type EmailAttachment,
  type JobMerge,
} from "@/lib/validation/email-job";
import { cacheTenant, getCachedTenantById } from "@/lib/tenants/cache";

export type ProcessJobResult = {
  jobId: string;
  status: EmailJob["status"] | "partial";
  sent: number;
  failed: number;
  errors?: string[];
};

export type CreateJobInput = {
  tenantId: string;
  subject: string;
  html: string;
  recipients: string[];
  from?: string | null;
  replyTo?: string | null;
  sendAt: Date;
  idempotencyKey?: string | null;
  attachments?: EmailAttachment[];
  merge?: JobMerge;
};

export async function findExistingJobByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_jobs")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}

export type CreateJobResult = {
  job: EmailJob;
  invalid: string[];
  children: EmailJob[];
};

function formatInvalidError(invalid: string[]): string {
  const preview = invalid.slice(0, 5).join(", ");
  const suffix =
    invalid.length > 5 ? ` (+${invalid.length - 5} more)` : "";

  return `Invalid addresses (not sent): ${preview}${suffix}`;
}

async function attachInvalidRecipients(
  job: EmailJob,
  invalid: string[],
): Promise<EmailJob> {
  if (invalid.length === 0) {
    return job;
  }

  await recordInvalidRecipients(job.id, job.tenant_id, invalid);

  const supabase = getSupabaseAdmin();
  const error = formatInvalidError(invalid);

  const { data, error: updateError } = await supabase
    .from("email_jobs")
    .update({
      failed_count: invalid.length,
      error,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .select("*")
    .single();

  if (updateError) {
    throw new Error(updateError.message);
  }

  return asEmailJob(data);
}

function isMissingMergeColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    (error.code === "PGRST204" || error.code === "42703") &&
    message.includes("merge")
  );
}

function jobMergeForRecipients(
  raw: JobMerge | undefined,
  valid: string[],
): JobMerge {
  return parseJobMerge(raw ?? {}, new Set(valid));
}

async function syncJobDeliveries(
  job: EmailJob,
  valid: string[],
  previousRecipients: string[] = [],
): Promise<void> {
  try {
    const previous = new Set(
      previousRecipients.map((value) => value.trim().toLowerCase()),
    );
    const added =
      previous.size === 0
        ? valid
        : valid.filter((email) => !previous.has(email));
    const removed = [...previous].filter((email) => !valid.includes(email));

    if (added.length > 0) {
      await insertPendingDeliveries(job.id, job.tenant_id, added);
    }
    if (removed.length > 0) {
      await markDeliveriesCanceled(job.id, removed);
    }
  } catch (error) {
    console.error("syncJobDeliveries:", error);
  }
}

export async function createEmailJob(
  input: CreateJobInput,
): Promise<CreateJobResult> {
  const { valid, invalid } = normalizeRecipients(input.recipients);
  const merge = jobMergeForRecipients(input.merge, valid);
  const supabase = getSupabaseAdmin();

  if (valid.length === 0) {
    const error = formatInvalidError(invalid);

    const { data, error: insertError } = await supabase
      .from("email_jobs")
      .insert({
        tenant_id: input.tenantId,
        idempotency_key: input.idempotencyKey ?? null,
        status: "failed",
        send_at: input.sendAt.toISOString(),
        subject: input.subject,
        html: input.html,
        recipients: invalid,
        from_email: input.from ?? null,
        reply_to: input.replyTo ?? null,
        attachments: input.attachments ?? [],
        merge: {},
        sent_count: 0,
        failed_count: invalid.length,
        error,
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (insertError && isMissingMergeColumn(insertError)) {
      const retry = await supabase
        .from("email_jobs")
        .insert({
          tenant_id: input.tenantId,
          idempotency_key: input.idempotencyKey ?? null,
          status: "failed",
          send_at: input.sendAt.toISOString(),
          subject: input.subject,
          html: input.html,
          recipients: invalid,
          from_email: input.from ?? null,
          reply_to: input.replyTo ?? null,
          attachments: input.attachments ?? [],
          sent_count: 0,
          failed_count: invalid.length,
          error,
          updated_at: new Date().toISOString(),
        })
        .select("*")
        .single();
      if (retry.error) {
        throw new Error(retry.error.message);
      }
      const job = asEmailJob(retry.data);
      try {
        await recordInvalidRecipients(job.id, job.tenant_id, invalid);
      } catch {
        // ignore
      }
      return { job, invalid, children: [] };
    }

    if (insertError) {
      throw new Error(insertError.message);
    }

    const job = asEmailJob(data);

    try {
      await recordInvalidRecipients(job.id, job.tenant_id, invalid);
    } catch {
      // Deliveries table may be missing; job row still shows failed + invalid list.
    }

    return { job, invalid, children: [] };
  }

  const campaignInput = {
    tenantId: input.tenantId,
    subject: input.subject,
    html: input.html,
    valid,
    merge,
    from: input.from,
    replyTo: input.replyTo,
    sendAt: input.sendAt,
    idempotencyKey: input.idempotencyKey,
    attachments: input.attachments,
  };

  if (valid.length > SEND_CHUNK_SIZE) {
    if (input.idempotencyKey) {
      const existing = await findExistingJobByIdempotencyKey(
        input.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        if (isCampaignJob(existing)) {
          const children = emailJobNeedsDispatch(existing.status)
            ? await createMissingChildren(
                existing,
                campaignInput,
                syncJobDeliveries,
              )
            : await listChildJobs(existing.id);
          return { job: existing, invalid: [], children };
        }
        if (existing.status !== "pending" || valid.length > SEND_CHUNK_SIZE) {
          return { job: existing, invalid: [], children: [] };
        }
      }
    }

    const { parent, children, reused } = await insertCampaignWithChildren(
      campaignInput,
      syncJobDeliveries,
    );
    return {
      job: reused ? parent : await attachInvalidRecipients(parent, invalid),
      invalid: reused ? [] : invalid,
      children,
    };
  }

  let { data, error } = await supabase
    .from("email_jobs")
    .insert({
      tenant_id: input.tenantId,
      idempotency_key: input.idempotencyKey ?? null,
      status: "pending",
      send_at: input.sendAt.toISOString(),
      subject: input.subject,
      html: input.html,
      recipients: valid,
      from_email: input.from ?? null,
      reply_to: input.replyTo ?? null,
      attachments: input.attachments ?? [],
      merge,
      kind: "send",
      parent_id: null,
    })
    .select("*")
    .single();

  if (error && isMissingMergeColumn(error)) {
    ({ data, error } = await supabase
      .from("email_jobs")
      .insert({
        tenant_id: input.tenantId,
        idempotency_key: input.idempotencyKey ?? null,
        status: "pending",
        send_at: input.sendAt.toISOString(),
        subject: input.subject,
        html: input.html,
        recipients: valid,
        from_email: input.from ?? null,
        reply_to: input.replyTo ?? null,
        attachments: input.attachments ?? [],
        kind: "send",
        parent_id: null,
      })
      .select("*")
      .single());
  }

  if (error && isMissingCampaignColumns(error)) {
    ({ data, error } = await supabase
      .from("email_jobs")
      .insert({
        tenant_id: input.tenantId,
        idempotency_key: input.idempotencyKey ?? null,
        status: "pending",
        send_at: input.sendAt.toISOString(),
        subject: input.subject,
        html: input.html,
        recipients: valid,
        from_email: input.from ?? null,
        reply_to: input.replyTo ?? null,
        attachments: input.attachments ?? [],
        merge,
      })
      .select("*")
      .single());
  }

  if (error) {
    if (error.code === "23505" && input.idempotencyKey) {
      const existing = await findExistingJobByIdempotencyKey(
        input.tenantId,
        input.idempotencyKey,
      );

      if (existing) {
        if (isCampaignJob(existing)) {
          const children = emailJobNeedsDispatch(existing.status)
            ? await createMissingChildren(
                existing,
                campaignInput,
                syncJobDeliveries,
              )
            : await listChildJobs(existing.id);
          return { job: existing, invalid: [], children };
        }
        if (existing.status !== "pending") {
          return { job: existing, invalid: [], children: [] };
        }

        let { data: updated, error: updateError } = await supabase
          .from("email_jobs")
          .update({
            subject: input.subject,
            html: input.html,
            recipients: valid,
            from_email: input.from ?? null,
            reply_to: input.replyTo ?? null,
            attachments: input.attachments ?? [],
            merge,
            send_at: input.sendAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .eq("status", "pending")
          .select("*")
          .maybeSingle();

        if (updateError && isMissingMergeColumn(updateError)) {
          ({ data: updated, error: updateError } = await supabase
            .from("email_jobs")
            .update({
              subject: input.subject,
              html: input.html,
              recipients: valid,
              from_email: input.from ?? null,
              reply_to: input.replyTo ?? null,
              attachments: input.attachments ?? [],
              send_at: input.sendAt.toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id)
            .eq("status", "pending")
            .select("*")
            .maybeSingle());
        }

        if (updateError) {
          throw new Error(updateError.message);
        }

        const job = updated ? asEmailJob(updated) : existing;
        await syncJobDeliveries(job, valid, existing.recipients);
        return {
          job: await attachInvalidRecipients(job, invalid),
          invalid,
          children: [],
        };
      }
    }

    throw new Error(error.message);
  }

  const job = await attachInvalidRecipients(asEmailJob(data), invalid);
  await syncJobDeliveries(job, valid);
  return { job, invalid, children: [] };
}

export async function claimJob(jobId: string): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();

  let { data, error } = await supabase
    .from("email_jobs")
    .update({
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "pending")
    .eq("kind", "send")
    .select("*")
    .maybeSingle();

  if (error && isMissingCampaignColumns(error)) {
    ({ data, error } = await supabase
      .from("email_jobs")
      .update({
        status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("status", "pending")
      .select("*")
      .maybeSingle());
  }

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}

async function getTenantById(tenantId: string): Promise<Tenant | null> {
  const cached = getCachedTenantById(tenantId);
  if (cached) {
    return cached;
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  const tenant = asTenant(data);
  cacheTenant(tenant);
  return tenant;
}

export async function processClaimedJob(
  job: EmailJob,
): Promise<ProcessJobResult> {
  if (isCampaignJob(job)) {
    return {
      jobId: job.id,
      status: job.status,
      sent: job.sent_count,
      failed: job.failed_count,
    };
  }

  const supabase = getSupabaseAdmin();
  const tenant = await getTenantById(job.tenant_id);
  const sendContent = await resolveSendContent(job);

  async function touchParent(): Promise<void> {
    if (!job.parent_id) return;
    try {
      const parent = await getJobById(job.parent_id);
      if (
        parent &&
        isCampaignJob(parent) &&
        emailJobNeedsDispatch(parent.status)
      ) {
        const before = await listChildJobs(parent.id);
        const beforeIds = new Set(before.map((child) => child.id));
        const children = await createMissingChildren(
          parent,
          campaignInputFromJob(parent),
          syncJobDeliveries,
        );
        const created = children.filter(
          (child) => !beforeIds.has(child.id) && child.status === "pending",
        );
        if (created.length > 0) {
          const { dispatchCreatedEmailJobs } = await import(
            "@/lib/trigger/schedule"
          );
          await dispatchCreatedEmailJobs(parent, created);
        }
      }
      await refreshCampaignParent(job.parent_id);
    } catch (error) {
      console.error("refreshCampaignParent:", error);
    }
  }

  async function failClaimed(errorMessage: string): Promise<ProcessJobResult> {
    await supabase
      .from("email_jobs")
      .update({
        status: "failed",
        error: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    await touchParent();
    return {
      jobId: job.id,
      status: "failed",
      sent: 0,
      failed: job.recipients.length,
      errors: [errorMessage],
    };
  }

  if (!tenant) {
    return failClaimed("Tenant not found");
  }

  const replyTo = job.reply_to || tenant.default_reply_to;
  const from = job.from_email || tenant.default_from;

  if (!from) {
    return failClaimed(
      "From address is missing. Pass `from` in the request or set tenant default_from.",
    );
  }

  if (!sendContent.html.trim()) {
    return failClaimed("Email HTML is missing");
  }

  try {
    const recipients = await getSendableRecipients(
      job.id,
      job.tenant_id,
      job.recipients,
    );

    if (recipients.length === 0) {
      const deliveries = await getDeliveriesForJob(job.id, job.tenant_id);
      const summary = summarizeDeliveries(deliveries);
      const dbStatus = summary.sent === 0 ? "failed" : "sent";
      await supabase
        .from("email_jobs")
        .update({
          status: dbStatus,
          sent_count: summary.sent,
          failed_count: summary.failed + summary.bounced + summary.invalid,
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      await touchParent();
      return {
        jobId: job.id,
        status: summary.sent === 0 ? "failed" : summary.failed > 0 ? "partial" : "sent",
        sent: summary.sent,
        failed: summary.failed + summary.bounced + summary.invalid,
      };
    }

    const result = await sendEmailBatch({
      from,
      subject: sendContent.subject,
      html: sendContent.html,
      recipients,
      replyTo,
      clientReference: job.id,
      attachments: sendContent.attachments,
      merge: job.merge,
      onChunk: async (chunkDeliveries) => {
        await recordDeliveryResults(job.id, job.tenant_id, chunkDeliveries);
        await supabase
          .from("email_jobs")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", job.id);
      },
    });

    const deliveries = await getDeliveriesForJob(job.id, job.tenant_id);
    const summary = summarizeDeliveries(deliveries);
    const remaining = deliveries.filter((row) => row.status === "pending").length;
    const priorInvalid =
      job.failed_count > 0 && job.error?.includes("Invalid addresses")
        ? job.failed_count
        : summary.invalid;
    const sendFailed = summary.failed + summary.bounced;
    const totalFailed = Math.max(priorInvalid, summary.invalid) + sendFailed;
    const dbStatus =
      remaining > 0 ? "processing" : summary.sent === 0 ? "failed" : "sent";
    const status =
      remaining > 0
        ? "processing"
        : summary.sent === 0
          ? "failed"
          : totalFailed > 0
            ? "partial"
            : "sent";
    const sendErrors =
      result.errors.length > 0 ? result.errors.join("; ") : null;
    const invalidNote =
      priorInvalid > 0 && job.error?.includes("Invalid addresses")
        ? job.error
        : null;
    const errorMessage = [invalidNote, sendErrors].filter(Boolean).join(" | ") || null;

    await supabase
      .from("email_jobs")
      .update({
        status: dbStatus,
        sent_count: summary.sent,
        failed_count: totalFailed,
        error: errorMessage,
        sent_at: remaining > 0 ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    await touchParent();
    return {
      jobId: job.id,
      status,
      sent: summary.sent,
      failed: totalFailed,
      ...(errorMessage ? { errors: [errorMessage] } : {}),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown send error";

    let deliveries: Awaited<ReturnType<typeof getDeliveriesForJob>> = [];
    try {
      deliveries = await getDeliveriesForJob(job.id, job.tenant_id);
    } catch (readError) {
      console.error("getDeliveriesForJob after send error:", readError);
      deliveries = [];
    }
    const summary = summarizeDeliveries(deliveries);
    const remaining = deliveries.filter((row) => row.status === "pending").length;
    const sendFailed = summary.failed + summary.bounced;
    const totalFailed = summary.invalid + sendFailed;
    const dbStatus =
      remaining > 0 ? "pending" : summary.sent === 0 ? "failed" : "sent";

    await supabase
      .from("email_jobs")
      .update({
        status: dbStatus,
        sent_count: summary.sent,
        failed_count: totalFailed,
        error: message,
        sent_at: remaining > 0 ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    await touchParent();
    return {
      jobId: job.id,
      status:
        remaining > 0
          ? "processing"
          : summary.sent === 0
            ? "failed"
            : totalFailed > 0
              ? "partial"
              : "sent",
      sent: summary.sent,
      failed: remaining > 0 ? remaining + totalFailed : totalFailed,
      errors: [message],
    };
  }
}

export const STALE_PROCESSING_MS = 3 * 60 * 1000;

export function isStaleProcessing(
  updatedAt: string,
  now = Date.now(),
  staleMs = STALE_PROCESSING_MS,
): boolean {
  const at = new Date(updatedAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at >= staleMs;
}

async function releaseStaleProcessingJob(jobId: string): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_jobs")
    .update({
      status: "pending",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "processing")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}

export async function processJobById(
  jobId: string,
): Promise<ProcessJobResult | null> {
  const claimed = await claimJob(jobId);

  if (claimed) {
    return processClaimedJob(claimed);
  }

  const existing = await getJobById(jobId);
  if (!existing || existing.status !== "processing") {
    return null;
  }

  if (!isStaleProcessing(existing.updated_at)) {
    return {
      jobId: existing.id,
      status: "processing",
      sent: existing.sent_count,
      failed: existing.failed_count,
    };
  }

  const released = await releaseStaleProcessingJob(existing.id);
  if (!released) {
    const latest = await getJobById(jobId);
    if (!latest) return null;
    return {
      jobId: latest.id,
      status: latest.status,
      sent: latest.sent_count,
      failed: latest.failed_count,
    };
  }

  const claimedAgain = await claimJob(jobId);
  if (!claimedAgain) {
    return {
      jobId: released.id,
      status: "pending",
      sent: released.sent_count,
      failed: released.failed_count,
    };
  }

  return processClaimedJob(claimedAgain);
}

export async function findPendingJobs(limit = 20): Promise<EmailJob[]> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  let { data, error } = await supabase
    .from("email_jobs")
    .select("*")
    .eq("status", "pending")
    .eq("kind", "send")
    .lte("send_at", now)
    .order("send_at", { ascending: true })
    .limit(limit);

  if (error && isMissingCampaignColumns(error)) {
    ({ data, error } = await supabase
      .from("email_jobs")
      .select("*")
      .eq("status", "pending")
      .lte("send_at", now)
      .order("send_at", { ascending: true })
      .limit(limit));
  }

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(asEmailJob);
}

export async function processPendingJobs(
  limit = 20,
): Promise<{ processed: number; results: ProcessJobResult[] }> {
  const pendingJobs = await findPendingJobs(limit);
  const results: ProcessJobResult[] = [];

  for (const job of pendingJobs) {
    const result = await processJobById(job.id);

    if (result) {
      results.push(result);
    }
  }

  await recordCronRun();

  return {
    processed: results.length,
    results,
  };
}

export async function cancelPendingJob(
  tenantId: string,
  jobId: string,
): Promise<EmailJob | null> {
  return cancelEmailJob(jobId, tenantId);
}

/** Admin: cancel any tenant's pending email job by id. */
export async function cancelPendingJobById(
  jobId: string,
): Promise<EmailJob | null> {
  return cancelEmailJob(jobId);
}

/**
 * Drop addresses from a pending campaign job without cancelling the rest.
 * If nobody remains, the job is cancelled.
 */
export async function removeRecipientsFromPendingJob(
  tenantId: string,
  jobId: string,
  emails: string[],
): Promise<EmailJob | null> {
  return removeRecipientsFromJob(tenantId, jobId, emails);
}

const CANCEL_CHUNK = 80;

async function loadJobsByColumn(
  tenantId: string,
  column: "id" | "idempotency_key",
  values: string[],
): Promise<EmailJob[]> {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const found: EmailJob[] = [];

  for (let i = 0; i < unique.length; i += CANCEL_CHUNK) {
    const chunk = unique.slice(i, i + CANCEL_CHUNK);
    const { data, error } = await supabase
      .from("email_jobs")
      .select("*")
      .eq("tenant_id", tenantId)
      .in(column, chunk);

    if (error) {
      throw new Error(error.message);
    }

    for (const row of data ?? []) {
      found.push(asEmailJob(row));
    }
  }

  return found;
}

/** Cancel many jobs in one request (signup / unsubscribe / campaign stop). */
export async function cancelPendingJobs(
  tenantId: string,
  input: { jobIds?: string[]; idempotencyKeys?: string[] },
): Promise<EmailJob[]> {
  const loaded = [
    ...(await loadJobsByColumn(tenantId, "id", input.jobIds ?? [])),
    ...(await loadJobsByColumn(
      tenantId,
      "idempotency_key",
      input.idempotencyKeys ?? [],
    )),
  ];

  const unique: EmailJob[] = [];
  const seenLoad = new Set<string>();
  for (const job of loaded) {
    if (seenLoad.has(job.id)) continue;
    seenLoad.add(job.id);
    unique.push(job);
  }
  unique.sort(
    (a, b) => Number(isCampaignJob(b)) - Number(isCampaignJob(a)),
  );

  const canceled: EmailJob[] = [];
  const seen = new Set<string>();

  for (const job of unique) {
    const result = await cancelEmailJob(job.id, tenantId);
    if (!result) continue;
    if (!seen.has(result.id)) {
      seen.add(result.id);
      canceled.push(result);
    }
    if (!isCampaignJob(job) && !isCampaignJob(result)) continue;
    const children = await listChildJobs(job.id);
    for (const child of children) {
      if (child.status !== "canceled" || seen.has(child.id)) continue;
      seen.add(child.id);
      canceled.push(child);
    }
  }

  return canceled;
}

export async function recordCronRun(): Promise<void> {
  const supabase = getSupabaseAdmin();

  await supabase.from("worker_meta").upsert({
    key: "last_cron_run_at",
    value: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

export function toJobResponse(
  job: EmailJob,
  invalid: string[] = [],
  children: EmailJob[] = [],
) {
  const stats =
    invalid.length > 0 && job.sent_count === 0
      ? {
          sent: 0,
          invalid: invalid.length,
          failed: 0,
          bounced: 0,
          delivered: 0,
          opened: 0,
          clicked: 0,
          complained: 0,
          notOpened: 0,
          total: invalid.length,
        }
      : undefined;

  return {
    jobId: job.id,
    status: resolveDisplayStatus(job, stats),
    sent: job.sent_count,
    failed: job.failed_count,
    invalid: invalid.length,
    recipientCount: job.recipients.length,
    recipients: job.recipients,
    kind: job.kind,
    ...(job.parent_id ? { parentId: job.parent_id } : {}),
    ...(children.length > 0
      ? {
          jobs: children.map((child) => ({
            jobId: child.id,
            status: child.status,
            sent: child.sent_count,
            failed: child.failed_count,
            recipientCount: child.recipients.length,
          })),
        }
      : {}),
    ...(invalid.length > 0 ? { invalidEmails: invalid } : {}),
    ...(job.error ? { errors: [job.error] } : {}),
  };
}

export function resolveJobFrom(
  from: string | undefined | null,
  tenant: Tenant,
): string | null {
  return from ?? tenant.default_from ?? null;
}
