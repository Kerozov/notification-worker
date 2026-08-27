import { schedules } from "@trigger.dev/sdk/v3";
import { invokeWorkerPendingDrain } from "@/lib/trigger/worker-fetch";

export const drainPendingEmailJobs = schedules.task({
  id: "drain-pending-email-jobs",
  cron: "* * * * *",
  maxDuration: 300,
  run: async () => {
    return invokeWorkerPendingDrain("email");
  },
});
