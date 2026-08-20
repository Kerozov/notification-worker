import { z } from "zod";

const emailSchema = z.string().email();

const FROM_ADDRESS_REGEX =
  /^(?:[^<>]+<\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*>|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

export const fromAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .refine((value) => FROM_ADDRESS_REGEX.test(value), {
    message: "Invalid from address. Use email or Name <email@domain.com>",
  });

export const emailAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), {
      message: "Attachment URL must be https",
    }),
  contentType: z.string().trim().min(1).max(100),
});

export const emailAttachmentsSchema = z
  .array(emailAttachmentSchema)
  .max(5)
  .optional();

export type EmailAttachment = z.infer<typeof emailAttachmentSchema>;

export function parseStoredAttachments(raw: unknown): EmailAttachment[] {
  const parsed = z.array(emailAttachmentSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export const sendJobBodySchema = z.object({
  subject: z.string().min(1).max(998),
  html: z.string().min(1),
  recipients: z.array(z.string()).min(1).max(500),
  from: fromAddressSchema.optional(),
  replyTo: z.string().email().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  attachments: emailAttachmentsSchema,
});

export const scheduleJobBodySchema = sendJobBodySchema.extend({
  sendAt: z.string().datetime(),
});

export const batchJobsBodySchema = z.object({
  from: fromAddressSchema.optional(),
  replyTo: z.string().email().optional(),
  jobs: z.array(scheduleJobBodySchema).min(1).max(30),
});

export const cancelJobsBodySchema = z
  .object({
    jobIds: z.array(z.string().min(1).max(80)).max(200).optional(),
    idempotencyKeys: z.array(z.string().min(1).max(255)).max(200).optional(),
  })
  .refine(
    (value) =>
      (value.jobIds?.length ?? 0) > 0 || (value.idempotencyKeys?.length ?? 0) > 0,
    { message: "jobIds or idempotencyKeys is required" },
  );

export type SendJobBody = z.infer<typeof sendJobBodySchema>;
export type ScheduleJobBody = z.infer<typeof scheduleJobBodySchema>;
export type BatchJobsBody = z.infer<typeof batchJobsBodySchema>;
export type CancelJobsBody = z.infer<typeof cancelJobsBodySchema>;

const EMAIL_REGEX =
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeRecipients(recipients: string[]): {
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

    const email = trimmed.toLowerCase();

    if (
      !EMAIL_REGEX.test(email) ||
      !emailSchema.safeParse(email).success ||
      email.endsWith(".") ||
      email.includes("..")
    ) {
      invalid.push(trimmed);
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
