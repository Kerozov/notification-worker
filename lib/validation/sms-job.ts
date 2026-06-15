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

/** Convert common BG formats (0888…, 359…) to E.164 (+359…). */
export function normalizePhoneToE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const compact = trimmed.replace(/[\s()-]/g, "");
  if (E164_REGEX.test(compact)) {
    return compact;
  }

  const digits = trimmed.replace(/\D/g, "");

  if (digits.startsWith("359") && digits.length >= 11) {
    const candidate = `+${digits}`;
    if (E164_REGEX.test(candidate)) {
      return candidate;
    }
  }

  if (digits.startsWith("0") && digits.length === 10) {
    const candidate = `+359${digits.slice(1)}`;
    if (E164_REGEX.test(candidate)) {
      return candidate;
    }
  }

  if (digits.length === 9) {
    const candidate = `+359${digits}`;
    if (E164_REGEX.test(candidate)) {
      return candidate;
    }
  }

  if (digits.length >= 10) {
    const candidate = `+${digits}`;
    if (E164_REGEX.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function normalizePhoneNumbers(recipients: string[]): {
  valid: string[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const raw of recipients) {
    const normalized = normalizePhoneToE164(raw);

    if (!normalized) {
      if (raw.trim()) {
        invalid.push(raw.trim());
      }
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
