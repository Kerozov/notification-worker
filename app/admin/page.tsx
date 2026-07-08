import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { hasAdminSession } from "@/lib/auth/admin";
import {
  fetchFilteredEmailJobs,
  fetchFilteredSmsJobs,
  parseJobListFilters,
} from "@/lib/admin/job-query";
import { getDeliveryStatsByJobIds } from "@/lib/deliveries/stats";
import { listTenantsForAdmin } from "@/lib/tenants/store";
import styles from "./admin.module.css";
import { formatDateTime, formatRelative } from "./components";
import { AdminNav } from "./nav";
import {
  JobFiltersBar,
  JobsPagination,
  StatusFilterChips,
} from "./job-filters-bar";
import {
  ChannelNav,
  ChannelOverview,
  EmailJobsTable,
  QuickStats,
  SectionBlock,
  SmsJobsTable,
  TenantsGrid,
  type ChannelView,
  type EmailJobRow,
  type SmsJobRow,
  type TenantRow,
} from "./dashboard-ui";

type SearchParams = Promise<{
  secret?: string;
  error?: string;
  canceled?: string;
  sent?: string;
  channel?: string;
  status?: string;
  tenant?: string;
  period?: string;
  q?: string;
  page?: string;
  sort?: string;
  sortDir?: string;
}>;

const EMAIL_SELECT =
  "id, tenant_id, status, subject, html, from_email, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key";

const SMS_SELECT =
  "id, tenant_id, status, body, sender, recipients, sent_count, failed_count, error, send_at, updated_at, created_at";

function parseChannel(value: string | undefined): ChannelView {
  if (value === "email" || value === "sms") {
    return value;
  }

  return "all";
}

function countByStatus<T extends { status: string }>(
  jobs: T[],
  status: string,
): number {
  return jobs.filter((job) => job.status === status).length;
}

function sumSentCount(jobs: Array<{ sent_count: number; status: string }>): number {
  return jobs
    .filter((job) => job.status === "sent" || job.status === "partial")
    .reduce((total, job) => total + job.sent_count, 0);
}

function buildReturnQuery(
  params: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();

  for (const key of [
    "channel",
    "status",
    "tenant",
    "period",
    "q",
    "page",
    "sort",
    "sortDir",
  ] as const) {
    const value = params[key];

    if (value) {
      search.set(key, value);
    }
  }

  return search.toString();
}

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

