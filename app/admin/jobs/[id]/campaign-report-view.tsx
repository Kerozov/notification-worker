import type { ReactNode } from "react";
import Link from "next/link";
import type { EmailJob } from "@/lib/db/supabase";
import type { EmailAttachment } from "@/lib/validation/email-job";
import { isCampaignJob } from "@/lib/jobs/campaign";
import { getJobDisplayCounts, resolveDisplayStatus } from "@/lib/deliveries/stats";
import {
  buildCampaignReport,
  defaultSortFor,
  filterRecipients,
  formatDuration,
  formatRate,
  formatSofiaFull,
  paginateRecipients,
  parseRecipientQuery,
  RECIPIENT_SEGMENTS,
  RESENDABLE_SEGMENTS,
  segmentLabel,
  type RecipientSegment,
  type ReportDelivery,
} from "@/lib/admin/campaign-report";
import { EMAIL_PREVIEW_SANDBOX, emailPreviewSrcDoc } from "@/lib/admin/email-preview";
import {
  cancelScheduledEmailJob,
  removeJobRecipient,
  resendFailedFromJob,
  sendScheduledEmailJob,
} from "../../actions";
import adminStyles from "../../admin.module.css";
import { shortId, StatusBadge } from "../../components";
import { CopyButton, EmailJobActions } from "../../job-actions";
import { ConfirmSubmit, EngagementChart } from "./report-client";
import {
  Card,
  DomainsCard,
  Funnel,
  KpiTiles,
  makeHrefFor,
  ProblemsCard,
  SortHeader,
  StatePill,
  Tabs,
  TimeCell,
  TimingCard,
  TopLinksCard,
  UrlCell,
  type ReportTab,
  type ReportView,
} from "./report-ui";
import styles from "./report.module.css";

export type ReportSearchParams = {
  error?: string;
  canceled?: string;
  sent?: string;
  removed?: string;
  tab?: string;
  seg?: string;
  rq?: string;
  sort?: string;
  dir?: string;
  rp?: string;
};

const TABS: ReportTab[] = ["overview", "recipients", "pockets", "email", "details"];

function parseTab(value: string | undefined, hasPockets: boolean): ReportTab {
  const tab = TABS.find((t) => t === value) ?? "overview";
  return tab === "pockets" && !hasPockets ? "overview" : tab;
}

const BAD_SEGMENTS = new Set<RecipientSegment>(["bounced", "failed", "invalid", "complained"]);
const ALWAYS_SHOWN = new Set<RecipientSegment>(["all", "opened", "clicked", "not_opened"]);

export type CampaignReportViewProps = {
  job: EmailJob;
  tenant: { slug: string; name: string } | null;
  pockets: EmailJob[];
  parent: EmailJob | null;
  content: { html: string; attachments: EmailAttachment[]; subject: string };
  deliveries: ReportDelivery[];
  query: ReportSearchParams;
};

