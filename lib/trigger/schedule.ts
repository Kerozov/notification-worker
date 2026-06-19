import { tasks } from "@trigger.dev/sdk/v3";
import type { sendEmailJobTask } from "@/src/trigger/send-email-job";
import type { sendSmsJobTask } from "@/src/trigger/send-sms-job";
import { processJobById } from "@/lib/jobs/process";
import { processSmsJobById } from "@/lib/jobs/process-sms";

/** If sendAt is this soon, process in the worker — no Trigger.dev run. */
const IMMEDIATE_WINDOW_MS = 60_000;

export type DispatchMode = "immediate" | "trigger" | "queued";

export async function dispatchScheduledEmailJob(
  jobId: string,
  sendAt: Date,
): Promise<{ mode: DispatchMode }> {
  const delayMs = sendAt.getTime() - Date.now();

  if (delayMs <= IMMEDIATE_WINDOW_MS) {
    await processJobById(jobId);
    return { mode: "immediate" };
  }

  if (!process.env.TRIGGER_SECRET_KEY?.trim()) {
    return { mode: "queued" };
  }

  await tasks.trigger<typeof sendEmailJobTask>(
    "send-email-job",
    { jobId },
    { delay: sendAt },
  );

  return { mode: "trigger" };
}

export async function dispatchScheduledSmsJob(
  jobId: string,
  sendAt: Date,
): Promise<{ mode: DispatchMode }> {
  const delayMs = sendAt.getTime() - Date.now();

  if (delayMs <= IMMEDIATE_WINDOW_MS) {
    await processSmsJobById(jobId);
    return { mode: "immediate" };
  }

  if (!process.env.TRIGGER_SECRET_KEY?.trim()) {
    return { mode: "queued" };
  }

  await tasks.trigger<typeof sendSmsJobTask>(
    "send-sms-job",
    { jobId },
    { delay: sendAt },
  );

  return { mode: "trigger" };
}
