import type { SmsDeliverySendResult } from "@/lib/sms/deliveries/store";
import {
  prepareNotifierMessageContent,
  sendNotifierMessages,
} from "@/lib/sms/notifier";
import { normalizePhoneNumbers } from "@/lib/validation/sms-job";

const INVALID_PHONE_ERROR = "Invalid phone number (not sent)";

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

function dedupeErrors(errors: string[]): string[] {
  return Array.from(new Set(errors));
}

/**
 * One Notifier request per recipient (the API only accepts a singular `phone`),
 * fanned out with bounded concurrency. Links are shortened once — unique URLs
 * only — before the first send, and a failure on one number does not fail the
 * rest of the cohort.
 */
export async function sendSmsBatch(
  input: SendSmsBatchInput,
): Promise<SendSmsBatchResult> {
  const apiKey = input.apiKey.trim().replace(/^Bearer\s+/i, "");

  if (!apiKey) {
    throw new Error("Notifier API key is required for this tenant");
  }

  // Notifier rejects anything that is not E.164; never send those.
  const { valid: recipients, invalid } = normalizePhoneNumbers(
    input.recipients,
  );

  const invalidDeliveries: SmsDeliverySendResult[] = invalid.map(
    (recipient) => ({ recipient, error: INVALID_PHONE_ERROR }),
  );

  if (recipients.length === 0) {
    return {
      sent: 0,
      failed: invalidDeliveries.length,
      errors: invalidDeliveries.length > 0 ? [INVALID_PHONE_ERROR] : [],
      deliveries: invalidDeliveries,
    };
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
      failed: recipients.length + invalidDeliveries.length,
      errors: dedupeErrors([
        message,
        ...invalidDeliveries.map(() => INVALID_PHONE_ERROR),
      ]),
      deliveries: [
        ...recipients.map((recipient) => ({ recipient, error: message })),
        ...invalidDeliveries,
      ],
    };
  }

  const outcomes = await sendNotifierMessages(
    apiKey,
    recipients,
    preparedContent,
    input.sendAt ?? null,
  );

  const deliveries: SmsDeliverySendResult[] = outcomes.map((outcome) =>
    outcome.message
      ? {
          recipient: outcome.phone,
          providerMessageId: outcome.message.id,
        }
      : {
          recipient: outcome.phone,
          error: outcome.error ?? "Notifier request failed",
        },
  );

  const sent = deliveries.filter((delivery) => !delivery.error).length;
  const errors = dedupeErrors([
    ...deliveries
      .map((delivery) => delivery.error)
      .filter((error): error is string => Boolean(error)),
    ...invalidDeliveries.map(() => INVALID_PHONE_ERROR),
  ]);

  return {
    sent,
    failed: deliveries.length - sent + invalidDeliveries.length,
    errors,
    deliveries: [...deliveries, ...invalidDeliveries],
  };
}
