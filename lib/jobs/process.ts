import {
  asEmailJob,
  asTenant,
  EmailJob,
  getSupabaseAdmin,
  Tenant,
} from "@/lib/db/supabase";
import { sendEmailBatch } from "@/lib/email/send";
import { recordDeliveryResults, recordInvalidRecipients } from "@/lib/deliveries/store";
import { resolveDisplayStatus } from "@/lib/deliveries/stats";
import { normalizeRecipients } from "@/lib/validation/email-job";

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

export async function createEmailJob(
  input: CreateJobInput,
): Promise<CreateJobResult> {
  const { valid, invalid } = normalizeRecipients(input.recipients);
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
        sent_count: 0,
        failed_count: invalid.length,
        error,
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (insertError) {
      throw new Error(insertError.message);
    }

    const job = asEmailJob(data);

    try {
      await recordInvalidRecipients(job.id, job.tenant_id, invalid);
    } catch {
      // Deliveries table may be missing; job row still shows failed + invalid list.
    }

    return { job, invalid };
  }

  const { data, error } = await supabase
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
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505" && input.idempotencyKey) {
      const existing = await findExistingJobByIdempotencyKey(
        input.tenantId,
        input.idempotencyKey,
      );

      if (existing) {
        if (existing.status !== "pending") {
          return { job: existing, invalid: [] };
        }

        const { data: updated, error: updateError } = await supabase
          .from("email_jobs")
          .update({
            subject: input.subject,
            html: input.html,
            recipients: valid,
            from_email: input.from ?? null,
            reply_to: input.replyTo ?? null,
            send_at: input.sendAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .eq("status", "pending")
          .select("*")
          .maybeSingle();

        if (updateError) {
          throw new Error(updateError.message);
        }

        const job = updated ? asEmailJob(updated) : existing;
        return { job: await attachInvalidRecipients(job, invalid), invalid };
      }
    }

    throw new Error(error.message);
  }

  const job = await attachInvalidRecipients(asEmailJob(data), invalid);
  return { job, invalid };
}

export async function claimJob(jobId: string): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_jobs")
    .update({
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}

async function getTenantById(tenantId: string): Promise<Tenant | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asTenant(data) : null;
}

export async function processClaimedJob(
  job: EmailJob,
): Promise<ProcessJobResult> {
  const supabase = getSupabaseAdmin();
  const tenant = await getTenantById(job.tenant_id);

  if (!tenant) {
    const errorMessage = "Tenant not found";

    await supabase
      .from("email_jobs")
      .update({
        status: "failed",
        error: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      jobId: job.id,
      status: "failed",
      sent: 0,
      failed: job.recipients.length,
      errors: [errorMessage],
    };
  }

  const replyTo = job.reply_to || tenant.default_reply_to;
  const from = job.from_email || tenant.default_from;

  if (!from) {
    const errorMessage =
      "From address is missing. Pass `from` in the request or set tenant default_from.";

    await supabase
      .from("email_jobs")
      .update({
        status: "failed",
        error: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      jobId: job.id,
      status: "failed",
      sent: 0,
      failed: job.recipients.length,
      errors: [errorMessage],
    };
  }

  try {
    const result = await sendEmailBatch({
      from,
      subject: job.subject,
      html: job.html,
      recipients: job.recipients,
      replyTo,
      clientReference: job.id,
    });

    await recordDeliveryResults(job.id, job.tenant_id, result.deliveries);

    const priorInvalid =
      job.failed_count > 0 && job.error?.includes("Invalid addresses")
        ? job.failed_count
        : 0;
    const sendFailed = result.failed;
    const totalFailed = priorInvalid + sendFailed;
    const dbStatus = result.sent === 0 ? "failed" : "sent";
    const status =
      result.sent === 0 ? "failed" : totalFailed > 0 ? "partial" : "sent";
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
        sent_count: result.sent,
        failed_count: totalFailed,
        error: errorMessage,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      jobId: job.id,
      status,
      sent: result.sent,
      failed: totalFailed,
      ...(errorMessage ? { errors: [errorMessage] } : {}),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown send error";

    await supabase
      .from("email_jobs")
      .update({
        status: "failed",
        failed_count: job.failed_count + job.recipients.length,
        error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      jobId: job.id,
      status: "failed",
      sent: 0,
      failed: job.failed_count + job.recipients.length,
      errors: [message],
    };
  }
}

export async function processJobById(
  jobId: string,
): Promise<ProcessJobResult | null> {
  const claimed = await claimJob(jobId);

  if (!claimed) {
    return null;
  }

  return processClaimedJob(claimed);
}

export async function findPendingJobs(limit = 20): Promise<EmailJob[]> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("email_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("send_at", now)
    .order("send_at", { ascending: true })
    .limit(limit);

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

  return {
    processed: results.length,
    results,
  };
}

export async function cancelPendingJob(
  tenantId: string,
  jobId: string,
): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_jobs")
    .update({
      status: "canceled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}

/** Admin: cancel any tenant's pending email job by id. */
export async function cancelPendingJobById(
  jobId: string,
): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_jobs")
    .update({
      status: "canceled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}

export async function recordCronRun(): Promise<void> {
  const supabase = getSupabaseAdmin();

  await supabase.from("worker_meta").upsert({
    key: "last_cron_run_at",
    value: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

export function toJobResponse(job: EmailJob, invalid: string[] = []) {
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
