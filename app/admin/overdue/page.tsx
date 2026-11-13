import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAdminSession } from "@/lib/auth/admin";
import { getAdminChrome } from "@/lib/admin/chrome";
import {
  countOldFailedEmailJobs,
  FAILED_EMAIL_DISMISS_AGE_DAYS,
  fetchOverdueEmailJobs,
  fetchOverdueSmsJobs,
  type OverdueReason,
} from "@/lib/admin/overdue";
import { listTenantsForAdmin } from "@/lib/tenants/store";
import styles from "../admin.module.css";
import {
  formatDateTime,
  formatRecipients,
  formatRelative,
  shortId,
  StatusBadge,
} from "../components";
import { SectionBlock, type EmailJobRow, type SmsJobRow } from "../dashboard-ui";
import { AdminShell } from "../shell";
import { DismissOldFailedEmailButton, OverdueEmailActions, OverdueSmsActions } from "./overdue-actions";

type SearchParams = Promise<{
  error?: string;
  sent?: string;
  canceled?: string;
  dismissed?: string;
  bulkDismissed?: string;
}>;

const REASON_LABEL: Record<OverdueReason, string> = {
  overdue: "Overdue",
  stuck: "Stuck",
  failed: "Failed",
};

const REASON_HINT: Record<OverdueReason, string> = {
  overdue: "The next send attempt is late",
  stuck: "Processing, but no step is running it",
  failed: "Not sent (or not to everyone)",
};

function ReasonCell({ reason }: { reason: OverdueReason }) {
  return (
    <span className={styles.campaignBadge} title={REASON_HINT[reason]}>
      {REASON_LABEL[reason]}
    </span>
  );
}

