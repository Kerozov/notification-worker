import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./admin.module.css";
import {
  formatDateTime,
  formatRecipients,
  formatRelative,
  shortId,
  StatCard,
  StatusBadge,
} from "./components";
import {
  getJobDisplayCounts,
  resolveDisplayStatus,
  type JobDeliveryStats,
} from "@/lib/deliveries/stats";

export type ChannelView = "all" | "email" | "sms";

export type EmailJobRow = {
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

export type SmsJobRow = {
  id: string;
  tenant_id: string;
  status: string;
  body: string;
  sender: string | null;
  recipients: string[];
  sent_count: number;
  failed_count: number;
  error: string | null;
  send_at: string;
  updated_at: string;
};

export type TenantRow = {
  id: string;
  slug: string;
  name: string;
  default_from: string | null;
  default_sms_sender: string | null;
  notifier_configured: boolean;
};

export function ChannelNav({
  active,
  emailPending,
  smsPending,
}: {
  active: ChannelView;
  emailPending: number;
  smsPending: number;
}) {
  const tabs: Array<{ id: ChannelView; label: string; count?: number }> = [
    { id: "all", label: "Overview" },
    { id: "email", label: "Email", count: emailPending },
    { id: "sms", label: "SMS", count: smsPending },
  ];

  return (
    <nav className={styles.channelNav} aria-label="Channels">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.id === "all" ? "/admin" : `/admin?channel=${tab.id}`}
          className={`${styles.channelTab} ${
            active === tab.id ? styles.channelTabActive : ""
          }`}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 ? (
            <span className={styles.channelTabCount}>{tab.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export function ChannelOverview({
  emailPending,
  emailSent24h,
  emailFailed24h,
  emailTotal24h,
  smsPending,
  smsSent24h,
  smsFailed24h,
  smsTotal24h,
}: {
  emailPending: number;
  emailSent24h: number;
  emailFailed24h: number;
  emailTotal24h: number;
  smsPending: number;
  smsSent24h: number;
  smsFailed24h: number;
  smsTotal24h: number;
}) {
  return (
    <div className={styles.channelOverview}>
      <div className={`${styles.channelPanel} ${styles.channelPanelEmail}`}>
        <div className={styles.channelPanelHead}>
          <span className={styles.channelIcon}>✉</span>
          <div>
            <h2 className={styles.channelPanelTitle}>Email</h2>
            <p className={styles.channelPanelHint}>ZeptoMail · last 24h</p>
          </div>
        </div>
        <div className={styles.channelMetrics}>
          <div className={styles.channelMetric}>
            <span className={styles.channelMetricValue}>{emailPending}</span>
            <span className={styles.channelMetricLabel}>In queue</span>
          </div>
          <div className={styles.channelMetric}>
            <span className={styles.channelMetricValue}>{emailSent24h}</span>
            <span className={styles.channelMetricLabel}>Sent jobs</span>
          </div>
          <div className={styles.channelMetric}>
            <span className={`${styles.channelMetricValue} ${styles.metricBad}`}>
              {emailFailed24h}
            </span>
            <span className={styles.channelMetricLabel}>Failed</span>
          </div>
          <div className={styles.channelMetric}>
            <span className={styles.channelMetricValue}>{emailTotal24h}</span>
            <span className={styles.channelMetricLabel}>Total</span>
          </div>
        </div>
        <Link className={styles.channelPanelLink} href="/admin?channel=email">
          Open email dashboard →
        </Link>
      </div>

      <div className={`${styles.channelPanel} ${styles.channelPanelSms}`}>
        <div className={styles.channelPanelHead}>
          <span className={styles.channelIcon}>💬</span>
          <div>
            <h2 className={styles.channelPanelTitle}>SMS</h2>
            <p className={styles.channelPanelHint}>Notifier · last 24h</p>
          </div>
        </div>
        <div className={styles.channelMetrics}>
          <div className={styles.channelMetric}>
            <span className={styles.channelMetricValue}>{smsPending}</span>
            <span className={styles.channelMetricLabel}>In queue</span>
          </div>
          <div className={styles.channelMetric}>
            <span className={styles.channelMetricValue}>{smsSent24h}</span>
            <span className={styles.channelMetricLabel}>Sent jobs</span>
          </div>
          <div className={styles.channelMetric}>
            <span className={`${styles.channelMetricValue} ${styles.metricBad}`}>
              {smsFailed24h}
            </span>
            <span className={styles.channelMetricLabel}>Failed</span>
          </div>
          <div className={styles.channelMetric}>
            <span className={styles.channelMetricValue}>{smsTotal24h}</span>
            <span className={styles.channelMetricLabel}>Total</span>
          </div>
        </div>
        <Link className={styles.channelPanelLink} href="/admin?channel=sms">
          Open SMS dashboard →
        </Link>
      </div>
    </div>
  );
}

function deliveryLine(counts: ReturnType<typeof getJobDisplayCounts>): string {
  return `${counts.sent}/${counts.requested} sent · ${counts.invalid} invalid · ${counts.failed} fail · ${counts.bounced} bounce`;
}

function engagementLine(counts: ReturnType<typeof getJobDisplayCounts>): string {
  return `${counts.opened} open · ${counts.clicked} click · ${counts.complained} spam`;
}

export function EmailJobsTable({
  jobs,
  tenantIdToSlug,
  deliveryStats,
  emptyMessage,
  compact = false,
}: {
  jobs: EmailJobRow[];
  tenantIdToSlug: Map<string, string>;
  deliveryStats: Map<string, JobDeliveryStats>;
  emptyMessage: string;
  compact?: boolean;
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
            {!compact ? <th>From</th> : null}
            <th>Subject</th>
            <th>Recipients</th>
            <th>Delivery</th>
            {!compact ? <th>Engagement</th> : null}
            <th>When</th>
            {!compact ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const stats = deliveryStats.get(job.id);
            const counts = getJobDisplayCounts(job, stats);
            const displayStatus = resolveDisplayStatus(job, stats);

            return (
              <tr key={job.id}>
                <td>
                  <StatusBadge status={displayStatus} />
                </td>
                <td className={styles.tenantCell}>
                  {tenantIdToSlug.get(job.tenant_id) ?? shortId(job.tenant_id)}
                </td>
                {!compact ? (
                  <td className={styles.truncateWide} title={job.from_email ?? undefined}>
                    {job.from_email ?? "—"}
                  </td>
                ) : null}
                <td className={styles.truncateWide} title={job.subject}>
                  {job.subject}
                </td>
                <td className={styles.recipients}>
                  {formatRecipients(job.recipients)}
                </td>
                <td className={styles.metricCell}>{deliveryLine(counts)}</td>
                {!compact ? (
                  <td className={styles.metricCell}>{engagementLine(counts)}</td>
                ) : null}
                <td className={styles.timeCell}>
                  <span title={formatRelative(job.updated_at)}>
                    {formatDateTime(job.send_at)}
                  </span>
                </td>
                {!compact ? (
                  <td>
                    <Link
                      className={styles.actionLink}
                      href={`/admin/resend/${job.id}`}
                    >
                      Resend
                    </Link>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SmsJobsTable({
  jobs,
  tenantIdToSlug,
  emptyMessage,
  compact = false,
}: {
  jobs: SmsJobRow[];
  tenantIdToSlug: Map<string, string>;
  emptyMessage: string;
  compact?: boolean;
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
            <th>Sender</th>
            <th>Message</th>
            <th>Recipients</th>
            <th>Result</th>
            {!compact ? <th>Error</th> : null}
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td className={styles.tenantCell}>
                {tenantIdToSlug.get(job.tenant_id) ?? shortId(job.tenant_id)}
              </td>
              <td>{job.sender ?? "—"}</td>
              <td className={styles.truncateWide} title={job.body}>
                {job.body}
              </td>
              <td className={styles.recipients}>
                {formatRecipients(job.recipients)}
              </td>
              <td className={styles.metricCell}>
                {job.sent_count} sent · {job.failed_count} failed
              </td>
              {!compact ? (
                <td className={styles.errorText}>{job.error ?? "—"}</td>
              ) : null}
              <td className={styles.timeCell}>{formatDateTime(job.send_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TenantsGrid({
  tenants,
  emailJobs24h,
  smsJobs24h,
}: {
  tenants: TenantRow[];
  emailJobs24h: EmailJobRow[];
  smsJobs24h: SmsJobRow[];
}) {
  if (tenants.length === 0) {
    return <div className={styles.empty}>No tenants yet. Run `bun run seed`.</div>;
  }

  return (
    <div className={styles.tenantGrid}>
      {tenants.map((tenant) => {
        const emailJobs = emailJobs24h.filter((j) => j.tenant_id === tenant.id);
        const smsJobs = smsJobs24h.filter((j) => j.tenant_id === tenant.id);

        return (
          <div key={tenant.slug} className={styles.tenantCard}>
            <div className={styles.tenantCardHead}>
              <div>
                <div className={styles.tenantSlug}>{tenant.name}</div>
                <div className={styles.tenantName}>{tenant.slug}</div>
              </div>
            </div>
            <div className={styles.tenantChannels}>
              <div className={styles.tenantChannelRow}>
                <span className={styles.tenantChannelLabel}>Email</span>
                <span className={styles.tenantChannelValue}>
                  {tenant.default_from ?? "no default from"}
                </span>
              </div>
              <div className={styles.tenantChannelRow}>
                <span className={styles.tenantChannelLabel}>SMS</span>
                <span className={styles.tenantChannelValue}>
                  {tenant.default_sms_sender ?? "no sender"}
                  {tenant.notifier_configured ? (
                    <span className={styles.configOk}> · Notifier OK</span>
                  ) : (
                    <span className={styles.configMissing}> · no Notifier key</span>
                  )}
                </span>
              </div>
            </div>
            <div className={styles.tenantStats}>
              <span className={styles.tenantStat}>
                ✉ {emailJobs.length} jobs
              </span>
              <span className={styles.tenantStat}>
                💬 {smsJobs.length} SMS
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SectionBlock({
  title,
  hint,
  badge,
  children,
  variant,
}: {
  title: string;
  hint?: string;
  badge?: string;
  children: ReactNode;
  variant?: "email" | "sms" | "neutral";
}) {
  return (
    <section
      className={`${styles.section} ${
        variant === "email"
          ? styles.sectionEmail
          : variant === "sms"
            ? styles.sectionSms
            : ""
      }`}
    >
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>
            {title}
            {badge ? <span className={styles.sectionBadge}>{badge}</span> : null}
          </h2>
          {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function QuickStats({
  emailPending,
  emailRecipients24h,
  smsPending,
  smsRecipients24h,
  tenants,
}: {
  emailPending: number;
  emailRecipients24h: number;
  smsPending: number;
  smsRecipients24h: number;
  tenants: number;
}) {
  return (
    <section className={styles.statsGrid}>
      <StatCard
        label="Email queue"
        value={emailPending}
        hint={`${emailRecipients24h} recipients sent (24h)`}
      />
      <StatCard
        label="SMS queue"
        value={smsPending}
        hint={`${smsRecipients24h} messages sent (24h)`}
      />
      <StatCard label="Clients" value={tenants} hint="active tenants" />
    </section>
  );
}
