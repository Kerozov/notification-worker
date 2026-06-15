import { schedules } from "@trigger.dev/sdk/v3";

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
 * Polls the worker queue every minute.
 *
 * Required Trigger.dev environment variables:
 *   - WORKER_URL
 *   - CRON_SECRET  (same as the worker's CRON_SECRET)
 */
export const processEmails = schedules.task({
  id: "process-emails",
  cron: "* * * * *",
  maxDuration: 120,
  run: async () => invokeWorkerCron(),
});
