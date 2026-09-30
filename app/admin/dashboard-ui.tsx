import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import styles from "./admin.module.css";
import {
  EmailJobActions,
  SmsJobActions,
  SmsMessageCell,
  type SmsPreviewJob,
} from "./job-actions";
import {
  formatDateTime,
  formatRecipients,
  formatRelative,
  shortId,
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
  html: string;
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
  kind?: string | null;
  parent_id?: string | null;
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
  created_at: string;
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

export function StatsStrip({
  emailPending,
  emailSent24h,
  emailFailed24h,
  smsPending,
  smsSent24h,
  smsFailed24h,
  tenants,
}: {
  emailPending: number;
  emailSent24h: number;
  emailFailed24h: number;
  smsPending: number;
  smsSent24h: number;
  smsFailed24h: number;
  tenants: number;
}) {
  const items = [
    {
      href: "/admin?channel=email&status=pending&period=all",
      value: emailPending,
      label: "Email queue",
      warn: false,
    },
    {
      href: "/admin?channel=email&period=24h",
      value: emailSent24h,
      label: "Email sent 24h",
      warn: false,
    },
    {
      href: "/admin?channel=email&status=failed&period=7d",
      value: emailFailed24h,
      label: "Email failed 24h",
      warn: emailFailed24h > 0,
    },
    {
      href: "/admin?channel=sms&status=pending&period=all",
      value: smsPending,
      label: "SMS queue",
      warn: false,
    },
    {
      href: "/admin?channel=sms&period=24h",
      value: smsSent24h,
      label: "SMS sent 24h",
      warn: false,
    },
    {
      href: "/admin?channel=sms&status=failed&period=7d",
      value: smsFailed24h,
      label: "SMS failed 24h",
      warn: smsFailed24h > 0,
    },
    {
      href: "/admin/clients",
      value: tenants,
      label: "Clients",
      warn: false,
    },
  ];

  return (
    <section className={styles.statsStrip}>
      {items.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          className={`${styles.statLink} ${item.warn ? styles.statLinkWarn : ""}`}
        >
          <span className={styles.statValue}>{item.value}</span>
          <span className={styles.statLabel}>{item.label}</span>
        </Link>
      ))}
    </section>
  );
}

function deliveryLine(counts: ReturnType<typeof getJobDisplayCounts>): string {
  const failed = counts.failed + counts.bounced;
  const extra =
    failed > 0
      ? ` · ${failed} fail`
      : counts.invalid > 0
        ? ` · ${counts.invalid} invalid`
        : "";
  return `${counts.sent.toLocaleString("bg-BG")} / ${counts.requested.toLocaleString("bg-BG")} sent${extra}`;
}

function engagementLine(counts: ReturnType<typeof getJobDisplayCounts>): string {
  if (!counts.opened && !counts.clicked && !counts.complained) {
    return "—";
  }
  return `${counts.opened} open · ${counts.clicked} click${
    counts.complained ? ` · ${counts.complained} spam` : ""
  }`;
}

