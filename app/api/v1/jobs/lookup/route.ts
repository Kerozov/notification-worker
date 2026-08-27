import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { isCampaignJob, listChildJobs } from "@/lib/jobs/campaign";
import {
  findExistingJobByIdempotencyKey,
  toJobResponse,
} from "@/lib/jobs/process";

export async function GET(request: NextRequest) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const key = request.nextUrl.searchParams.get("key")?.trim();
  if (!key) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }

  try {
    const job = await findExistingJobByIdempotencyKey(tenant.id, key);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const children = isCampaignJob(job) ? await listChildJobs(job.id) : [];
    return Response.json(toJobResponse(job, [], children));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to look up job";
    return Response.json({ error: message }, { status: 500 });
  }
}