export default async function OverduePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  const params = await searchParams;
  const flashError = params.error;

  const now = Date.now();
  const [chrome, tenants, email, sms, oldFailedCount] = await Promise.all([
    getAdminChrome(false),
    listTenantsForAdmin().catch(() => []),
    fetchOverdueEmailJobs<EmailJobRow>(now),
    fetchOverdueSmsJobs<SmsJobRow>(now),
    countOldFailedEmailJobs(now),
  ]);
  const tenantIdToSlug = new Map(tenants.map((t) => [t.id, t.slug]));
  const tenantLabel = (id: string) => tenantIdToSlug.get(id) ?? shortId(id);

  const bulkDismissed = Number.parseInt(params.bulkDismissed ?? "", 10);
  const success = Number.isSafeInteger(bulkDismissed) && bulkDismissed >= 0
    ? (bulkDismissed === 0 ? "No old failed email jobs to dismiss." : `Dismissed ${bulkDismissed} old failed email jobs.`)
    : params.sent === "email" || params.sent === "sms"
      ? (params.sent === "email" ? "Email job started." : "SMS sent.")
      : params.canceled === "email" || params.canceled === "sms"
        ? `${params.canceled === "email" ? "Email" : "SMS"} canceled — it will not be sent.`
        : params.dismissed === "email" || params.dismissed === "sms"
          ? "Removed from the list."
          : null;

  return (
    <AdminShell
      active="overdue"
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
      overdue={(email.count ?? 0) + (sms.count ?? 0)}
      lastProcessed={chrome.lastCronRun}
    >
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Overdue</h1>
          <p className={styles.pageSubtitle}>
            Late, stuck and failed email and SMS jobs. The worker can still recover pending jobs.
          </p>
        </div>
      </header>

      {flashError ? (
        <section className={styles.errorBanner}>{flashError}</section>
      ) : null}

      {success ? (
        <section className={styles.successBanner}>{success}</section>
      ) : null}

      <SectionBlock
        title="Email"
        hint="Campaigns are grouped. Each row shows the next job to review."
        badge={`${email.count ?? email.rows.length}`}
        variant="email"
        actions={oldFailedCount ? (
          <DismissOldFailedEmailButton count={oldFailedCount} days={FAILED_EMAIL_DISMISS_AGE_DAYS} />
        ) : null}
      >
        {email.error ? (
          <div className={styles.empty}>{email.error}</div>
        ) : email.rows.length === 0 ? (
          <div className={styles.empty}>No overdue, stuck or failed email jobs.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Problem</th>
                  <th>Status</th>
                  <th>Tenant</th>
                  <th>Subject</th>
                  <th>Recipients</th>
                  <th>Result</th>
                  <th>Send at</th>
                  <th className={styles.actionsHead}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {email.rows.map((job) => (
                  <Fragment key={job.id}>
                    <tr className={styles.dataRow}>
                      <td>
                        <ReasonCell reason={job.reason} />
                      </td>
                      <td>
                        <StatusBadge status={job.status} />
                      </td>
                      <td className={styles.tenantCell}>
                        {tenantLabel(job.tenant_id)}
                      </td>
                      <td className={styles.truncateWide} title={job.subject}>
                        <Link
                          href={`/admin/jobs/${job.id}`}
                          className={styles.jobSubjectLink}
                        >
                          {job.subject}
                        </Link>
                        {job.parent_id ? (
                          <div>
                            <Link href={`/admin/jobs/${job.parent_id}?tab=pockets`}>
                              Campaign
                            </Link>
                            {job.issue_count > 1 ? ` · ${job.issue_count} jobs to review` : null}
                          </div>
                        ) : null}
                      </td>
                      <td className={styles.recipients}>
                        {formatRecipients(job.recipients)}
                      </td>
                      <td className={styles.metricCell}>
                        {job.sent_count} sent · {job.failed_count} failed
                      </td>
                      <td className={styles.timeCell}>
                        <span title={formatDateTime(job.send_at)}>
                          {formatRelative(job.send_at)}
                        </span>
                      </td>
                      <td className={styles.actionsCell}>
                        <OverdueEmailActions
                          jobId={job.id}
                          reason={job.reason}
                          recipientCount={job.recipients.length}
                          canCancel={Boolean(job.parent_id) || job.sent_count === 0}
                        />
                      </td>
                    </tr>
                    {job.error ? (
                      <tr className={styles.errorRow}>
                        <td colSpan={8}>
                          <span className={styles.errorRowLabel}>Error</span>
                          {job.error}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionBlock>

      <SectionBlock
        title="SMS"
        hint="Overdue: pending 10+ min past send time · Stuck: processing with a dead step · Failed: not yet dismissed"
        badge={`${sms.count ?? sms.rows.length}`}
        variant="sms"
      >
        {sms.error ? (
          <div className={styles.empty}>{sms.error}</div>
        ) : sms.rows.length === 0 ? (
          <div className={styles.empty}>No overdue, stuck or failed SMS jobs.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Problem</th>
                  <th>Status</th>
                  <th>Tenant</th>
                  <th>Message</th>
                  <th>Recipients</th>
                  <th>Result</th>
                  <th>Send at</th>
                  <th className={styles.actionsHead}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sms.rows.map((job) => (
                  <Fragment key={job.id}>
                    <tr className={styles.dataRow}>
                      <td>
                        <ReasonCell reason={job.reason} />
                      </td>
                      <td>
                        <StatusBadge status={job.status} />
                      </td>
                      <td className={styles.tenantCell}>
                        {tenantLabel(job.tenant_id)}
                      </td>
                      <td className={styles.truncateWide} title={job.body}>
                        {job.body}
                      </td>
                      <td className={styles.recipients}>
                        {formatRecipients(job.recipients)}
                      </td>
                      <td className={styles.metricCell}>
                        {job.sent_count} sent · {job.failed_count} failed
                      </td>
                      <td className={styles.timeCell}>
                        <span title={formatDateTime(job.send_at)}>
                          {formatRelative(job.send_at)}
                        </span>
                      </td>
                      <td className={styles.actionsCell}>
                        <OverdueSmsActions
                          jobId={job.id}
                          reason={job.reason}
                          recipientCount={job.recipients.length}
                        />
                      </td>
                    </tr>
                    {job.error ? (
                      <tr className={styles.errorRow}>
                        <td colSpan={8}>
                          <span className={styles.errorRowLabel}>Error</span>
                          {job.error}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionBlock>
    </AdminShell>
  );
}
