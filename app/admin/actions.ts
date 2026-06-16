"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { hasAdminSession } from "@/lib/auth/admin";
import { processPendingJobs, recordCronRun, cancelPendingJobById } from "@/lib/jobs/process";
import { processPendingSmsJobs, cancelPendingSmsJobById } from "@/lib/jobs/process-sms";
import { resendJobAsNew } from "@/lib/jobs/resend";
import {
  parseRecipientsFromFile,
  parseRecipientsFromText,
  splitRecipients,
} from "@/lib/validation/recipient-import";

async function requireAdmin(): Promise<void> {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }
}

function redirectResendResult(
  jobId: string,
  result: {
    job: { id: string };
    invalid: string[];
    processed: { sent: number; failed: number; status: string } | null;
  },
) {
  const params = new URLSearchParams({
    ok: "1",
    newJobId: result.job.id,
    invalid: String(result.invalid.length),
  });

  if (result.processed) {
    params.set("sent", String(result.processed.sent));
    params.set("failed", String(result.processed.failed));
    params.set("status", result.processed.status);
  }

  redirect(`/admin/resend/${jobId}?${params.toString()}`);
}

export async function runCronNow(): Promise<void> {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  let processed = 0;

  try {
    const [email, sms] = await Promise.all([
      processPendingJobs(20),
      processPendingSmsJobs(20),
    ]);
    processed = email.processed + sms.processed;

    if (processed > 0) {
      await recordCronRun();
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Cron processing failed";
    redirect(`/admin?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin");
  redirect(`/admin?cronProcessed=${processed}`);
}

function adminRedirect(channel: string, params: Record<string, string>): void {
  const search = new URLSearchParams(params);

  if (channel !== "all") {
    search.set("channel", channel);
  }

  redirect(`/admin?${search.toString()}`);
}

export async function cancelScheduledEmailJob(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const channel = String(formData.get("channel") ?? "all");

  if (!jobId) {
    adminRedirect(channel, { error: "missing-job" });
  }

  let errorMessage: string | null = null;
  let canceled = false;

  try {
    const job = await cancelPendingJobById(jobId);

    if (!job) {
      errorMessage =
        "Job not found or already sent — only pending jobs can be canceled";
    } else {
      canceled = true;
    }
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Failed to cancel email job";
  }

  if (errorMessage) {
    adminRedirect(channel, { error: errorMessage });
  }

  if (canceled) {
    revalidatePath("/admin");
    adminRedirect(channel, { canceled: "email" });
  }
}

export async function cancelScheduledSmsJob(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const channel = String(formData.get("channel") ?? "all");

  if (!jobId) {
    adminRedirect(channel, { error: "missing-job" });
  }

  let errorMessage: string | null = null;
  let canceled = false;

  try {
    const job = await cancelPendingSmsJobById(jobId);

    if (!job) {
      errorMessage =
        "Job not found or already sent — only pending jobs can be canceled";
    } else {
      canceled = true;
    }
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Failed to cancel SMS job";
  }

  if (errorMessage) {
    adminRedirect(channel, { error: errorMessage });
  }

  if (canceled) {
    revalidatePath("/admin");
    adminRedirect(channel, { canceled: "sms" });
  }
}

export async function resendSameRecipients(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");

  if (!jobId) {
    redirect("/admin?error=missing-job");
  }

  try {
    const source = await import("@/lib/jobs/query").then((m) =>
      m.getJobById(jobId),
    );

    if (!source) {
      redirect("/admin?error=job-not-found");
    }

    const result = await resendJobAsNew(jobId, source.recipients, {
      sendNow: true,
    });

    revalidatePath("/admin");
    redirectResendResult(jobId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resend failed";
    redirect(`/admin/resend/${jobId}?error=${encodeURIComponent(message)}`);
  }
}

export async function resendFromUpload(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const file = formData.get("file");

  if (!jobId) {
    redirect("/admin?error=missing-job");
  }

  if (!(file instanceof File) || file.size === 0) {
    redirect(`/admin/resend/${jobId}?error=${encodeURIComponent("Choose a file")}`);
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const raw = parseRecipientsFromFile(buffer, file.name);
    const { valid, invalid } = splitRecipients(raw);

    if (valid.length === 0) {
      redirect(
        `/admin/resend/${jobId}?error=${encodeURIComponent("No valid emails in file")}`,
      );
    }

    const result = await resendJobAsNew(jobId, valid, { sendNow: true });

    revalidatePath("/admin");
    redirectResendResult(jobId, {
      ...result,
      invalid: [...invalid, ...result.invalid],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    redirect(`/admin/resend/${jobId}?error=${encodeURIComponent(message)}`);
  }
}

export async function resendFromPaste(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const text = String(formData.get("recipients") ?? "");

  if (!jobId) {
    redirect("/admin?error=missing-job");
  }

  try {
    const raw = parseRecipientsFromText(text);
    const { valid, invalid } = splitRecipients(raw);

    if (valid.length === 0) {
      redirect(
        `/admin/resend/${jobId}?error=${encodeURIComponent("No valid emails pasted")}`,
      );
    }

    const result = await resendJobAsNew(jobId, valid, { sendNow: true });

    revalidatePath("/admin");
    redirectResendResult(jobId, {
      ...result,
      invalid: [...invalid, ...result.invalid],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resend failed";
    redirect(`/admin/resend/${jobId}?error=${encodeURIComponent(message)}`);
  }
}
