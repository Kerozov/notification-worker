async function postToWorker(path: string, label: string): Promise<unknown> {
  const workerUrl = process.env.WORKER_URL?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();

  if (!workerUrl || !cronSecret) {
    throw new Error("WORKER_URL and CRON_SECRET are required in Trigger.dev");
  }

  const response = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
    },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `Worker ${label} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }

  return body;
}

export async function invokeWorkerJobProcess(
  channel: "email" | "sms",
  jobId: string,
): Promise<unknown> {
  return postToWorker(`/api/internal/process/${channel}/${jobId}`, "process");
}

/** The safety-net drain: sends what lost its own run. */
export async function invokeWorkerDrain(channel: "email"): Promise<unknown> {
  return postToWorker(`/api/internal/drain/${channel}`, "drain");
}
