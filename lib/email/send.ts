import { Resend } from "resend";
import { prepareHtml } from "@/lib/validation/email-job";

const BATCH_SIZE = 50;

export type SendBatchInput = {
  from: string;
  subject: string;
  html: string;
  recipients: string[];
  replyTo?: string | null;
};

export type SendBatchResult = {
  sent: number;
  failed: number;
  errors: string[];
};

function getResendClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required");
  }

  return new Resend(apiKey);
}

export async function sendEmailBatch(
  input: SendBatchInput,
): Promise<SendBatchResult> {
  const resend = getResendClient();
  const html = prepareHtml(input.html);
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < input.recipients.length; i += BATCH_SIZE) {
    const chunk = input.recipients.slice(i, i + BATCH_SIZE);

    const payload = chunk.map((to) => ({
      from: input.from,
      to,
      subject: input.subject,
      html,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    }));

    const { error } = await resend.batch.send(payload);

    if (error) {
      failed += chunk.length;
      errors.push(error.message);
      continue;
    }

    sent += chunk.length;
  }

  return { sent, failed, errors };
}
