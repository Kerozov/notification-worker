import { z } from "zod";

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export const sendSmsBodySchema = z.object({
  body: z.string().min(1).max(1024),
  recipients: z.array(z.string()).min(1).max(500),
  sender: z.string().min(1).max(14).optional(),
  shortenLinks: z.boolean().optional(),
  campaign: z.string().min(1).max(255).optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export const scheduleSmsBodySchema = sendSmsBodySchema.extend({
  sendAt: z.string().datetime(),
});

export type SendSmsBody = z.infer<typeof sendSmsBodySchema>;
export type ScheduleSmsBody = z.infer<typeof scheduleSmsBodySchema>;

export function normalizePhoneNumbers(recipients: string[]): {
  valid: string[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const raw of recipients) {
    const trimmed = raw.trim();

    if (!trimmed) {
      continue;
    }

    const normalized = trimmed.replace(/[\s()-]/g, "");

    if (!E164_REGEX.test(normalized)) {
      invalid.push(trimmed);
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    valid.push(normalized);
  }

  return { valid, invalid };
}
