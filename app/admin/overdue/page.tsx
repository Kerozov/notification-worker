import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAdminSession } from "@/lib/auth/admin";
import { getAdminChrome } from "@/lib/admin/chrome";
import {
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
import { OverdueEmailActions, OverdueSmsActions } from "./overdue-actions";

type SearchParams = Promise<{
  error?: string;
  sent?: string;
  canceled?: string;
  dismissed?: string;
}>;

const REASON_LABEL: Record<OverdueReason, string> = {
  overdue: "Overdue",
  stuck: "Stuck",
  failed: "Failed",
};

const REASON_HINT: Record<OverdueReason, string> = {
  overdue: "Still pending, its send time has passed",
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
  const flashError = params.error ? decodeURIComponent(params.error) : null;

  const [chrome, tenants, email, sms] = await Promise.all([
    getAdminChrome(),
    listTenantsForAdmin().catch(() => []),
    fetchOverdueEmailJobs<EmailJobRow>(),
    fetchOverdueSmsJobs<SmsJobRow>(),
  ]);
  const tenantIdToSlug = new Map(tenants.map((t) => [t.id, t.slug]));
  const tenantLabel = (id: string) => tenantIdToSlug.get(id) ?? shortId(id);

  const success =
    params.sent === "email" || params.sent === "sms"
      ? `${params.sent === "email" ? "Email" : "SMS"} sent.`
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
      overdue={chrome.overdue}
      lastProcessed={chrome.lastCronRun}
    >
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Overdue</h1>
          <p className={styles.pageSubtitle}>
            Email and SMS that should have gone out but did not. Send, cancel or
            dismiss each one — nothing here is sent without a click.
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
        hint="Overdue: pending 10+ min past send time · Stuck: processing with a dead step · Failed: not yet dismissed"
        badge={`${email.rows.length}`}
        variant="email"
      >
        {email.error ? (
          <div className={styles.empty}>{email.error}</div>
        ) : email.rows.length === 0 ? (
          <div className={styles.empty}>Nothing overdue. All email went out.</div>
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
        badge={`${sms.rows.length}`}
        variant="sms"
      >
        {sms.error ? (
          <div className={styles.empty}>{sms.error}</div>
        ) : sms.rows.length === 0 ? (
          <div className={styles.empty}>Nothing overdue. All SMS went out.</div>
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
                          sentCount={job.sent_count}
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