/** Everything on the campaign page below the top bar. Data comes in as props. */
export function CampaignReportView({
  job,
  tenant,
  pockets: children,
  parent,
  content,
  deliveries,
  query,
}: CampaignReportViewProps) {
  const isCampaign = isCampaignJob(job);

  // Jobs that have not been split or queued yet have no delivery rows; show
  // their stored list as waiting so the recipient table is never blank.
  const jobIsOpen = job.status === "pending" || job.status === "processing";
  const rows: ReportDelivery[] =
    deliveries.length > 0
      ? deliveries
      : jobIsOpen
        ? job.recipients.map((recipient, index) => ({
            id: `stored-${index}`,
            job_id: job.id,
            recipient: recipient.trim().toLowerCase(),
            status: "pending",
            error: null,
            sent_at: null,
            delivered_at: null,
            opened_at: null,
            clicked_at: null,
            clicked_url: null,
            complained_at: null,
          }))
        : [];

  const report = buildCampaignReport(rows, { sendAt: job.send_at });
  const stats = deliveries.length > 0 ? report.stats : undefined;
  const counts = getJobDisplayCounts(job, stats);
  const displayStatus = resolveDisplayStatus(job, stats);
  const pocketIndex = new Map(children.map((child, index) => [child.id, index + 1]));

  const hasPockets = children.length > 0;
  const recipientQuery = parseRecipientQuery(query);
  const view: ReportView = {
    tab: parseTab(query.tab, hasPockets),
    seg: recipientQuery.segment,
    rq: recipientQuery.q,
    sort: recipientQuery.sort,
    dir: recipientQuery.dir,
    rp: recipientQuery.page,
  };
  const hrefFor = makeHrefFor(job.id, view, defaultSortFor);
  const currentHref = hrefFor({});

  const flashError = query.error ? decodeURIComponent(query.error) : null;
  const failedCount = deliveries.filter(
    (row) => (row.status === "failed" || row.status === "bounced") && !row.complained_at,
  ).length;
  const canCancel =
    job.status === "pending" || (isCampaign && job.status === "processing");
  const pendingChildren = children.filter((child) => child.status === "pending").length;
  const canSendNow = job.status === "pending" || (isCampaign && pendingChildren > 0);
  const canRemove =
    job.status === "pending" ||
    job.status === "processing" ||
    children.some((child) => child.status === "pending");
  const tenantLabel = tenant?.slug ?? shortId(job.tenant_id);
  const sentAt = job.sent_at ?? report.firstSentAt;
  const isScheduledFuture =
    jobIsOpen && new Date(job.send_at).getTime() > Date.now();
  const headlineTime = sentAt && !isScheduledFuture ? sentAt : job.send_at;

  const tabs = [
    { id: "overview" as const, label: "Overview", href: hrefFor({ tab: "overview" }) },
    {
      id: "recipients" as const,
      label: "Recipients",
      href: hrefFor({ tab: "recipients", seg: "all", rq: "" }),
      count: report.recipients || rows.length,
    },
    ...(hasPockets
      ? [
          {
            id: "pockets" as const,
            label: "Send pockets",
            href: hrefFor({ tab: "pockets" }),
            count: children.length,
          },
        ]
      : []),
    { id: "email" as const, label: "Email", href: hrefFor({ tab: "email" }) },
    { id: "details" as const, label: "Details & IDs", href: hrefFor({ tab: "details" }) },
  ];

  return (
      <div className={styles.report}>
        <nav className={styles.crumbs} aria-label="Breadcrumb">
          <Link href="/admin?channel=email">Email jobs</Link>
          <span className={styles.crumbSep} aria-hidden>/</span>
          {tenant?.slug ? (
            <Link href={`/admin?channel=email&tenant=${encodeURIComponent(tenant.slug)}`}>
              {tenant.name || tenant.slug}
            </Link>
          ) : (
            <span>{tenantLabel}</span>
          )}
          {parent ? (
            <>
              <span className={styles.crumbSep} aria-hidden>/</span>
              <Link href={`/admin/jobs/${parent.id}`}>{parent.subject}</Link>
            </>
          ) : null}
        </nav>

        <header className={styles.header}>
          <div className={styles.headerMain}>
            <div className={styles.headerTags}>
              <StatusBadge status={displayStatus} />
              <span className={`${styles.tag} ${styles.tagAccent}`}>
                {isCampaign ? "Campaign" : parent ? "Send pocket" : "Single send"}
              </span>
              <span className={styles.tag}>{tenantLabel}</span>
            </div>
            <h1 className={styles.title}>{job.subject || "(no subject)"}</h1>
            <div className={styles.meta}>
              <span>
                From <strong>{job.from_email ?? "client default"}</strong>
              </span>
              <span>
                {isScheduledFuture ? "Goes out " : sentAt ? "Sent " : "Scheduled "}
                <strong>{formatSofiaFull(headlineTime)}</strong>
                {" · "}
                {relativeTime(headlineTime)}
              </span>
              <span>
                <strong>{counts.requested.toLocaleString("bg-BG")}</strong> recipients
                {hasPockets ? ` in ${children.length.toLocaleString("bg-BG")} pockets` : ""}
              </span>
            </div>
          </div>

          <div className={styles.headerActions}>
            {canSendNow ? (
              <form action={sendScheduledEmailJob}>
                <input type="hidden" name="jobId" value={job.id} />
                <input type="hidden" name="returnTo" value={currentHref} />
                <ConfirmSubmit
                  className={styles.btnPrimary}
                  message={
                    isCampaign && pendingChildren > 0
                      ? `Send the ${pendingChildren} waiting pocket(s) now instead of at the scheduled time?`
                      : `Send this email now to ${job.recipients.length} recipient(s) instead of at the scheduled time?`
                  }
                >
                  {isCampaign ? "Send remaining now" : "Send now"}
                </ConfirmSubmit>
              </form>
            ) : null}
            {failedCount > 0 ? (
              <form action={resendFailedFromJob}>
                <input type="hidden" name="jobId" value={job.id} />
                <ConfirmSubmit
                  className={styles.btn}
                  message={`Send this email again right now to ${failedCount} failed or bounced address(es)?`}
                >
                  Resend failed ({failedCount.toLocaleString("bg-BG")})
                </ConfirmSubmit>
              </form>
            ) : null}
            <Link className={styles.btn} href={`/admin/resend/${job.id}`}>
              Resend…
            </Link>
            {canCancel ? (
              <form action={cancelScheduledEmailJob}>
                <input type="hidden" name="jobId" value={job.id} />
                <input type="hidden" name="returnTo" value={currentHref} />
                <ConfirmSubmit
                  className={styles.btnDanger}
                  message={
                    isCampaign
                      ? "Cancel this campaign? Pockets that have not gone out will not be sent."
                      : "Cancel this job? It will not be sent."
                  }
                >
                  {isCampaign ? "Cancel campaign" : "Cancel job"}
                </ConfirmSubmit>
              </form>
            ) : null}
          </div>
        </header>

        {flashError ? <section className={adminStyles.errorBanner}>{flashError}</section> : null}
        {query.canceled ? <section className={adminStyles.successBanner}>Canceled.</section> : null}
        {query.sent ? <section className={adminStyles.successBanner}>Queued to send.</section> : null}
        {query.removed ? (
          <section className={adminStyles.successBanner}>
            Removed {query.removed} address(es).
          </section>
        ) : null}
        {parent ? (
          <section className={adminStyles.infoBanner}>
            This is one send pocket of up to 250 people.{" "}
            <Link href={`/admin/jobs/${parent.id}`}>Open the whole campaign</Link> for every
            recipient and every pocket.
          </section>
        ) : null}

        <KpiTiles
          report={report}
          hrefFor={hrefFor}
          activeSegment={view.tab === "recipients" ? view.seg : null}
        />

        <Tabs active={view.tab} items={tabs} />

        {view.tab === "overview" ? (
          <OverviewTab report={report} hrefFor={hrefFor} isScheduledFuture={isScheduledFuture} sendAt={job.send_at} />
        ) : null}

        {view.tab === "recipients" ? (
          <RecipientsTab
            jobId={job.id}
            rows={rows}
            hasDeliveries={deliveries.length > 0}
            report={report}
            view={view}
            hrefFor={hrefFor}
            currentHref={currentHref}
            pocketIndex={hasPockets ? pocketIndex : null}
            canRemove={canRemove}
            isCampaign={isCampaign}
          />
        ) : null}

        {view.tab === "pockets" && hasPockets ? (
          <Card
            title="Send pockets"
            hint="ZeptoMail gets the campaign in pockets of up to 250. Open, send or cancel one without touching the rest."
          >
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Pocket</th>
                    <th>Status</th>
                    <th className={styles.num}>Recipients</th>
                    <th className={styles.num}>Sent</th>
                    <th className={styles.num}>Opened</th>
                    <th className={styles.num}>Clicked</th>
                    <th className={styles.num}>Problems</th>
                    <th>Send at</th>
                    <th className={styles.num}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {children.map((child, index) => {
                    const childStats = report.byJob.get(child.id);
                    const sent = childStats?.sent ?? child.sent_count;
                    const problems = childStats
                      ? childStats.bounced + childStats.failed + childStats.invalid
                      : child.failed_count;
                    return (
                      <tr key={child.id}>
                        <td>
                          <Link className={styles.email} href={`/admin/jobs/${child.id}`} title={child.id}>
                            #{index + 1}
                          </Link>
                          <span className={styles.sub}>{shortId(child.id)}</span>
                        </td>
                        <td>
                          <StatusBadge status={resolveDisplayStatus(child, childStats?.total ? childStats : undefined)} />
                        </td>
                        <td className={styles.num}>{child.recipients.length.toLocaleString("bg-BG")}</td>
                        <td className={styles.num}>{sent.toLocaleString("bg-BG")}</td>
                        <td className={styles.num}>
                          {(childStats?.opened ?? 0).toLocaleString("bg-BG")}
                          <span className={styles.sub}>
                            {formatRate(sent ? (childStats?.opened ?? 0) / sent : null)}
                          </span>
                        </td>
                        <td className={styles.num}>
                          {(childStats?.clicked ?? 0).toLocaleString("bg-BG")}
                          <span className={styles.sub}>
                            {formatRate(sent ? (childStats?.clicked ?? 0) / sent : null)}
                          </span>
                        </td>
                        <td className={styles.num}>
                          {problems ? (
                            <span className={styles.badCount}>{problems.toLocaleString("bg-BG")}</span>
                          ) : (
                            <span className={styles.none}>0</span>
                          )}
                        </td>
                        <td>
                          <TimeCell value={child.sent_at ?? child.send_at} />
                        </td>
                        <td className={styles.num}>
                          <EmailJobActions
                            job={{
                              id: child.id,
                              subject: `${job.subject} · pocket ${index + 1}`,
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {view.tab === "email" ? (
          <Card
            title="The email"
            hint="Exactly what ZeptoMail sends, before merge fields like {{name}} are filled in."
          >
            <div className={`${styles.facts} ${styles.factsSpaced}`}>
              <Fact label="Subject">{content.subject || "—"}</Fact>
              <Fact label="From">{job.from_email ?? "client default"}</Fact>
              <Fact label="Reply-to">{job.reply_to ?? "client default"}</Fact>
              <Fact label="Attachments">
                {content.attachments.length === 0 ? (
                  "None"
                ) : (
                  <ul className={styles.attachments}>
                    {content.attachments.map((file) => (
                      <li key={file.url}>
                        <a href={file.url} target="_blank" rel="noopener noreferrer">
                          {file.filename}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
            </div>
            <iframe
              className={styles.previewFrame}
              title={`Email preview: ${job.subject}`}
              sandbox={EMAIL_PREVIEW_SANDBOX}
              srcDoc={emailPreviewSrcDoc(content.html)}
            />
          </Card>
        ) : null}

        {view.tab === "details" ? (
          <>
            <Card
              title="IDs and timing"
              hint={
                isCampaign
                  ? "Apps store the campaign id as worker_job_id. Paste it, the app's campaign id, or the key into the search box to land here."
                  : undefined
              }
            >
              <div className={styles.facts}>
                <Fact label="Worker job id">
                  <code className={styles.code}>{job.id}</code>
                  <CopyButton value={job.id} label="Copy" />
                </Fact>
                <Fact label="Idempotency key">
                  {job.idempotency_key ? (
                    <>
                      <code className={styles.code}>{job.idempotency_key}</code>
                      <CopyButton value={job.idempotency_key} label="Copy" />
                    </>
                  ) : (
                    "—"
                  )}
                </Fact>
                {parent ? (
                  <Fact label="Parent campaign">
                    <Link className={styles.code} href={`/admin/jobs/${parent.id}`}>
                      {parent.id}
                    </Link>
                  </Fact>
                ) : null}
                <Fact label="Client">
                  {tenant?.slug ? (
                    <Link href={`/admin/clients/${encodeURIComponent(tenant.slug)}`}>
                      {tenant.name} · {tenant.slug}
                    </Link>
                  ) : (
                    <code className={styles.code}>{job.tenant_id}</code>
                  )}
                </Fact>
                <Fact label="Stored status">
                  <StatusBadge status={job.status} />
                  {displayStatus !== job.status ? (
                    <span className={styles.sub}>shown as {displayStatus}</span>
                  ) : null}
                </Fact>
                <Fact label="Delivery counts">
                  {counts.sent.toLocaleString("bg-BG")} sent · {counts.invalid} invalid ·{" "}
                  {counts.failed} failed · {counts.bounced} bounced
                </Fact>
                <Fact label="Created">{formatSofiaFull(job.created_at)}</Fact>
                <Fact label="Scheduled for">{formatSofiaFull(job.send_at)}</Fact>
                <Fact label="First email out">{formatSofiaFull(report.firstSentAt)}</Fact>
                <Fact label="Last delivery, open or click">{formatSofiaFull(report.lastActivityAt)}</Fact>
                <Fact label="Last update">{formatSofiaFull(job.updated_at)}</Fact>
                <Fact label="Merge fields">
                  {Object.keys(job.merge ?? {}).length.toLocaleString("bg-BG")} personalised recipients
                </Fact>
              </div>
              {job.error ? (
                <div className={`${styles.fact} ${styles.factPlain}`}>
                  <span className={styles.factLabel}>Last error</span>
                  <p className={styles.errorText}>{job.error}</p>
                </div>
              ) : null}
            </Card>
            <Card
              title="Stored recipient list"
              hint={`The addresses saved on this ${isCampaign ? "campaign" : "job"}, as the app sent them.`}
              action={<CopyButton value={job.recipients.join("\n")} label="Copy all" />}
            >
              <textarea
                className={styles.recipientList}
                readOnly
                rows={Math.min(16, Math.max(6, job.recipients.length))}
                value={job.recipients.join("\n")}
              />
            </Card>
          </>
        ) : null}
      </div>
  );
}

/** "in 3 h" for the future, "3 h ago" for the past. */
function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diff)) return "";
  return diff > 0 ? `in ${formatDuration(diff)}` : `${formatDuration(-diff)} ago`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{children}</span>
    </div>
  );
}

function OverviewTab({
  report,
  hrefFor,
  isScheduledFuture,
  sendAt,
}: {
  report: ReturnType<typeof buildCampaignReport>;
  hrefFor: ReturnType<typeof makeHrefFor>;
  isScheduledFuture: boolean;
  sendAt: string;
}) {
  const timeline = report.timeline;

  return (
    <>
      <div className={styles.grid2}>
        <Card
          title="Opens and clicks over time"
          hint={
            timeline
              ? `${timeline.opens.toLocaleString("bg-BG")} unique opens and ${timeline.clicks.toLocaleString("bg-BG")} unique clicks, per ${timeline.unit} in Sofia time. ZeptoMail reports each person's first open and first click only.`
              : undefined
          }
        >
          {timeline ? (
            <EngagementChart buckets={timeline.buckets} unit={timeline.unit} />
          ) : (
            <p className={styles.emptyNote}>
              {isScheduledFuture
                ? `Nothing sent yet. It goes out ${formatSofiaFull(sendAt)}.`
                : report.sent
                  ? "No opens or clicks reported yet. They show up here as ZeptoMail sends them."
                  : "Nothing has been sent yet."}
            </p>
          )}
        </Card>
        <Card title="Funnel" hint="From the list to a click">
          <Funnel report={report} />
        </Card>
      </div>
      <div className={styles.grid3}>
        <ProblemsCard report={report} hrefFor={hrefFor} />
        <TopLinksCard report={report} hrefFor={hrefFor} />
        <TimingCard report={report} />
      </div>
      <DomainsCard report={report} />
    </>
  );
}

function RecipientsTab({
  jobId,
  rows,
  hasDeliveries,
  report,
  view,
  hrefFor,
  currentHref,
  pocketIndex,
  canRemove,
  isCampaign,
}: {
  jobId: string;
  rows: ReportDelivery[];
  hasDeliveries: boolean;
  report: ReturnType<typeof buildCampaignReport>;
  view: ReportView;
  hrefFor: ReturnType<typeof makeHrefFor>;
  currentHref: string;
  pocketIndex: Map<string, number> | null;
  canRemove: boolean;
  isCampaign: boolean;
}) {
  const filtered = filterRecipients(rows, {
    segment: view.seg,
    q: view.rq,
    sort: view.sort,
    dir: view.dir,
  });
  const page = paginateRecipients(filtered, view.rp);
  const segmentCount = report.segmentCounts[view.seg];
  const exportParams = new URLSearchParams();
  if (view.seg !== "all") exportParams.set("seg", view.seg);
  if (view.rq) exportParams.set("rq", view.rq);
  const exportQuery = exportParams.toString();
  const exportHref = `/admin/jobs/${jobId}/export${exportQuery ? `?${exportQuery}` : ""}`;
  const canResendSegment = hasDeliveries && RESENDABLE_SEGMENTS.has(view.seg) && segmentCount > 0;
  const showRemove = canRemove && page.rows.some((row) => row.status === "pending");

  return (
    <Card
      title={view.seg === "all" ? "Everyone on this send" : segmentLabel(view.seg)}
      hint="Every address with what happened to it. Filter, search, sort, export or act on a group."
    >
      <div className={styles.segments} role="list">
        {RECIPIENT_SEGMENTS.filter(
          (segment) =>
            ALWAYS_SHOWN.has(segment.id) ||
            report.segmentCounts[segment.id] > 0 ||
            view.seg === segment.id,
        ).map((segment) => (
          <Link
            key={segment.id}
            role="listitem"
            href={hrefFor({ seg: segment.id, rq: view.rq })}
            scroll={false}
            aria-current={view.seg === segment.id ? "true" : undefined}
            className={`${styles.segment} ${view.seg === segment.id ? styles.segmentActive : ""} ${
              BAD_SEGMENTS.has(segment.id) && report.segmentCounts[segment.id] > 0 ? styles.segmentBad : ""
            }`}
          >
            {segment.label}
            <span className={styles.segmentCount}>
              {report.segmentCounts[segment.id].toLocaleString("bg-BG")}
            </span>
          </Link>
        ))}
      </div>

      <div className={styles.toolbar}>
        <form className={styles.search} action={`/admin/jobs/${jobId}`} method="get" role="search">
          <input type="hidden" name="tab" value="recipients" />
          {view.seg !== "all" ? <input type="hidden" name="seg" value={view.seg} /> : null}
          <input
            className={styles.searchInput}
            type="search"
            name="rq"
            defaultValue={view.rq}
            placeholder="Find an address, domain, link or error"
            aria-label="Search recipients"
          />
          <button className={styles.btn} type="submit">
            Search
          </button>
          {view.rq ? (
            <Link className={styles.btn} href={hrefFor({ rq: "" })} scroll={false}>
              Clear
            </Link>
          ) : null}
        </form>
        <div className={styles.toolbarActions}>
          <span className={styles.resultCount}>
            {page.total === 0
              ? "No matches"
              : `${page.from.toLocaleString("bg-BG")}–${page.to.toLocaleString("bg-BG")} of ${page.total.toLocaleString("bg-BG")}`}
          </span>
          {page.total > 0 ? (
            <a className={`${styles.btn} ${styles.btnSmall}`} href={exportHref}>
              Export CSV
            </a>
          ) : null}
          {canResendSegment ? (
            <Link
              className={`${styles.btnPrimary} ${styles.btnSmall}`}
              href={`/admin/resend/${jobId}?segment=${view.seg}`}
            >
              Resend to {segmentLabel(view.seg).toLowerCase()} ({segmentCount.toLocaleString("bg-BG")})…
            </Link>
          ) : null}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className={styles.emptyNote}>
          No per-recipient records for this job. The stored address list is under Details &amp; IDs.
        </p>
      ) : page.total === 0 ? (
        <p className={styles.emptyNote}>
          Nobody here{view.rq ? ` matching “${view.rq}”` : ""}.{" "}
          <Link className={styles.cardLink} href={hrefFor({ seg: "all", rq: "" })} scroll={false}>
            Show everyone
          </Link>
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <SortHeader label="Recipient" sort="email" view={view} hrefFor={hrefFor} />
                <SortHeader label="Result" sort="status" view={view} hrefFor={hrefFor} />
                {pocketIndex ? <th>Pocket</th> : null}
                <SortHeader label="Sent" sort="sent" view={view} hrefFor={hrefFor} />
                <SortHeader label="Opened" sort="opened" view={view} hrefFor={hrefFor} />
                <SortHeader label="Clicked" sort="clicked" view={view} hrefFor={hrefFor} />
                <th>Link / note</th>
                {showRemove ? <th className={styles.num}>Manage</th> : null}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => {
                const pocket = pocketIndex?.get(row.job_id);
                const note =
                  row.error && row.status !== "canceled" ? row.error : row.status === "canceled" ? "Removed before sending" : null;
                return (
                  <tr key={row.id}>
                    <td>
                      <span className={styles.email}>{row.recipient}</span>
                      {row.delivered_at ? (
                        <span className={styles.sub}>delivered {formatSofiaFull(row.delivered_at)}</span>
                      ) : null}
                    </td>
                    <td>
                      <StatePill row={row} />
                    </td>
                    {pocketIndex ? (
                      <td>
                        {pocket ? (
                          <Link className={styles.cardLink} href={`/admin/jobs/${row.job_id}`}>
                            #{pocket}
                          </Link>
                        ) : (
                          <span className={styles.none}>—</span>
                        )}
                      </td>
                    ) : null}
                    <td>
                      <TimeCell value={row.sent_at} />
                    </td>
                    <td>
                      <TimeCell value={row.opened_at} since={row.sent_at} />
                    </td>
                    <td>
                      <TimeCell value={row.clicked_at} since={row.sent_at} />
                    </td>
                    <td>
                      {row.clicked_url ? (
                        <UrlCell url={row.clicked_url} />
                      ) : note ? (
                        <span className={styles.cellNote}>{note}</span>
                      ) : (
                        <span className={styles.none}>—</span>
                      )}
                    </td>
                    {showRemove ? (
                      <td className={styles.num}>
                        {row.status === "pending" ? (
                          <form action={removeJobRecipient} className={styles.rowForm}>
                            <input type="hidden" name="jobId" value={jobId} />
                            <input type="hidden" name="returnTo" value={currentHref} />
                            <input type="hidden" name="emails" value={row.recipient} />
                            <ConfirmSubmit
                              className={styles.linkButton}
                              message={`Remove ${row.recipient}? They will not get this email.`}
                            >
                              Remove
                            </ConfirmSubmit>
                          </form>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {page.pages > 1 ? (
        <div className={styles.pager}>
          <span>
            Page {page.page} of {page.pages}
          </span>
          <div className={styles.pagerLinks}>
            <Link
              className={`${styles.btn} ${styles.btnSmall} ${page.page <= 1 ? styles.pagerDisabled : ""}`}
              href={hrefFor({ rp: 1 })}
              scroll={false}
              aria-disabled={page.page <= 1}
            >
              First
            </Link>
            <Link
              className={`${styles.btn} ${styles.btnSmall} ${page.page <= 1 ? styles.pagerDisabled : ""}`}
              href={hrefFor({ rp: page.page - 1 })}
              scroll={false}
              aria-disabled={page.page <= 1}
            >
              ← Previous
            </Link>
            <Link
              className={`${styles.btn} ${styles.btnSmall} ${page.page >= page.pages ? styles.pagerDisabled : ""}`}
              href={hrefFor({ rp: page.page + 1 })}
              scroll={false}
              aria-disabled={page.page >= page.pages}
            >
              Next →
            </Link>
          </div>
        </div>
      ) : null}

      {canRemove ? (
        <details className={styles.manage}>
          <summary>Remove addresses from this {isCampaign ? "campaign" : "job"}</summary>
          <form action={removeJobRecipient} className={styles.manageBody}>
            <p>
              Paste one or more addresses. They are dropped from pockets that have not gone out
              yet; pockets already sending stay as they are.
            </p>
            <input type="hidden" name="jobId" value={jobId} />
            <input type="hidden" name="returnTo" value={currentHref} />
            <textarea
              className={styles.textarea}
              name="emails"
              rows={3}
              placeholder="one@example.com"
              required
            />
            <div>
              <ConfirmSubmit
                className={styles.btnDanger}
                message="Remove these addresses? They will not get this email."
              >
                Remove from {isCampaign ? "campaign" : "job"}
              </ConfirmSubmit>
            </div>
          </form>
        </details>
      ) : null}
    </Card>
  );
}
