import { getSupabaseAdmin } from "@/lib/db/supabase";
import {
  INVALID_EMAIL_ERROR,
  isInvalidDeliveryError,
} from "@/lib/deliveries/stats";

export { INVALID_EMAIL_ERROR } from "@/lib/deliveries/stats";

export const COMPLAINT_ERROR = "Reported as spam (feedback loop)";

export type DeliveryStatus =
  | "pending"
  | "sent"
  | "failed"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "canceled";

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
  clicked_at: string | null;
  clicked_url: string | null;
  complained_at: string | null;
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

const DELIVERY_PAGE = 1000;
const INSERT_CHUNK = 500;

function isTerminalStatus(status: string): boolean {
  return (
    status === "complained" ||
    status === "bounced" ||
    status === "failed" ||
    status === "canceled"
  );
}

async function getDeliveryRow(jobId: string, recipient: string) {
  const supabase = getSupabaseAdmin();

  return supabase
    .from("email_deliveries")
    .select("id, status, opened_at, clicked_at, complained_at")
    .eq("job_id", jobId)
    .eq("recipient", normalizeEmail(recipient))
    .maybeSingle();
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
  if (results.length === 0) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Deduplicate by recipient (last write wins) so a single batch upsert never
  // tries to touch the same (job_id, recipient) row twice, which Postgres
  // rejects with "ON CONFLICT DO UPDATE command cannot affect row a second time".
  const rowsByRecipient = new Map<string, Record<string, unknown>>();

  for (const result of results) {
    const recipient = normalizeEmail(result.recipient);
    const status: DeliveryStatus = result.error ? "failed" : "sent";

    rowsByRecipient.set(recipient, {
      job_id: jobId,
      tenant_id: tenantId,
      recipient,
      provider: "zeptomail",
      provider_message_id: result.providerMessageId ?? null,
      status,
      error: result.error ?? null,
      sent_at: result.error ? null : now,
      updated_at: now,
    });
  }

  const { error } = await supabase
    .from("email_deliveries")
    .upsert([...rowsByRecipient.values()], { onConflict: "job_id,recipient" });

  if (error) {
    throw new Error(
      `Failed to record deliveries for job ${jobId}: ${error.message}. Run migrations 003–005 in Supabase.`,
    );
  }
}

