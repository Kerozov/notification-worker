import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import {
  checkTenantJobRateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit/tenant";
import {
  createEmailJob,
  processJobById,
  toJobResponse,
} from "@/lib/jobs/process";
import { sendJobBodySchema } from "@/lib/validation/email-job";

export async function POST(request: NextRequest) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const rateLimit = await checkTenantJobRateLimit(tenant.id);

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfterSeconds);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = sendJobBodySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const job = await createEmailJob({
      tenantId: tenant.id,
      subject: parsed.data.subject,
      html: parsed.data.html,
      recipients: parsed.data.recipients,
      replyTo: parsed.data.replyTo,
      sendAt: new Date(),
      idempotencyKey: parsed.data.idempotencyKey,
    });

    if (job.status !== "pending") {
      return Response.json(toJobResponse(job));
    }

    const result = await processJobById(job.id);

    if (!result) {
      return Response.json({
        jobId: job.id,
        status: job.status,
        sent: job.sent_count,
        failed: job.failed_count,
      });
    }

    return Response.json({
      jobId: result.jobId,
      status: result.status,
      sent: result.sent,
      failed: result.failed,
      ...(result.errors ? { errors: result.errors } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send";

    return Response.json({ error: message }, { status: 400 });
  }
}
