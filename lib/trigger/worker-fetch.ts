export async function invokeWorkerJobProcess(
  channel: "email" | "sms",
  jobId: string,
): Promise<unknown> {
  const workerUrl = process.env.WORKER_URL?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();

  if (!workerUrl || !cronSecret) {
    throw new Error("WORKER_URL and CRON_SECRET are required in Trigger.dev");
  }

  const response = await fetch(
    `${workerUrl}/api/internal/process/${channel}/${jobId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
      },
    },
  );

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `Worker process failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }

  return body;
}