export function EmailJobsTable({
  jobs,
  tenantIdToSlug,
  deliveryStats,
  emptyMessage,
  compact = false,
  showActions = false,
  channel = "all",
  showJobId = false,
  returnQuery = "",
  childrenByParent,
}: {
  jobs: EmailJobRow[];
  tenantIdToSlug: Map<string, string>;
  deliveryStats: Map<string, JobDeliveryStats>;
  emptyMessage: string;
  compact?: boolean;
  showActions?: boolean;
  channel?: ChannelView;
  showJobId?: boolean;
  returnQuery?: string;
  childrenByParent?: Map<string, EmailJobRow[]>;
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
            {showJobId ? <th>Job ID</th> : null}
            <th>Tenant</th>
            {!compact ? <th>From</th> : null}
            <th>Subject</th>
            <th>Recipients</th>
            <th>Delivery</th>
            {!compact ? <th>Engagement</th> : null}
            <th>Created</th>
            {!compact ? <th>Send at</th> : null}
            <th className={styles.actionsHead}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const stats = deliveryStats.get(job.id);
            const counts = getJobDisplayCounts(job, stats);
            const displayStatus = resolveDisplayStatus(job, stats);
            const hasError =
              job.error &&
              (displayStatus === "failed" ||
                displayStatus === "partial" ||
                job.failed_count > 0);
            const isCampaign = job.kind === "campaign";
            const chunks = childrenByParent?.get(job.id) ?? [];

            return (
              <Fragment key={job.id}>
                <tr className={styles.dataRow}>
                  <td>
                    <div className={styles.statusStack}>
                      <StatusBadge status={displayStatus} />
                      {isCampaign ? (
                        <span className={styles.campaignBadge}>Campaign</span>
                      ) : null}
                    </div>
                  </td>
                  {showJobId ? (
                    <td className={styles.mono} title={job.id}>
                      {shortId(job.id)}
                    </td>
                  ) : null}
                  <td className={styles.tenantCell}>
                    {tenantIdToSlug.get(job.tenant_id) ?? shortId(job.tenant_id)}
                  </td>
                  {!compact ? (
                    <td className={styles.truncateWide} title={job.from_email ?? undefined}>
                      {job.from_email ?? "—"}
                    </td>
                  ) : null}
                  <td className={styles.truncateWide} title={job.subject}>
                    <Link
                      href={`/admin/jobs/${job.id}`}
                      className={styles.jobSubjectLink}
                    >
                      {job.subject}
                    </Link>
                  </td>
                  <td className={styles.recipients}>
                    {formatRecipients(job.recipients)}
                  </td>
                  <td className={styles.metricCell}>{deliveryLine(counts)}</td>
                  {!compact ? (
                    <td className={styles.metricCell}>{engagementLine(counts)}</td>
                  ) : null}
                  <td className={styles.timeCell}>
                    <span title={formatRelative(job.created_at)}>
                      {formatDateTime(job.created_at)}
                    </span>
                  </td>
                  {!compact ? (
                    <td className={styles.timeCell}>
                      <span title={formatRelative(job.send_at)}>
                        {formatDateTime(job.send_at)}
                      </span>
                    </td>
                  ) : null}
                  <td className={styles.actionsCell}>
                    <div className={styles.actionStack}>
                      <EmailJobActions
                        job={{
                          id: job.id,
                          subject: job.subject,
                          html: job.html,
                          from_email: job.from_email,
                          recipients: job.recipients,
                          send_at: job.send_at,
                          status: job.status,
                        }}
                        channel={channel}
                        returnQuery={returnQuery}
                        showSendNow={showActions}
                        detailHref={`/admin/jobs/${job.id}`}
                      />
                      {!compact &&
                      !showActions &&
                      (job.status === "sent" || job.status === "partial" || job.failed_count > 0) ? (
                        <Link
                          className={styles.actionLink}
                          href={`/admin/resend/${job.id}`}
                        >
                          Resend
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {isCampaign && chunks.length > 0 && !compact ? (
                  <tr className={styles.chunkRow}>
                    <td colSpan={12}>
                      <details className={styles.chunkDetails}>
                        <summary className={styles.chunkSummary}>
                          {chunks.length.toLocaleString("bg-BG")} send jobs ·{" "}
                          {job.recipients.length.toLocaleString("bg-BG")} recipients
                        </summary>
                        <div className={styles.chunkTableWrap}>
                          <table className={styles.chunkTable}>
                            <thead>
                              <tr>
                                <th>Status</th>
                                <th>Job</th>
                                <th>Recipients</th>
                                <th>Result</th>
                                <th>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {chunks.map((child, index) => (
                                <tr key={child.id}>
                                  <td>
                                    <StatusBadge
                                      status={resolveDisplayStatus(
                                        child,
                                        deliveryStats.get(child.id),
                                      )}
                                    />
                                  </td>
                                  <td className={styles.mono} title={child.id}>
                                    #{index + 1} · {shortId(child.id)}
                                  </td>
                                  <td>
                                    {child.recipients.length.toLocaleString("bg-BG")}
                                  </td>
                                  <td className={styles.metricCell}>
                                    {child.sent_count} sent · {child.failed_count} fail
                                  </td>
                                  <td className={styles.actionsCell}>
                                    <EmailJobActions
                                      job={{
                                        id: child.id,
                                        subject: `${job.subject} · job ${index + 1}`,
                                        html: job.html,
                                        from_email: child.from_email,
                                        recipients: child.recipients,
                                        send_at: child.send_at,
                                        status: child.status,
                                      }}
                                      channel={channel}
                                      returnQuery={returnQuery}
                                      showSendNow={showActions}
                                      detailHref={`/admin/jobs/${child.id}`}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </td>
                  </tr>
                ) : null}
                {hasError && !compact ? (
                  <tr className={styles.errorRow}>
                    <td colSpan={12}>
                      <span className={styles.errorRowLabel}>Error</span>
                      {job.error}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
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
  showActions = false,
  channel = "all",
  showJobId = false,
  returnQuery = "",
}: {
  jobs: SmsJobRow[];
  tenantIdToSlug: Map<string, string>;
  emptyMessage: string;
  compact?: boolean;
  showActions?: boolean;
  channel?: ChannelView;
  showJobId?: boolean;
  returnQuery?: string;
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
            {showJobId ? <th>Job ID</th> : null}
            <th>Tenant</th>
            <th>Sender</th>
            <th>Message</th>
            <th>Recipients</th>
            <th>Result</th>
            <th>Created</th>
            {!compact ? <th>Send at</th> : null}
            <th className={styles.actionsHead}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const hasError =
              job.error &&
              (job.status === "failed" ||
                job.status === "partial" ||
                job.failed_count > 0);
            const tenantLabel =
              tenantIdToSlug.get(job.tenant_id) ?? shortId(job.tenant_id);
            const preview: SmsPreviewJob = {
              id: job.id,
              body: job.body,
              sender: job.sender,
              recipients: job.recipients,
              send_at: job.send_at,
              status: job.status,
              tenant: tenantLabel,
              sent_count: job.sent_count,
              failed_count: job.failed_count,
              error: job.error,
              created_at: job.created_at,
            };

            return (
              <Fragment key={job.id}>
                <tr className={styles.dataRow}>
                  <td>
                    <StatusBadge status={job.status} />
                  </td>
                  {showJobId ? (
                    <td className={styles.mono} title={job.id}>
                      {shortId(job.id)}
                    </td>
                  ) : null}
                  <td className={styles.tenantCell}>{tenantLabel}</td>
                  <td>{job.sender ?? "—"}</td>
                  <td className={styles.messageCell}>
                    <SmsMessageCell
                      job={preview}
                      channel={channel}
                      returnQuery={returnQuery}
                      showSendNow={showActions}
                    />
                  </td>
                  <td className={styles.recipients}>
                    {formatRecipients(job.recipients)}
                  </td>
                  <td className={styles.metricCell}>
                    {job.sent_count} sent · {job.failed_count} failed
                  </td>
                  <td className={styles.timeCell}>
                    <span title={formatRelative(job.created_at)}>
                      {formatDateTime(job.created_at)}
                    </span>
                  </td>
                  {!compact ? (
                    <td className={styles.timeCell}>
                      <span title={formatRelative(job.send_at)}>
                        {formatDateTime(job.send_at)}
                      </span>
                    </td>
                  ) : null}
                  <td className={styles.actionsCell}>
                    <SmsJobActions
                      job={preview}
                      channel={channel}
                      returnQuery={returnQuery}
                      showSendNow={showActions}
                    />
                  </td>
                </tr>
                {hasError && !compact ? (
                  <tr className={styles.errorRow}>
                    <td colSpan={12}>
                      <span className={styles.errorRowLabel}>Error</span>
                      {job.error}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
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
