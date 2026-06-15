import type { SmsDeliverySendResult } from "@/lib/sms/deliveries/store";

const BATCH_SIZE = 100;
const NOTIFIER_BULK_URL = "https://usenotifier.com/api/sms/bulk";
const NOTIFIER_GHL_URL =
  "https://notifierbg.com/api/integrations/callbacks/go-high-level";

export type SendSmsBatchInput = {
  apiKey: string;
  body: string;
  recipients: string[];
  sender?: string | null;
  shortenLinks?: boolean;
  campaign?: string | null;
  jobId: string;
};

export type SendSmsBatchResult = {
  sent: number;
  failed: number;
  errors: string[];
  deliveries: SmsDeliverySendResult[];
};

type NotifierMessage = {
  to: string;
  body: string;
  sender?: string;
  uuid?: string;
  campaign?: string;
  shortenLinks?: boolean;
};

type NotifierResponseItem = {
  uuid?: string;
  to?: string;
  status?: string;
  failure_reason?: string | null;
};

function normalizeNotifierApiKey(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, "");
}

function getApiUrl(): string {
  return process.env.NOTIFIER_API_URL?.trim() || NOTIFIER_BULK_URL;
}

/** Notifier.bg GoHighLevel integration (used by funnel svetoslava). */
export function isGhlNotifierUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("go-high-level") ||
    lower.includes("notifierbg.com/api/integrations")
  );
}

function deliveryUuid(jobId: string, recipient: string): string {
  return `${jobId}:${recipient}`;
}

export async function sendSmsBatch(
  input: SendSmsBatchInput,
): Promise<SendSmsBatchResult> {
  const apiKey = normalizeNotifierApiKey(input.apiKey);

  if (!apiKey) {
    throw new Error("Notifier API key is required for this tenant");
  }

  const url = getApiUrl();

  if (isGhlNotifierUrl(url)) {
    return sendGhlSmsBatch(input, url, apiKey);
  }

  return sendBulkSmsBatch(input, url, apiKey);
}

/** Per-recipient POST — same contract as funnel-master-svetoslava. */
async function sendGhlSmsBatch(
  input: SendSmsBatchInput,
  url: string,
  apiKey: string,
): Promise<SendSmsBatchResult> {
  const errors: string[] = [];
  const deliveries: SmsDeliverySendResult[] = [];
  let sent = 0;
  let failed = 0;
  const sendAt = new Date().toISOString();

  for (const recipient of input.recipients) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone: recipient,
          customData: {
            content: input.body,
            send_at: sendAt,
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const message =
          text.trim() || `Notifier request failed with status ${response.status}`;
        failed += 1;
        errors.push(`${recipient}: ${message}`);
        deliveries.push({ recipient, error: message });
        continue;
      }

      sent += 1;
      deliveries.push({ recipient });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Notifier request failed";
      failed += 1;
      errors.push(`${recipient}: ${message}`);
      deliveries.push({ recipient, error: message });
    }
  }

  return { sent, failed, errors, deliveries };
}

/** Bulk array POST — usenotifier.com API. */
async function sendBulkSmsBatch(
  input: SendSmsBatchInput,
  url: string,
  apiKey: string,
): Promise<SendSmsBatchResult> {
  const errors: string[] = [];
  const deliveries: SmsDeliverySendResult[] = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < input.recipients.length; i += BATCH_SIZE) {
    const chunk = input.recipients.slice(i, i + BATCH_SIZE);
    const payload: NotifierMessage[] = chunk.map((recipient) => ({
      to: recipient,
      body: input.body,
      uuid: deliveryUuid(input.jobId, recipient),
      ...(input.sender ? { sender: input.sender } : {}),
      ...(input.campaign ? { campaign: input.campaign } : {}),
      ...(input.shortenLinks === false ? { shortenLinks: false } : {}),
    }));

    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Notifier request failed";
      failed += chunk.length;
      errors.push(message);
      for (const recipient of chunk) {
        deliveries.push({ recipient, error: message });
      }
      continue;
    }

    let body: unknown = null;

    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const message = extractNotifierError(body, response.status);
      failed += chunk.length;
      errors.push(message);
      for (const recipient of chunk) {
        deliveries.push({ recipient, error: message });
      }
      continue;
    }

    const byPhone = mapNotifierResults(body);

    for (const recipient of chunk) {
      const item = byPhone.get(recipient);

      if (!item) {
        failed += 1;
        deliveries.push({
          recipient,
          error: "No response for recipient from Notifier",
        });
        continue;
      }

      if (item.failure_reason || item.status === "failed") {
        failed += 1;
        deliveries.push({
          recipient,
          error: item.failure_reason ?? "SMS failed",
          providerMessageId: item.uuid,
        });
        continue;
      }

      sent += 1;
      deliveries.push({
        recipient,
        providerMessageId: item.uuid,
      });
    }
  }

  return { sent, failed, errors, deliveries };
}

function mapNotifierResults(payload: unknown): Map<string, NotifierResponseItem> {
  const map = new Map<string, NotifierResponseItem>();

  if (!payload || typeof payload !== "object") {
    return map;
  }

  const data = (payload as { data?: unknown }).data;

  if (!Array.isArray(data)) {
    return map;
  }

  for (const item of data) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const row = item as NotifierResponseItem;
    const phone = row.to?.replace(/[\s()-]/g, "");

    if (phone) {
      map.set(phone, row);
    }
  }

  return map;
}

function extractNotifierError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const message = (payload as { message?: unknown }).message;

    if (typeof message === "string") {
      return message;
    }

    const error = (payload as { error?: unknown }).error;

    if (typeof error === "string") {
      return error;
    }
  }

  return `Notifier request failed with status ${status}`;
}

export { NOTIFIER_BULK_URL, NOTIFIER_GHL_URL };
