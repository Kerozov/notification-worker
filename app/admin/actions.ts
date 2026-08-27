"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { hasAdminSession } from "@/lib/auth/admin";
import { cancelPendingJobById } from "@/lib/jobs/process";
import { cancelPendingSmsJobById } from "@/lib/jobs/process-sms";
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

function adminRedirect(channel: string, params: Record<string, string>): void {
  const search = new URLSearchParams(params);

  if (channel !== "all") {
    search.set("channel", channel);
  }

  redirect(`/admin?${search.toString()}`);
}

function adminRedirectFromForm(formData: FormData, params: Record<string, string>): void {
  const returnTo = String(formData.get("returnTo") ?? "").trim();
  if (
    returnTo === "/admin" ||
    (returnTo.startsWith("/admin/") && !returnTo.startsWith("//"))
  ) {
    const url = new URL(returnTo, "https://worker.local");
    const search = url.searchParams;
    for (const [key, value] of Object.entries(params)) {
      search.set(key, value);
    }
    const query = search.toString();
    redirect(`${url.pathname}${query ? `?${query}` : ""}`);
    return;
  }

  const channel = String(formData.get("channel") ?? "all");
  const returnQuery = String(formData.get("returnQuery") ?? "").trim();

  if (returnQuery) {
    const search = new URLSearchParams(returnQuery);

    for (const [key, value] of Object.entries(params)) {
      search.set(key, value);
    }

    redirect(`/admin?${search.toString()}`);
    return;
  }

  adminRedirect(channel, params);
}

export async function sendScheduledEmailJob(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const channel = String(formData.get("channel") ?? "all");

  if (!jobId) {
    adminRedirectFromForm(formData, { error: "missing-job" });
  }

  let errorMessage: string | null = null;
  let sent = false;

  try {
    const { getJobById } = await import("@/lib/jobs/query");
    const { listChildJobs, isCampaignJob } = await import("@/lib/jobs/campaign");
    const { dispatchCreatedEmailJobs } = await import("@/lib/trigger/schedule");
    const { processJobById } = await import("@/lib/jobs/process");
    const job = await getJobById(jobId);

    if (job && isCampaignJob(job)) {
      const children = await listChildJobs(job.id);
      const pending = children.filter((child) => child.status === "pending");
      if (pending.length === 0) {
        errorMessage = "No pending send jobs left on this campaign";
      } else {
        await dispatchCreatedEmailJobs(job, pending);
        sent = true;
      }
    } else {
      const result = await processJobById(jobId);

      if (!result) {
        errorMessage =
          "Job not found or not pending — only scheduled jobs can be sent now";
      } else if (result.status === "failed") {
        errorMessage = result.errors?.join("; ") ?? "Send failed";
      } else {
        sent = true;
      }
    }
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Failed to send email job";
  }

  if (errorMessage) {
    adminRedirectFromForm(formData, { error: errorMessage });
  }

  if (sent) {
    revalidatePath("/admin");
    adminRedirectFromForm(formData, { sent: "email" });
  }
}

export async function sendScheduledSmsJob(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const channel = String(formData.get("channel") ?? "all");

  if (!jobId) {
    adminRedirectFromForm(formData, { error: "missing-job" });
  }

  let errorMessage: string | null = null;
  let sent = false;

  try {
    const { processSmsJobById } = await import("@/lib/jobs/process-sms");
    const result = await processSmsJobById(jobId);

    if (!result) {
      errorMessage =
        "Job not found or not pending — only scheduled jobs can be sent now";
    } else if (result.status === "failed") {
      errorMessage = result.errors?.join("; ") ?? "Send failed";
    } else {
      sent = true;
    }
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Failed to send SMS job";
  }

  if (errorMessage) {
    adminRedirectFromForm(formData, { error: errorMessage });
  }

  if (sent) {
    revalidatePath("/admin");
    adminRedirectFromForm(formData, { sent: "sms" });
  }
}

export async function cancelScheduledEmailJob(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const channel = String(formData.get("channel") ?? "all");

  if (!jobId) {
    adminRedirectFromForm(formData, { error: "missing-job" });
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
    adminRedirectFromForm(formData, { error: errorMessage });
  }

  if (canceled) {
    revalidatePath("/admin");
    adminRedirectFromForm(formData, { canceled: "email" });
  }
}

export async function cancelScheduledSmsJob(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const channel = String(formData.get("channel") ?? "all");

  if (!jobId) {
    adminRedirectFromForm(formData, { error: "missing-job" });
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
    adminRedirectFromForm(formData, { error: errorMessage });
  }

  if (canceled) {
    revalidatePath("/admin");
    adminRedirectFromForm(formData, { canceled: "sms" });
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

export async function removeJobRecipient(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  const emails = String(formData.get("emails") ?? "");

  if (!jobId) {
    adminRedirectFromForm(formData, { error: "missing-job" });
  }

  try {
    const { getJobById } = await import("@/lib/jobs/query");
    const { removeRecipientsFromPendingJob } = await import("@/lib/jobs/process");
    const job = await getJobById(jobId);
    if (!job) {
      adminRedirectFromForm(formData, { error: "job-not-found" });
      return;
    }

    const list = emails
      .split(/[\s,;]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    const updated = await removeRecipientsFromPendingJob(job.tenant_id, jobId, list);
    if (!updated) {
      adminRedirectFromForm(formData, {
        error: "Could not remove — address already sending or job is not pending",
      });
      return;
    }

    revalidatePath("/admin");
    revalidatePath(`/admin/jobs/${jobId}`);
    adminRedirectFromForm(formData, { removed: String(list.length) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to remove recipient";
    adminRedirectFromForm(formData, { error: message });
  }
}

export async function resendFailedFromJob(formData: FormData): Promise<void> {
  await requireAdmin();

  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) {
    redirect("/admin?error=missing-job");
  }

  try {
    const { getJobById } = await import("@/lib/jobs/query");
    const { getDeliveriesForEmailJob } = await import("@/lib/jobs/campaign");
    const job = await getJobById(jobId);
    if (!job) {
      redirect("/admin?error=job-not-found");
    }

    const deliveries = await getDeliveriesForEmailJob(job);
    const failed = [
      ...new Set(
        deliveries
          .filter(
            (row) =>
              (row.status === "failed" || row.status === "bounced") &&
              !row.complained_at,
          )
          .map((row) => row.recipient),
      ),
    ];

    if (failed.length === 0) {
      redirect(
        `/admin/jobs/${jobId}?error=${encodeURIComponent("No failed deliveries to resend")}`,
      );
    }

    const result = await resendJobAsNew(jobId, failed, { sendNow: true });
    revalidatePath("/admin");
    redirectResendResult(jobId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resend failed";
    redirect(`/admin/jobs/${jobId}?error=${encodeURIComponent(message)}`);
  }
}
