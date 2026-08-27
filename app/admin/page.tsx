import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { hasAdminSession } from "@/lib/auth/admin";
import { getAdminChrome } from "@/lib/admin/chrome";
import {
  EMAIL_JOB_SELECT,
  fetchFilteredEmailJobs,
  fetchFilteredSmsJobs,
  parseJobListFilters,
} from "@/lib/admin/job-query";
import { resolveAdminEmailJobId } from "@/lib/admin/lookup";
import { getDeliveryStatsByJobIds, mergeJobDeliveryStats } from "@/lib/deliveries/stats";
import { listChildrenForParents } from "@/lib/jobs/campaign";
import { listTenantsForAdmin } from "@/lib/tenants/store";
import styles from "./admin.module.css";
import {
  JobFiltersBar,
  JobsPagination,
  StatusFilterChips,
} from "./job-filters-bar";
import {
  EmailJobsTable,
  SectionBlock,
  SmsJobsTable,
  StatsStrip,
  type ChannelView,
  type EmailJobRow,
  type SmsJobRow,
  type TenantRow,
} from "./dashboard-ui";
import { AdminLogin, AdminShell } from "./shell";

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

function navTab(channel: ChannelView): "overview" | "email" | "sms" {
  if (channel === "email" || channel === "sms") {
    return channel;
  }

  return "overview";
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
  const isSearch = Boolean(jobFilters.q);
  const showOverview = channel === "all" && !isSearch;
  const loadEmailList = channel === "email" || (channel === "all" && isSearch);
  const loadSmsList = channel === "sms" || (channel === "all" && isSearch);

  if (!authorized) {
    return <AdminLogin />;
  }

  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const chrome = await getAdminChrome();

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

  if (isSearch && channel !== "sms" && filterTenantId !== "__invalid__") {
    const resolved = await resolveAdminEmailJobId(
      jobFilters.q,
      filterTenantId,
    );
    if (resolved) {
      redirect(`/admin/jobs/${resolved}`);
    }
  }

  const overviewQueries = showOverview
    ? Promise.all([
        supabase
          .from("email_jobs")
          .select(EMAIL_JOB_SELECT)
          .is("parent_id", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false }),
        supabase
          .from("email_jobs")
          .select(EMAIL_JOB_SELECT)
          .is("parent_id", null)
          .eq("status", "pending")
          .order("send_at", { ascending: true })
          .limit(8),
        supabase
          .from("email_jobs")
          .select(EMAIL_JOB_SELECT)
          .is("parent_id", null)
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

  const [overviewResults, emailList, smsList] = await Promise.all([
    overviewQueries,
    loadEmailList
      ? fetchFilteredEmailJobs<EmailJobRow>(jobFilters, filterTenantId)
      : null,
    loadSmsList
      ? fetchFilteredSmsJobs<SmsJobRow>(jobFilters, filterTenantId)
      : null,
  ]);

  let email24h: EmailJobRow[] = [];
  let pendingEmail: EmailJobRow[] = [];
  let failedEmail: EmailJobRow[] = [];
  let sms24h: SmsJobRow[] = [];
  let pendingSms: SmsJobRow[] = [];
  let failedSms: SmsJobRow[] = [];
  let sms24hError = false;

  if (overviewResults) {
    const [
      email24hResult,
      pendingEmailResult,
      failedEmailResult,
      sms24hResult,
      pendingSmsResult,
      failedSmsResult,
    ] = overviewResults;

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

  const emailJobs = emailList?.jobs ?? pendingEmail;
  const smsJobs = smsList?.jobs ?? pendingSms;

  const campaignIds = [
    ...new Set(
      [...emailJobs, ...failedEmail]
        .filter((job) => job.kind === "campaign")
        .map((job) => job.id),
    ),
  ];
  const childrenByParent = await listChildrenForParents(campaignIds);
  const childIds = [...childrenByParent.values()].flat().map((job) => job.id);

  const deliveryStats = await getDeliveryStatsByJobIds([
    ...new Set([
      ...emailJobs.map((job) => job.id),
      ...smsJobs.map((job) => job.id),
      ...failedEmail.map((job) => job.id),
      ...childIds,
    ]),
  ]);

  for (const job of [...emailJobs, ...failedEmail]) {
    if (job.kind !== "campaign") continue;
    const children = childrenByParent.get(job.id) ?? [];
    deliveryStats.set(
      job.id,
      mergeJobDeliveryStats([
        deliveryStats.get(job.id),
        ...children.map((child) => deliveryStats.get(child.id)),
      ]),
    );
  }

  const childRows = childrenByParent as unknown as Map<string, EmailJobRow[]>;
  const tenantOptions = tenants.map((tenant) => ({
    slug: tenant.slug,
    name: tenant.name,
  }));

  return (
    <AdminShell
      active={navTab(channel)}
      q={jobFilters.q}
      channel={channel}
      tenant={jobFilters.tenant}
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
      lastProcessed={chrome.lastCronRun}
    >
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

      {showOverview ? (
        <StatsStrip
          emailPending={chrome.emailPending}
          emailSent24h={countByStatus(email24h, "sent")}
          emailFailed24h={countByStatus(email24h, "failed")}
          smsPending={chrome.smsPending}
          smsSent24h={countByStatus(sms24h, "sent")}
          smsFailed24h={countByStatus(sms24h, "failed")}
          tenants={tenants.length}
        />
      ) : null}

      {channel === "all" && isSearch ? (
        <>
          <SectionBlock
            title="Email"
            hint={`Search · ${jobFilters.q}`}
            variant="email"
          >
            {emailList?.error ? (
              <div className={styles.empty}>{emailList.error}</div>
            ) : (
              <>
                <EmailJobsTable
                  jobs={emailList?.jobs ?? []}
                  tenantIdToSlug={tenantIdToSlug}
                  deliveryStats={deliveryStats}
                  emptyMessage="No email jobs match this search."
                  showActions
                  channel="email"
                  returnQuery={returnQuery}
                  childrenByParent={childRows}
                />
                {(emailList?.total ?? 0) > (emailList?.jobs.length ?? 0) ? (
                  <p className={styles.sectionFooterLink}>
                    <Link
                      className={styles.actionLink}
                      href={`/admin?channel=email&q=${encodeURIComponent(jobFilters.q)}&period=all`}
                    >
                      All {emailList?.total} email matches →
                    </Link>
                  </p>
                ) : null}
              </>
            )}
          </SectionBlock>
          <SectionBlock
            title="SMS"
            hint={`Search · ${jobFilters.q}`}
            variant="sms"
          >
            {smsList?.error ? (
              <div className={styles.empty}>{smsList.error}</div>
            ) : (
              <>
                <SmsJobsTable
                  jobs={smsList?.jobs ?? []}
                  tenantIdToSlug={tenantIdToSlug}
                  emptyMessage={
                    sms24hError
                      ? "SMS tables missing — run migration 006_sms.sql"
                      : "No SMS jobs match this search."
                  }
                  showActions
                  channel="sms"
                  returnQuery={returnQuery}
                />
                {(smsList?.total ?? 0) > (smsList?.jobs.length ?? 0) ? (
                  <p className={styles.sectionFooterLink}>
                    <Link
                      className={styles.actionLink}
                      href={`/admin?channel=sms&q=${encodeURIComponent(jobFilters.q)}&period=all`}
                    >
                      All {smsList?.total} SMS matches →
                    </Link>
                  </p>
                ) : null}
              </>
            )}
          </SectionBlock>
        </>
      ) : null}

      {channel === "email" && emailList ? (
        <SectionBlock
          title="Email jobs"
          hint="Search is in the header. Paste a campaign id, camp-… key, or worker job id to open the parent campaign."
          variant="email"
        >
          <JobFiltersBar
            channel="email"
            filters={jobFilters}
            tenants={tenantOptions}
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
                childrenByParent={childRows}
              />
              <JobsPagination
                channel="email"
                filters={jobFilters}
                total={emailList.total}
              />
            </>
          )}
        </SectionBlock>
      ) : null}

      {channel === "sms" && smsList ? (
        <SectionBlock
          title="SMS jobs"
          hint="Filter by status, client, or period. Search is in the header."
          variant="sms"
        >
          <JobFiltersBar
            channel="sms"
            filters={jobFilters}
            tenants={tenantOptions}
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
      ) : null}

      {showOverview ? (
        <div className={styles.splitGrid}>
          <SectionBlock
            title="Email queue"
            hint="Next scheduled sends"
            badge={`${chrome.emailPending}`}
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
              childrenByParent={childRows}
            />
            {chrome.emailPending > pendingEmail.length ? (
              <p className={styles.sectionFooterLink}>
                <Link
                  className={styles.actionLink}
                  href="/admin?channel=email&status=pending&period=all"
                >
                  View all {chrome.emailPending} pending →
                </Link>
              </p>
            ) : null}
          </SectionBlock>
          <SectionBlock
            title="SMS queue"
            hint="Next scheduled sends"
            badge={`${chrome.smsPending}`}
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
            {chrome.smsPending > pendingSms.length ? (
              <p className={styles.sectionFooterLink}>
                <Link
                  className={styles.actionLink}
                  href="/admin?channel=sms&status=pending&period=all"
                >
                  View all {chrome.smsPending} pending →
                </Link>
              </p>
            ) : null}
          </SectionBlock>
        </div>
      ) : null}

      {showOverview && (failedEmail.length > 0 || failedSms.length > 0) ? (
        <div className={styles.splitGrid}>
          {failedEmail.length > 0 ? (
            <SectionBlock
              title="Recent email failures"
              hint="Last 5"
              variant="email"
            >
              <EmailJobsTable
                jobs={failedEmail}
                tenantIdToSlug={tenantIdToSlug}
                deliveryStats={deliveryStats}
                emptyMessage="No failed email jobs."
                compact
                returnQuery={returnQuery}
                childrenByParent={childRows}
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
              hint="Last 5"
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
    </AdminShell>
  );
}
