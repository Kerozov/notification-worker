import { tasks } from "@trigger.dev/sdk/v3";
import type { sendEmailJobTask } from "@/src/trigger/send-email-job";
import type { sendSmsJobTask } from "@/src/trigger/send-sms-job";
import { processJobById, type ProcessJobResult } from "@/lib/jobs/process";
import { processSmsJobById } from "@/lib/jobs/process-sms";
import { INLINE_SEND_RECIPIENT_LIMIT } from "@/lib/validation/email-job";

/** If sendAt is this soon, process in the worker — no Trigger.dev run. */
export const IMMEDIATE_WINDOW_MS = 60_000;
const TRIGGER_CONCURRENCY = 8;

export type DispatchMode = "immediate" | "trigger";

export class DelayedDispatchError extends Error {
  readonly code: "not_configured" | "trigger_failed";

  constructor(
    message: string,
    code: "not_configured" | "trigger_failed" = "trigger_failed",
  ) {
    super(message);
    this.name = "DelayedDispatchError";
    this.code = code;
  }
}

export function isImmediateSend(sendAt: Date, now = Date.now()): boolean {
  return sendAt.getTime() <= now + IMMEDIATE_WINDOW_MS;
}

export function hasTriggerSecret(): boolean {
  return Boolean(process.env.TRIGGER_SECRET_KEY?.trim());
}

/** Delayed jobs need Trigger.dev. Call before creating a pending row. */
export function assertCanDispatchAt(sendAt: Date): void {
  if (isImmediateSend(sendAt)) {
    return;
  }

  if (!hasTriggerSecret()) {
    throw new DelayedDispatchError(
      "Delayed scheduling requires TRIGGER_SECRET_KEY",
      "not_configured",
    );
  }
}

export async function dispatchScheduledEmailJob(
  jobId: string,
  sendAt: Date,
): Promise<{ mode: DispatchMode }> {
  if (isImmediateSend(sendAt)) {
    await processJobById(jobId);
    return { mode: "immediate" };
  }

  assertCanDispatchAt(sendAt);

  try {
    await tasks.trigger<typeof sendEmailJobTask>(
      "send-email-job",
      { jobId },
      { delay: sendAt },
    );
  } catch (error) {
    console.error(
      "dispatchScheduledEmailJob trigger failed; job stays pending:",
      error,
    );
  }

  return { mode: "trigger" };
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await fn(items[index]);
      }
    }),
  );
}

/**
 * Immediate send: small lists process in this request; large lists are one
 * Trigger.dev run so the HTTP call can return the job (with every recipient
 * already stored) without waiting for ZeptoMail.
 */
export async function dispatchCreatedEmailJobs(
  job: {
    id: string;
    status: string;
    kind?: string;
    recipients: string[];
  },
  children: Array<{ id: string; status: string; recipients: string[] }>,
  options?: { sendAt?: Date },
): Promise<{
  mode: DispatchMode;
  result: ProcessJobResult | null;
}> {
  const isCampaign = children.length > 0 || job.kind === "campaign";
  const targets =
    children.length > 0
      ? children
      : job.kind === "campaign"
        ? []
        : [job];

  let mode: DispatchMode = "immediate";
  let result: ProcessJobResult | null = null;
  const sendAt = options?.sendAt;
  const pending = targets.filter((target) => target.status === "pending");

  await mapWithConcurrency(pending, TRIGGER_CONCURRENCY, async (target) => {
    if (sendAt && !isImmediateSend(sendAt)) {
      const dispatched = await dispatchScheduledEmailJob(target.id, sendAt);
      if (dispatched.mode === "trigger") mode = "trigger";
      return;
    }
    const dispatched = await dispatchEmailJobNow(
      target.id,
      target.recipients.length,
      { allowInline: !isCampaign || !hasTriggerSecret() },
    );
    if (dispatched.mode === "trigger") mode = "trigger";
    result = dispatched.result ?? result;
  });

  return { mode, result };
}

export async function dispatchEmailJobNow(
  jobId: string,
  recipientCount: number,
  options?: { allowInline?: boolean },
): Promise<{
  mode: DispatchMode;
  result: ProcessJobResult | null;
}> {
  const allowInline = options?.allowInline ?? true;
  const useTrigger =
    recipientCount > INLINE_SEND_RECIPIENT_LIMIT && hasTriggerSecret();

  if (!useTrigger) {
    if (!allowInline && recipientCount > INLINE_SEND_RECIPIENT_LIMIT) {
      return { mode: "trigger", result: null };
    }
    const result = await processJobById(jobId);
    return { mode: "immediate", result };
  }

  try {
    await tasks.trigger<typeof sendEmailJobTask>("send-email-job", { jobId });
    return { mode: "trigger", result: null };
  } catch (error) {
    console.error("dispatchEmailJobNow trigger failed:", error);
    if (!allowInline) {
      return { mode: "trigger", result: null };
    }
    const result = await processJobById(jobId);
    return { mode: "immediate", result };
  }
}

export async function dispatchScheduledSmsJob(
  jobId: string,
  sendAt: Date,
): Promise<{ mode: DispatchMode }> {
  if (isImmediateSend(sendAt)) {
    await processSmsJobById(jobId);
    return { mode: "immediate" };
  }

  assertCanDispatchAt(sendAt);

  try {
    await tasks.trigger<typeof sendSmsJobTask>(
      "send-sms-job",
      { jobId },
      { delay: sendAt },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Trigger.dev request failed";
    throw new DelayedDispatchError(message, "trigger_failed");
  }

  return { mode: "trigger" };
}
