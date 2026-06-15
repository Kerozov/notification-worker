import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { hasAdminSession } from "@/lib/auth/admin";
import { getOpenStatsByJobIds } from "@/lib/deliveries/store";
import { runCronNow } from "./actions";
import styles from "./admin.module.css";
import {
  formatDateTime,
  formatRecipients,
  formatRelative,
  shortId,
  StatCard,
  StatusBadge,
} from "./components";

type SearchParams = Promise<{ secret?: string; error?: string; cronProcessed?: string }>;

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  default_from: string | null;
  created_at: string;
};

type JobRow = {
  id: string;
  tenant_id: string;
  status: string;
  subject: string;
  from_email: string | null;
  recipients: string[];
  sent_count: number;
  failed_count: number;
  error: string | null;
  send_at: string;
  created_at: string;
  sent_at: string | null;
  updated_at: string;
  idempotency_key: string | null;
};

async function authorizeAdmin(searchParams: SearchParams): Promise<boolean> {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    return false;
  }

  const params = await searchParams;

  if (params.secret === adminSecret) {
    redirect(
      `/api/admin/login?secret=${encodeURIComponent(params.secret)}`,
    );
  }

  return hasAdminSession();
}

function countByStatus(jobs: JobRow[], status: string): number {
  return jobs.filter((job) => job.status === status).length;
}

function sumSentRecipients(jobs: JobRow[]): number {
  return jobs
    .filter((job) => job.status === "sent")
    .reduce((total, job) => total + job.sent_count, 0);
}

function tenantJobStats(
  jobs: JobRow[],
  tenants: TenantRow[],
): Array<{
  slug: string;
  name: string;
  default_from: string | null;
  total: number;
  sent: number;
  failed: number;
  pending: number;
}> {
  return tenants.map((tenant) => {
    const tenantJobs = jobs.filter((job) => job.tenant_id === tenant.id);

    return {
      slug: tenant.slug,
      name: tenant.name,
      default_from: tenant.default_from,
      total: tenantJobs.length,
      sent: tenantJobs.filter((job) => job.status === "sent").length,
      failed: tenantJobs.filter((job) => job.status === "failed").length,
      pending: tenantJobs.filter((job) => job.status === "pending").length,
    };
  });
}

