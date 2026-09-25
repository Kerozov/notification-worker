import { z } from "zod";
import { uniqueEmails } from "@/lib/recipients/unique";

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

/**
 * Incoming campaign size. The worker stores this list on a parent job, then
 * splits it into send jobs of SEND_CHUNK_SIZE.
 */
export const MAX_RECIPIENTS_PER_JOB = 50_000;

/** Actual ZeptoMail send jobs. A failed pocket is this many people, not the campaign. */
export const SEND_CHUNK_SIZE = 250;

export function chunkItems<T>(items: T[], size = SEND_CHUNK_SIZE): T[][] {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Tiny lists send in this HTTP call. A full job (250) goes to Trigger.dev so the next job can be created immediately. */
export const INLINE_SEND_RECIPIENT_LIMIT = 50;

const MERGE_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export type RecipientMerge = Record<string, string>;
export type JobMerge = Record<string, RecipientMerge>;

/**
 * Per-recipient ZeptoMail merge_info, keyed by lowercased email.
 * Values are truncated; unknown recipients and illegal keys are dropped.
 */
export function parseJobMerge(
  raw: unknown,
  validEmails?: Set<string>,
): JobMerge {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const out: JobMerge = {};

  for (const [emailRaw, fields] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const email = emailRaw.trim().toLowerCase();
    if (!email) continue;
    if (validEmails && !validEmails.has(email)) continue;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      continue;
    }

    const inner: RecipientMerge = {};
    for (const [key, value] of Object.entries(
      fields as Record<string, unknown>,
    )) {
      if (!MERGE_KEY_RE.test(key) || typeof value !== "string") continue;
      inner[key] = value.slice(0, 4000);
    }
    if (Object.keys(inner).length > 0) {
      out[email] = inner;
    }
  }

  return out;
}

export const sendJobBodySchema = z.object({
  subject: z.string().min(1).max(998),
  html: z.string().min(1),
  recipients: z.array(z.string()).min(1).max(MAX_RECIPIENTS_PER_JOB),
  from: fromAddressSchema.optional(),
  replyTo: z.string().email().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  attachments: emailAttachmentsSchema,
  merge: z.record(z.string(), z.record(z.string(), z.string())).optional(),
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

export const removeRecipientsBodySchema = z.object({
  emails: z.array(z.string()).min(1).max(MAX_RECIPIENTS_PER_JOB),
});

/**
 * How many pending jobs one content update may touch. Automations are one job
 * per person, so a rewritten drip is hundreds of these and the caller batches.
 * Per-person HTML is ~20KB — a hundred stays well under the request body cap.
 */
export const MAX_CONTENT_UPDATES = 100;

/**
 * New subject + HTML for jobs that have not started sending. Nothing else:
 * recipients, sender and `send_at` are what the job was accepted with, and a
 * content edit must not be able to move or re-address a scheduled email.
 */
export const updateJobsContentBodySchema = z.object({
  jobs: z
    .array(
      z.object({
        jobId: z.string().min(1).max(80),
        subject: z.string().min(1).max(998),
        html: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_CONTENT_UPDATES),
});

export type SendJobBody = z.infer<typeof sendJobBodySchema>;
export type ScheduleJobBody = z.infer<typeof scheduleJobBodySchema>;
export type BatchJobsBody = z.infer<typeof batchJobsBodySchema>;
export type CancelJobsBody = z.infer<typeof cancelJobsBodySchema>;
export type RemoveRecipientsBody = z.infer<typeof removeRecipientsBodySchema>;
export type UpdateJobsContentBody = z.infer<typeof updateJobsContentBodySchema>;

const EMAIL_REGEX =
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeRecipients(recipients: string[]): {
  valid: string[];
  invalid: string[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;

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
      duplicates += 1;
      continue;
    }

    seen.add(email);
    valid.push(email);
  }

  return { valid, invalid, duplicates };
}

export { uniqueEmails };

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
