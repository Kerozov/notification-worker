import { getSupabaseAdmin } from "@/lib/db/supabase";

export const INVALID_EMAIL_ERROR = "Invalid email address (not sent)";

export type JobDeliveryStats = {
  sent: number;
  invalid: number;
  failed: number;
  opened: number;
  notOpened: number;
  total: number;
};

function emptyStats(): JobDeliveryStats {
  return {
    sent: 0,
    invalid: 0,
    failed: 0,
    opened: 0,
    notOpened: 0,
    total: 0,
  };
}

export function isInvalidDeliveryError(error: string | null | undefined): boolean {
  return Boolean(error?.includes(INVALID_EMAIL_ERROR));
}

export async function getDeliveryStatsByJobIds(
  jobIds: string[],
): Promise<Map<string, JobDeliveryStats>> {
  const stats = new Map<string, JobDeliveryStats>();

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
    const current = stats.get(jobId) ?? emptyStats();
    current.total += 1;

    if (isInvalidDeliveryError(row.error as string | null)) {
      current.invalid += 1;
    } else if (row.status === "failed" || row.status === "bounced") {
      current.failed += 1;
    } else if (row.status !== "pending") {
      current.sent += 1;
    }

    if (row.opened_at) {
      current.opened += 1;
    } else if (
      row.sent_at &&
      row.status !== "failed" &&
      row.status !== "bounced" &&
      !isInvalidDeliveryError(row.error as string | null)
    ) {
      current.notOpened += 1;
    }

    stats.set(jobId, current);
  }

  return stats;
}

export function resolveDisplayStatus(
  job: {
    status: string;
    sent_count: number;
    failed_count: number;
    error?: string | null;
  },
  stats?: JobDeliveryStats,
): string {
  if (job.status === "pending" || job.status === "processing") {
    return job.status;
  }

  if (job.status === "canceled") {
    return "canceled";
  }

  const sent = stats?.sent ?? job.sent_count;
  const invalid =
    stats?.invalid ??
    (job.error?.includes("Invalid addresses") ? job.failed_count : 0);
  const failed = stats?.failed ?? Math.max(0, job.failed_count - invalid);

  if (sent === 0) {
    return "failed";
  }

  if (invalid > 0 || failed > 0) {
    return "partial";
  }

  return "sent";
}

export function getJobDisplayCounts(
  job: {
    recipients: string[];
    sent_count: number;
    failed_count: number;
    error?: string | null;
  },
  stats?: JobDeliveryStats,
): { requested: number; sent: number; invalid: number; failed: number } {
  if (stats && stats.total > 0) {
    return {
      requested: stats.total,
      sent: stats.sent,
      invalid: stats.invalid,
      failed: stats.failed,
    };
  }

  const hasInvalidNote = job.error?.includes("Invalid addresses");
  const requested = job.recipients.length;

  if (hasInvalidNote && job.sent_count === 0) {
    return {
      requested: Math.max(requested, job.failed_count),
      sent: 0,
      invalid: job.failed_count,
      failed: 0,
    };
  }

  return {
    requested,
    sent: job.sent_count,
    invalid: 0,
    failed: job.failed_count,
  };
}
