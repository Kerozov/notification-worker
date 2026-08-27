import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { hasAdminSession } from "@/lib/auth/admin";
import {
  getDeliveriesForEmailJob,
  isCampaignJob,
  listChildJobs,
  resolveSendContent,
} from "@/lib/jobs/campaign";
import { getJobById } from "@/lib/jobs/query";
import {
  getDeliveryStatsByJobIds,
  getJobDisplayCounts,
  mergeJobDeliveryStats,
  resolveDisplayStatus,
} from "@/lib/deliveries/stats";
import { getAdminChrome } from "@/lib/admin/chrome";
import {
  cancelScheduledEmailJob,
  removeJobRecipient,
  resendFailedFromJob,
  sendScheduledEmailJob,
} from "../../actions";
import styles from "../../admin.module.css";
import { formatDateTime, shortId, StatusBadge } from "../../components";
import { EmailJobActions } from "../../job-actions";
import { AdminShell } from "../../shell";

type SearchParams = Promise<{
  error?: string;
  canceled?: string;
  sent?: string;
  removed?: string;
}>;

export default async function AdminJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  const { id } = await params;
  const query = await searchParams;
  const job = await getJobById(id);

  if (!job) {
    const chrome = await getAdminChrome();
    return (
      <AdminShell
        active="email"
        channel="email"
        emailPending={chrome.emailPending}
        smsPending={chrome.smsPending}
      >
        <p className={styles.empty}>Job not found.</p>
      </AdminShell>
    );
  }

  const supabase = getSupabaseAdmin();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("slug, name")
    .eq("id", job.tenant_id)
    .maybeSingle();

  const children = isCampaignJob(job) ? await listChildJobs(job.id) : [];
  const parent = job.parent_id ? await getJobById(job.parent_id) : null;
  const content = await resolveSendContent(job);
  const deliveries = await getDeliveriesForEmailJob(job);
  const statsIds = [job.id, ...children.map((child) => child.id)];
  const statsMap = await getDeliveryStatsByJobIds(statsIds);
  const stats = isCampaignJob(job)
    ? mergeJobDeliveryStats(statsIds.map((jobId) => statsMap.get(jobId)))
    : statsMap.get(job.id);
  const counts = getJobDisplayCounts(job, stats);
  const displayStatus = resolveDisplayStatus(job, stats);
  const flashError = query.error ? decodeURIComponent(query.error) : null;
  const failedCount = deliveries.filter(
    (row) =>
      (row.status === "failed" || row.status === "bounced") &&
      !row.complained_at,
  ).length;
  const canCancel =
    job.status === "pending" ||
    (isCampaignJob(job) && job.status === "processing");
  const canSendNow =
    job.status === "pending" ||
    (isCampaignJob(job) &&
      children.some((child) => child.status === "pending"));
  const canRemove =
    job.status === "pending" ||
    job.status === "processing" ||
    children.some((child) => child.status === "pending");
  const chrome = await getAdminChrome();

  return (
    <AdminShell
      active="email"
      channel="email"
      q=""
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
    >
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.kicker}>
            {isCampaignJob(job)
              ? "Campaign · whole send"
              : parent
                ? "Send job · one pocket"
                : "Send job"}
          </p>
          <h1 className={styles.pageTitle}>{job.subject}</h1>
          <p className={styles.pageSubtitle}>
            {tenant?.slug ?? shortId(job.tenant_id)}
          </p>
        </div>
      </header>

        {flashError ? (
          <section className={styles.errorBanner}>{flashError}</section>
        ) : null}
        {query.canceled ? (
          <section className={styles.successBanner}>Canceled.</section>
        ) : null}
        {query.sent ? (
          <section className={styles.successBanner}>Queued to send.</section>
        ) : null}
        {query.removed ? (
          <section className={styles.successBanner}>
            Removed {query.removed} address(es).
          </section>
        ) : null}

        {parent ? (
          <section className={styles.infoBanner}>
            This is one send pocket of 250.{" "}
            <Link href={`/admin/jobs/${parent.id}`}>Open the campaign</Link> to
            see everyone and every pocket.
          </section>
        ) : null}

        <section className={styles.resendCard}>
          {isCampaignJob(job) ? (
            <p className={styles.sectionHint}>
              Parent campaign. Apps store this id as <code>worker_job_id</code>.
              Paste the campaign id from Funnel / Zara / HC, this job id, or the
              key below into Search to land here.
            </p>
          ) : null}
          <div className={styles.resendMeta}>
            <div>
              <strong>Status</strong>
              <StatusBadge status={displayStatus} />
            </div>
            <div>
              <strong>Worker job id</strong>
              <code className={styles.copyValue}>{job.id}</code>
            </div>
            {parent ? (
              <div>
                <strong>Parent campaign</strong>
                <Link href={`/admin/jobs/${parent.id}`} className={styles.copyValue}>
                  {parent.id}
                </Link>
              </div>
            ) : null}
            <div>
              <strong>Key</strong>
              <code className={styles.copyValue}>
                {job.idempotency_key ?? "—"}
              </code>
            </div>
            <div>
              <strong>From</strong>
              <span>{job.from_email ?? "—"}</span>
            </div>
            <div>
              <strong>Recipients</strong>
              <span>{job.recipients.length.toLocaleString("bg-BG")}</span>
            </div>
            <div>
              <strong>Delivery</strong>
              <span>
                {counts.sent} sent · {counts.invalid} invalid · {counts.failed}{" "}
                failed · {counts.bounced} bounced
              </span>
            </div>
            <div>
              <strong>Send at</strong>
              <span>{formatDateTime(job.send_at)}</span>
            </div>
          </div>

          <div className={styles.jobDetailActions}>
            {canSendNow ? (
              <form action={sendScheduledEmailJob}>
                <input type="hidden" name="jobId" value={job.id} />
                <input type="hidden" name="returnTo" value={`/admin/jobs/${job.id}`} />
                <button className={styles.sendNowButton} type="submit">
                  {isCampaignJob(job) ? "Send remaining jobs" : "Send now"}
                </button>
              </form>
            ) : null}
            {canCancel ? (
              <form action={cancelScheduledEmailJob}>
                <input type="hidden" name="jobId" value={job.id} />
                <input type="hidden" name="returnTo" value={`/admin/jobs/${job.id}`} />
                <button className={styles.cancelButton} type="submit">
                  {isCampaignJob(job) ? "Cancel campaign" : "Cancel job"}
                </button>
              </form>
            ) : null}
            {failedCount > 0 ? (
              <form action={resendFailedFromJob}>
                <input type="hidden" name="jobId" value={job.id} />
                <button className={styles.sendNowButton} type="submit">
                  Resend failed ({failedCount})
                </button>
              </form>
            ) : null}
            <Link className={styles.actionLink} href={`/admin/resend/${job.id}`}>
              Resend…
            </Link>
            {parent ? (
              <Link className={styles.actionLink} href={`/admin/jobs/${parent.id}`}>
                Open campaign
              </Link>
            ) : null}
          </div>
        </section>

        <section className={styles.resendCard}>
          <h2 className={styles.sectionTitle}>Who this message goes to</h2>
          <p className={styles.sectionHint}>
            The stored recipient list for this {isCampaignJob(job) ? "campaign" : "job"}.
          </p>
          <textarea
            className={styles.previewRecipientList}
            readOnly
            rows={Math.min(16, Math.max(6, job.recipients.length))}
            value={job.recipients.join("\n")}
          />
        </section>

        {canRemove ? (
          <section className={styles.resendCard}>
            <h2 className={styles.sectionTitle}>Remove an address</h2>
            <p className={styles.sectionHint}>
              Drops the person from a pending send job. Already-sending pockets stay as they are.
            </p>
            <form action={removeJobRecipient} className={styles.recipientRemoveForm}>
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="returnTo" value={`/admin/jobs/${job.id}`} />
              <textarea
                className={styles.textarea}
                name="emails"
                rows={3}
                placeholder="one@example.com"
                required
              />
              <button className={styles.cancelButton} type="submit">
                Remove from campaign
              </button>
            </form>
          </section>
        ) : null}

        {children.length > 0 ? (
          <section className={styles.resendCard}>
            <h2 className={styles.sectionTitle}>Send jobs</h2>
            <p className={styles.sectionHint}>
              Pockets of up to 250 that actually go to ZeptoMail. Cancel one without stopping the rest.
            </p>
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
                  {children.map((child, index) => (
                    <tr key={child.id}>
                      <td>
                        <StatusBadge
                          status={resolveDisplayStatus(child, statsMap.get(child.id))}
                        />
                      </td>
                      <td className={styles.mono}>
                        <Link
                          href={`/admin/jobs/${child.id}`}
                          className={styles.copyValue}
                          title={child.id}
                        >
                          #{index + 1} · {shortId(child.id)}
                        </Link>
                      </td>
                      <td>{child.recipients.length.toLocaleString("bg-BG")}</td>
                      <td className={styles.metricCell}>
                        {child.sent_count} sent · {child.failed_count} fail
                      </td>
                      <td>
                        <EmailJobActions
                          job={{
                            id: child.id,
                            subject: `${job.subject} · job ${index + 1}`,
                            html: content.html,
                            from_email: child.from_email,
                            recipients: child.recipients,
                            send_at: child.send_at,
                            status: child.status,
                          }}
                          channel="email"
                          returnQuery=""
                          showSendNow
                          detailHref={`/admin/jobs/${child.id}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className={styles.resendCard}>
          <h2 className={styles.sectionTitle}>Preview</h2>
          <div className={styles.previewFrameWrap}>
            <iframe
              className={styles.previewFrame}
              title={`Email preview: ${job.subject}`}
              sandbox=""
              srcDoc={content.html}
            />
          </div>
        </section>
    </AdminShell>
  );
}
