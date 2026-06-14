import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import {
  checkTenantJobRateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit/tenant";
import { createEmailJob } from "@/lib/jobs/process";
import { scheduleJobBodySchema } from "@/lib/validation/email-job";

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

  const parsed = scheduleJobBodySchema.safeParse(body);

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

  try {
    const job = await createEmailJob({
      tenantId: tenant.id,
      subject: parsed.data.subject,
      html: parsed.data.html,
      recipients: parsed.data.recipients,
      replyTo: parsed.data.replyTo,
      sendAt,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    return Response.json({
      jobId: job.id,
      status: job.status,
      sendAt: job.send_at,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to schedule";

    return Response.json({ error: message }, { status: 400 });
  }
}
