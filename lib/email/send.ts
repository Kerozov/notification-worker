import { loadZeptoAttachments } from "@/lib/email/attachments";
import { prepareHtml, type EmailAttachment } from "@/lib/validation/email-job";
import type { DeliverySendResult } from "@/lib/deliveries/store";
import { uniqueEmails } from "@/lib/recipients/unique";

const BATCH_SIZE = 50;
const ZEPTOMAIL_BATCH_URL = "https://api.zeptomail.com/v1.1/email/batch";

export type SendBatchInput = {
  from: string;
  subject: string;
  html: string;
  recipients: string[];
  replyTo?: string | null;
  clientReference: string;
  attachments?: EmailAttachment[];
  merge?: Record<string, Record<string, string>>;
  /** Called after each ZeptoMail request (up to 50 people) so a crash cannot resend those people. */
  onChunk?: (deliveries: DeliverySendResult[]) => Promise<void>;
};

export type SendBatchResult = {
  sent: number;
  failed: number;
  errors: string[];
  deliveries: DeliverySendResult[];
};

type ParsedAddress = {
  address: string;
  name: string;
};

function getApiKey(): string {
  const raw = process.env.ZEPTOMAIL_API_KEY?.trim();

  if (!raw) {
    throw new Error("ZEPTOMAIL_API_KEY is required");
  }

  // Accept either the token alone or the full "Zoho-enczapikey ..." value from ZeptoMail.
  return raw.replace(/^Zoho-enczapikey\s+/i, "");
}

function getApiUrl(): string {
  return process.env.ZEPTOMAIL_API_URL || ZEPTOMAIL_BATCH_URL;
}

export function parseAddress(value: string): ParsedAddress {
  const trimmed = value.trim();
  const match = trimmed.match(/^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/);

  if (match) {
    return { name: match[1].replace(/^"|"$/g, "").trim(), address: match[2] };
  }

  return { name: "", address: trimmed };
}

export type UnsubscribeHeaders = {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click";
};

/**
 * RFC 8058 one-click headers for a recipient's own `unsubscribe_url`, so
 * Gmail and Yahoo show their "Unsubscribe" next to the sender and POST
 * `List-Unsubscribe=One-Click` to that URL. One-click needs https; anything
 * else, or a value that could break the header line, gets no headers.
 */
export function listUnsubscribeHeaders(
  unsubscribeUrl: string | undefined,
): UnsubscribeHeaders | null {
  const value = unsubscribeUrl?.trim();
  if (!value || /[\s<>"]/.test(value)) return null;

  try {
    if (new URL(value).protocol !== "https:") return null;
  } catch {
    return null;
  }

  return {
    "List-Unsubscribe": `<${value}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** `EMAIL_LIST_UNSUBSCRIBE=off` sends without the headers, batched as before. */
function unsubscribeHeadersEnabled(): boolean {
  return process.env.EMAIL_LIST_UNSUBSCRIBE?.trim().toLowerCase() !== "off";
}

export type ZeptoRequestPlan = {
  recipients: string[];
  headers?: UnsubscribeHeaders;
};

/**
 * Which recipients share one ZeptoMail request. The batch API takes
 * `mime_headers` once per request, for everyone in it, and does not fill merge
 * tags inside headers. So a recipient with their own unsubscribe link goes in
 * a request of their own; everyone else is batched by 50 as before.
 */
export function planZeptoRequests(
  recipients: string[],
  merge: SendBatchInput["merge"],
  withUnsubscribeHeaders = true,
): ZeptoRequestPlan[] {
  const plans: ZeptoRequestPlan[] = [];
  let batch: string[] = [];

  for (const recipient of recipients) {
    const headers = withUnsubscribeHeaders
      ? listUnsubscribeHeaders(merge?.[recipient]?.unsubscribe_url)
      : null;

    if (headers) {
      plans.push({ recipients: [recipient], headers });
      continue;
    }

    batch.push(recipient);
    if (batch.length === BATCH_SIZE) {
      plans.push({ recipients: batch });
      batch = [];
    }
  }

  if (batch.length > 0) plans.push({ recipients: batch });
  return plans;
}

export async function sendEmailBatch(
  input: SendBatchInput,
): Promise<SendBatchResult> {
  const apiKey = getApiKey();
  const url = getApiUrl();
  const html = prepareHtml(input.html);
  const from = parseAddress(input.from);
  const replyTo = input.replyTo ? parseAddress(input.replyTo) : null;
  const attachments = await loadZeptoAttachments(input.attachments);
  const recipients = uniqueEmails(input.recipients);
  const plans = planZeptoRequests(
    recipients,
    input.merge,
    unsubscribeHeadersEnabled(),
  );

  const errors: string[] = [];
  const deliveries: DeliverySendResult[] = [];
  let sent = 0;
  let failed = 0;

  for (const plan of plans) {
    const chunk = plan.recipients;

    const body = {
      from: { address: from.address, name: from.name },
      to: chunk.map((address) => {
        const mergeInfo = input.merge?.[address];
        return {
          email_address: {
            address,
            name: mergeInfo?.name ?? "",
          },
          ...(mergeInfo && Object.keys(mergeInfo).length > 0
            ? { merge_info: mergeInfo }
            : {}),
        };
      }),
      ...(replyTo
        ? { reply_to: [{ address: replyTo.address, name: replyTo.name }] }
        : {}),
      subject: input.subject,
      htmlbody: html,
      track_opens: true,
      track_clicks: true,
      client_reference: input.clientReference,
      ...(plan.headers ? { mime_headers: plan.headers } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    let response: Response;

    const chunkDeliveries: DeliverySendResult[] = [];

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Zoho-enczapikey ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ZeptoMail request failed";
      failed += chunk.length;
      errors.push(message);
      for (const recipient of chunk) {
        chunkDeliveries.push({ recipient, error: message });
      }
      deliveries.push(...chunkDeliveries);
      if (input.onChunk) await input.onChunk(chunkDeliveries);
      continue;
    }

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = extractZeptoError(payload, response.status);
      failed += chunk.length;
      errors.push(message);
      for (const recipient of chunk) {
        chunkDeliveries.push({ recipient, error: message });
      }
      deliveries.push(...chunkDeliveries);
      if (input.onChunk) await input.onChunk(chunkDeliveries);
      continue;
    }

    const requestId = extractRequestId(payload);

    for (const recipient of chunk) {
      sent += 1;
      chunkDeliveries.push({ recipient, providerMessageId: requestId });
    }
    deliveries.push(...chunkDeliveries);
    if (input.onChunk) await input.onChunk(chunkDeliveries);
  }

  return { sent, failed, errors, deliveries };
}

function extractRequestId(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "request_id" in payload) {
    const value = (payload as { request_id?: unknown }).request_id;
    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}

function extractZeptoError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;

    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      const details = (error as { details?: unknown }).details;

      if (Array.isArray(details) && details.length > 0) {
        const detailMessages = details
          .map((d) =>
            d && typeof d === "object" && "message" in d
              ? String((d as { message?: unknown }).message)
              : null,
          )
          .filter(Boolean);

        if (detailMessages.length > 0) {
          return detailMessages.join("; ");
        }
      }

      if (typeof message === "string") {
        return message;
      }
    }

    const topMessage = (payload as { message?: unknown }).message;
    if (typeof topMessage === "string") {
      return topMessage;
    }
  }

  return `ZeptoMail request failed with status ${status}`;
}
