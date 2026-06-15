import { schedules, wait } from "@trigger.dev/sdk/v3";

const POLL_INTERVAL_SECONDS = 1;

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
 * Polls the worker cron endpoint every second.
 *
 * Trigger.dev cron only supports minute granularity, so this task runs a 1s
 * loop. A once-per-minute schedule restarts it if a run hits maxDuration.
 *
 * Required Trigger.dev environment variables:
 *   - WORKER_URL   e.g. https://notification-worker-phi.vercel.app
 *   - CRON_SECRET  same value as the worker's CRON_SECRET
 */
export const processEmails = schedules.task({
  id: "process-emails",
  cron: "* * * * *",
  ttl: "30s",
  maxDuration: 3600,
  run: async () => {
    while (true) {
      await invokeWorkerCron();
      await wait.for({ seconds: POLL_INTERVAL_SECONDS });
    }
  },
});
