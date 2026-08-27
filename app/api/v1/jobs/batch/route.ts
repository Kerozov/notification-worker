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
} from "@/lib/jobs/process";
import {
  assertCanDispatchAt,
  DelayedDispatchError,
  dispatchCreatedEmailJobs,
  IMMEDIATE_WINDOW_MS,
  isImmediateSend,
} from "@/lib/trigger/schedule";
import { batchJobsBodySchema, parseJobMerge } from "@/lib/validation/email-job";
import { emailJobNeedsDispatch } from "@/lib/jobs/campaign";

/**
 * Submit multiple email jobs in one request (e.g. all automations for one subscriber).
 * Worker handles immediate send + Trigger.dev scheduling per job.
 */
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

  const parsed = batchJobsBodySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

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

  const now = Date.now();
  const hasDelayed = parsed.data.jobs.some(
    (item) => !isImmediateSend(new Date(item.sendAt), now),
  );

  if (hasDelayed) {
    try {
      assertCanDispatchAt(new Date(now + IMMEDIATE_WINDOW_MS + 1));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Delayed scheduling is not configured";
      return Response.json({ error: message }, { status: 503 });
    }
  }

  const results: {
    idempotencyKey?: string;
    jobId: string;
    status: string;
    sendAt: string;
    dispatch?: string;
    sent?: number;
    failed?: number;
    error?: string;
  }[] = [];

  let dispatchFailed = false;

  for (const item of parsed.data.jobs) {
    const sendAt = new Date(item.sendAt);

    try {
      const { job, invalid, children } = await createEmailJob({
        tenantId: tenant.id,
        subject: item.subject,
        html: item.html,
        recipients: item.recipients,
        from,
        replyTo: item.replyTo ?? parsed.data.replyTo,
        sendAt,
        idempotencyKey: item.idempotencyKey,
        attachments: item.attachments,
        merge: parseJobMerge(item.merge),
      });

      if (invalid.length > 0 && job.status === "failed") {
        results.push({
          idempotencyKey: item.idempotencyKey,
          jobId: job.id,
          status: job.status,
          sendAt: job.send_at,
          error: job.error ?? "Invalid recipients",
        });
        continue;
      }

      const isImmediate = isImmediateSend(sendAt, now);

      if (emailJobNeedsDispatch(job.status) && isImmediate) {
        const dispatched = await dispatchCreatedEmailJobs(job, children);
        results.push({
          idempotencyKey: item.idempotencyKey,
          jobId: job.id,
          status: dispatched.result?.status ?? job.status,
          sendAt: job.send_at,
          dispatch: dispatched.mode,
          sent: dispatched.result?.sent,
          failed: dispatched.result?.failed,
        });
        continue;
      }

      if (emailJobNeedsDispatch(job.status) && !isImmediate) {
        try {
          const dispatched = await dispatchCreatedEmailJobs(job, children, {
            sendAt,
          });
          results.push({
            idempotencyKey: item.idempotencyKey,
            jobId: job.id,
            status: job.status,
            sendAt: job.send_at,
            dispatch: dispatched.mode,
          });
        } catch (error) {
          dispatchFailed = true;
          const message =
            error instanceof DelayedDispatchError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Failed to dispatch scheduled job";
          results.push({
            idempotencyKey: item.idempotencyKey,
            jobId: job.id,
            status: job.status,
            sendAt: job.send_at,
            error: message,
          });
        }
        continue;
      }

      results.push({
        idempotencyKey: item.idempotencyKey,
        jobId: job.id,
        status: job.status,
        sendAt: job.send_at,
      });
    } catch (error) {
      results.push({
        idempotencyKey: item.idempotencyKey,
        jobId: "",
        status: "failed",
        sendAt: item.sendAt,
        error: error instanceof Error ? error.message : "Job failed",
      });
    }
  }

  if (dispatchFailed) {
    return Response.json(
      { ok: false, error: "One or more jobs could not be scheduled", results },
      { status: 503 },
    );
  }

  return Response.json({ ok: true, results });
}
