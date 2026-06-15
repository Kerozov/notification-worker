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
  resolveJobFrom,
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
    const from = resolveJobFrom(parsed.data.from, tenant);

    if (!from) {
      return Response.json(
        {
          error:
            "from is required. Pass it in the request body or set tenant default_from.",
        },
        { status: 400 },
      );
    }

    const { job, invalid } = await createEmailJob({
      tenantId: tenant.id,
      subject: parsed.data.subject,
      html: parsed.data.html,
      recipients: parsed.data.recipients,
      from,
      replyTo: parsed.data.replyTo,
      sendAt: new Date(),
      idempotencyKey: parsed.data.idempotencyKey,
    });

    if (job.status !== "pending") {
      return Response.json(toJobResponse(job, invalid));
    }

    const result = await processJobById(job.id);

    if (!result) {
      return Response.json({
        ...toJobResponse(job, invalid),
      });
    }

    return Response.json({
      jobId: result.jobId,
      status: result.status,
      sent: result.sent,
      failed: result.failed,
      invalid: invalid.length,
      ...(invalid.length > 0 ? { invalidEmails: invalid } : {}),
      ...(result.errors ? { errors: result.errors } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send";

    return Response.json({ error: message }, { status: 400 });
  }
}
