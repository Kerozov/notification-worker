import { task } from "@trigger.dev/sdk/v3";
import { invokeWorkerJobProcess } from "@/lib/trigger/worker-fetch";

export const sendEmailJobTask = task({
  id: "send-email-job",
  maxDuration: 900,
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 180_000,
  },
  run: async (payload: { jobId: string }) => {
    return invokeWorkerJobProcess("email", payload.jobId);
  },
});
