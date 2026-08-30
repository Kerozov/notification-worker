import {
  asEmailJob,
  EmailJob,
  EmailJobStatus,
  getSupabaseAdmin,
} from "@/lib/db/supabase";
import { isInvalidDeliveryError } from "@/lib/deliveries/stats";
import {
  getDeliveriesForJob,
  getDeliveriesForJobs,
  insertPendingDeliveries,
  markDeliveriesCanceled,
} from "@/lib/deliveries/store";
import { getJobById } from "@/lib/jobs/query";
import {
  chunkItems,
  parseJobMerge,
  SEND_CHUNK_SIZE,
  type EmailAttachment,
  type JobMerge,
} from "@/lib/validation/email-job";

export function isCampaignJob(job: { kind?: string | null }): boolean {
  return job.kind === "campaign";
}

export function isMissingCampaignColumns(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    (error.code === "PGRST204" ||
      error.code === "42703" ||
      message.includes("schema cache")) &&
    (message.includes("kind") || message.includes("parent_id"))
  );
}

/** Parent key `camp-xyz`, child `camp-xyz~0` — `~` does not collide with old `-0` chunks. */
export function childIdempotencyKey(
  parentKey: string | null | undefined,
  index: number,
): string | null {
  if (!parentKey) return null;
  return `${parentKey}~${index}`;
}

export function combineCampaignStatus(
  children: Array<{ status: string }>,
): EmailJobStatus {
  if (children.length === 0) return "pending";

  const statuses = children.map((child) => child.status);
  if (statuses.every((status) => status === "canceled")) return "canceled";
  if (statuses.some((status) => status === "processing")) return "processing";
  if (statuses.some((status) => status === "pending")) {
    return statuses.some(
      (status) => status === "sent" || status === "failed" || status === "processing",
    )
      ? "processing"
      : "pending";
  }
  if (statuses.every((status) => status === "failed" || status === "canceled")) {
    return statuses.some((status) => status === "failed") ? "failed" : "canceled";
  }
  return "sent";
}

export function emailJobNeedsDispatch(status: string): boolean {
  return status === "pending" || status === "processing";
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  return (
    code === "23505" ||
    message.includes("duplicate key") ||
    message.includes("unique constraint")
  );
}

function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}

/** Parent list minus addresses already sitting on a child send job. */
export function uncoveredRecipients(
  parentRecipients: string[],
  children: Array<{ recipients: string[] }>,
): string[] {
  const covered = new Set(
    children.flatMap((child) => child.recipients.map(normalizeRecipient)),
  );
  return parentRecipients.filter(
    (email) => !covered.has(normalizeRecipient(email)),
  );
}

export function missingRecipientChunks(
  parentRecipients: string[],
  children: Array<{ recipients: string[] }>,
  size = SEND_CHUNK_SIZE,
): string[][] {
  return chunkItems(uncoveredRecipients(parentRecipients, children), size);
}

