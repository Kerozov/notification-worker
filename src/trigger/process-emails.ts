import { schedules } from "@trigger.dev/sdk/v3";

/**
 * Trigger.dev scheduled task that drains the worker's pending email queue.
 *
 * It simply calls the worker cron endpoint every 5 minutes so we don't need
 * Vercel Pro cron. The worker keeps `send_at` in the database; this task is the
 * external timer that tells the worker "process whatever is due now".
 *
 * Required Trigger.dev environment variables:
 *   - WORKER_URL   e.g. https://notification-worker-phi.vercel.app
 *   - CRON_SECRET  same value as the worker's CRON_SECRET
 */
export const processEmails = schedules.task({
  id: "process-emails",
  cron: "*/5 * * * *",
  maxDuration: 120,
  run: async () => {
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
  },
});
