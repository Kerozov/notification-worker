import { getSupabaseAdmin } from "@/lib/db/supabase";
import {
  INVALID_EMAIL_ERROR,
  isEngagementEligible,
  isInvalidDeliveryError,
} from "@/lib/deliveries/stats";
import {
  isTemporaryDeliveryError,
  MAX_DELIVERY_RETRIES,
  nextRetryAt,
  retryNote,
} from "@/lib/deliveries/retry";
import { uniqueEmails } from "@/lib/recipients/unique";

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
  /** Migration 016; undefined on databases that do not have it yet. */
  bounce_type?: "soft" | "hard" | null;
  retry_count?: number;
  next_attempt_at?: string | null;
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

async function getDeliveryRow(jobId: string, recipient: string) {
  const supabase = getSupabaseAdmin();

  // `*` so the read works with or without the retry columns of migration 016.
  const result = await supabase
    .from("email_deliveries")
    .select("*")
    .eq("job_id", jobId)
    .eq("recipient", normalizeEmail(recipient))
    .maybeSingle();

  return {
    data: result.data ? asDelivery(result.data) : null,
    error: result.error,
  };
}

function hasRetryColumns(row: EmailDelivery): boolean {
  return "next_attempt_at" in row;
}

/**
 * An open, click or "delivered" event is proof the mail arrived. It counts for
 * a row that was handed to ZeptoMail, even one an earlier bounce marked as
 * bounced or put back in the queue; never for a row that was not sent at all.
 */
function canTakeDeliveryProof(row: EmailDelivery): boolean {
  if (row.status === "failed" || row.status === "canceled") return false;
  if (row.status === "complained") return false;
  if (row.status === "pending") return row.sent_at !== null;
  return true;
}

