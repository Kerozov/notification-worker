import { getSupabaseAdmin } from "@/lib/db/supabase";
import {
  INVALID_EMAIL_ERROR,
  isInvalidDeliveryError,
} from "@/lib/deliveries/stats";

export { INVALID_EMAIL_ERROR } from "@/lib/deliveries/stats";

export type DeliveryStatus =
  | "pending"
  | "sent"
  | "failed"
  | "delivered"
  | "opened"
  | "bounced";

export type EmailDelivery = {
  id: string;
  job_id: string;
  tenant_id: string;
  recipient: string;
  provider: string;
  provider_message_id: string | null;
  status: DeliveryStatus;
  error: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeliverySendResult = {
  recipient: string;
  providerMessageId?: string;
  error?: string;
};

function asDelivery(row: Record<string, unknown>): EmailDelivery {
  return row as unknown as EmailDelivery;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function recordInvalidRecipients(
  jobId: string,
  tenantId: string,
  invalid: string[],
): Promise<void> {
  if (invalid.length === 0) {
    return;
  }

  await recordDeliveryResults(
    jobId,
    tenantId,
    invalid.map((recipient) => ({
      recipient,
      error: INVALID_EMAIL_ERROR,
    })),
  );
}

export async function recordDeliveryResults(
  jobId: string,
  tenantId: string,
  results: DeliverySendResult[],
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  for (const result of results) {
    const status: DeliveryStatus = result.error ? "failed" : "sent";

    const { error } = await supabase.from("email_deliveries").upsert(
      {
        job_id: jobId,
        tenant_id: tenantId,
        recipient: normalizeEmail(result.recipient),
        provider: "zeptomail",
        provider_message_id: result.providerMessageId ?? null,
        status,
        error: result.error ?? null,
        sent_at: result.error ? null : now,
        updated_at: now,
      },
      { onConflict: "job_id,recipient" },
    );

    if (error) {
      throw new Error(
        `Failed to record delivery (${result.recipient}): ${error.message}. Run migrations 003 and 004 in Supabase.`,
      );
    }
  }
}

export async function markDeliveryOpened(
  jobId: string,
  recipient: string,
  openedAt: string,
): Promise<boolean> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_deliveries")
    .update({
      status: "opened",
      opened_at: openedAt,
      updated_at: new Date().toISOString(),
    })
    .eq("job_id", jobId)
    .eq("recipient", normalizeEmail(recipient))
    .is("opened_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

export async function markDeliveryBounced(
  jobId: string,
  recipient: string,
  error: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  await supabase
    .from("email_deliveries")
    .update({
      status: "bounced",
      error,
      updated_at: new Date().toISOString(),
    })
    .eq("job_id", jobId)
    .eq("recipient", normalizeEmail(recipient));
}

export async function markDeliveryDelivered(
  jobId: string,
  recipient: string,
  deliveredAt: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data } = await supabase
    .from("email_deliveries")
    .select("status")
    .eq("job_id", jobId)
    .eq("recipient", normalizeEmail(recipient))
    .maybeSingle();

  if (!data || data.status === "opened") {
    return;
  }

  await supabase
    .from("email_deliveries")
    .update({
      status: "delivered",
      delivered_at: deliveredAt,
      updated_at: new Date().toISOString(),
    })
    .eq("job_id", jobId)
    .eq("recipient", normalizeEmail(recipient));
}

export async function getDeliveriesForJob(
  jobId: string,
  tenantId: string,
): Promise<EmailDelivery[]> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_deliveries")
    .select("*")
    .eq("job_id", jobId)
    .eq("tenant_id", tenantId)
    .order("recipient", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(asDelivery);
}

export function summarizeDeliveries(deliveries: EmailDelivery[]) {
  const opened = deliveries.filter((d) => d.opened_at !== null).length;
  const invalid = deliveries.filter((d) =>
    isInvalidDeliveryError(d.error),
  ).length;
  const failed = deliveries.filter(
    (d) =>
      (d.status === "failed" || d.status === "bounced") &&
      !isInvalidDeliveryError(d.error),
  ).length;
  const sent = deliveries.filter(
    (d) =>
      d.status !== "failed" &&
      d.status !== "bounced" &&
      d.status !== "pending",
  ).length;
  const notOpened = deliveries.filter(
    (d) =>
      d.sent_at !== null &&
      d.opened_at === null &&
      d.status !== "failed" &&
      d.status !== "bounced",
  ).length;

  return {
    total: deliveries.length,
    sent,
    failed,
    invalid,
    opened,
    notOpened,
  };
}

export function formatDeliveryRow(delivery: EmailDelivery) {
  return {
    email: delivery.recipient,
    status: delivery.status,
    opened: delivery.opened_at !== null,
    openedAt: delivery.opened_at,
    deliveredAt: delivery.delivered_at,
    sentAt: delivery.sent_at,
    error: delivery.error,
  };
}

export async function getOpenStatsByJobIds(
  jobIds: string[],
): Promise<Map<string, { opened: number; notOpened: number; total: number }>> {
  const stats = new Map<
    string,
    { opened: number; notOpened: number; total: number }
  >();

  if (jobIds.length === 0) {
    return stats;
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_deliveries")
    .select("job_id, opened_at, sent_at, status")
    .in("job_id", jobIds);

  if (error) {
    throw new Error(error.message);
  }

  for (const row of data ?? []) {
    const jobId = row.job_id as string;
    const current = stats.get(jobId) ?? { opened: 0, notOpened: 0, total: 0 };
    current.total += 1;

    if (row.opened_at) {
      current.opened += 1;
    } else if (
      row.sent_at &&
      row.status !== "failed" &&
      row.status !== "bounced"
    ) {
      current.notOpened += 1;
    }

    stats.set(jobId, current);
  }

  return stats;
}
