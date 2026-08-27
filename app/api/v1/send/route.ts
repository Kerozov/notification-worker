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
  resolveJobFrom,
  toJobResponse,
} from "@/lib/jobs/process";
import { parseJobMerge, sendJobBodySchema } from "@/lib/validation/email-job";
import { dispatchCreatedEmailJobs } from "@/lib/trigger/schedule";
import { emailJobNeedsDispatch } from "@/lib/jobs/campaign";

export const maxDuration = 300;

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

    const { job, invalid, children } = await createEmailJob({
      tenantId: tenant.id,
      subject: parsed.data.subject,
      html: parsed.data.html,
      recipients: parsed.data.recipients,
      from,
      replyTo: parsed.data.replyTo,
      sendAt: new Date(),
      idempotencyKey: parsed.data.idempotencyKey,
      attachments: parsed.data.attachments,
      merge: parseJobMerge(parsed.data.merge),
    });

    if (!emailJobNeedsDispatch(job.status)) {
      return Response.json(toJobResponse(job, invalid, children));
    }

    const dispatched = await dispatchCreatedEmailJobs(job, children);

    if (
      children.length > 0 ||
      dispatched.mode === "trigger" ||
      !dispatched.result
    ) {
      return Response.json({
        ...toJobResponse(job, invalid, children),
        status: dispatched.result?.status ?? "pending",
        sent: children.length > 0 ? 0 : (dispatched.result?.sent ?? 0),
        failed: children.length > 0 ? 0 : (dispatched.result?.failed ?? 0),
        dispatch: dispatched.mode,
      });
    }

    return Response.json({
      jobId: dispatched.result.jobId,
      status: dispatched.result.status,
      sent: dispatched.result.sent,
      failed: dispatched.result.failed,
      invalid: invalid.length,
      recipientCount: job.recipients.length,
      recipients: job.recipients,
      kind: job.kind,
      ...(invalid.length > 0 ? { invalidEmails: invalid } : {}),
      ...(dispatched.result.errors ? { errors: dispatched.result.errors } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send";

    return Response.json({ error: message }, { status: 400 });
  }
}
