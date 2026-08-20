import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { cancelPendingJobs } from "@/lib/jobs/process";
import { cancelJobsBodySchema } from "@/lib/validation/email-job";

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

  const parsed = cancelJobsBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const jobs = await cancelPendingJobs(tenant.id, parsed.data);
    return Response.json({
      canceled: jobs.length,
      jobIds: jobs.map((job) => job.id),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel jobs";
    return Response.json({ error: message }, { status: 500 });
  }
}
