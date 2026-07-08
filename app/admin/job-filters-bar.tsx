import Link from "next/link";
import {
  buildAdminJobsHref,
  JOBS_PAGE_SIZE,
  type JobListFilters,
  type JobPeriod,
  type StatusCount,
} from "@/lib/admin/job-query";
import styles from "./admin.module.css";

const PERIODS: Array<{ id: JobPeriod; label: string }> = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

export function StatusFilterChips({
  channel,
  filters,
  statusCounts,
  total,
}: {
  channel: "email" | "sms";
  filters: JobListFilters;
  statusCounts: StatusCount[];
  total: number;
}) {
  const allCount = statusCounts.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className={styles.statusChips} role="group" aria-label="Filter by status">
      <Link
        href={buildAdminJobsHref(channel, filters, { status: "all", page: 1 })}
        className={`${styles.statusChip} ${
          filters.status === "all" ? styles.statusChipActive : ""
        }`}
      >
        All
        <span className={styles.statusChipCount}>{allCount}</span>
      </Link>
      {statusCounts.map((row) =>
        row.count > 0 || filters.status === row.status ? (
          <Link
            key={row.status}
            href={buildAdminJobsHref(channel, filters, {
              status: row.status,
              page: 1,
            })}
            className={`${styles.statusChip} ${styles[`statusChip_${row.status}`] ?? ""} ${
              filters.status === row.status ? styles.statusChipActive : ""
            }`}
          >
            {row.status}
            <span className={styles.statusChipCount}>{row.count}</span>
          </Link>
        ) : null,
      )}
      <span className={styles.resultsMeta}>
        {total === 0
          ? "No matches"
          : `${total} result${total === 1 ? "" : "s"} · page ${filters.page}`}
      </span>
    </div>
  );
}

export function JobFiltersBar({
  channel,
  filters,
  tenants,
}: {
  channel: "email" | "sms";
  filters: JobListFilters;
  tenants: Array<{ slug: string; name: string }>;
}) {
  return (
    <form className={styles.filtersBar} method="get" action="/admin">
      <input type="hidden" name="channel" value={channel} />
      {filters.status !== "all" ? (
        <input type="hidden" name="status" value={filters.status} />
      ) : null}

      <div className={styles.filtersRow}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Search</span>
          <input
            className={styles.filterInput}
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Subject, message, job ID, error…"
          />
        </label>

        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Client</span>
          <select
            className={styles.filterSelect}
            name="tenant"
            defaultValue={filters.tenant}
          >
            <option value="all">All clients</option>
            {tenants.map((tenant) => (
              <option key={tenant.slug} value={tenant.slug}>
                {tenant.name}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Period</span>
          <select
            className={styles.filterSelect}
            name="period"
            defaultValue={filters.period}
          >
            {PERIODS.map((period) => (
              <option key={period.id} value={period.id}>
                {period.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Sort</span>
          <select
            className={styles.filterSelect}
            name="sort"
            defaultValue={filters.sort}
          >
            <option value="created_at">Created</option>
            <option value="send_at">Scheduled send</option>
            <option value="updated_at">Last updated</option>
          </select>
        </label>

        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Order</span>
          <select
            className={styles.filterSelect}
            name="sortDir"
            defaultValue={filters.sortDir}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>

        <div className={styles.filterActions}>
          <button className={styles.filterApplyButton} type="submit">
            Apply
          </button>
          <Link
            className={styles.filterResetLink}
            href={`/admin?channel=${channel}`}
          >
            Reset
          </Link>
        </div>
      </div>
    </form>
  );
}

export function JobsPagination({
  channel,
  filters,
  total,
}: {
  channel: "email" | "sms";
  filters: JobListFilters;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE));
  const start = total === 0 ? 0 : (filters.page - 1) * JOBS_PAGE_SIZE + 1;
  const end = Math.min(filters.page * JOBS_PAGE_SIZE, total);
  const pages = buildPageNumbers(filters.page, totalPages);

  if (total === 0) {
    return null;
  }

  return (
    <nav className={styles.pagination} aria-label="Job list pagination">
      <span className={styles.paginationSummary}>
        Showing {start}–{end} of {total}
      </span>

      {totalPages > 1 ? (
        <>
          {filters.page > 1 ? (
            <Link
              className={styles.pageLink}
              href={buildAdminJobsHref(channel, filters, {
                page: filters.page - 1,
              })}
            >
              ← Prev
            </Link>
          ) : (
            <span className={styles.pageLinkDisabled}>← Prev</span>
          )}

          <div className={styles.pageNumbers}>
            {pages.map((page, index) =>
              page === "…" ? (
                <span key={`gap-${index}`} className={styles.pageEllipsis}>
                  …
                </span>
              ) : (
                <Link
                  key={page}
                  href={buildAdminJobsHref(channel, filters, { page })}
                  className={`${styles.pageNumber} ${
                    page === filters.page ? styles.pageNumberActive : ""
                  }`}
                  aria-current={page === filters.page ? "page" : undefined}
                >
                  {page}
                </Link>
              ),
            )}
          </div>

          {filters.page < totalPages ? (
            <Link
              className={styles.pageLink}
              href={buildAdminJobsHref(channel, filters, {
                page: filters.page + 1,
              })}
            >
              Next →
            </Link>
          ) : (
            <span className={styles.pageLinkDisabled}>Next →</span>
          )}
        </>
      ) : (
        <span className={styles.pageLinkDisabled}>Page 1 of 1</span>
      )}
    </nav>
  );
}

function buildPageNumbers(current: number, total: number): Array<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const pages: Array<number | "…"> = [1];

  if (current > 3) {
    pages.push("…");
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let page = start; page <= end; page += 1) {
    pages.push(page);
  }

  if (current < total - 2) {
    pages.push("…");
  }

  pages.push(total);
  return pages;
}
