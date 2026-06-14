import {
  asEmailJob,
  asTenant,
  EmailJob,
  getSupabaseAdmin,
  Tenant,
} from "@/lib/db/supabase";
import { sendEmailBatch } from "@/lib/email/send";
import { normalizeRecipients } from "@/lib/validation/email-job";

export type ProcessJobResult = {
  jobId: string;
  status: EmailJob["status"];
  sent: number;
  failed: number;
  errors?: string[];
};

export type CreateJobInput = {
  tenantId: string;
  subject: string;
  html: string;
  recipients: string[];
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

export async function createEmailJob(
  input: CreateJobInput,
): Promise<EmailJob> {
  const { valid, invalid } = normalizeRecipients(input.recipients);

  if (valid.length === 0) {
    throw new Error(
      invalid.length > 0
        ? `No valid recipients. Invalid: ${invalid.join(", ")}`
        : "At least one recipient is required",
    );
  }

  const supabase = getSupabaseAdmin();

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
        return existing;
      }
    }

    throw new Error(error.message);
  }

  return asEmailJob(data);
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

  try {
    const result = await sendEmailBatch({
      subject: job.subject,
      html: job.html,
      recipients: job.recipients,
      replyTo,
    });

    const status = result.failed > 0 && result.sent === 0 ? "failed" : "sent";
    const errorMessage =
      result.errors.length > 0 ? result.errors.join("; ") : null;

    await supabase
      .from("email_jobs")
      .update({
        status,
        sent_count: result.sent,
        failed_count: result.failed,
        error: errorMessage,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      jobId: job.id,
      status,
      sent: result.sent,
      failed: result.failed,
      ...(result.errors.length > 0 ? { errors: result.errors } : {}),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown send error";

    await supabase
      .from("email_jobs")
      .update({
        status: "failed",
        failed_count: job.recipients.length,
        error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      jobId: job.id,
      status: "failed",
      sent: 0,
      failed: job.recipients.length,
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

export async function recordCronRun(): Promise<void> {
  const supabase = getSupabaseAdmin();

  await supabase.from("worker_meta").upsert({
    key: "last_cron_run_at",
    value: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

export function toJobResponse(job: EmailJob) {
  return {
    jobId: job.id,
    status: job.status,
    sent: job.sent_count,
    failed: job.failed_count,
    ...(job.error ? { errors: [job.error] } : {}),
  };
}