export async function markDeliveryOpened(
  jobId: string,
  recipient: string,
  openedAt: string,
): Promise<boolean> {
  const { data: existing, error: readError } = await getDeliveryRow(
    jobId,
    recipient,
  );

  if (readError) {
    throw new Error(readError.message);
  }

  if (existing?.opened_at || existing?.complained_at) {
    return true;
  }

  if (!existing || isTerminalStatus(existing.status)) {
    return false;
  }

  const supabase = getSupabaseAdmin();
  const status: DeliveryStatus =
    existing.clicked_at || existing.status === "clicked" ? "clicked" : "opened";

  const { data, error } = await supabase
    .from("email_deliveries")
    .update({
      status,
      opened_at: openedAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id)
    .is("opened_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

export async function markDeliveryClicked(
  jobId: string,
  recipient: string,
  clickedAt: string,
  clickedUrl?: string,
): Promise<boolean> {
  const { data: existing, error: readError } = await getDeliveryRow(
    jobId,
    recipient,
  );

  if (readError) {
    throw new Error(readError.message);
  }

  if (existing?.clicked_at || existing?.complained_at) {
    return true;
  }

  if (!existing || isTerminalStatus(existing.status)) {
    return false;
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_deliveries")
    .update({
      status: "clicked",
      clicked_at: clickedAt,
      clicked_url: clickedUrl ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id)
    .is("clicked_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

export async function markDeliveryComplained(
  jobId: string,
  recipient: string,
  complainedAt: string,
): Promise<boolean> {
  const { data: existing, error: readError } = await getDeliveryRow(
    jobId,
    recipient,
  );

  if (readError) {
    throw new Error(readError.message);
  }

  if (existing?.complained_at) {
    return true;
  }

  if (!existing) {
    return false;
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_deliveries")
    .update({
      status: "complained",
      complained_at: complainedAt,
      error: COMPLAINT_ERROR,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id)
    .is("complained_at", null)
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
  const { data: existing } = await getDeliveryRow(jobId, recipient);

  if (
    !existing ||
    isTerminalStatus(existing.status) ||
    existing.status === "opened" ||
    existing.status === "clicked"
  ) {
    return;
  }

  const supabase = getSupabaseAdmin();

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

export async function insertPendingDeliveries(
  jobId: string,
  tenantId: string,
  recipients: string[],
): Promise<void> {
  if (recipients.length === 0) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  for (let i = 0; i < recipients.length; i += INSERT_CHUNK) {
    const chunk = recipients.slice(i, i + INSERT_CHUNK).map((recipient) => ({
      job_id: jobId,
      tenant_id: tenantId,
      recipient: normalizeEmail(recipient),
      status: "pending" as const,
      updated_at: now,
    }));

    const { error } = await supabase.from("email_deliveries").upsert(chunk, {
      onConflict: "job_id,recipient",
      ignoreDuplicates: true,
    });

    if (error) {
      throw new Error(
        `Failed to record pending deliveries for job ${jobId}: ${error.message}`,
      );
    }
  }
}

export async function markDeliveriesCanceled(
  jobId: string,
  recipients: string[],
): Promise<void> {
  const unique = [
    ...new Set(recipients.map(normalizeEmail).filter(Boolean)),
  ];
  if (unique.length === 0) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
    const chunk = unique.slice(i, i + INSERT_CHUNK);
    const { error } = await supabase
      .from("email_deliveries")
      .update({
        status: "canceled",
        error: "Removed from job",
        updated_at: now,
      })
      .eq("job_id", jobId)
      .eq("status", "pending")
      .in("recipient", chunk);

    if (error) {
      throw new Error(error.message);
    }
  }
}

export async function getDeliveriesForJob(
  jobId: string,
  tenantId: string,
): Promise<EmailDelivery[]> {
  return getDeliveriesForJobs([jobId], tenantId);
}

export async function getDeliveriesForJobs(
  jobIds: string[],
  tenantId: string,
): Promise<EmailDelivery[]> {
  const unique = [...new Set(jobIds.filter(Boolean))];
  if (unique.length === 0) {
    return [];
  }

  const supabase = getSupabaseAdmin();
  const all: EmailDelivery[] = [];
  const ID_CHUNK = 80;

  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const slice = unique.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += DELIVERY_PAGE) {
      const { data, error } = await supabase
        .from("email_deliveries")
        .select("*")
        .eq("tenant_id", tenantId)
        .in("job_id", slice)
        .order("id", { ascending: true })
        .range(from, from + DELIVERY_PAGE - 1);

      if (error) {
        throw new Error(error.message);
      }

      const rows = (data ?? []).map(asDelivery);
      all.push(...rows);
      if (rows.length < DELIVERY_PAGE) {
        break;
      }
    }
  }

  all.sort((a, b) => a.recipient.localeCompare(b.recipient));
  return all;
}

export async function getSendableRecipients(
  jobId: string,
  tenantId: string,
  fallback: string[],
): Promise<string[]> {
  const deliveries = await getDeliveriesForJob(jobId, tenantId);
  if (deliveries.length === 0) {
    return fallback.map(normalizeEmail);
  }

  return deliveries
    .filter((delivery) => delivery.status === "pending")
    .map((delivery) => delivery.recipient);
}

export function summarizeDeliveries(deliveries: EmailDelivery[]) {
  const opened = deliveries.filter((d) => d.opened_at !== null).length;
  const clicked = deliveries.filter((d) => d.clicked_at !== null).length;
  const complained = deliveries.filter((d) => d.complained_at !== null).length;
  const delivered = deliveries.filter((d) => d.delivered_at !== null).length;
  const invalid = deliveries.filter((d) =>
    isInvalidDeliveryError(d.error),
  ).length;
  const bounced = deliveries.filter((d) => d.status === "bounced").length;
  const failed = deliveries.filter(
    (d) => d.status === "failed" && !isInvalidDeliveryError(d.error),
  ).length;
  const sent = deliveries.filter(
    (d) =>
      d.status !== "failed" &&
      d.status !== "bounced" &&
      d.status !== "pending" &&
      d.status !== "complained" &&
      d.status !== "canceled",
  ).length;
  const notOpened = deliveries.filter(
    (d) =>
      d.sent_at !== null &&
      d.opened_at === null &&
      d.status !== "failed" &&
      d.status !== "bounced" &&
      d.status !== "complained" &&
      !isInvalidDeliveryError(d.error),
  ).length;

  return {
    total: deliveries.length,
    sent,
    failed,
    bounced,
    invalid,
    delivered,
    opened,
    clicked,
    complained,
    notOpened,
  };
}

export function formatDeliveryRow(delivery: EmailDelivery) {
  return {
    email: delivery.recipient,
    status: delivery.status,
    opened: delivery.opened_at !== null,
    openedAt: delivery.opened_at,
    clicked: delivery.clicked_at !== null,
    clickedAt: delivery.clicked_at,
    clickedUrl: delivery.clicked_url,
    complained: delivery.complained_at !== null,
    complainedAt: delivery.complained_at,
    deliveredAt: delivery.delivered_at,
    sentAt: delivery.sent_at,
    error: delivery.error,
  };
}

/** @deprecated Use getDeliveryStatsByJobIds from lib/deliveries/stats */
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
    .select("job_id, opened_at, sent_at, status, error")
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
      row.status !== "bounced" &&
      row.status !== "complained" &&
      !isInvalidDeliveryError(row.error as string | null)
    ) {
      current.notOpened += 1;
    }

    stats.set(jobId, current);
  }

  return stats;
}
