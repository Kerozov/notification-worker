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
  createSmsJob,
  processSmsJobById,
  resolveNotifierApiKey,
  resolveSmsSender,
  toSmsJobResponse,
} from "@/lib/jobs/process-sms";
import { sendSmsBodySchema } from "@/lib/validation/sms-job";

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

  const parsed = sendSmsBodySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    if (!resolveNotifierApiKey(tenant)) {
      return Response.json(
        {
          error:
            "Notifier API key is not configured for this tenant. Set TENANT_*_NOTIFIER_KEY and run seed.",
        },
        { status: 400 },
      );
    }

    const sender = resolveSmsSender(parsed.data.sender, tenant);

    const { job, invalid } = await createSmsJob({
      tenantId: tenant.id,
      body: parsed.data.body,
      recipients: parsed.data.recipients,
      sender,
      shortenLinks: parsed.data.shortenLinks,
      campaign: parsed.data.campaign,
      sendAt: new Date(),
      idempotencyKey: parsed.data.idempotencyKey,
    });

    if (job.status !== "pending") {
      return Response.json(toSmsJobResponse(job, invalid));
    }

    const result = await processSmsJobById(job.id);

    if (!result) {
      return Response.json(toSmsJobResponse(job, invalid));
    }

    return Response.json({
      jobId: result.jobId,
      status: result.status,
      sent: result.sent,
      failed: result.failed,
      invalid: invalid.length,
      ...(invalid.length > 0 ? { invalidPhones: invalid } : {}),
      ...(result.errors ? { errors: result.errors } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send SMS";

    return Response.json({ error: message }, { status: 400 });
  }
}
