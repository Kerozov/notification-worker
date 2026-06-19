import { task } from "@trigger.dev/sdk/v3";
import { invokeWorkerJobProcess } from "@/lib/trigger/worker-fetch";

export const sendEmailJobTask = task({
  id: "send-email-job",
  maxDuration: 120,
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: { jobId: string }) => {
    return invokeWorkerJobProcess("email", payload.jobId);
  },
});
