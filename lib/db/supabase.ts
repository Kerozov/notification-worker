import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  api_key_hash: string;
  default_from: string | null;
  default_reply_to: string | null;
  created_at: string;
};

export type EmailJobStatus =
  | "pending"
  | "processing"
  | "sent"
  | "failed"
  | "canceled";

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
  return row as unknown as EmailJob;
}

export function asTenant(row: Record<string, unknown>): Tenant {
  return row as unknown as Tenant;
}
