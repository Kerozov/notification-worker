import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { cancelPendingJob } from "@/lib/jobs/process";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function DELETE(request: NextRequest, context: RouteContext) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const { id } = await context.params;

  try {
    const job = await cancelPendingJob(tenant.id, id);

    if (!job) {
      return Response.json(
        { error: "Job not found or not cancelable" },
        { status: 404 },
      );
    }

    return Response.json({
      jobId: job.id,
      status: job.status,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel job";

    return Response.json({ error: message }, { status: 500 });
  }
}