export default async function AdminPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const authorized = await authorizeAdmin(searchParams);
  const params = await searchParams;
  const channel = parseChannel(params.channel);
  const jobFilters = parseJobListFilters(params);
  const flashError = params.error ? decodeURIComponent(params.error) : null;
  const canceled = params.canceled;
  const sent = params.sent;
  const returnQuery = buildReturnQuery(params);

  if (!authorized) {
    return (
      <main className={styles.unauthorized}>
        <div className={styles.unauthorizedCard}>
          <h1 className={styles.title}>Notification Worker</h1>
          <p className={styles.subtitle}>
            Sign in to monitor email and SMS delivery.
          </p>
          <p>
            Use <code>/api/admin/login?secret=YOUR_ADMIN_SECRET</code>
          </p>
        </div>
      </main>
    );
  }

  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let tenants: TenantRow[] = [];
  let tenantsSchemaWarning: string | null = null;

  try {
    const rows = await listTenantsForAdmin();
    tenants = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      default_from: row.default_from,
      default_sms_sender: row.default_sms_sender,
      notifier_configured: row.notifier_configured,
    }));
  } catch (error) {
    tenantsSchemaWarning =
      error instanceof Error
        ? error.message
        : "Failed to load clients from database";
  }

  const tenantIdToSlug = new Map(tenants.map((tenant) => [tenant.id, tenant.slug]));
  const slugToTenantId = new Map(tenants.map((tenant) => [tenant.slug, tenant.id]));
  const filterTenantId =
    jobFilters.tenant === "all"
      ? null
      : (slugToTenantId.get(jobFilters.tenant) ?? "__invalid__");

  const overviewQueries = channel === "all"
    ? Promise.all([
        supabase
          .from("worker_meta")
          .select("value")
          .eq("key", "last_cron_run_at")
          .maybeSingle(),
        supabase
          .from("email_jobs")
          .select(EMAIL_SELECT)
          .gte("created_at", since)
          .order("created_at", { ascending: false }),
        supabase
          .from("email_jobs")
          .select(EMAIL_SELECT)
          .eq("status", "pending")
          .order("send_at", { ascending: true })
          .limit(8),
        supabase
          .from("email_jobs")
          .select(EMAIL_SELECT)
          .eq("status", "failed")
          .order("updated_at", { ascending: false })
          .limit(5),
        supabase
          .from("sms_jobs")
          .select(SMS_SELECT)
          .gte("created_at", since)
          .order("created_at", { ascending: false }),
        supabase
          .from("sms_jobs")
          .select(SMS_SELECT)
          .eq("status", "pending")
          .order("send_at", { ascending: true })
          .limit(8),
        supabase
          .from("sms_jobs")
          .select(SMS_SELECT)
          .eq("status", "failed")
          .order("updated_at", { ascending: false })
          .limit(5),
      ])
    : null;

  const filteredEmailPromise =
    channel === "email"
      ? fetchFilteredEmailJobs<EmailJobRow>(jobFilters, filterTenantId)
      : null;

  const filteredSmsPromise =
    channel === "sms"
      ? fetchFilteredSmsJobs<SmsJobRow>(jobFilters, filterTenantId)
      : null;

  const [overviewResults, emailList, smsList] = await Promise.all([
    overviewQueries,
    filteredEmailPromise,
    filteredSmsPromise,
  ]);

  let lastCronRun: string | null | undefined;
  let email24h: EmailJobRow[] = [];
  let pendingEmail: EmailJobRow[] = [];
  let failedEmail: EmailJobRow[] = [];
  let sms24h: SmsJobRow[] = [];
  let pendingSms: SmsJobRow[] = [];
  let failedSms: SmsJobRow[] = [];
  let sms24hError = false;

  if (overviewResults) {
    const [
      metaResult,
      email24hResult,
      pendingEmailResult,
      failedEmailResult,
      sms24hResult,
      pendingSmsResult,
      failedSmsResult,
    ] = overviewResults;

    lastCronRun = (metaResult.data as { value: string } | null)?.value;
    email24h = (email24hResult.data ?? []) as EmailJobRow[];
    pendingEmail = (pendingEmailResult.data ?? []) as EmailJobRow[];
    failedEmail = (failedEmailResult.data ?? []) as EmailJobRow[];
    sms24h = sms24hResult.error ? [] : ((sms24hResult.data ?? []) as SmsJobRow[]);
    pendingSms = pendingSmsResult.error
      ? []
      : ((pendingSmsResult.data ?? []) as SmsJobRow[]);
    failedSms = failedSmsResult.error
      ? []
      : ((failedSmsResult.data ?? []) as SmsJobRow[]);
    sms24hError = Boolean(sms24hResult.error);
  }

  const emailJobs =
    channel === "email" && emailList ? emailList.jobs : pendingEmail;
  const smsJobs = channel === "sms" && smsList ? smsList.jobs : pendingSms;

  const deliveryStats = await getDeliveryStatsByJobIds([
    ...new Set([
      ...emailJobs.map((job) => job.id),
      ...smsJobs.map((job) => job.id),
      ...failedEmail.map((job) => job.id),
    ]),
  ]);


  return (
    <main className={styles.adminPage}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.kicker}>Operations dashboard</p>
            <h1 className={styles.title}>Notification Worker</h1>
            <p className={styles.subtitle}>
              Email (ZeptoMail) and SMS (Notifier) — queues, delivery, engagement
            </p>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.headerMeta}>
              <span>Last send processed</span>
              <strong>{formatDateTime(lastCronRun ?? null)}</strong>
              <span>{formatRelative(lastCronRun ?? null)} · Europe/Sofia</span>
            </div>
          </div>
        </header>

        <AdminNav active="dashboard" />

        <ChannelNav
          active={channel}
          emailPending={pendingEmail.length}
          smsPending={pendingSms.length}
        />

        {flashError ? (
          <section className={styles.errorBanner}>{flashError}</section>
        ) : null}

        {tenantsSchemaWarning ? (
          <section className={styles.errorBanner}>{tenantsSchemaWarning}</section>
        ) : null}

        {canceled === "email" || canceled === "sms" ? (
          <section className={styles.successBanner}>
            Scheduled {canceled === "email" ? "email" : "SMS"} canceled.
          </section>
        ) : null}

        {sent === "email" || sent === "sms" ? (
          <section className={styles.successBanner}>
            {sent === "email" ? "Email" : "SMS"} sent immediately.
          </section>
        ) : null}

        {channel === "all" ? (
          <>
            <ChannelOverview
              emailPending={pendingEmail.length}
              emailSent24h={countByStatus(email24h, "sent")}
              emailFailed24h={countByStatus(email24h, "failed")}
              emailTotal24h={email24h.length}
              smsPending={pendingSms.length}
              smsSent24h={countByStatus(sms24h, "sent")}
              smsFailed24h={countByStatus(sms24h, "failed")}
              smsTotal24h={sms24h.length}
            />
            <QuickStats
              emailPending={pendingEmail.length}
              emailRecipients24h={sumSentCount(email24h)}
              smsPending={pendingSms.length}
              smsRecipients24h={sumSentCount(sms24h)}
              tenants={tenants.length}
            />

            <div className={styles.exploreLinks}>
              <Link className={styles.exploreLink} href="/admin?channel=email">
                Browse all email jobs →
              </Link>
              <Link className={styles.exploreLink} href="/admin?channel=sms">
                Browse all SMS jobs →
              </Link>
              <Link
                className={styles.exploreLink}
                href="/admin?channel=email&status=failed&period=7d"
              >
                Failed email (7d) →
              </Link>
              <Link
                className={styles.exploreLink}
                href="/admin?channel=sms&status=failed&period=7d"
              >
                Failed SMS (7d) →
              </Link>
            </div>
          </>
        ) : null}

        {channel === "email" && emailList ? (
          <>
            <QuickStats
              emailPending={
                emailList.statusCounts.find((row) => row.status === "pending")
                  ?.count ?? 0
              }
              emailRecipients24h={sumSentCount(
                emailList.jobs.filter((job) => job.status === "sent"),
              )}
              smsPending={0}
              smsRecipients24h={0}
              tenants={tenants.length}
            />
            <SectionBlock
              title="Email jobs"
              hint="Filter by status, client, period, or search"
              variant="email"
            >
              <JobFiltersBar
                channel="email"
                filters={jobFilters}
                tenants={tenants.map((tenant) => ({
                  slug: tenant.slug,
                  name: tenant.name,
                }))}
              />
              <StatusFilterChips
                channel="email"
                filters={jobFilters}
                statusCounts={emailList.statusCounts}
                total={emailList.total}
              />
              {emailList.error ? (
                <div className={styles.empty}>{emailList.error}</div>
              ) : (
                <>
                  <EmailJobsTable
                    jobs={emailList.jobs}
                    tenantIdToSlug={tenantIdToSlug}
                    deliveryStats={deliveryStats}
                    emptyMessage="No email jobs match your filters."
                    showActions
                    showJobId
                    channel="email"
                    returnQuery={returnQuery}
                  />
                  <JobsPagination
                    channel="email"
                    filters={jobFilters}
                    total={emailList.total}
                  />
                </>
              )}
            </SectionBlock>
          </>
        ) : null}

        {channel === "sms" && smsList ? (
          <>
            <QuickStats
              emailPending={0}
              emailRecipients24h={0}
              smsPending={
                smsList.statusCounts.find((row) => row.status === "pending")
                  ?.count ?? 0
              }
              smsRecipients24h={sumSentCount(
                smsList.jobs.filter((job) => job.status === "sent"),
              )}
              tenants={tenants.length}
            />
            <SectionBlock
              title="SMS jobs"
              hint="Filter by status, client, period, or search"
              variant="sms"
            >
              <JobFiltersBar
                channel="sms"
                filters={jobFilters}
                tenants={tenants.map((tenant) => ({
                  slug: tenant.slug,
                  name: tenant.name,
                }))}
              />
              <StatusFilterChips
                channel="sms"
                filters={jobFilters}
                statusCounts={smsList.statusCounts}
                total={smsList.total}
              />
              {smsList.error ? (
                <div className={styles.empty}>{smsList.error}</div>
              ) : (
                <>
                  <SmsJobsTable
                    jobs={smsList.jobs}
                    tenantIdToSlug={tenantIdToSlug}
                    emptyMessage={
                      sms24hError
                        ? "SMS tables missing — run migration 006_sms.sql"
                        : "No SMS jobs match your filters."
                    }
                    showActions
                    showJobId
                    channel="sms"
                    returnQuery={returnQuery}
                  />
                  <JobsPagination
                    channel="sms"
                    filters={jobFilters}
                    total={smsList.total}
                  />
                </>
              )}
            </SectionBlock>
          </>
        ) : null}

        {channel === "all" ? (
          <div className={styles.splitGrid}>
            <SectionBlock
              title="Email queue"
              hint="Next scheduled sends"
              badge={`${pendingEmail.length}`}
              variant="email"
            >
              <EmailJobsTable
                jobs={pendingEmail}
                tenantIdToSlug={tenantIdToSlug}
                deliveryStats={deliveryStats}
                emptyMessage="No pending email jobs."
                compact
                showActions
                channel={channel}
                returnQuery={returnQuery}
              />
            </SectionBlock>
            <SectionBlock
              title="SMS queue"
              hint="Next scheduled sends"
              badge={`${pendingSms.length}`}
              variant="sms"
            >
              <SmsJobsTable
                jobs={pendingSms}
                tenantIdToSlug={tenantIdToSlug}
                emptyMessage={
                  sms24hError
                    ? "SMS tables missing — run migration 006_sms.sql"
                    : "No pending SMS jobs."
                }
                compact
                showActions
                channel={channel}
                returnQuery={returnQuery}
              />
            </SectionBlock>
          </div>
        ) : null}

        {channel === "all" && (failedEmail.length > 0 || failedSms.length > 0) ? (
          <div className={styles.splitGrid}>
            {failedEmail.length > 0 ? (
              <SectionBlock
                title="Recent email failures"
                hint="Last 5 · open full list for filters"
                variant="email"
              >
                <EmailJobsTable
                  jobs={failedEmail}
                  tenantIdToSlug={tenantIdToSlug}
                  deliveryStats={deliveryStats}
                  emptyMessage="No failed email jobs."
                  compact
                  returnQuery={returnQuery}
                />
                <p className={styles.sectionFooterLink}>
                  <Link
                    className={styles.actionLink}
                    href="/admin?channel=email&status=failed&period=7d"
                  >
                    View all failed email →
                  </Link>
                </p>
              </SectionBlock>
            ) : null}
            {failedSms.length > 0 ? (
              <SectionBlock
                title="Recent SMS failures"
                hint="Last 5 · open full list for filters"
                variant="sms"
              >
                <SmsJobsTable
                  jobs={failedSms}
                  tenantIdToSlug={tenantIdToSlug}
                  emptyMessage="No failed SMS jobs."
                  compact
                  returnQuery={returnQuery}
                />
                <p className={styles.sectionFooterLink}>
                  <Link
                    className={styles.actionLink}
                    href="/admin?channel=sms&status=failed&period=7d"
                  >
                    View all failed SMS →
                  </Link>
                </p>
              </SectionBlock>
            ) : null}
          </div>
        ) : null}

        <SectionBlock title="Clients" hint="Tenants and channel configuration">
          <p className={styles.clientsSectionLink}>
            <Link className={styles.actionLink} href="/admin/clients">
              Manage clients →
            </Link>
          </p>
          <TenantsGrid
            tenants={tenants}
            emailJobs24h={email24h}
            smsJobs24h={sms24h}
          />
        </SectionBlock>

        <section className={styles.footerNote}>
          Scheduled: Trigger.dev at sendAt · Immediate:{" "}
          <code>/api/v1/send</code>, <code>/api/v1/sms/send</code>
        </section>
      </div>
    </main>
  );
}
