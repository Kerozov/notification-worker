import { NextRequest } from "next/server";
import { processPendingJobs, recordCronRun } from "@/lib/jobs/process";
import { processPendingSmsJobs } from "@/lib/jobs/process-sms";

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
    const [email, sms] = await Promise.all([
      processPendingJobs(20),
      processPendingSmsJobs(20),
    ]);

    const processed = email.processed + sms.processed;

    if (processed > 0) {
      await recordCronRun();
    }

    return Response.json({
      processed,
      email,
      sms,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Cron processing failed";

    return Response.json({ error: message }, { status: 500 });
  }
}
