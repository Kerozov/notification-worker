import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { updatePendingJobsContent } from "@/lib/jobs/update-content";
import { updateJobsContentBodySchema } from "@/lib/validation/email-job";

/**
 * Rewrite subject + HTML of scheduled jobs that have not started sending.
 *
 * Always 200 with one outcome per job — an automation is one job per person,
 * and one refused row must not hide the ninety-nine that took the new text.
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

  const parsed = updateJobsContentBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const results = await updatePendingJobsContent(tenant.id, parsed.data.jobs);

  return Response.json({
    updated: results.filter((row) => row.outcome === "updated").length,
    results,
  });
}
