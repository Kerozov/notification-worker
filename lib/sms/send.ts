import type { SmsDeliverySendResult } from "@/lib/sms/deliveries/store";
import {
  prepareNotifierMessageContent,
  sendNotifierMessages,
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

/**
 * One Notifier messages request for the whole recipient list.
 * Links are shortened once (unique URLs only) before that single send.
 */
export async function sendSmsBatch(
  input: SendSmsBatchInput,
): Promise<SendSmsBatchResult> {
  const apiKey = input.apiKey.trim().replace(/^Bearer\s+/i, "");
  const recipients = uniquePhones(input.recipients);

  if (!apiKey) {
    throw new Error("Notifier API key is required for this tenant");
  }

  if (recipients.length === 0) {
    return { sent: 0, failed: 0, errors: [], deliveries: [] };
  }

  const shortenLinks = input.shortenLinks !== false;

  let preparedContent: string;

  try {
    preparedContent = await prepareNotifierMessageContent(
      apiKey,
      input.body,
      shortenLinks,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to prepare SMS content";

    return {
      sent: 0,
      failed: recipients.length,
      errors: [message],
      deliveries: recipients.map((recipient) => ({ recipient, error: message })),
    };
  }

  try {
    const rows = await sendNotifierMessages(
      apiKey,
      recipients,
      preparedContent,
      input.sendAt ?? null,
    );

    const byPhone = new Map(rows.map((row) => [row.to, row] as const));

    const deliveries: SmsDeliverySendResult[] = recipients.map(
      (recipient, index) => ({
        recipient,
        providerMessageId:
          byPhone.get(recipient)?.id ?? rows[index]?.id ?? rows[0]?.id,
      }),
    );

    return {
      sent: deliveries.length,
      failed: 0,
      errors: [],
      deliveries,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Notifier request failed";

    return {
      sent: 0,
      failed: recipients.length,
      errors: [message],
      deliveries: recipients.map((recipient) => ({ recipient, error: message })),
    };
  }
}
