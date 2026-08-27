import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { removeRecipientsFromPendingJob } from "@/lib/jobs/process";
import { removeRecipientsBodySchema } from "@/lib/validation/email-job";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = removeRecipientsBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const job = await removeRecipientsFromPendingJob(
      tenant.id,
      id,
      parsed.data.emails,
    );

    if (!job) {
      return Response.json(
        { error: "Job not found or not pending" },
        { status: 409 },
      );
    }

    return Response.json({
      jobId: job.id,
      status: job.status,
      recipientCount: job.recipients.length,
      recipients: job.recipients,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update recipients";
    return Response.json({ error: message }, { status: 500 });
  }
}
