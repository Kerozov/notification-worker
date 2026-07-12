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
} from "@/lib/jobs/process";
import { dispatchScheduledEmailJob } from "@/lib/trigger/schedule";
import { batchJobsBodySchema } from "@/lib/validation/email-job";

const IMMEDIATE_WINDOW_MS = 60_000;

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

  for (const item of parsed.data.jobs) {
    const sendAt = new Date(item.sendAt);

    try {
      const { job, invalid } = await createEmailJob({
        tenantId: tenant.id,
        subject: item.subject,
        html: item.html,
        recipients: item.recipients,
        from,
        replyTo: item.replyTo ?? parsed.data.replyTo,
        sendAt,
        idempotencyKey: item.idempotencyKey,
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

      const isImmediate = sendAt.getTime() <= now + IMMEDIATE_WINDOW_MS;

      if (job.status === "pending" && isImmediate) {
        const processed = await processJobById(job.id);
        results.push({
          idempotencyKey: item.idempotencyKey,
          jobId: processed?.jobId ?? job.id,
          status: processed?.status ?? job.status,
          sendAt: job.send_at,
          dispatch: "immediate",
          sent: processed?.sent,
          failed: processed?.failed,
        });
        continue;
      }

      if (job.status === "pending" && !isImmediate) {
        let dispatch: string = "queued";
        try {
          const dispatched = await dispatchScheduledEmailJob(job.id, sendAt);
          dispatch = dispatched.mode;
        } catch {
          dispatch = "queued";
        }
        results.push({
          idempotencyKey: item.idempotencyKey,
          jobId: job.id,
          status: job.status,
          sendAt: job.send_at,
          dispatch,
        });
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

  return Response.json({ ok: true, results });
}
