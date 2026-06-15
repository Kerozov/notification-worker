import { NextRequest } from "next/server";
import { isBotOpenUserAgent } from "@/lib/deliveries/open-filter";
import {
  markDeliveryBounced,
  markDeliveryDelivered,
  markDeliveryOpened,
} from "@/lib/deliveries/store";

type ZeptoEmailAddress = {
  email_address?: { address?: string; name?: string };
  address?: string;
};

type ZeptoEventDetail = {
  time?: string;
  user_agent?: string;
  bounced_recipient?: string;
};

type ZeptoEventMessage = {
  email_info?: {
    client_reference?: string;
    processed_time?: string;
    to?: ZeptoEmailAddress[];
  };
  event_data?: {
    details?: ZeptoEventDetail[] | ZeptoEventDetail;
  }[];
};

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

function parseBody(raw: string): ZeptoWebhookPayload | null {
  try {
    return JSON.parse(raw) as ZeptoWebhookPayload;
  } catch {
    // ZeptoMail can also send "data=<urlencoded json>"
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

function classifyEvent(
  eventName: string,
): "opened" | "bounced" | "delivered" | null {
  const name = eventName.toLowerCase();

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
  let updated = 0;
  let skippedBots = 0;
  let notFound = 0;
  let skippedNoJobId = 0;
  let skippedNoRecipients = 0;

  try {
    for (const message of messages) {
      const jobId = message.email_info?.client_reference;

      if (!jobId) {
        skippedNoJobId += 1;
        continue;
      }

      const detail = firstDetail(message);
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
            updated += 1;
          } else {
            notFound += 1;
          }
        } else if (kind === "bounced") {
          await markDeliveryBounced(jobId, recipient, "Email bounced");
          updated += 1;
        } else if (kind === "delivered") {
          await markDeliveryDelivered(jobId, recipient, eventTime);
          updated += 1;
        }
      }
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Webhook handler failed";
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    kind,
    eventNames,
    updated,
    skippedBots,
    notFound,
    skippedNoJobId,
    skippedNoRecipients,
  });
}