function JobsTable({
  jobs,
  tenantIdToSlug,
  openStats,
  emptyMessage,
}: {
  jobs: JobRow[];
  tenantIdToSlug: Map<string, string>;
  openStats: Map<string, { opened: number; notOpened: number; total: number }>;
  emptyMessage: string;
}) {
  if (jobs.length === 0) {
    return <div className={styles.empty}>{emptyMessage}</div>;
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Status</th>
            <th>Tenant</th>
            <th>From</th>
            <th>Subject</th>
            <th>Recipients</th>
            <th>Sent / Failed</th>
            <th>Opens</th>
            <th>Send at</th>
            <th>Updated</th>
            <th>Job</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td>{tenantIdToSlug.get(job.tenant_id) ?? shortId(job.tenant_id)}</td>
              <td className={styles.truncate} title={job.from_email ?? undefined}>
                {job.from_email ?? "—"}
              </td>
              <td className={styles.truncate} title={job.subject}>
                {job.subject}
              </td>
              <td className={styles.recipients}>
                {formatRecipients(job.recipients)}
              </td>
              <td>
                {job.sent_count} / {job.failed_count}
              </td>
              <td>
                {openStats.get(job.id)
                  ? `${openStats.get(job.id)!.opened} opened · ${openStats.get(job.id)!.notOpened} not`
                  : "—"}
              </td>
              <td>{formatDateTime(job.send_at)}</td>
              <td title={formatRelative(job.updated_at)}>
                {formatDateTime(job.updated_at)}
              </td>
              <td className={styles.mono} title={job.id}>
                {shortId(job.id)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const authorized = await authorizeAdmin(searchParams);
  const params = await searchParams;
  const flashError = params.error ? decodeURIComponent(params.error) : null;
  const cronProcessed = params.cronProcessed
    ? Number(params.cronProcessed)
    : null;

  if (!authorized) {
    return (
      <main className={styles.unauthorized}>
        <div className={styles.unauthorizedCard}>
          <h1 className={styles.title}>Email Worker Admin</h1>
          <p className={styles.subtitle}>
            Unauthorized. Use one of the options below to sign in.
          </p>
          <p>
            Use <code>/api/admin/login?secret=YOUR_ADMIN_SECRET</code> to sign in.
          </p>
        </div>
      </main>
    );
  }

  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    metaResult,
    tenantsResult,
    jobs24hResult,
    recentJobsResult,
    pendingQueueResult,
    failedJobsResult,
  ] = await Promise.all([
    supabase
      .from("worker_meta")
      .select("value")
      .eq("key", "last_cron_run_at")
      .maybeSingle(),
    supabase.from("tenants").select("id, slug, name, default_from, created_at").order("slug"),
    supabase
      .from("email_jobs")
      .select(
        "id, tenant_id, status, subject, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false }),
    supabase
      .from("email_jobs")
      .select(
        "id, tenant_id, status, subject, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key",
      )
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("email_jobs")
      .select(
        "id, tenant_id, status, subject, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key",
      )
      .eq("status", "pending")
      .order("send_at", { ascending: true })
      .limit(20),
    supabase
      .from("email_jobs")
      .select(
        "id, tenant_id, status, subject, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key",
      )
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);

  const tenants = (tenantsResult.data ?? []) as TenantRow[];
  const jobs24h = (jobs24hResult.data ?? []) as JobRow[];
  const recentJobs = (recentJobsResult.data ?? []) as JobRow[];
  const pendingQueue = (pendingQueueResult.data ?? []) as JobRow[];
  const failedJobs = (failedJobsResult.data ?? []) as JobRow[];
  const tenantIdToSlug = new Map(tenants.map((tenant) => [tenant.id, tenant.slug]));
  const lastCronRun = (metaResult.data as { value: string } | null)?.value;
  const tenantStats = tenantJobStats(jobs24h, tenants);
  const openStats = await getOpenStatsByJobIds(
    [...recentJobs, ...pendingQueue].map((job) => job.id),
  );

  return (
    <main className={styles.adminPage}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Email Worker</h1>
            <p className={styles.subtitle}>
              Queue monitor, cron health, and delivery overview
            </p>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.headerMeta}>
              <span>Last cron run (Europe/Sofia)</span>
              <strong>{formatDateTime(lastCronRun)}</strong>
              <span>{formatRelative(lastCronRun)}</span>
            </div>
            <form className={styles.runCronForm} action={runCronNow}>
              <button className={styles.runCronButton} type="submit">
                Run cron now
              </button>
            </form>
          </div>
        </header>

        <section className={styles.planBanner}>
          <div className={styles.planBannerText}>
            <strong>Vercel Hobby setup:</strong> cron runs once daily at 09:00 UTC.
            Immediate sends via <code>/api/v1/send</code> still work without cron.
            For scheduled jobs before Pro, use <strong>Run cron now</strong> or an external scheduler.
          </div>
        </section>

        {flashError ? (
          <section className={styles.errorBanner}>{flashError}</section>
        ) : null}

        {cronProcessed !== null && !Number.isNaN(cronProcessed) ? (
          <section className={styles.successBanner}>
            Cron finished. Processed {cronProcessed} job(s).
          </section>
        ) : null}

        <section className={styles.statsGrid}>
          <StatCard
            label="Pending 24h"
            value={countByStatus(jobs24h, "pending")}
            hint={`${pendingQueue.length} waiting now`}
          />
          <StatCard
            label="Sent 24h"
            value={countByStatus(jobs24h, "sent")}
            hint={`${sumSentRecipients(jobs24h)} recipients delivered`}
          />
          <StatCard
            label="Failed 24h"
            value={countByStatus(jobs24h, "failed")}
            hint={`${countByStatus(jobs24h, "processing")} processing`}
          />
          <StatCard
            label="Total jobs 24h"
            value={jobs24h.length}
            hint={`${countByStatus(jobs24h, "canceled")} canceled`}
          />
          <StatCard label="Tenants" value={tenants.length} hint="active API keys" />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Tenants</h2>
              <p className={styles.sectionHint}>Activity in the last 24 hours</p>
            </div>
          </div>
          {tenants.length === 0 ? (
            <div className={styles.empty}>No tenants yet. Run `bun run seed`.</div>
          ) : (
            <div className={styles.tenantGrid}>
              {tenantStats.map((tenant) => (
                <div key={tenant.slug} className={styles.tenantCard}>
                  <div className={styles.tenantSlug}>{tenant.slug}</div>
                  <div className={styles.tenantName}>{tenant.name}</div>
                  <div className={styles.tenantStats}>
                    <span className={styles.tenantStat}>
                      from: {tenant.default_from ?? "—"}
                    </span>
                  </div>
                  <div className={styles.tenantStats}>
                    <span className={styles.tenantStat}>{tenant.total} jobs</span>
                    <span className={styles.tenantStat}>{tenant.sent} sent</span>
                    <span className={styles.tenantStat}>{tenant.pending} pending</span>
                    <span className={styles.tenantStat}>{tenant.failed} failed</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Pending queue</h2>
              <p className={styles.sectionHint}>Next jobs to be picked up by cron</p>
            </div>
          </div>
          <JobsTable
            jobs={pendingQueue}
            tenantIdToSlug={tenantIdToSlug}
            openStats={openStats}
            emptyMessage="No pending jobs in the queue."
          />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Recent jobs</h2>
              <p className={styles.sectionHint}>Latest 40 jobs across all tenants</p>
            </div>
          </div>
          <JobsTable
            jobs={recentJobs}
            tenantIdToSlug={tenantIdToSlug}
            openStats={openStats}
            emptyMessage="No jobs yet."
          />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Failed jobs</h2>
              <p className={styles.sectionHint}>Latest 20 failures with error details</p>
            </div>
          </div>
          {failedJobs.length === 0 ? (
            <div className={styles.empty}>No failed jobs. Nice.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Subject</th>
                    <th>Recipients</th>
                    <th>Error</th>
                    <th>Send at</th>
                    <th>Updated</th>
                    <th>Job</th>
                  </tr>
                </thead>
                <tbody>
                  {failedJobs.map((job) => (
                    <tr key={job.id}>
                      <td>{tenantIdToSlug.get(job.tenant_id) ?? shortId(job.tenant_id)}</td>
                      <td className={styles.truncate} title={job.subject}>
                        {job.subject}
                      </td>
                      <td className={styles.recipients}>
                        {formatRecipients(job.recipients)}
                      </td>
                      <td className={styles.errorText}>{job.error ?? "—"}</td>
                      <td>{formatDateTime(job.send_at)}</td>
                      <td>{formatDateTime(job.updated_at)}</td>
                      <td className={styles.mono} title={job.id}>
                        {shortId(job.id)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
