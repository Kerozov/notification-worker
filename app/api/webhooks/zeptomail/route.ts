import { notifyDeliveryEvents, type DeliveryEvent } from "@/lib/events/hook";
import { NextRequest } from "next/server";
import { isBotOpenUserAgent } from "@/lib/deliveries/open-filter";
import {
  markDeliveryBounced,
  markDeliveryClicked,
  markDeliveryComplained,
  markDeliveryDelivered,
  markDeliveryOpened,
} from "@/lib/deliveries/store";
import { bounceTypeOf } from "@/lib/deliveries/retry";
import { scheduleRetry } from "@/lib/jobs/retry";
import { isPacingEnabled } from "@/lib/trigger/schedule";

type ZeptoEmailAddress = {
  email_address?: { address?: string; name?: string };
  address?: string;
};

type ZeptoEventDetail = {
  time?: string;
  user_agent?: string;
  bounced_recipient?: string;
  fblFrom?: string;
  reason?: string;
  diagnostic_message?: string;
  clicked_link?: string;
};

type ZeptoEventMessage = {
  email_info?: {
    client_reference?: string;
    processed_time?: string;
    to?: ZeptoEmailAddress[];
  };
  event_data?: {
    details?: ZeptoEventDetail[] | ZeptoEventDetail;
    /** "softbounce" / "hardbounce" per ZeptoMail's docs. */
    object?: string;
  }[];
};

/** The event name and each event_data.object, for telling soft from hard. */
function bounceLabels(eventNames: string[], message: ZeptoEventMessage): string[] {
  const objects = (message.event_data ?? [])
    .map((block) => block.object)
    .filter((value): value is string => typeof value === "string");
  return [...eventNames, ...objects];
}

function firstDetail(
  message: ZeptoEventMessage,
): ZeptoEventDetail | undefined {
  for (const block of message.event_data ?? []) {
    const details = block.details;

    if (Array.isArray(details)) {
      if (details.length > 0) {
        return details[0];
      }
      continue;
    }

    if (details) {
      return details;
    }
  }

  return undefined;
}

type ZeptoWebhookPayload = {
  event_name?: string[] | string;
  event_message?: ZeptoEventMessage[];
};

type WebhookKind =
  | "opened"
  | "clicked"
  | "complained"
  | "bounced"
  | "delivered";

