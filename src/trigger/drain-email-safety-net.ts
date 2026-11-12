import { schedules } from "@trigger.dev/sdk/v3";
import { invokeWorkerDrain } from "@/lib/trigger/worker-fetch";

/**
 * Safety net for per-job runs. Every 5 minutes the worker sends what lost its
 * own run: a trigger call that failed, a step cut off by the Vercel timeout, a
 * retry that came too early. Only jobs active in the last 24 h; older ones
 * wait for the owner. Production only, so `trigger:dev` never drains the
 * real queue.
 */
export const drainEmailSafetyNetTask = schedules.task({
  id: "drain-email-safety-net",
  cron: { pattern: "*/5 * * * *", environments: ["PRODUCTION"] },
  maxDuration: 400,
  // One drain at a time; the next tick comes in 5 minutes anyway.
  concurrency: { total: 1 },
  retry: { maxAttempts: 1 },
  run: async () => {
    return invokeWorkerDrain("email");
  },
});
