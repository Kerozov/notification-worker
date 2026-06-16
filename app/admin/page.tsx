import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { hasAdminSession } from "@/lib/auth/admin";
import { getDeliveryStatsByJobIds } from "@/lib/deliveries/stats";
import { runCronNow } from "./actions";
import styles from "./admin.module.css";
import { formatDateTime, formatRelative } from "./components";
import { AdminNav } from "./nav";
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
  cronProcessed?: string;
  canceled?: string;
  channel?: string;
}>;

const EMAIL_SELECT =
  "id, tenant_id, status, subject, from_email, recipients, sent_count, failed_count, error, send_at, created_at, sent_at, updated_at, idempotency_key";

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
  const flashError = params.error ? decodeURIComponent(params.error) : null;
  const canceled = params.canceled;
  const cronProcessed = params.cronProcessed
    ? Number(params.cronProcessed)
    : null;

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

  const [
    metaResult,
    tenantsResult,
    email24hResult,
    recentEmailResult,
    pendingEmailResult,
    failedEmailResult,
    sms24hResult,
    recentSmsResult,
    pendingSmsResult,
    failedSmsResult,
  ] = await Promise.all([
    supabase
      .from("worker_meta")
      .select("value")
      .eq("key", "last_cron_run_at")
      .maybeSingle(),
    supabase
      .from("tenants")
      .select("id, slug, name, default_from, default_sms_sender, notifier_api_key")
      .order("slug"),
    supabase
      .from("email_jobs")
      .select(EMAIL_SELECT)
      .gte("created_at", since)
      .order("created_at", { ascending: false }),
    supabase
      .from("email_jobs")
      .select(EMAIL_SELECT)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("email_jobs")
      .select(EMAIL_SELECT)
      .eq("status", "pending")
      .order("send_at", { ascending: true })
      .limit(15),
    supabase
      .from("email_jobs")
      .select(EMAIL_SELECT)
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("sms_jobs")
      .select(SMS_SELECT)
      .gte("created_at", since)
      .order("created_at", { ascending: false }),
    supabase
      .from("sms_jobs")
      .select(SMS_SELECT)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("sms_jobs")
      .select(SMS_SELECT)
      .eq("status", "pending")
      .order("send_at", { ascending: true })
      .limit(15),
    supabase
      .from("sms_jobs")
      .select(SMS_SELECT)
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(10),
  ]);

  const tenants: TenantRow[] = (tenantsResult.data ?? []).map((row) => ({
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    default_from: row.default_from as string | null,
    default_sms_sender: row.default_sms_sender as string | null,
    notifier_configured: Boolean(row.notifier_api_key),
  }));

  const email24h = (email24hResult.data ?? []) as EmailJobRow[];
  const recentEmail = (recentEmailResult.data ?? []) as EmailJobRow[];
  const pendingEmail = (pendingEmailResult.data ?? []) as EmailJobRow[];
  const failedEmail = (failedEmailResult.data ?? []) as EmailJobRow[];

  const sms24h = sms24hResult.error ? [] : ((sms24hResult.data ?? []) as SmsJobRow[]);
  const recentSms = recentSmsResult.error
    ? []
    : ((recentSmsResult.data ?? []) as SmsJobRow[]);
  const pendingSms = pendingSmsResult.error
    ? []
    : ((pendingSmsResult.data ?? []) as SmsJobRow[]);
  const failedSms = failedSmsResult.error
    ? []
    : ((failedSmsResult.data ?? []) as SmsJobRow[]);

  const tenantIdToSlug = new Map(tenants.map((tenant) => [tenant.id, tenant.slug]));
  const lastCronRun = (metaResult.data as { value: string } | null)?.value;

  const deliveryStats = await getDeliveryStatsByJobIds([
    ...new Set([
      ...recentEmail.map((job) => job.id),
      ...pendingEmail.map((job) => job.id),
    ]),
  ]);

  const showEmail = channel === "all" || channel === "email";
  const showSms = channel === "all" || channel === "sms";

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
              <span>Last queue run</span>
              <strong>{formatDateTime(lastCronRun)}</strong>
              <span>{formatRelative(lastCronRun)} · Europe/Sofia</span>
            </div>
            <form className={styles.runCronForm} action={runCronNow}>
              <button className={styles.runCronButton} type="submit">
                Process queues
              </button>
            </form>
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

        {canceled === "email" || canceled === "sms" ? (
          <section className={styles.successBanner}>
            Scheduled {canceled === "email" ? "email" : "SMS"} canceled.
          </section>
        ) : null}

        {cronProcessed !== null && !Number.isNaN(cronProcessed) ? (
          <section className={styles.successBanner}>
            Queues processed. Handled {cronProcessed} job(s).
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
          </>
        ) : null}

        {channel === "email" ? (
          <QuickStats
            emailPending={pendingEmail.length}
            emailRecipients24h={sumSentCount(email24h)}
            smsPending={0}
            smsRecipients24h={0}
            tenants={tenants.length}
          />
        ) : null}

        {channel === "sms" ? (
          <QuickStats
            emailPending={0}
            emailRecipients24h={0}
            smsPending={pendingSms.length}
            smsRecipients24h={sumSentCount(sms24h)}
            tenants={tenants.length}
          />
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
                showCancel
                channel={channel}
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
                  sms24hResult.error
                    ? "SMS tables missing — run migration 006_sms.sql"
                    : "No pending SMS jobs."
                }
                compact
                showCancel
                channel={channel}
              />
            </SectionBlock>
          </div>
        ) : null}

        {showEmail && channel !== "all" ? (
          <SectionBlock
            title="Email queue"
            hint="Waiting for Trigger.dev or manual process"
            badge={`${pendingEmail.length}`}
            variant="email"
          >
            <EmailJobsTable
              jobs={pendingEmail}
              tenantIdToSlug={tenantIdToSlug}
              deliveryStats={deliveryStats}
              emptyMessage="No pending email jobs."
              showCancel
              channel={channel}
            />
          </SectionBlock>
        ) : null}

        {showSms && channel !== "all" ? (
          <SectionBlock
            title="SMS queue"
            hint="Waiting for Trigger.dev or manual process"
            badge={`${pendingSms.length}`}
            variant="sms"
          >
            <SmsJobsTable
              jobs={pendingSms}
              tenantIdToSlug={tenantIdToSlug}
              emptyMessage="No pending SMS jobs."
              showCancel
              channel={channel}
            />
          </SectionBlock>
        ) : null}

        {channel === "all" ? (
          <div className={styles.splitGrid}>
            <SectionBlock
              title="Recent email"
              hint="Latest 25 campaigns"
              variant="email"
            >
              <EmailJobsTable
                jobs={recentEmail}
                tenantIdToSlug={tenantIdToSlug}
                deliveryStats={deliveryStats}
                emptyMessage="No email jobs yet."
                compact
              />
            </SectionBlock>
            <SectionBlock
              title="Recent SMS"
              hint="Latest 25 messages"
              variant="sms"
            >
              <SmsJobsTable
                jobs={recentSms}
                tenantIdToSlug={tenantIdToSlug}
                emptyMessage="No SMS jobs yet."
                compact
              />
            </SectionBlock>
          </div>
        ) : null}

        {showEmail && channel !== "all" ? (
          <SectionBlock
            title="Recent email jobs"
            hint="Latest 25 across all tenants"
            variant="email"
          >
            <EmailJobsTable
              jobs={recentEmail}
              tenantIdToSlug={tenantIdToSlug}
              deliveryStats={deliveryStats}
              emptyMessage="No email jobs yet."
            />
          </SectionBlock>
        ) : null}

        {showSms && channel !== "all" ? (
          <SectionBlock
            title="Recent SMS jobs"
            hint="Latest 25 across all tenants"
            variant="sms"
          >
            <SmsJobsTable
              jobs={recentSms}
              tenantIdToSlug={tenantIdToSlug}
              emptyMessage="No SMS jobs yet."
            />
          </SectionBlock>
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

        {channel === "all" ? (
          <div className={styles.splitGrid}>
            <SectionBlock
              title="Email failures"
              hint="Latest errors"
              variant="email"
            >
              <EmailJobsTable
                jobs={failedEmail}
                tenantIdToSlug={tenantIdToSlug}
                deliveryStats={deliveryStats}
                emptyMessage="No failed email jobs."
                compact
              />
            </SectionBlock>
            <SectionBlock
              title="SMS failures"
              hint="Latest errors"
              variant="sms"
            >
              <SmsJobsTable
                jobs={failedSms}
                tenantIdToSlug={tenantIdToSlug}
                emptyMessage="No failed SMS jobs."
                compact
              />
            </SectionBlock>
          </div>
        ) : null}

        {showEmail && channel !== "all" && failedEmail.length > 0 ? (
          <SectionBlock title="Failed email jobs" variant="email">
            <EmailJobsTable
              jobs={failedEmail}
              tenantIdToSlug={tenantIdToSlug}
              deliveryStats={deliveryStats}
              emptyMessage="No failed email jobs."
            />
          </SectionBlock>
        ) : null}

        {showSms && channel !== "all" && failedSms.length > 0 ? (
          <SectionBlock title="Failed SMS jobs" variant="sms">
            <SmsJobsTable
              jobs={failedSms}
              tenantIdToSlug={tenantIdToSlug}
              emptyMessage="No failed SMS jobs."
            />
          </SectionBlock>
        ) : null}

        <section className={styles.footerNote}>
          Scheduler: Trigger.dev every minute · Immediate API:{" "}
          <code>/api/v1/send</code>, <code>/api/v1/sms/send</code>
        </section>
      </div>
    </main>
  );
}
