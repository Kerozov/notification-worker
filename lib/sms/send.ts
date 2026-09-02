import type { SmsDeliverySendResult } from "@/lib/sms/deliveries/store";
import {
  prepareNotifierMessageContent,
  sendNotifierMessage,
} from "@/lib/sms/notifier";
import { uniquePhones } from "@/lib/validation/sms-job";

export type SendSmsBatchInput = {
  apiKey: string;
  body: string;
  recipients: string[];
  sender?: string | null;
  shortenLinks?: boolean;
  campaign?: string | null;
  jobId: string;
  sendAt?: string | null;
};

export type SendSmsBatchResult = {
  sent: number;
  failed: number;
  errors: string[];
  deliveries: SmsDeliverySendResult[];
};

export async function sendSmsBatch(
  input: SendSmsBatchInput,
): Promise<SendSmsBatchResult> {
  const apiKey = input.apiKey.trim().replace(/^Bearer\s+/i, "");
  const recipients = uniquePhones(input.recipients);

  if (!apiKey) {
    throw new Error("Notifier API key is required for this tenant");
  }

  const errors: string[] = [];
  const deliveries: SmsDeliverySendResult[] = [];
  let sent = 0;
  let failed = 0;

  const shortenLinks = input.shortenLinks !== false;
  const linkCache = new Map<string, string>();

  let preparedContent: string;

  try {
    preparedContent = await prepareNotifierMessageContent(
      apiKey,
      input.body,
      shortenLinks,
      linkCache,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to prepare SMS content";
    failed += recipients.length;
    errors.push(message);

    for (const recipient of recipients) {
      deliveries.push({ recipient, error: message });
    }

    return { sent, failed, errors, deliveries };
  }

  for (const recipient of recipients) {
    try {
      const result = await sendNotifierMessage(
        apiKey,
        recipient,
        preparedContent,
        input.sendAt ?? null,
      );

      sent += 1;
      deliveries.push({
        recipient,
        providerMessageId: result.id,
      });
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
