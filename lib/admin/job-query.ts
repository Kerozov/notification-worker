import { getSupabaseAdmin } from "@/lib/db/supabase";

export const EMAIL_JOB_SELECT =
  "id, tenant_id, status, subject, from_email, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key";

export const SMS_JOB_SELECT =
  "id, tenant_id, status, body, sender, recipients, sent_count, failed_count, error, send_at, updated_at, created_at, sent_at";

export const JOB_STATUSES = [
  "pending",
  "processing",
  "sent",
  "partial",
  "failed",
  "canceled",
] as const;

export type JobPeriod = "24h" | "7d" | "30d" | "all";
export type JobSort = "created_at" | "send_at" | "updated_at";
export type JobSortDir = "asc" | "desc";

export type JobListFilters = {
  status: string;
  tenant: string;
  period: JobPeriod;
  q: string;
  page: number;
  sort: JobSort;
  sortDir: JobSortDir;
};

export const JOBS_PAGE_SIZE = 50;

export function parseJobListFilters(
  params: Record<string, string | undefined>,
): JobListFilters {
  const period = params.period;
  const sort = params.sort;

  return {
    status: params.status?.trim() || "all",
    tenant: params.tenant?.trim() || "all",
    period:
      period === "24h" || period === "7d" || period === "30d" || period === "all"
        ? period
        : "7d",
    q: params.q?.trim() ?? "",
    page: Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1),
    sort:
      sort === "created_at" || sort === "send_at" || sort === "updated_at"
        ? sort
        : "created_at",
    sortDir: params.sortDir === "asc" ? "asc" : "desc",
  };
}