export function nextChildChunkIndex(
  children: Array<{ idempotency_key?: string | null }>,
): number {
  let max = -1;
  for (const child of children) {
    const match = /~(\d+)$/.exec(child.idempotency_key ?? "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * Parent row status from its send jobs. A canceled campaign stays canceled
 * (so a retry cannot invent new pockets). Recipients with no child yet keep
 * the campaign open so the next create/heal can fill the gap.
 */
export function campaignStatusFromChildren(
  parentStatus: string,
  parentRecipients: string[],
  children: Array<{ status: string; recipients: string[] }>,
): EmailJobStatus {
  const combined = combineCampaignStatus(children);
  const uncovered = uncoveredRecipients(parentRecipients, children).length > 0;

  if (parentStatus === "canceled") {
    if (combined === "sent" || combined === "failed") return combined;
    return "canceled";
  }

  if (uncovered) {
    if (children.length === 0) return "pending";
    if (
      combined === "sent" ||
      combined === "failed" ||
      combined === "canceled"
    ) {
      return "processing";
    }
  }

  return combined;
}

export function campaignInputFromJob(job: EmailJob): CampaignCreateInput {
  return {
    tenantId: job.tenant_id,
    subject: job.subject,
    html: job.html,
    valid: job.recipients,
    merge: job.merge,
    from: job.from_email,
    replyTo: job.reply_to,
    sendAt: new Date(job.send_at),
    idempotencyKey: job.idempotency_key,
    attachments: job.attachments,
  };
}

const CHILD_LIST_SELECT =
  "id, tenant_id, status, subject, from_email, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key, kind, parent_id, html, reply_to, attachments, merge";

const CHILD_PAGE = 1000;

function childListOrder<T extends { order: (column: string, options: { ascending: boolean }) => T }>(
  query: T,
): T {
  return query
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
}

export async function listChildJobs(parentId: string): Promise<EmailJob[]> {
  const supabase = getSupabaseAdmin();
  const jobs: EmailJob[] = [];

  for (let from = 0; ; from += CHILD_PAGE) {
    const { data, error } = await childListOrder(
      supabase.from("email_jobs").select("*").eq("parent_id", parentId),
    ).range(from, from + CHILD_PAGE - 1);

    if (error) {
      if (isMissingCampaignColumns(error)) return jobs;
      throw new Error(error.message);
    }

    const rows = data ?? [];
    for (const row of rows) {
      jobs.push(asEmailJob(row));
    }
    if (rows.length < CHILD_PAGE) break;
  }

  return jobs;
}

export async function listChildrenForParents(
  parentIds: string[],
): Promise<Map<string, EmailJob[]>> {
  const grouped = new Map<string, EmailJob[]>();
  const unique = [...new Set(parentIds.filter(Boolean))];
  if (unique.length === 0) return grouped;

  const supabase = getSupabaseAdmin();
  const CHUNK = 80;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    for (let from = 0; ; from += CHILD_PAGE) {
      const { data, error } = await childListOrder(
        supabase
          .from("email_jobs")
          .select(CHILD_LIST_SELECT)
          .in("parent_id", slice),
      ).range(from, from + CHILD_PAGE - 1);

      if (error) {
        if (isMissingCampaignColumns(error)) return grouped;
        throw new Error(error.message);
      }

      const rows = data ?? [];
      for (const row of rows) {
        const job = asEmailJob(row as Record<string, unknown>);
        const parentId = job.parent_id;
        if (!parentId) continue;
        const list = grouped.get(parentId) ?? [];
        list.push(job);
        grouped.set(parentId, list);
      }
      if (rows.length < CHILD_PAGE) break;
    }
  }

  return grouped;
}

function isMissingMergeColumn(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    (error.code === "PGRST204" || error.code === "42703") &&
    message.includes("merge")
  );
}

export type CampaignCreateInput = {
  tenantId: string;
  subject: string;
  html: string;
  valid: string[];
  merge: JobMerge;
  from?: string | null;
  replyTo?: string | null;
  sendAt: Date;
  idempotencyKey?: string | null;
  attachments?: EmailAttachment[];
};

function throwDbError(error: { code?: string; message: string }): never {
  const err = new Error(error.message) as Error & { code?: string };
  if (error.code) err.code = error.code;
  throw err;
}

async function findJobByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_jobs")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : null;
}

async function defaultSyncDeliveries(
  job: EmailJob,
  valid: string[],
): Promise<void> {
  try {
    await insertPendingDeliveries(job.id, job.tenant_id, valid);
  } catch (error) {
    console.error("syncJobDeliveries:", error);
  }
}

async function insertJobRow(
  row: Record<string, unknown>,
): Promise<EmailJob> {
  const supabase = getSupabaseAdmin();
  let { data, error } = await supabase
    .from("email_jobs")
    .insert(row)
    .select("*")
    .single();

  if (error && isMissingMergeColumn(error)) {
    const rest = { ...row };
    delete rest.merge;
    ({ data, error } = await supabase
      .from("email_jobs")
      .insert(rest)
      .select("*")
      .single());
  }

  if (error && isMissingCampaignColumns(error)) {
    throw new Error(
      "email_jobs.kind / parent_id missing — run supabase/scripts/SETUP_DATABASE.sql or migration 010_campaign_parent.sql",
    );
  }

  if (error) {
    throwDbError(error);
  }

  return asEmailJob(data);
}

