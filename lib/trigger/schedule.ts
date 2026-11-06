import { tasks } from "@trigger.dev/sdk/v3";
import type { sendEmailJobTask } from "@/src/trigger/send-email-job";
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

/**
 * Pacing (per-domain quota, pockets one after another, retries later) needs a
 * way to come back later, which is a delayed Trigger.dev run. Without
 * Trigger.dev everything goes out at once, as before.
 */
export function isPacingEnabled(): boolean {
  return hasTriggerSecret();
}

/**
 * Runs the next step of a send job at `at` (throttled leftovers, a retry that
 * is due). One run per job per minute: a second request for the same minute
 * is the same run.
 */
export async function scheduleEmailJobStep(
  jobId: string,
  at: Date,
  options?: { idempotencyKey?: string },
): Promise<boolean> {
  if (!hasTriggerSecret()) return false;

  const minute = Math.floor(at.getTime() / 60_000);

  try {
    await tasks.trigger<typeof sendEmailJobTask>(
      "send-email-job",
      { jobId },
      {
        delay: at,
        idempotencyKey:
          options?.idempotencyKey ?? `email-step:${jobId}:${minute}`,
        idempotencyKeyTTL: "2d",
      },
    );
    return true;
  } catch (error) {
    console.error(`scheduleEmailJobStep ${jobId} failed:`, error);
    return false;
  }
}

/**
 * A pocket nobody has picked up yet: still pending and nothing counted on it.
 * (A pocket held back with zero quota also looks like this; starting it again
 * only costs one extra run.)
 */
export function isUnstartedPocket(job: {
  status: string;
  sent_count: number;
  failed_count: number;
}): boolean {
  return job.status === "pending" && job.sent_count === 0 && job.failed_count === 0;
}

/**
 * The pocket a chain should start next: the first unstarted one in list order,
 * wherever it sits. List order is not creation order (pockets inserted together
 * share created_at and are ordered by random id), so "the one after me" could
 * skip a pocket for good.
 */
export function pickNextPocket<
  T extends { id: string; status: string; sent_count: number; failed_count: number },
>(children: T[], afterJobId: string | null): T | null {
  return (
    children.find(
      (child) => child.id !== afterJobId && isUnstartedPocket(child),
    ) ?? null
  );
}

/**
 * Pockets of a campaign go out one after another, so a 50k list does not hit
 * one provider from many pockets at once. When a pocket is done for now, it
 * starts the next unstarted pocket — once: the run key is per finishing
 * pocket, so a pocket that finishes again after a retry cannot start a second,
 * parallel chain.
 */
export async function startNextPocket(
  parentId: string,
  afterJobId: string,
): Promise<string | null> {
  if (!hasTriggerSecret()) return null;

  const { listChildJobs } = await import("@/lib/jobs/campaign");
  const next = pickNextPocket(await listChildJobs(parentId), afterJobId);

  if (!next) return null;

  try {
    await tasks.trigger<typeof sendEmailJobTask>(
      "send-email-job",
      { jobId: next.id },
      {
        idempotencyKey: `email-pocket-after:${afterJobId}`,
        idempotencyKeyTTL: "7d",
      },
    );
    return next.id;
  } catch (error) {
    console.error(`startNextPocket ${next.id} failed:`, error);
    return null;
  }
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
    sent_count: number;
    failed_count: number;
  },
  children: Array<{
    id: string;
    status: string;
    recipients: string[];
    sent_count: number;
    failed_count: number;
  }>,
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
  const waiting = targets.filter((target) => target.status === "pending");
  // With pacing, a campaign starts one unstarted pocket and each pocket starts
  // the next when it is done. Pockets that already began and wait for their
  // next step are resumed too (their own run normally does that; an extra
  // run is harmless), so an admin "send now" also unsticks a stalled one.
  const pending =
    isCampaign && isPacingEnabled()
      ? [
          ...waiting.filter((target) => !isUnstartedPocket(target)),
          ...[pickNextPocket(waiting, null)].filter(
            (target): target is (typeof waiting)[number] => target !== null,
          ),
        ]
      : waiting;

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

/**
 * SMS goes to Notifier now; a future `send_at` travels as Notifier's `sendAt`,
 * so Notifier holds the message — no delayed Trigger.dev run.
 */
export async function dispatchScheduledSmsJob(
  jobId: string,
): Promise<{ mode: DispatchMode }> {
  await processSmsJobById(jobId);
  return { mode: "immediate" };
}