export function periodToSince(period: JobPeriod): string | null {
  if (period === "all") {
    return null;
  }

  const hours =
    period === "24h" ? 24 : period === "7d" ? 24 * 7 : period === "30d" ? 24 * 30 : 0;

  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

type FilterableQuery<T> = {
  eq: (column: string, value: string) => T;
  gte: (column: string, value: string) => T;
  or: (filters: string) => T;
};

function applyBaseFilters<T>(
  query: FilterableQuery<T>,
  filters: JobListFilters,
  tenantId: string | null,
): FilterableQuery<T> {
  let q = query;

  if (filters.status !== "all") {
    q = q.eq("status", filters.status) as FilterableQuery<T>;
  }

  if (tenantId) {
    q = q.eq("tenant_id", tenantId) as FilterableQuery<T>;
  }

  const since = periodToSince(filters.period);
  if (since) {
    q = q.gte("created_at", since) as FilterableQuery<T>;
  }

  return q;
}

function applyEmailSearch<T>(query: FilterableQuery<T>, q: string): T {
  const term = q.trim();
  if (!term) {
    return query as unknown as T;
  }

  const escaped = escapeIlike(term);
  const isUuid = /^[0-9a-f-]{36}$/i.test(term);

  if (isUuid) {
    return query.or(
      `subject.ilike.%${escaped}%,error.ilike.%${escaped}%,id.eq.${term}`,
    ) as unknown as T;
  }

  return query.or(
    `subject.ilike.%${escaped}%,error.ilike.%${escaped}%`,
  ) as unknown as T;
}

function applySmsSearch<T>(query: FilterableQuery<T>, q: string): T {
  const term = q.trim();
  if (!term) {
    return query as unknown as T;
  }

  const escaped = escapeIlike(term);
  const isUuid = /^[0-9a-f-]{36}$/i.test(term);

  if (isUuid) {
    return query.or(
      `body.ilike.%${escaped}%,error.ilike.%${escaped}%,id.eq.${term}`,
    ) as unknown as T;
  }

  return query.or(
    `body.ilike.%${escaped}%,error.ilike.%${escaped}%`,
  ) as unknown as T;
}

function applyEmailFilters<T>(
  query: FilterableQuery<T>,
  filters: JobListFilters,
  tenantId: string | null,
): T {
  const q = applyBaseFilters(query, filters, tenantId);
  return applyEmailSearch(q, filters.q);
}

function applySmsFilters<T>(
  query: FilterableQuery<T>,
  filters: JobListFilters,
  tenantId: string | null,
): T {
  const q = applyBaseFilters(query, filters, tenantId);
  return applySmsSearch(q, filters.q);
}

export type StatusCount = {
  status: string;
  count: number;
};

export type JobListResult<TRow> = {
  jobs: TRow[];
  total: number;
  statusCounts: StatusCount[];
  error: string | null;
};

async function fetchStatusCounts(
  table: "email_jobs" | "sms_jobs",
  filters: JobListFilters,
  tenantId: string | null,
): Promise<StatusCount[]> {
  const supabase = getSupabaseAdmin();
  const baseFilters = { ...filters, status: "all" };
  const applyFilters =
    table === "email_jobs" ? applyEmailFilters : applySmsFilters;

  const counts = await Promise.all(
    JOB_STATUSES.map(async (status) => {
      let query = supabase
        .from(table)
        .select("*", { count: "exact", head: true })
        .eq("status", status);

      query = applyFilters(query, baseFilters, tenantId);

      const { count, error } = await query;

      return {
        status,
        count: error ? 0 : (count ?? 0),
      };
    }),
  );

  return counts;
}

export async function fetchFilteredEmailJobs<TRow>(
  filters: JobListFilters,
  tenantId: string | null,
): Promise<JobListResult<TRow>> {
  const supabase = getSupabaseAdmin();
  const offset = (filters.page - 1) * JOBS_PAGE_SIZE;

  let query = supabase
    .from("email_jobs")
    .select(EMAIL_JOB_SELECT, { count: "exact" });

  query = applyEmailFilters(query, filters, tenantId);
  query = query
    .order(filters.sort, { ascending: filters.sortDir === "asc" })
    .range(offset, offset + JOBS_PAGE_SIZE - 1);

  const [{ data, count, error }, statusCounts] = await Promise.all([
    query,
    fetchStatusCounts("email_jobs", filters, tenantId),
  ]);

  return {
    jobs: (data ?? []) as TRow[],
    total: count ?? 0,
    statusCounts,
    error: error?.message ?? null,
  };
}

export async function fetchFilteredSmsJobs<TRow>(
  filters: JobListFilters,
  tenantId: string | null,
): Promise<JobListResult<TRow>> {
  const supabase = getSupabaseAdmin();
  const offset = (filters.page - 1) * JOBS_PAGE_SIZE;

  let query = supabase
    .from("sms_jobs")
    .select(SMS_JOB_SELECT, { count: "exact" });

  query = applySmsFilters(query, filters, tenantId);
  query = query
    .order(filters.sort, { ascending: filters.sortDir === "asc" })
    .range(offset, offset + JOBS_PAGE_SIZE - 1);

  const [{ data, count, error }, statusCounts] = await Promise.all([
    query,
    fetchStatusCounts("sms_jobs", filters, tenantId),
  ]);

  return {
    jobs: (data ?? []) as TRow[],
    total: count ?? 0,
    statusCounts,
    error: error?.message ?? null,
  };
}

export function buildAdminJobsHref(
  channel: "email" | "sms",
  filters: JobListFilters,
  overrides: Partial<JobListFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();

  params.set("channel", channel);

  if (merged.status !== "all") {
    params.set("status", merged.status);
  }

  if (merged.tenant !== "all") {
    params.set("tenant", merged.tenant);
  }

  if (merged.period !== "7d") {
    params.set("period", merged.period);
  }

  if (merged.q) {
    params.set("q", merged.q);
  }

  if (merged.page > 1) {
    params.set("page", String(merged.page));
  }

  if (merged.sort !== "created_at") {
    params.set("sort", merged.sort);
  }

  if (merged.sortDir !== "desc") {
    params.set("sortDir", merged.sortDir);
  }

  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}
