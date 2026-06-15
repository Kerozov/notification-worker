import { NextRequest } from "next/server";
import {
  markDeliveryBounced,
  markDeliveryDelivered,
  markDeliveryOpened,
} from "@/lib/deliveries/store";

type ZeptoEmailAddress = {
  email_address?: { address?: string; name?: string };
  address?: string;
};

type ZeptoEventMessage = {
  email_info?: {
    client_reference?: string;
    to?: ZeptoEmailAddress[];
  };
  event_data?: {
    details?: { time?: string };
  }[];
};

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

function extractRecipients(message: ZeptoEventMessage): string[] {
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

function classifyEvent(eventName: string): "opened" | "bounced" | "delivered" | null {
  const name = eventName.toLowerCase();

  if (name.includes("open")) {
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
    return Response.json({ ok: true, skipped: "unhandled event" });
  }

  const messages = payload.event_message ?? [];
  const now = new Date().toISOString();
  let updated = 0;

  try {
    for (const message of messages) {
      const jobId = message.email_info?.client_reference;

      if (!jobId) {
        continue;
      }

      const eventTime = message.event_data?.[0]?.details?.time ?? now;
      const recipients = extractRecipients(message);

      for (const recipient of recipients) {
        if (kind === "opened") {
          await markDeliveryOpened(jobId, recipient, eventTime);
        } else if (kind === "bounced") {
          await markDeliveryBounced(jobId, recipient, "Email bounced");
        } else if (kind === "delivered") {
          await markDeliveryDelivered(jobId, recipient, eventTime);
        }
        updated += 1;
      }
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Webhook handler failed";
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({ ok: true, kind, updated });
}
