import { task } from "@trigger.dev/sdk/v3";
import { invokeWorkerJobProcess } from "@/lib/trigger/worker-fetch";

export const sendEmailJobTask = task({
  id: "send-email-job",
  maxDuration: 900,
  // The retry must come after the job counts as stale (3 min since its last
  // touch), or it finds the dead step still "processing". Without
  // maxTimeoutInMs Trigger.dev caps the wait at 60 s.
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 180_000,
    maxTimeoutInMs: 240_000,
  },
  run: async (payload: { jobId: string }) => {
    return invokeWorkerJobProcess("email", payload.jobId);
  },
});
