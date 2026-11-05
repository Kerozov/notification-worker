import Link from "next/link";
import type { ReactNode } from "react";
import {
  formatDuration,
  formatRate,
  formatSofiaFull,
  formatSofiaShort,
  RECIPIENT_STATE_LABEL,
  recipientState,
  type CampaignReport,
  type RecipientSegment,
  type RecipientSort,
  type ReportDelivery,
  type SortDir,
} from "@/lib/admin/campaign-report";
import { formatRelative } from "../../components";
import styles from "./report.module.css";

export type ReportTab = "overview" | "recipients" | "pockets" | "email" | "details";

export type ReportView = {
  tab: ReportTab;
  seg: RecipientSegment;
  rq: string;
  sort: RecipientSort;
  dir: SortDir;
  rp: number;
};

export type HrefFor = (patch: Partial<ReportView>) => string;

export function makeHrefFor(
  jobId: string,
  current: ReportView,
  defaults: (seg: RecipientSegment) => { sort: RecipientSort; dir: SortDir },
): HrefFor {
  return (patch) => {
    const next: ReportView = { ...current, ...patch };
    // Changing the segment or search starts again on page one with that
    // segment's natural sort, unless the caller set them.
    if (patch.seg !== undefined || patch.rq !== undefined) {
      if (patch.rp === undefined) next.rp = 1;
      if (patch.sort === undefined) {
        const fallback = defaults(next.seg);
        next.sort = fallback.sort;
        next.dir = patch.dir ?? fallback.dir;
      }
    }
    const params = new URLSearchParams();
    if (next.tab !== "overview") params.set("tab", next.tab);
    if (next.tab === "recipients") {
      const fallback = defaults(next.seg);
      if (next.seg !== "all") params.set("seg", next.seg);
      if (next.rq) params.set("rq", next.rq);
      if (next.sort !== fallback.sort || next.dir !== fallback.dir) {
        params.set("sort", next.sort);
        params.set("dir", next.dir);
      }
      if (next.rp > 1) params.set("rp", String(next.rp));
    }
    const query = params.toString();
    return `/admin/jobs/${jobId}${query ? `?${query}` : ""}`;
  };
}

function fmt(value: number): string {
  return value.toLocaleString("bg-BG");
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, (part / whole) * 100) : 0;
}

