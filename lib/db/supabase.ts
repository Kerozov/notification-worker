import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  parseJobMerge,
  parseStoredAttachments,
  type EmailAttachment,
  type JobMerge,
} from "@/lib/validation/email-job";

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  api_key_hash: string;
  default_from: string | null;
  default_reply_to: string | null;
  default_sms_sender: string | null;
  notifier_api_key: string | null;
  /** Missing before migration 013 — read as false. */
  can_act_for_tenants?: boolean | null;
  created_at: string;
  /**
   * Set only on the tenant a request resolved to through an extra key
   * (`tenant_api_keys`), never stored. Such a key never acts for others.
   */
  auth_key_id?: string | null;
};

export type EmailJobStatus =
  | "pending"
  | "processing"
  | "sent"
  | "failed"
  | "canceled";

export type EmailJobKind = "send" | "campaign";

export type EmailJob = {
  id: string;
  tenant_id: string;
  idempotency_key: string | null;
  status: EmailJobStatus;
  send_at: string;
  subject: string;
  html: string;
  recipients: string[];
  from_email: string | null;
  reply_to: string | null;
  sent_count: number;
  failed_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  attachments: EmailAttachment[];
  merge: JobMerge;
  kind: EmailJobKind;
  parent_id: string | null;
};

export type SmsJobStatus =
  | "pending"
  | "processing"
  | "sent"
  | "failed"
  | "canceled";

export type SmsJob = {
  id: string;
  tenant_id: string;
  idempotency_key: string | null;
  status: SmsJobStatus;
  send_at: string;
  body: string;
  recipients: string[];
  sender: string | null;
  /** Missing on rows written before migration 012 — those were always shortened. */
  shorten_links?: boolean | null;
  sent_count: number;
  failed_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

let adminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  if (!adminClient) {
    adminClient = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return adminClient;
}

export function asEmailJob(row: Record<string, unknown>): EmailJob {
  const job = row as unknown as EmailJob;
  const recipients = Array.isArray(row.recipients)
    ? (row.recipients as unknown[]).map((value) => String(value))
    : [];
  return {
    ...job,
    recipients,
    attachments: parseStoredAttachments(row.attachments),
    merge: parseJobMerge(row.merge),
    kind: row.kind === "campaign" ? "campaign" : "send",
    parent_id:
      typeof row.parent_id === "string" && row.parent_id
        ? row.parent_id
        : null,
  };
}

export function asSmsJob(row: Record<string, unknown>): SmsJob {
  return row as unknown as SmsJob;
}

export function asTenant(row: Record<string, unknown>): Tenant {
  return row as unknown as Tenant;
}
