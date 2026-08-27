import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { cancelPendingJob } from "@/lib/jobs/process";
import { getJobForTenant } from "@/lib/jobs/query";
import {
  formatDeliveryRow,
  summarizeDeliveries,
  type DeliveryStatus,
} from "@/lib/deliveries/store";
import {
  campaignStatusFromChildren,
  getDeliveriesForEmailJob,
  isCampaignJob,
  listChildJobs,
  refreshCampaignParent,
} from "@/lib/jobs/campaign";

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

function emptyRecipientRow(
  email: string,
  status: DeliveryStatus,
  sentAt: string | null,
) {
  return {
    email,
    status,
    opened: false,
    openedAt: null,
    clicked: false,
    clickedAt: null,
    clickedUrl: null,
    complained: false,
    complainedAt: null,
    deliveredAt: null,
    sentAt,
    error: null,
  };
}

function statusFromChildJob(status: string): DeliveryStatus {
  if (
    status === "sent" ||
    status === "failed" ||
    status === "canceled" ||
    status === "pending"
  ) {
    return status;
  }
  return "pending";
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
    const jobRow = await getJobForTenant(tenant.id, id);

    if (!jobRow) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    let job = jobRow;
    const children = isCampaignJob(job) ? await listChildJobs(job.id) : [];

    if (
      isCampaignJob(job) &&
      (job.status === "pending" || job.status === "processing")
    ) {
      const combined = campaignStatusFromChildren(
        job.status,
        job.recipients,
        children,
      );
      const sent = children.reduce((sum, child) => sum + child.sent_count, 0);
      if (combined !== job.status || sent !== job.sent_count) {
        try {
          job = (await refreshCampaignParent(job.id)) ?? job;
        } catch (error) {
          console.error("refreshCampaignParent:", error);
        }
      }
    }

    const deliveries = await getDeliveriesForEmailJob(job);
    const summary = summarizeDeliveries(deliveries);

    const response: Record<string, unknown> = {
      jobId: job.id,
      status: job.status,
      subject: job.subject,
      sendAt: job.send_at,
      sentAt: job.sent_at,
      kind: job.kind,
      tracking: summary.total > 0 ? summary : {
        ...summary,
        total: job.recipients.length,
      },
      sent: job.sent_count,
      failed: job.failed_count,
      recipientCount: job.recipients.length,
    };

    if (job.parent_id) {
      response.parentId = job.parent_id;
    }

    if (children.length > 0) {
      response.jobs = children.map((child) => ({
        jobId: child.id,
        status: child.status,
        sent: child.sent_count,
        failed: child.failed_count,
        recipientCount: child.recipients.length,
        sendAt: child.send_at,
        sentAt: child.sent_at,
      }));
    }

    const needsRows =
      includeRecipients ||
      notOpenedOnly ||
      notClickedOnly ||
      complainedOnly ||
      bouncedOnly;

    if (needsRows) {
      let rows = deliveries.map(formatDeliveryRow);

      if (rows.length === 0) {
        if (isCampaignJob(job) && children.length > 0) {
          rows = children.flatMap((child) =>
            child.recipients.map((email) =>
              emptyRecipientRow(
                email,
                statusFromChildJob(child.status),
                child.sent_at,
              ),
            ),
          );
        } else {
          const fallbackStatus =
            job.status === "failed" ||
            job.status === "canceled" ||
            job.status === "sent"
              ? job.status
              : "pending";
          rows = job.recipients.map((email) =>
            emptyRecipientRow(email, fallbackStatus, job.sent_at),
          );
        }
      } else if (isCampaignJob(job) && rows.length < job.recipients.length) {
        const have = new Set(
          rows.map((row) => row.email.trim().toLowerCase()),
        );
        const childStatus = new Map<string, DeliveryStatus>();
        for (const child of children) {
          for (const email of child.recipients) {
            childStatus.set(
              email.trim().toLowerCase(),
              statusFromChildJob(child.status),
            );
          }
        }
        for (const email of job.recipients) {
          const key = email.trim().toLowerCase();
          if (have.has(key)) continue;
          rows.push(
            emptyRecipientRow(email, childStatus.get(key) ?? "pending", null),
          );
        }
      }

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

    if (job) {
      return Response.json({
        jobId: job.id,
        status: job.status,
      });
    }

    const existing = await getJobForTenant(tenant.id, id);
    if (!existing) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    // Already sending or already sent — caller must not mark the delivery canceled.
    return Response.json(
      {
        error: "Job not cancelable",
        status: existing.status,
      },
      { status: 409 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel job";

    return Response.json({ error: message }, { status: 500 });
  }
}
