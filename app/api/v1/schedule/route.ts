import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import {
  checkTenantJobRateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit/tenant";
import { createEmailJob, resolveJobFrom } from "@/lib/jobs/process";
import {
  assertCanDispatchAt,
  DelayedDispatchError,
  dispatchCreatedEmailJobs,
} from "@/lib/trigger/schedule";
import { parseJobMerge, scheduleJobBodySchema } from "@/lib/validation/email-job";
import { emailJobNeedsDispatch } from "@/lib/jobs/campaign";

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
    assertCanDispatchAt(sendAt);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Delayed scheduling is not configured";
    return Response.json({ error: message }, { status: 503 });
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

    const { job, invalid, children } = await createEmailJob({
      tenantId: tenant.id,
      subject: parsed.data.subject,
      html: parsed.data.html,
      recipients: parsed.data.recipients,
      from,
      replyTo: parsed.data.replyTo,
      sendAt,
      idempotencyKey: parsed.data.idempotencyKey,
      attachments: parsed.data.attachments,
      merge: parseJobMerge(parsed.data.merge),
    });

    let dispatch: "immediate" | "trigger" | undefined;

    if (emailJobNeedsDispatch(job.status)) {
      try {
        const result = await dispatchCreatedEmailJobs(job, children, { sendAt });
        dispatch = result.mode;
      } catch (error) {
        const message =
          error instanceof DelayedDispatchError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Failed to dispatch scheduled job";

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
      jobId: job.id,
      status: job.status,
      sendAt: job.send_at,
      dispatch,
      invalid: invalid.length,
      recipientCount: job.recipients.length,
      kind: job.kind,
      ...(children.length > 0
        ? {
            jobs: children.map((child) => ({
              jobId: child.id,
              status: child.status,
              recipientCount: child.recipients.length,
            })),
          }
        : {}),
      ...(invalid.length > 0 ? { invalidEmails: invalid } : {}),
      ...(job.error ? { errors: [job.error] } : {}),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to schedule";

    return Response.json({ error: message }, { status: 400 });
  }
}
