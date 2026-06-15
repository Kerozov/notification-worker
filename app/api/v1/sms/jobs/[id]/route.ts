import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { cancelPendingSmsJob, toSmsJobResponse } from "@/lib/jobs/process-sms";
import { getSmsJobForTenant } from "@/lib/jobs/query-sms";
import {
  formatSmsDeliveryRow,
  getSmsDeliveriesForJob,
  INVALID_PHONE_ERROR,
  summarizeSmsDeliveries,
} from "@/lib/sms/deliveries/store";

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
  const bouncedOnly = request.nextUrl.searchParams.get("bounced") === "true";
  const failedOnly = request.nextUrl.searchParams.get("failed") === "true";

  try {
    const job = await getSmsJobForTenant(tenant.id, id);

    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const deliveries = await getSmsDeliveriesForJob(id, tenant.id);
    const summary = summarizeSmsDeliveries(deliveries);
    const invalidPhones = deliveries
      .filter((d) => d.error?.includes(INVALID_PHONE_ERROR))
      .map((d) => d.recipient);

    const response: Record<string, unknown> = {
      jobId: job.id,
      status: toSmsJobResponse(job, invalidPhones).status,
      body: job.body,
      sendAt: job.send_at,
      sentAt: job.sent_at,
      error: job.error,
      tracking: summary,
      sent: job.sent_count,
      failed: job.failed_count,
    };

    if (includeRecipients || bouncedOnly || failedOnly) {
      let rows = deliveries.map(formatSmsDeliveryRow);

      if (bouncedOnly) {
        rows = rows.filter((row) => row.status === "bounced");
      }

      if (failedOnly) {
        rows = rows.filter((row) => row.status === "failed" || row.error);
      }

      response.recipients = rows;
    }

    if (bouncedOnly && !includeRecipients) {
      response.bouncedPhones = deliveries
        .filter((d) => d.status === "bounced")
        .map((d) => d.recipient);
    }

    return Response.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load SMS job";

    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const { id } = await context.params;

  try {
    const job = await cancelPendingSmsJob(tenant.id, id);

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
      error instanceof Error ? error.message : "Failed to cancel SMS job";

    return Response.json({ error: message }, { status: 400 });
  }
}