/** Only http(s) links from webhook data become clickable. */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function displayUrl(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function Card({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>{title}</h2>
          {hint ? <p className={styles.cardHint}>{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Tabs({
  active,
  items,
}: {
  active: ReportTab;
  items: Array<{ id: ReportTab; label: string; href: string; count?: number }>;
}) {
  return (
    <nav className={styles.tabs} aria-label="Campaign sections">
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          className={`${styles.tab} ${active === item.id ? styles.tabActive : ""}`}
          aria-current={active === item.id ? "page" : undefined}
          scroll={false}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className={styles.tabCount}>{fmt(item.count)}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export function KpiTiles({
  report,
  hrefFor,
  activeSegment,
}: {
  report: CampaignReport;
  hrefFor: HrefFor;
  activeSegment: RecipientSegment | null;
}) {
  const problems = report.bounced + report.failed + report.invalid;
  const waitingBits = [
    report.pending ? `${fmt(report.pending)} waiting` : null,
    report.canceled ? `${fmt(report.canceled)} removed` : null,
  ].filter(Boolean);

  const tiles: Array<{
    key: string;
    seg: RecipientSegment;
    label: string;
    value: string;
    sub: string;
    meter?: { value: number; tone: "open" | "click" };
    bad?: boolean;
  }> = [
    {
      key: "recipients",
      seg: "all",
      label: "Recipients",
      value: fmt(report.recipients),
      sub: waitingBits.length ? waitingBits.join(" · ") : "everyone on the list",
    },
    {
      key: "sent",
      seg: "all",
      label: "Sent",
      value: fmt(report.sent),
      sub: `${formatRate(report.rates.sent)} of recipients`,
    },
    {
      key: "opened",
      seg: "opened",
      label: "Opened",
      value: formatRate(report.rates.open),
      sub: `${fmt(report.opened)} people`,
      meter: { value: (report.rates.open ?? 0) * 100, tone: "open" },
    },
    {
      key: "clicked",
      seg: "clicked",
      label: "Clicked",
      value: formatRate(report.rates.click),
      sub: `${fmt(report.clicked)} people · ${formatRate(report.rates.clickToOpen)} of opens`,
      meter: { value: (report.rates.click ?? 0) * 100, tone: "click" },
    },
    {
      key: "not_opened",
      seg: "not_opened",
      label: "Not opened",
      value: fmt(report.notOpened),
      sub: report.sent ? `${formatRate(report.notOpened / report.sent)} of sent` : "—",
    },
    {
      key: "problems",
      seg: report.bounced ? "bounced" : report.failed ? "failed" : report.invalid ? "invalid" : "bounced",
      label: "Bounced or failed",
      value: fmt(problems),
      sub: problems
        ? [
            report.bounced ? `${fmt(report.bounced)} bounced` : null,
            report.failed ? `${fmt(report.failed)} failed` : null,
            report.invalid ? `${fmt(report.invalid)} invalid` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "none",
      bad: problems > 0,
    },
    {
      key: "complained",
      seg: "complained",
      label: "Spam reports",
      value: fmt(report.complained),
      sub: report.complained ? `${formatRate(report.rates.complaint, 2)} of sent` : "none",
      bad: report.complained > 0,
    },
  ];

  return (
    <div className={styles.kpis}>
      {tiles.map((tile) => (
        <Link
          key={tile.key}
          href={hrefFor({ tab: "recipients", seg: tile.seg })}
          scroll={false}
          className={`${styles.kpi} ${tile.bad ? styles.kpiBad : ""} ${
            activeSegment === tile.seg && tile.key !== "sent" ? styles.kpiActive : ""
          }`}
        >
          <span className={styles.kpiLabel}>{tile.label}</span>
          <span className={styles.kpiValue}>{tile.value}</span>
          <span className={styles.kpiSub}>{tile.sub}</span>
          {tile.meter ? (
            <span
              className={`${styles.meter} ${tile.meter.tone === "click" ? styles.meterClick : ""}`}
              aria-hidden
            >
              <span style={{ width: `${Math.min(100, tile.meter.value)}%` }} />
            </span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

export function Funnel({ report }: { report: CampaignReport }) {
  const base = Math.max(report.recipients, report.sent, 1);
  const stages = [
    { label: "Recipients", value: report.recipients, note: null },
    { label: "Sent", value: report.sent, note: formatRate(report.rates.sent) },
    { label: "Delivered", value: report.delivered, note: formatRate(report.rates.delivered) },
    { label: "Opened", value: report.opened, note: formatRate(report.rates.open) },
    { label: "Clicked", value: report.clicked, note: formatRate(report.rates.click) },
  ];

  return (
    <>
      <ol className={styles.funnel}>
        {stages.map((stage) => (
          <li key={stage.label} className={styles.funnelRow}>
            <span className={styles.funnelLabel}>{stage.label}</span>
            <span className={styles.funnelTrack} aria-hidden>
              {stage.value ? (
                <span className={styles.funnelBar} style={{ width: `${pct(stage.value, base)}%` }} />
              ) : null}
            </span>
            <span className={styles.funnelValue}>
              {fmt(stage.value)}
              {stage.note ? <span>{stage.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className={styles.funnelNote}>
        Sent is the share of recipients; the rest are shares of sent. Delivered counts a
        delivery, open, click or spam report from ZeptoMail.
        {report.clickedWithoutOpen > 0
          ? ` ${fmt(report.clickedWithoutOpen)} clicked with images off, so their open was never tracked.`
          : ""}
      </p>
    </>
  );
}

export function ProblemsCard({
  report,
  hrefFor,
}: {
  report: CampaignReport;
  hrefFor: HrefFor;
}) {
  const items: Array<{ seg: RecipientSegment; label: string; value: number; tone: "bad" | "warn" | "muted" }> = [
    { seg: "bounced", label: "Bounced", value: report.bounced, tone: "bad" },
    { seg: "failed", label: "Failed to send", value: report.failed, tone: "bad" },
    { seg: "invalid", label: "Invalid address", value: report.invalid, tone: "bad" },
    { seg: "complained", label: "Spam reports", value: report.complained, tone: "bad" },
    { seg: "pending", label: "Waiting to send", value: report.pending, tone: "warn" },
    { seg: "canceled", label: "Removed from the job", value: report.canceled, tone: "muted" },
  ];
  const trouble = report.bounced + report.failed + report.invalid + report.complained;

  return (
    <Card
      title="Problems"
      hint={
        report.rates.bounce !== null
          ? `Bounce rate ${formatRate(report.rates.bounce, 2)}`
          : "Nothing handed to ZeptoMail yet"
      }
    >
      {trouble === 0 ? (
        <p className={styles.allGood}>
          <span aria-hidden>✓</span> No bounces, failures or spam reports
        </p>
      ) : null}
      <ul className={styles.statList}>
        {items.map((item) => (
          <li key={item.seg}>
            <Link
              href={hrefFor({ tab: "recipients", seg: item.seg })}
              scroll={false}
              className={styles.statItem}
            >
              <span className={styles.statName}>
                <span
                  className={`${styles.dot} ${
                    item.value === 0
                      ? styles.dotMuted
                      : item.tone === "bad"
                        ? styles.dotBad
                        : item.tone === "warn"
                          ? styles.dotWarn
                          : styles.dotMuted
                  }`}
                  aria-hidden
                />
                {item.label}
              </span>
              <span className={`${styles.statCount} ${item.value === 0 ? styles.statCountZero : ""}`}>
                {fmt(item.value)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TopLinksCard({
  report,
  hrefFor,
}: {
  report: CampaignReport;
  hrefFor: HrefFor;
}) {
  return (
    <Card
      title="Clicked links"
      hint="The first link each person clicked"
      action={
        report.clicked ? (
          <Link className={styles.cardLink} href={hrefFor({ tab: "recipients", seg: "clicked" })} scroll={false}>
            Who clicked →
          </Link>
        ) : null
      }
    >
      {report.topLinks.length === 0 ? (
        <p className={styles.emptyNote}>No clicks yet.</p>
      ) : (
        <div>
          {report.topLinks.map((link) => {
            const href = safeHttpUrl(link.url);
            return (
              <div key={link.url} className={styles.linkRow}>
                <div className={styles.linkTop}>
                  {href ? (
                    <a
                      className={styles.linkUrl}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={link.url}
                    >
                      {displayUrl(link.url)}
                    </a>
                  ) : (
                    <span className={styles.linkUrl} title={link.url}>
                      {link.url}
                    </span>
                  )}
                  <span className={styles.statCount}>
                    {fmt(link.clicks)}{" "}
                    <span className={styles.statCountZero}>{formatRate(link.share, 0)}</span>
                  </span>
                </div>
                <span className={styles.thinBar} aria-hidden>
                  <span style={{ width: `${pct(link.share, 1)}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function TimingCard({ report }: { report: CampaignReport }) {
  const { measured, medianMs, within1h, within24h } = report.timeToOpen;

  return (
    <Card
      title="Time to open"
      hint={
        report.lastActivityAt
          ? `Last activity ${formatRelative(report.lastActivityAt)} · ${formatSofiaFull(report.lastActivityAt)}`
          : "No activity yet"
      }
    >
      {measured === 0 ? (
        <p className={styles.emptyNote}>No opens yet.</p>
      ) : (
        <>
          <div className={styles.bigFigure}>{formatDuration(medianMs)}</div>
          <p className={styles.bigFigureLabel}>
            median from send to first open · {fmt(measured)} opens
          </p>
          <div className={styles.timingRows}>
            {[
              { label: "Within 1 hour", value: within1h },
              { label: "Within 24 hours", value: within24h },
              { label: "Later", value: measured - within24h },
            ].map((row) => (
              <div key={row.label} className={styles.timingRow}>
                <span>{row.label}</span>
                <span className={`${styles.meter} ${styles.meterInline}`} aria-hidden>
                  <span style={{ width: `${pct(row.value, measured)}%` }} />
                </span>
                <strong>{formatRate(row.value / measured, 0)}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

export function DomainsCard({ report }: { report: CampaignReport }) {
  if (report.domains.length === 0) return null;

  return (
    <Card
      title="Email providers"
      hint="How each inbox provider treated this send. A provider with many problems or no opens is a deliverability warning."
    >
      <div className={styles.tableWrap}>
        <table className={`${styles.table} ${styles.tableNarrow}`}>
          <thead>
            <tr>
              <th>Domain</th>
              <th className={styles.num}>Recipients</th>
              <th className={styles.num}>Sent</th>
              <th>Opened</th>
              <th>Clicked</th>
              <th className={styles.num}>Problems</th>
            </tr>
          </thead>
          <tbody>
            {report.domains.map((row) => (
              <tr key={row.domain}>
                <td className={styles.email}>{row.domain}</td>
                <td className={styles.num}>{fmt(row.recipients)}</td>
                <td className={styles.num}>{fmt(row.sent)}</td>
                <td>
                  <RateCell value={row.openRate} count={row.opened} tone="open" />
                </td>
                <td>
                  <RateCell value={row.clickRate} count={row.clicked} tone="click" />
                </td>
                <td className={styles.num}>
                  {row.problems ? (
                    <span className={styles.badCount}>{fmt(row.problems)}</span>
                  ) : (
                    <span className={styles.none}>0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RateCell({
  value,
  count,
  tone,
}: {
  value: number | null;
  count: number;
  tone: "open" | "click";
}) {
  if (value === null) return <span className={styles.none}>—</span>;
  return (
    <span className={styles.rateCell}>
      <span className={styles.rateValue} title={`${fmt(count)} people`}>
        {formatRate(value)}
      </span>
      <span
        className={`${styles.meter} ${styles.meterInline} ${tone === "click" ? styles.meterClick : ""}`}
        aria-hidden
      >
        <span style={{ width: `${pct(value, 1)}%` }} />
      </span>
    </span>
  );
}

export function StatePill({ row }: { row: ReportDelivery }) {
  const state = recipientState(row);
  return (
    <span className={`${styles.pill} ${styles[`pill_${state}`] ?? ""}`}>
      {RECIPIENT_STATE_LABEL[state]}
    </span>
  );
}

function after(fromIso: string | null, toIso: string | null): string | null {
  if (!fromIso || !toIso) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return `after ${formatDuration(ms)}`;
}

export function TimeCell({
  value,
  since,
}: {
  value: string | null;
  since?: string | null;
}) {
  if (!value) return <span className={styles.none}>—</span>;
  const delay = since !== undefined ? after(since, value) : null;
  return (
    <span className={styles.time} title={formatSofiaFull(value)}>
      {formatSofiaShort(value)}
      {delay ? <span className={styles.sub}>{delay}</span> : null}
    </span>
  );
}

export function UrlCell({ url }: { url: string | null }) {
  if (!url) return <span className={styles.none}>—</span>;
  const href = safeHttpUrl(url);
  return href ? (
    <a className={styles.cellUrl} href={href} target="_blank" rel="noopener noreferrer" title={url}>
      {displayUrl(url)}
    </a>
  ) : (
    <span className={styles.cellUrl} title={url}>
      {url}
    </span>
  );
}

export function SortHeader({
  label,
  sort,
  view,
  hrefFor,
  className,
}: {
  label: string;
  sort: RecipientSort;
  view: ReportView;
  hrefFor: HrefFor;
  className?: string;
}) {
  const on = view.sort === sort;
  const nextDir: SortDir = on
    ? view.dir === "asc"
      ? "desc"
      : "asc"
    : sort === "email" || sort === "status"
      ? "asc"
      : "desc";
  return (
    <th className={className} aria-sort={on ? (view.dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link
        href={hrefFor({ sort, dir: nextDir, rp: 1 })}
        scroll={false}
        className={`${styles.sortLink} ${on ? styles.sortOn : ""}`}
      >
        {label}
        <span aria-hidden>{on ? (view.dir === "asc" ? "↑" : "↓") : ""}</span>
      </Link>
    </th>
  );
}