async function insertJobRows(rows: Record<string, unknown>[]): Promise<EmailJob[]> {
  if (rows.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const created: EmailJob[] = [];
  const BATCH = 20;

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    let { data, error } = await supabase
      .from("email_jobs")
      .insert(slice)
      .select("*");

    if (error && isMissingMergeColumn(error)) {
      const withoutMerge = slice.map((row) => {
        const rest = { ...row };
        delete rest.merge;
        return rest;
      });
      ({ data, error } = await supabase
        .from("email_jobs")
        .insert(withoutMerge)
        .select("*"));
    }

    if (error && isMissingCampaignColumns(error)) {
      throw new Error(
        "email_jobs.kind / parent_id missing — run supabase/scripts/SETUP_DATABASE.sql or migration 010_campaign_parent.sql",
      );
    }

    if (error) {
      throwDbError(error);
    }

    for (const row of data ?? []) {
      created.push(asEmailJob(row));
    }
  }

  return created;
}

export async function insertCampaignWithChildren(
  input: CampaignCreateInput,
  syncDeliveries: (job: EmailJob, valid: string[]) => Promise<void>,
): Promise<{ parent: EmailJob; children: EmailJob[]; reused: boolean }> {
  try {
    const parent = await insertJobRow({
      tenant_id: input.tenantId,
      idempotency_key: input.idempotencyKey ?? null,
      status: "pending",
      send_at: input.sendAt.toISOString(),
      subject: input.subject,
      html: input.html,
      recipients: input.valid,
      from_email: input.from ?? null,
      reply_to: input.replyTo ?? null,
      attachments: input.attachments ?? [],
      merge: input.merge,
      kind: "campaign",
      parent_id: null,
    });

    const children = await createMissingChildren(parent, input, syncDeliveries);
    return { parent, children, reused: false };
  } catch (error) {
    if (!isUniqueViolation(error) || !input.idempotencyKey) {
      throw error;
    }

    const existing = await findJobByIdempotencyKey(
      input.tenantId,
      input.idempotencyKey,
    );
    if (!existing || !isCampaignJob(existing)) {
      throw error;
    }

    const children = await createMissingChildren(
      existing,
      input,
      syncDeliveries,
    );
    return { parent: existing, children, reused: true };
  }
}

function childRowsForChunks(
  parent: EmailJob,
  input: CampaignCreateInput,
  chunks: string[][],
  startIndex: number,
): Record<string, unknown>[] {
  const parentKey = parent.idempotency_key ?? input.idempotencyKey;
  const mergeSource =
    parent.merge && Object.keys(parent.merge).length > 0
      ? parent.merge
      : input.merge;

  return chunks.map((recipients, index) => ({
    tenant_id: parent.tenant_id,
    idempotency_key: childIdempotencyKey(parentKey, startIndex + index),
    status: "pending" as const,
    send_at: parent.send_at,
    subject: parent.subject || input.subject,
    html: "",
    recipients,
    from_email: parent.from_email ?? input.from ?? null,
    reply_to: parent.reply_to ?? input.replyTo ?? null,
    attachments: [] as EmailAttachment[],
    merge: parseJobMerge(mergeSource, new Set(recipients)),
    kind: "send",
    parent_id: parent.id,
  }));
}