/** Fields that undo a bounce or a queued retry once delivery is proven. */
function clearBounceFields(row: EmailDelivery): Record<string, unknown> {
  if (row.status !== "bounced" && row.status !== "pending") return {};
  return {
    error: null,
    ...(hasRetryColumns(row) ? { next_attempt_at: null, bounce_type: null } : {}),
  };
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

  if (!existing || !canTakeDeliveryProof(existing)) {
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
      ...clearBounceFields(existing),
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

  if (!existing || !canTakeDeliveryProof(existing)) {
    return false;
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_deliveries")
    .update({
      status: "clicked",
      clicked_at: clickedAt,
      clicked_url: clickedUrl ?? null,
      ...clearBounceFields(existing),
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

export type BounceOutcome =
  | { outcome: "ignored" }
  | { outcome: "bounced" }
  | { outcome: "requeued"; retryAt: Date };

/**
 * A hard bounce with a temporary cause (abv.bg "Host not reachable") puts the
 * address back in the queue, up to MAX_DELIVERY_RETRIES times. Anything else
 * marks it bounced. A soft bounce is recorded but not final: ZeptoMail keeps
 * trying, and a later open or "delivered" event clears it.
 */
export async function markDeliveryBounced(
  jobId: string,
  recipient: string,
  error: string,
  bounceType: "soft" | "hard" = "hard",
  /** False without Trigger.dev: nothing would come back to send the retry. */
  allowRetry = true,
): Promise<BounceOutcome> {
  const { data: existing, error: readError } = await getDeliveryRow(
    jobId,
    recipient,
  );

  if (readError) {
    throw new Error(readError.message);
  }

  // Opened, clicked or reported as spam: the mail arrived, a bounce is noise.
  // Pending: already queued again by an earlier bounce for the same send.
  if (
    !existing ||
    existing.opened_at ||
    existing.clicked_at ||
    existing.complained_at ||
    existing.status === "canceled" ||
    existing.status === "pending"
  ) {
    return { outcome: "ignored" };
  }

  // A soft bounce never overrides a hard one that is already recorded.
  if (
    bounceType === "soft" &&
    existing.status === "bounced" &&
    existing.bounce_type !== "soft"
  ) {
    return { outcome: "ignored" };
  }

  const supabase = getSupabaseAdmin();
  const now = new Date();
  const retryCount = existing.retry_count ?? 0;

  if (
    allowRetry &&
    bounceType === "hard" &&
    hasRetryColumns(existing) &&
    isTemporaryDeliveryError(error) &&
    retryCount < MAX_DELIVERY_RETRIES
  ) {
    const attempt = retryCount + 1;
    const retryAt = nextRetryAt(attempt, "bounce", now.getTime());
    const { error: updateError } = await supabase
      .from("email_deliveries")
      .update({
        status: "pending",
        error: retryNote(attempt, error),
        bounce_type: "hard",
        retry_count: attempt,
        next_attempt_at: retryAt.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", existing.id)
      .neq("status", "pending");

    if (!updateError) {
      return { outcome: "requeued", retryAt };
    }
    console.error("markDeliveryBounced requeue:", updateError.message);
  }

  const label = bounceType === "soft" ? `Soft bounce: ${error}` : error;
  const { error: updateError } = await supabase
    .from("email_deliveries")
    .update({
      status: "bounced",
      error: label,
      ...(hasRetryColumns(existing) ? { bounce_type: bounceType } : {}),
      updated_at: now.toISOString(),
    })
    .eq("id", existing.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return { outcome: "bounced" };
}

export async function markDeliveryDelivered(
  jobId: string,
  recipient: string,
  deliveredAt: string,
): Promise<void> {
  const { data: existing } = await getDeliveryRow(jobId, recipient);

  if (
    !existing ||
    !canTakeDeliveryProof(existing) ||
    existing.status === "opened" ||
    existing.status === "clicked" ||
    (existing.status === "bounced" && existing.bounce_type !== "soft")
  ) {
    return;
  }

  const supabase = getSupabaseAdmin();

  await supabase
    .from("email_deliveries")
    .update({
      status: "delivered",
      delivered_at: deliveredAt,
      ...clearBounceFields(existing),
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id);
}

/**
 * Puts addresses back in the queue for another try. Returns the earliest
 * time one of them is due, or null when nothing was queued (no rows matched,
 * or the database does not have migration 016 yet).
 */
export async function requeueDeliveries(
  jobId: string,
  rows: Array<Pick<EmailDelivery, "recipient" | "error" | "retry_count">>,
  options: { kind: "bounce" | "send"; manual?: boolean; now?: number },
): Promise<Date | null> {
  if (rows.length === 0) return null;

  const supabase = getSupabaseAdmin();
  const now = options.now ?? Date.now();
  const groups = new Map<
    string,
    { values: Record<string, unknown>; recipients: string[]; at: Date }
  >();

  for (const row of rows) {
    const attempt = (row.retry_count ?? 0) + 1;
    const at = options.manual
      ? new Date(now)
      : nextRetryAt(attempt, options.kind, now);
    const note = retryNote(attempt, row.error ?? "Delivery failed", {
      manual: options.manual,
    });
    const key = `${attempt}|${at.toISOString()}|${note}`;
    const group = groups.get(key) ?? {
      values: {
        status: "pending",
        error: note,
        retry_count: attempt,
        next_attempt_at: at.toISOString(),
        updated_at: new Date(now).toISOString(),
      },
      recipients: [],
      at,
    };
    group.recipients.push(normalizeEmail(row.recipient));
    groups.set(key, group);
  }

  let earliest: Date | null = null;

  for (const group of groups.values()) {
    for (let i = 0; i < group.recipients.length; i += INSERT_CHUNK) {
      const chunk = group.recipients.slice(i, i + INSERT_CHUNK);
      const { error } = await supabase
        .from("email_deliveries")
        .update(group.values)
        .eq("job_id", jobId)
        .in("status", ["failed", "bounced"])
        .in("recipient", chunk);

      if (error) {
        console.error("requeueDeliveries:", error.message);
        return earliest;
      }
    }
    if (!earliest || group.at < earliest) earliest = group.at;
  }

  return earliest;
}

export type SendQueue = {
  /** Pending addresses that may go out now. */
  due: string[];
  /** Earliest time a pending address that is not due yet becomes due. */
  nextDueAt: Date | null;
  /**
   * False when the job has no delivery rows and `due` is the job's own list:
   * anything held back must get a pending row first, or it is forgotten.
   */
  hasRows: boolean;
};

/** Pending addresses of a send job, split into "now" and "later". */
export async function getSendQueue(
  jobId: string,
  tenantId: string,
  fallback: string[],
  now = Date.now(),
): Promise<SendQueue> {
  const deliveries = await getDeliveriesForJob(jobId, tenantId);
  if (deliveries.length === 0) {
    return { due: uniqueEmails(fallback), nextDueAt: null, hasRows: false };
  }

  const due: string[] = [];
  let nextDueAt: Date | null = null;

  for (const delivery of deliveries) {
    if (delivery.status !== "pending") continue;
    const at = delivery.next_attempt_at
      ? new Date(delivery.next_attempt_at)
      : null;
    if (at && at.getTime() > now) {
      if (!nextDueAt || at < nextDueAt) nextDueAt = at;
      continue;
    }
    due.push(delivery.recipient);
  }

  return { due: uniqueEmails(due), nextDueAt, hasRows: true };
}

export async function insertPendingDeliveries(
  jobId: string,
  tenantId: string,
  recipients: string[],
): Promise<void> {
  const unique = uniqueEmails(recipients);
  if (unique.length === 0) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
    const chunk = unique.slice(i, i + INSERT_CHUNK).map((recipient) => ({
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
    (d) => isEngagementEligible(d) && d.opened_at === null,
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
      isEngagementEligible({
        sent_at: row.sent_at as string | null,
        status: row.status as string,
        error: row.error as string | null,
      })
    ) {
      current.notOpened += 1;
    }

    stats.set(jobId, current);
  }

  return stats;
}