function parseBody(raw: string): ZeptoWebhookPayload | null {
  try {
    return JSON.parse(raw) as ZeptoWebhookPayload;
  } catch {
    if (raw.startsWith("data=")) {
      try {
        const decoded = decodeURIComponent(raw.slice("data=".length));
        return JSON.parse(decoded) as ZeptoWebhookPayload;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractRecipients(
  message: ZeptoEventMessage,
  detail?: ZeptoEventDetail,
): string[] {
  if (detail?.fblFrom) {
    return [detail.fblFrom];
  }

  if (detail?.bounced_recipient) {
    return [detail.bounced_recipient];
  }

  const to = message.email_info?.to ?? [];
  const recipients: string[] = [];

  for (const entry of to) {
    const address = entry.email_address?.address ?? entry.address;
    if (address) {
      recipients.push(address);
    }
  }

  return recipients;
}

function classifyEvent(eventName: string): WebhookKind | null {
  const name = eventName.toLowerCase();

  if (name.includes("feedback") || name === "fbl") {
    return "complained";
  }
  if (name.includes("click")) {
    return "clicked";
  }
  if (
    name === "email_open" ||
    name === "open" ||
    (name.includes("open") && !name.includes("click"))
  ) {
    return "opened";
  }
  if (name.includes("bounce")) {
    return "bounced";
  }
  if (name.includes("deliver")) {
    return "delivered";
  }

  return null;
}

function bounceMessage(detail?: ZeptoEventDetail): string {
  const parts = [detail?.reason, detail?.diagnostic_message].filter(Boolean);
  return parts.length > 0 ? parts.join(": ") : "Email bounced";
}

export async function POST(request: NextRequest) {
  const expectedSecret = process.env.ZEPTOMAIL_WEBHOOK_SECRET;
  const providedSecret = request.nextUrl.searchParams.get("key");

  if (expectedSecret && providedSecret !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await request.text();
  const payload = parseBody(raw);

  if (!payload) {
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  const eventNames = Array.isArray(payload.event_name)
    ? payload.event_name
    : payload.event_name
      ? [payload.event_name]
      : [];

  const kind = eventNames.map(classifyEvent).find(Boolean) ?? null;

  if (!kind) {
    return Response.json({ ok: true, skipped: "unhandled event", eventNames });
  }

  const messages = payload.event_message ?? [];
  const now = new Date().toISOString();
  let softBounced = 0;
  let updated = 0;
  let skippedBots = 0;
  let notFound = 0;
  let skippedNoJobId = 0;
  let skippedNoRecipients = 0;
  let requeued = 0;
  /** Send job id → earliest time one of its addresses is due again. */
  const retries = new Map<string, Date>();
  /** What changed here, to pass on to the client that sent the mail. */
  const events: DeliveryEvent[] = [];

  try {
    for (const message of messages) {
      const jobId = message.email_info?.client_reference;

      if (!jobId) {
        skippedNoJobId += 1;
        continue;
      }

      const detail = firstDetail(message);
      const bounceType = bounceTypeOf(bounceLabels(eventNames, message));
      const eventTime =
        detail?.time ?? message.email_info?.processed_time ?? now;
      const recipients = extractRecipients(message, detail);

      if (recipients.length === 0) {
        skippedNoRecipients += 1;
        continue;
      }

      for (const recipient of recipients) {
        if (kind === "opened") {
          if (isBotOpenUserAgent(detail?.user_agent)) {
            skippedBots += 1;
            continue;
          }

          const marked = await markDeliveryOpened(jobId, recipient, eventTime);
          if (marked) {
            events.push({ type: "opened", jobId, email: recipient, at: eventTime });
            updated += 1;
          } else {
            notFound += 1;
          }
        } else if (kind === "clicked") {
          const marked = await markDeliveryClicked(
            jobId,
            recipient,
            eventTime,
            detail?.clicked_link,
          );
          if (marked) {
            events.push({
              type: "clicked",
              jobId,
              email: recipient,
              at: eventTime,
              ...(detail?.clicked_link ? { url: detail.clicked_link } : {}),
            });
            updated += 1;
          } else {
            notFound += 1;
          }
        } else if (kind === "complained") {
          const marked = await markDeliveryComplained(
            jobId,
            recipient,
            eventTime,
          );
          if (marked) {
            events.push({ type: "complained", jobId, email: recipient, at: eventTime });
            updated += 1;
          } else {
            notFound += 1;
          }
        } else if (kind === "bounced") {
          const result = await markDeliveryBounced(
            jobId,
            recipient,
            bounceMessage(detail),
            bounceType,
            isPacingEnabled(),
          );
          if (result.outcome === "requeued") {
            requeued += 1;
            const current = retries.get(jobId);
            if (!current || result.retryAt < current) {
              retries.set(jobId, result.retryAt);
            }
          }
          // A requeued address is waiting for its second try, not bounced.
          if (result.outcome === "bounced" && bounceType === "hard") {
            events.push({
              type: "bounced",
              jobId,
              email: recipient,
              at: eventTime,
              error: bounceMessage(detail),
            });
          }
          if (result.outcome !== "ignored") {
            updated += 1;
            if (bounceType === "soft") softBounced += 1;
          }
        } else if (kind === "delivered") {
          await markDeliveryDelivered(jobId, recipient, eventTime);
          events.push({ type: "delivered", jobId, email: recipient, at: eventTime });
          updated += 1;
        }
      }
    }

    for (const [jobId, at] of retries) {
      await scheduleRetry(jobId, at);
    }

    await notifyDeliveryEvents(events);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Webhook handler failed";
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    kind,
    eventNames,
    ...(kind === "bounced" ? { softBounced, requeued } : {}),
    updated,
    skippedBots,
    notFound,
    skippedNoJobId,
    skippedNoRecipients,
  });
}