export async function createMissingChildren(
  parent: EmailJob,
  input: CampaignCreateInput,
  syncDeliveries: (job: EmailJob, valid: string[]) => Promise<void> = defaultSyncDeliveries,
): Promise<EmailJob[]> {
  if (
    parent.status === "canceled" ||
    parent.status === "failed" ||
    parent.status === "sent"
  ) {
    return listChildJobs(parent.id);
  }

  const MAX_ATTEMPTS = 8;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await listChildJobs(parent.id);
    const chunks = missingRecipientChunks(parent.recipients, existing);
    if (chunks.length === 0) {
      return existing;
    }

    const rows = childRowsForChunks(
      parent,
      input,
      chunks,
      nextChildChunkIndex(existing),
    );

    try {
      const created = await insertJobRows(rows);
      for (const child of created) {
        await syncDeliveries(child, child.recipients);
      }
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  const leftover = await listChildJobs(parent.id);
  if (missingRecipientChunks(parent.recipients, leftover).length > 0) {
    throw new Error("Could not create all send jobs for this campaign");
  }
  return leftover;
}

export async function refreshCampaignParent(parentId: string): Promise<EmailJob | null> {
  const parent = await getJobById(parentId);
  if (!parent || !isCampaignJob(parent)) {
    return parent;
  }

  const children = await listChildJobs(parentId);
  const sent = children.reduce((sum, child) => sum + child.sent_count, 0);
  let failed = children.reduce((sum, child) => sum + child.failed_count, 0);
  try {
    const parentDeliveries = await getDeliveriesForJob(parent.id, parent.tenant_id);
    failed += parentDeliveries.filter((row) =>
      isInvalidDeliveryError(row.error),
    ).length;
  } catch (error) {
    console.error("refreshCampaignParent invalid count:", error);
  }

  const status = campaignStatusFromChildren(
    parent.status,
    parent.recipients,
    children,
  );
  const uncovered = uncoveredRecipients(parent.recipients, children).length > 0;
  const allDone =
    !uncovered &&
    children.length > 0 &&
    children.every(
      (child) =>
        child.status === "sent" ||
        child.status === "failed" ||
        child.status === "canceled",
    );
  const sentAt =
    allDone && sent > 0
      ? children
          .map((child) => child.sent_at)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? new Date().toISOString()
      : allDone
        ? parent.sent_at
        : null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_jobs")
    .update({
      status,
      sent_count: sent,
      failed_count: failed,
      sent_at: sentAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parentId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : parent;
}

export async function resolveSendContent(job: EmailJob): Promise<{
  html: string;
  attachments: EmailAttachment[];
  subject: string;
}> {
  if (job.html.trim()) {
    return {
      html: job.html,
      attachments: job.attachments,
      subject: job.subject,
    };
  }

  if (!job.parent_id) {
    return {
      html: job.html,
      attachments: job.attachments,
      subject: job.subject,
    };
  }

  const parent = await getJobById(job.parent_id);
  if (!parent) {
    return {
      html: job.html,
      attachments: job.attachments,
      subject: job.subject,
    };
  }

  return {
    html: parent.html,
    attachments: job.attachments.length > 0 ? job.attachments : parent.attachments,
    subject: job.subject || parent.subject,
  };
}

async function cancelPendingSendRow(job: EmailJob): Promise<EmailJob | null> {
  if (job.status !== "pending") {
    return null;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_jobs")
    .update({
      status: "canceled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  const canceled = asEmailJob(data);
  try {
    await markDeliveriesCanceled(canceled.id, canceled.recipients);
  } catch (err) {
    console.error("markDeliveriesCanceled:", err);
  }

  if (canceled.parent_id) {
    await refreshCampaignParent(canceled.parent_id);
  }

  return canceled;
}

export async function cancelPendingChildren(parentId: string): Promise<EmailJob[]> {
  const children = await listChildJobs(parentId);
  const canceled: EmailJob[] = [];
  for (const child of children) {
    const result = await cancelPendingSendRow(child);
    if (result) canceled.push(result);
  }
  await refreshCampaignParent(parentId);
  return canceled;
}

export async function cancelEmailJob(
  jobId: string,
  tenantId?: string,
): Promise<EmailJob | null> {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("email_jobs").select("*").eq("id", jobId);
  if (tenantId) {
    query = query.eq("tenant_id", tenantId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    return null;
  }

  const job = asEmailJob(data);

  if (isCampaignJob(job)) {
    if (job.status !== "pending" && job.status !== "processing") {
      return null;
    }
    await cancelPendingChildren(job.id);
    return getJobById(job.id);
  }

  return cancelPendingSendRow(job);
}

async function patchPendingRecipients(
  job: EmailJob,
  remaining: string[],
  merge: JobMerge,
): Promise<EmailJob | null> {
  if (remaining.length === 0) {
    return cancelPendingSendRow(job);
  }

  const supabase = getSupabaseAdmin();
  const patch: Record<string, unknown> = {
    recipients: remaining,
    updated_at: new Date().toISOString(),
  };

  let { data, error } = await supabase
    .from("email_jobs")
    .update({ ...patch, merge })
    .eq("id", job.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error && isMissingMergeColumn(error)) {
    ({ data, error } = await supabase
      .from("email_jobs")
      .update(patch)
      .eq("id", job.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle());
  }

  if (error) {
    throw new Error(error.message);
  }

  return data ? asEmailJob(data) : job;
}

export async function removeRecipientsFromJob(
  tenantId: string,
  jobId: string,
  emails: string[],
): Promise<EmailJob | null> {
  const remove = [
    ...new Set(emails.map((value) => value.trim().toLowerCase()).filter(Boolean)),
  ];
  if (remove.length === 0) {
    return null;
  }

  const supabase = getSupabaseAdmin();
  const { data: row, error: readError } = await supabase
    .from("email_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (readError) {
    throw new Error(readError.message);
  }
  if (!row) {
    return null;
  }

  const job = asEmailJob(row);

  if (isCampaignJob(job)) {
    if (job.status === "canceled" || job.status === "failed" || job.status === "sent") {
      return null;
    }

    const children = await listChildJobs(job.id);
    const removed: string[] = [];

    for (const email of remove) {
      const child = children.find((item) => item.recipients.includes(email));
      if (!child) continue;
      if (child.status !== "pending") continue;

      const remaining = child.recipients.filter((value) => value !== email);
      const merge = { ...child.merge };
      delete merge[email];
      await markDeliveriesCanceled(child.id, [email]);
      const updated = await patchPendingRecipients(child, remaining, merge);
      if (updated) {
        removed.push(email);
        const index = children.findIndex((item) => item.id === child.id);
        if (index >= 0) children[index] = updated;
      }
    }

    if (removed.length === 0) {
      return job.status === "pending" ? job : null;
    }

    const remainingParent = job.recipients.filter((email) => !removed.includes(email));
    const merge = { ...job.merge };
    for (const email of removed) {
      delete merge[email];
    }

    const { data, error } = await supabase
      .from("email_jobs")
      .update({
        recipients: remainingParent,
        merge,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .select("*")
      .maybeSingle();

    if (error && isMissingMergeColumn(error)) {
      await supabase
        .from("email_jobs")
        .update({
          recipients: remainingParent,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    } else if (error) {
      throw new Error(error.message);
    }

    return (await refreshCampaignParent(job.id)) ?? (data ? asEmailJob(data) : job);
  }

  if (job.status !== "pending") {
    return null;
  }

  const remaining = job.recipients.filter((email) => !remove.includes(email));
  if (remaining.length === job.recipients.length) {
    return job;
  }

  const merge = { ...job.merge };
  for (const email of remove) {
    delete merge[email];
  }

  await markDeliveriesCanceled(job.id, remove);
  const updated = await patchPendingRecipients(job, remaining, merge);

  if (job.parent_id) {
    const parent = await getJobById(job.parent_id);
    if (parent) {
      const parentRemaining = parent.recipients.filter((email) => !remove.includes(email));
      const parentMerge = { ...parent.merge };
      for (const email of remove) {
        delete parentMerge[email];
      }
      await supabase
        .from("email_jobs")
        .update({
          recipients: parentRemaining,
          merge: parentMerge,
          updated_at: new Date().toISOString(),
        })
        .eq("id", parent.id);
      await refreshCampaignParent(parent.id);
    }
  }

  return updated;
}

export async function getDeliveriesForEmailJob(job: EmailJob) {
  if (!isCampaignJob(job)) {
    return getDeliveriesForJob(job.id, job.tenant_id);
  }

  const children = await listChildJobs(job.id);
  return getDeliveriesForJobs(
    [job.id, ...children.map((child) => child.id)],
    job.tenant_id,
  );
}

export async function findOpenCampaigns(limit = 10): Promise<EmailJob[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_jobs")
    .select("*")
    .eq("kind", "campaign")
    .in("status", ["pending", "processing"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    if (isMissingCampaignColumns(error)) return [];
    throw new Error(error.message);
  }

  return (data ?? []).map(asEmailJob);
}

/**
 * Create send jobs for campaign parents that were stored without a full split,
 * then hand only the new pockets to Trigger. Already-pending pockets are left
 * alone — re-triggering them on every heal would stampede the queue.
 */
export async function healOpenCampaigns(limit = 10): Promise<{
  campaigns: number;
  created: number;
}> {
  const campaigns = await findOpenCampaigns(limit);
  let created = 0;

  for (const parent of campaigns) {
    const before = await listChildJobs(parent.id);
    const beforeIds = new Set(before.map((child) => child.id));
    const children = await createMissingChildren(
      parent,
      campaignInputFromJob(parent),
    );
    const newChildren = children.filter(
      (child) => !beforeIds.has(child.id) && child.status === "pending",
    );
    if (newChildren.length === 0) continue;

    created += newChildren.length;
    const { dispatchCreatedEmailJobs } = await import("@/lib/trigger/schedule");
    await dispatchCreatedEmailJobs(parent, newChildren);
  }

  return { campaigns: campaigns.length, created };
}
