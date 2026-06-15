import { getSupabaseAdmin } from "@/lib/db/supabase";

export const INVALID_PHONE_ERROR = "Invalid phone number (not sent)";

export type SmsDeliveryStatus =
  | "pending"
  | "sent"
  | "failed"
  | "delivered"
  | "bounced";

export type SmsDelivery = {
  id: string;
  job_id: string;
  tenant_id: string;
  recipient: string;
  provider: string;
  provider_message_id: string | null;
  status: SmsDeliveryStatus;
  error: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SmsDeliverySendResult = {
  recipient: string;
  providerMessageId?: string;
  error?: string;
};

function asDelivery(row: Record<string, unknown>): SmsDelivery {
  return row as unknown as SmsDelivery;
}

function normalizePhone(value: string): string {
  return value.trim().replace(/[\s()-]/g, "");
}

export async function recordInvalidSmsRecipients(
  jobId: string,
  tenantId: string,
  invalid: string[],
): Promise<void> {
  if (invalid.length === 0) {
    return;
  }

  await recordSmsDeliveryResults(
    jobId,
    tenantId,
    invalid.map((recipient) => ({
      recipient,
      error: INVALID_PHONE_ERROR,
    })),
  );
}

export async function recordSmsDeliveryResults(
  jobId: string,
  tenantId: string,
  results: SmsDeliverySendResult[],
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  for (const result of results) {
    const status: SmsDeliveryStatus = result.error ? "failed" : "sent";

    const { error } = await supabase.from("sms_deliveries").upsert(
      {
        job_id: jobId,
        tenant_id: tenantId,
        recipient: normalizePhone(result.recipient),
        provider: "notifier",
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
        `Failed to record SMS delivery (${result.recipient}): ${error.message}. Run migration 006_sms.sql in Supabase.`,
      );
    }
  }
}

export async function getSmsDeliveriesForJob(
  jobId: string,
  tenantId: string,
): Promise<SmsDelivery[]> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("sms_deliveries")
    .select("*")
    .eq("job_id", jobId)
    .eq("tenant_id", tenantId)
    .order("recipient", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(asDelivery);
}

export function summarizeSmsDeliveries(deliveries: SmsDelivery[]) {
  const invalid = deliveries.filter((d) =>
    d.error?.includes(INVALID_PHONE_ERROR),
  ).length;
  const failed = deliveries.filter(
    (d) => d.status === "failed" && !d.error?.includes(INVALID_PHONE_ERROR),
  ).length;
  const bounced = deliveries.filter((d) => d.status === "bounced").length;
  const delivered = deliveries.filter((d) => d.delivered_at !== null).length;
  const sent = deliveries.filter(
    (d) =>
      d.status !== "failed" &&
      d.status !== "bounced" &&
      d.status !== "pending",
  ).length;

  return {
    total: deliveries.length,
    sent,
    failed,
    bounced,
    invalid,
    delivered,
  };
}

export function formatSmsDeliveryRow(delivery: SmsDelivery) {
  return {
    phone: delivery.recipient,
    status: delivery.status,
    delivered: delivery.delivered_at !== null,
    deliveredAt: delivery.delivered_at,
    sentAt: delivery.sent_at,
    error: delivery.error,
    providerMessageId: delivery.provider_message_id,
  };
}
