import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { cancelPendingJob } from "@/lib/jobs/process";
import { getJobForTenant } from "@/lib/jobs/query";
import {
  formatDeliveryRow,
  getDeliveriesForJob,
  summarizeDeliveries,
} from "@/lib/deliveries/store";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const { id } = await context.params;
  const includeRecipients =
    request.nextUrl.searchParams.get("recipients") === "true";
  const notOpenedOnly =
    request.nextUrl.searchParams.get("notOpened") === "true";

  try {
    const job = await getJobForTenant(tenant.id, id);

    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const deliveries = await getDeliveriesForJob(id, tenant.id);
    const summary = summarizeDeliveries(deliveries);

    const response: Record<string, unknown> = {
      jobId: job.id,
      status: job.status,
      subject: job.subject,
      sendAt: job.send_at,
      sentAt: job.sent_at,
      tracking: summary,
    };

    if (includeRecipients || notOpenedOnly) {
      let rows = deliveries.map(formatDeliveryRow);

      if (notOpenedOnly) {
        rows = rows.filter((row) => !row.opened && !row.error);
      }

      response.recipients = rows;
    }

    if (notOpenedOnly && !includeRecipients) {
      response.notOpenedEmails = deliveries
        .filter((d) => d.opened_at === null && d.status !== "failed" && d.status !== "bounced")
        .map((d) => d.recipient);
    }

    return Response.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load job";

    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const { id } = await context.params;

  try {
    const job = await cancelPendingJob(tenant.id, id);

    if (!job) {
      return Response.json(
        { error: "Job not found or not cancelable" },
        { status: 404 },
      );
    }

    return Response.json({
      jobId: job.id,
      status: job.status,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel job";

    return Response.json({ error: message }, { status: 500 });
  }
}
