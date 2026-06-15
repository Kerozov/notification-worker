import { getSupabaseAdmin, asSmsJob, SmsJob, Tenant } from "@/lib/db/supabase";
import { sendSmsBatch } from "@/lib/sms/send";
import {
  recordInvalidSmsRecipients,
  recordSmsDeliveryResults,
} from "@/lib/sms/deliveries/store";
import { normalizePhoneNumbers } from "@/lib/validation/sms-job";

export type ProcessSmsJobResult = {
  jobId: string;
  status: SmsJob["status"] | "partial";
  sent: number;
  failed: number;
  errors?: string[];
};

export type CreateSmsJobInput = {
  tenantId: string;
  body: string;
  recipients: string[];
  sender?: string | null;
  shortenLinks?: boolean;
  campaign?: string | null;
  sendAt: Date;
  idempotencyKey?: string | null;
};

export type CreateSmsJobResult = {
  job: SmsJob;
  invalid: string[];
};

function formatInvalidError(invalid: string[]): string {
  const preview = invalid.slice(0, 5).join(", ");
  const suffix =
    invalid.length > 5 ? ` (+${invalid.length - 5} more)` : "";

  return `Invalid phone numbers (not sent): ${preview}${suffix}`;
}

async function attachInvalidRecipients(
  job: SmsJob,
  invalid: string[],
): Promise<SmsJob> {
  if (invalid.length === 0) {
    return job;
  }

  await recordInvalidSmsRecipients(job.id, job.tenant_id, invalid);

  const supabase = getSupabaseAdmin();
  const error = formatInvalidError(invalid);

  const { data, error: updateError } = await supabase
    .from("sms_jobs")
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

  return asSmsJob(data);
}

export async function findExistingSmsJobByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<SmsJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("sms_jobs")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asSmsJob(data) : null;
}

export async function createSmsJob(
  input: CreateSmsJobInput,
): Promise<CreateSmsJobResult> {
  const { valid, invalid } = normalizePhoneNumbers(input.recipients);
  const supabase = getSupabaseAdmin();

  if (valid.length === 0) {
    const error = formatInvalidError(invalid);

    const { data, error: insertError } = await supabase
      .from("sms_jobs")
      .insert({
        tenant_id: input.tenantId,
        idempotency_key: input.idempotencyKey ?? null,
        status: "failed",
        send_at: input.sendAt.toISOString(),
        body: input.body,
        recipients: invalid,
        sender: input.sender ?? null,
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

    const job = asSmsJob(data);

    try {
      await recordInvalidSmsRecipients(job.id, job.tenant_id, invalid);
    } catch {
      // sms_deliveries table may be missing
    }

    return { job, invalid };
  }

  const { data, error } = await supabase
    .from("sms_jobs")
    .insert({
      tenant_id: input.tenantId,
      idempotency_key: input.idempotencyKey ?? null,
      status: "pending",
      send_at: input.sendAt.toISOString(),
      body: input.body,
      recipients: valid,
      sender: input.sender ?? null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505" && input.idempotencyKey) {
      const existing = await findExistingSmsJobByIdempotencyKey(
        input.tenantId,
        input.idempotencyKey,
      );

      if (existing) {
        if (existing.status !== "pending") {
          return { job: existing, invalid: [] };
        }

        const { data: updated, error: updateError } = await supabase
          .from("sms_jobs")
          .update({
            body: input.body,
            recipients: valid,
            sender: input.sender ?? null,
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

        const job = updated ? asSmsJob(updated) : existing;
        return { job: await attachInvalidRecipients(job, invalid), invalid };
      }
    }

    throw new Error(error.message);
  }

  const job = await attachInvalidRecipients(asSmsJob(data), invalid);
  return { job, invalid };
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

  return data as Tenant | null;
}

export async function claimSmsJob(jobId: string): Promise<SmsJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("sms_jobs")
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

  return data ? asSmsJob(data) : null;
}

export async function processClaimedSmsJob(
  job: SmsJob,
): Promise<ProcessSmsJobResult> {
  const supabase = getSupabaseAdmin();
  const tenant = await getTenantById(job.tenant_id);

  if (!tenant) {
    const errorMessage = "Tenant not found";

    await supabase
      .from("sms_jobs")
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

  const sender = resolveSmsSender(job.sender, tenant);
  const notifierApiKey = resolveNotifierApiKey(tenant);

  if (!notifierApiKey) {
    const errorMessage =
      "Notifier API key is not configured for this tenant. Set TENANT_*_NOTIFIER_KEY and run seed.";

    await supabase
      .from("sms_jobs")
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
    const result = await sendSmsBatch({
      apiKey: notifierApiKey,
      body: job.body,
      recipients: job.recipients,
      sender,
      shortenLinks: undefined,
      campaign: job.id,
      jobId: job.id,
    });

    await recordSmsDeliveryResults(job.id, job.tenant_id, result.deliveries);

    const priorInvalid =
      job.failed_count > 0 && job.error?.includes("Invalid phone")
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
      priorInvalid > 0 && job.error?.includes("Invalid phone")
        ? job.error
        : null;
    const errorMessage =
      [invalidNote, sendErrors].filter(Boolean).join(" | ") || null;

    await supabase
      .from("sms_jobs")
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
      error instanceof Error ? error.message : "Unknown SMS send error";

    await supabase
      .from("sms_jobs")
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

export async function processSmsJobById(
  jobId: string,
): Promise<ProcessSmsJobResult | null> {
  const claimed = await claimSmsJob(jobId);

  if (!claimed) {
    return null;
  }

  return processClaimedSmsJob(claimed);
}

export async function findPendingSmsJobs(limit = 20): Promise<SmsJob[]> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("sms_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("send_at", now)
    .order("send_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(asSmsJob);
}

export async function processPendingSmsJobs(
  limit = 20,
): Promise<{ processed: number; results: ProcessSmsJobResult[] }> {
  const pendingJobs = await findPendingSmsJobs(limit);
  const results: ProcessSmsJobResult[] = [];

  for (const job of pendingJobs) {
    const result = await processSmsJobById(job.id);

    if (result) {
      results.push(result);
    }
  }

  return {
    processed: results.length,
    results,
  };
}

export async function cancelPendingSmsJob(
  tenantId: string,
  jobId: string,
): Promise<SmsJob | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("sms_jobs")
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

  return data ? asSmsJob(data) : null;
}

export function toSmsJobResponse(job: SmsJob, invalid: string[] = []) {
  const sent = job.sent_count;
  const failed = job.failed_count;
  let status: string = job.status;

  if (job.status === "sent" && (invalid.length > 0 || failed > 0)) {
    status = sent === 0 ? "failed" : "partial";
  }

  return {
    jobId: job.id,
    status,
    sent,
    failed,
    invalid: invalid.length,
    ...(invalid.length > 0 ? { invalidPhones: invalid } : {}),
    ...(job.error ? { errors: [job.error] } : {}),
  };
}

export function resolveNotifierApiKey(tenant: Tenant): string | null {
  const raw = tenant.notifier_api_key?.trim();

  if (!raw) {
    return null;
  }

  return raw.replace(/^Bearer\s+/i, "");
}

export function resolveSmsSender(
  sender: string | undefined | null,
  tenant: Tenant,
): string | null {
  return (
    sender ??
    tenant.default_sms_sender ??
    process.env.NOTIFIER_DEFAULT_SENDER ??
    null
  );
}
