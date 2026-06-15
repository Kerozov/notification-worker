"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { hasAdminSession } from "@/lib/auth/admin";
import { processPendingJobs, recordCronRun } from "@/lib/jobs/process";
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
    const result = await processPendingJobs(20);
    processed = result.processed;

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
