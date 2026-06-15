import { NextRequest } from "next/server";
import { processPendingJobs, recordCronRun } from "@/lib/jobs/process";

function unauthorizedResponse() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return Response.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  if (!token || token !== cronSecret) {
    return unauthorizedResponse();
  }

  try {
    const result = await processPendingJobs(20);

    if (result.processed > 0) {
      await recordCronRun();
    }

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Cron processing failed";

    return Response.json({ error: message }, { status: 500 });
  }
}
