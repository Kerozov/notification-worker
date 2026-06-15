import { schedules, task, tasks } from "@trigger.dev/sdk/v3";

const TASK_ID = "process-emails";

async function invokeWorkerCron() {
  const workerUrl = process.env.WORKER_URL;
  const cronSecret = process.env.CRON_SECRET;

  if (!workerUrl || !cronSecret) {
    throw new Error("WORKER_URL and CRON_SECRET are required");
  }

  const response = await fetch(`${workerUrl}/api/cron/process`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
    },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `Cron failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }

  return body;
}

/**
 * Drains the worker queue every second via a self-rescheduling chain.
 * Only one run executes at a time (concurrencyLimit: 1).
 *
 * Required Trigger.dev environment variables:
 *   - WORKER_URL
 *   - CRON_SECRET  (same as the worker's CRON_SECRET)
 */
export const processEmails = task({
  id: TASK_ID,
  queue: {
    concurrencyLimit: 1,
  },
  maxDuration: 60,
  run: async () => {
    const result = await invokeWorkerCron();

    await tasks.trigger(TASK_ID, {}, { delay: "1s" });

    return result;
  },
});

/**
 * Hourly safety net — restarts the poller if the chain stopped.
 */
export const processEmailsKickoff = schedules.task({
  id: "process-emails-kickoff",
  cron: "0 * * * *",
  maxDuration: 30,
  run: async () => {
    await tasks.trigger(TASK_ID, {}, {
      idempotencyKey: "process-emails-poller",
      idempotencyKeyTTL: "55m",
    });
  },
});
