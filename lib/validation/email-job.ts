import { z } from "zod";

const emailSchema = z.string().email();

export const sendJobBodySchema = z.object({
  subject: z.string().min(1).max(998),
  html: z.string().min(1),
  recipients: z.array(z.string()).min(1).max(500),
  replyTo: z.string().email().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export const scheduleJobBodySchema = sendJobBodySchema.extend({
  sendAt: z.string().datetime(),
});

export type SendJobBody = z.infer<typeof sendJobBodySchema>;
export type ScheduleJobBody = z.infer<typeof scheduleJobBodySchema>;

const EMAIL_REGEX =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecipients(recipients: string[]): {
  valid: string[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const raw of recipients) {
    const email = raw.trim().toLowerCase();

    if (!email) {
      continue;
    }

    if (!EMAIL_REGEX.test(email) || !emailSchema.safeParse(email).success) {
      invalid.push(raw);
      continue;
    }

    if (seen.has(email)) {
      continue;
    }

    seen.add(email);
    valid.push(email);
  }

  return { valid, invalid };
}

export function prepareHtml(html: string): string {
  if (html.includes("<")) {
    return html;
  }

  return html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}
