import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { reschedulePendingJobs } from "@/lib/jobs/reschedule";
import { assertCanDispatchAt } from "@/lib/trigger/schedule";
import { rescheduleJobsBodySchema } from "@/lib/validation/email-job";

/**
 * Move scheduled jobs that have not started sending to a new time.
 *
 * Always 200 with one outcome per job, like `/jobs/update`: one job that
 * started sending must not hide the hundred that moved.
 */
export async function POST(request: NextRequest) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = rescheduleJobsBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const sendAt = new Date(parsed.data.sendAt);
  if (Number.isNaN(sendAt.getTime())) {
    return Response.json({ error: "Invalid sendAt" }, { status: 400 });
  }

  // A later time needs a run that comes back; without Trigger.dev nothing would.
  try {
    assertCanDispatchAt(sendAt);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Delayed scheduling is not configured";
    return Response.json({ error: message }, { status: 503 });
  }

  const results = await reschedulePendingJobs(tenant.id, parsed.data.jobIds, sendAt);

  return Response.json({
    moved: results.filter((row) => row.outcome === "moved").length,
    results,
  });
}
