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

function isDeliveredRecipient(row: ReturnType<typeof formatDeliveryRow>): boolean {
  return (
    !row.error &&
    row.status !== "failed" &&
    row.status !== "bounced" &&
    row.status !== "complained"
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  const { id } = await context.params;
  const params = request.nextUrl.searchParams;
  const includeRecipients = params.get("recipients") === "true";
  const notOpenedOnly = params.get("notOpened") === "true";
  const notClickedOnly = params.get("notClicked") === "true";
  const complainedOnly = params.get("complained") === "true";
  const bouncedOnly = params.get("bounced") === "true";

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
      sent: job.sent_count,
      failed: job.failed_count,
    };

    const needsRows =
      includeRecipients ||
      notOpenedOnly ||
      notClickedOnly ||
      complainedOnly ||
      bouncedOnly;

    if (needsRows) {
      let rows = deliveries.map(formatDeliveryRow);

      if (notOpenedOnly) {
        rows = rows.filter(
          (row) => isDeliveredRecipient(row) && !row.opened,
        );
      }

      if (notClickedOnly) {
        rows = rows.filter(
          (row) => isDeliveredRecipient(row) && !row.clicked,
        );
      }

      if (complainedOnly) {
        rows = rows.filter((row) => row.complained);
      }

      if (bouncedOnly) {
        rows = rows.filter((row) => row.status === "bounced");
      }

      if (includeRecipients || complainedOnly || bouncedOnly || notClickedOnly) {
        response.recipients = rows;
      }
    }

    if (notOpenedOnly && !includeRecipients) {
      response.notOpenedEmails = deliveries
        .filter(
          (d) =>
            d.sent_at !== null &&
            d.opened_at === null &&
            d.status !== "failed" &&
            d.status !== "bounced" &&
            d.status !== "complained",
        )
        .map((d) => d.recipient);
    }

    if (notClickedOnly && !includeRecipients) {
      response.notClickedEmails = deliveries
        .filter(
          (d) =>
            d.sent_at !== null &&
            d.clicked_at === null &&
            d.status !== "failed" &&
            d.status !== "bounced" &&
            d.status !== "complained",
        )
        .map((d) => d.recipient);
    }

    if (complainedOnly && !includeRecipients) {
      response.complainedEmails = deliveries
        .filter((d) => d.complained_at !== null)
        .map((d) => d.recipient);
    }

    if (bouncedOnly && !includeRecipients) {
      response.bouncedEmails = deliveries
        .filter((d) => d.status === "bounced")
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
