import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { replaceRecipientInJob } from "@/lib/jobs/campaign";
import {
  normalizeRecipients,
  parseJobMerge,
  replaceRecipientBodySchema,
} from "@/lib/validation/email-job";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Swap one address of a job that has not gone out yet — the person changed
 * their email. 409 when that part of the job is already sending or sent: the
 * caller must not record the new address as queued.
 */
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

  const parsed = replaceRecipientBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const [to] = normalizeRecipients([parsed.data.to]).valid;
  if (!to) {
    return Response.json({ error: "Invalid email address" }, { status: 400 });
  }
  const fields = parsed.data.merge
    ? parseJobMerge({ [to]: parsed.data.merge })[to]
    : undefined;

  try {
    const result = await replaceRecipientInJob(
      tenant.id,
      id,
      parsed.data.from,
      to,
      fields,
    );

    if (!result) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const status = result.outcome === "replaced" || result.outcome === "unchanged" ? 200 : 409;
    return Response.json(
      {
        jobId: result.job.id,
        status: result.job.status,
        outcome: result.outcome,
      },
      { status },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to replace recipient";
    return Response.json({ error: message }, { status: 500 });
  }
}
