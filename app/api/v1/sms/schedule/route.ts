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
  resolveNotifierApiKey,
  resolveSmsSender,
  toSmsJobResponse,
} from "@/lib/jobs/process-sms";
import {
  assertCanDispatchAt,
  DelayedDispatchError,
  dispatchScheduledSmsJob,
} from "@/lib/trigger/schedule";
import { scheduleSmsBodySchema } from "@/lib/validation/sms-job";

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

  const parsed = scheduleSmsBodySchema.safeParse(body);

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
    assertCanDispatchAt(sendAt);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Delayed scheduling is not configured";
    return Response.json({ error: message }, { status: 503 });
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
      sendAt,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    let dispatch: "immediate" | "trigger" | undefined;

    if (job.status === "pending") {
      try {
        const result = await dispatchScheduledSmsJob(job.id, sendAt);
        dispatch = result.mode;
      } catch (error) {
        const message =
          error instanceof DelayedDispatchError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Failed to dispatch scheduled SMS";

        return Response.json(
          {
            error: message,
            jobId: job.id,
            status: job.status,
            sendAt: job.send_at,
          },
          { status: 503 },
        );
      }
    }

    return Response.json({
      ...toSmsJobResponse(job, invalid),
      sendAt: job.send_at,
      dispatch,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to schedule SMS";

    return Response.json({ error: message }, { status: 400 });
  }
}
