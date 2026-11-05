import type { EmailDelivery } from "@/lib/deliveries/store";
import {
  addDeliveryRow,
  emptyStats,
  isEngagementEligible,
  isInvalidDeliveryError,
  type JobDeliveryStats,
} from "@/lib/deliveries/stats";

/** The columns of email_deliveries the campaign report reads. */
export type ReportDelivery = Pick<
  EmailDelivery,
  | "id"
  | "job_id"
  | "recipient"
  | "status"
  | "error"
  | "sent_at"
  | "delivered_at"
  | "opened_at"
  | "clicked_at"
  | "clicked_url"
  | "complained_at"
>;

export const RECIPIENT_SEGMENTS = [
  { id: "all", label: "All" },
  { id: "opened", label: "Opened" },
  { id: "clicked", label: "Clicked" },
  { id: "opened_no_click", label: "Opened, no click" },
  { id: "not_opened", label: "Not opened" },
  { id: "bounced", label: "Bounced" },
  { id: "failed", label: "Failed" },
  { id: "invalid", label: "Invalid address" },
  { id: "complained", label: "Spam reports" },
  { id: "pending", label: "Waiting to send" },
  { id: "canceled", label: "Removed" },
] as const;

export type RecipientSegment = (typeof RECIPIENT_SEGMENTS)[number]["id"];

const SEGMENT_IDS = new Set<string>(RECIPIENT_SEGMENTS.map((s) => s.id));

export function isRecipientSegment(value: string | undefined): value is RecipientSegment {
  return Boolean(value && SEGMENT_IDS.has(value));
}

export function segmentLabel(segment: RecipientSegment): string {
  return RECIPIENT_SEGMENTS.find((s) => s.id === segment)?.label ?? segment;
}

/** Segments where "send this email again to these people" is a sane move. */
export const RESENDABLE_SEGMENTS: ReadonlySet<RecipientSegment> = new Set([
  "not_opened",
  "opened",
  "opened_no_click",
  "clicked",
  "failed",
  "bounced",
]);

/** One word for where a recipient ended up; worst outcome wins. */
export type RecipientState =
  | "complained"
  | "invalid"
  | "bounced"
  | "failed"
  | "canceled"
  | "pending"
  | "clicked"
  | "opened"
  | "delivered"
  | "sent";

export const RECIPIENT_STATE_LABEL: Record<RecipientState, string> = {
  complained: "Spam report",
  invalid: "Invalid",
  bounced: "Bounced",
  failed: "Failed",
  canceled: "Removed",
  pending: "Waiting",
  clicked: "Clicked",
  opened: "Opened",
  delivered: "Delivered",
  sent: "Sent",
};

const STATE_ORDER: RecipientState[] = [
  "clicked",
  "opened",
  "delivered",
  "sent",
  "pending",
  "canceled",
  "complained",
  "bounced",
  "failed",
  "invalid",
];

export function recipientState(row: ReportDelivery): RecipientState {
  if (row.complained_at) return "complained";
  if (isInvalidDeliveryError(row.error)) return "invalid";
  if (row.status === "bounced") return "bounced";
  if (row.status === "failed") return "failed";
  if (row.status === "canceled") return "canceled";
  if (row.status === "pending") return "pending";
  if (row.clicked_at) return "clicked";
  if (row.opened_at) return "opened";
  if (row.delivered_at) return "delivered";
  return "sent";
}

export function matchesSegment(
  row: ReportDelivery,
  segment: RecipientSegment,
): boolean {
  const invalid = isInvalidDeliveryError(row.error);

  switch (segment) {
    case "all":
      return true;
    case "opened":
      return Boolean(row.opened_at);
    case "clicked":
      return Boolean(row.clicked_at);
    case "opened_no_click":
      return Boolean(row.opened_at) && !row.clicked_at;
    case "not_opened":
      // A click with the tracking pixel blocked still means they read it.
      return isEngagementEligible(row) && !row.opened_at && !row.clicked_at;
    case "bounced":
      return !invalid && row.status === "bounced";
    case "failed":
      return !invalid && row.status === "failed";
    case "invalid":
      return invalid;
    case "complained":
      return Boolean(row.complained_at);
    case "pending":
      return row.status === "pending";
    case "canceled":
      return row.status === "canceled";
  }
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export type TimelineBucket = {
  key: string;
  label: string;
  longLabel: string;
  opens: number;
  clicks: number;
};

export type Timeline = {
  unit: "hour" | "day";
  buckets: TimelineBucket[];
  opens: number;
  clicks: number;
};

export type DomainRow = {
  domain: string;
  recipients: number;
  sent: number;
  opened: number;
  clicked: number;
  problems: number;
  openRate: number | null;
  clickRate: number | null;
};

export type CampaignReport = {
  stats: JobDeliveryStats;
  /** Everyone still meant to get the email (removed addresses left out). */
  recipients: number;
  /** Handed to ZeptoMail without an error and not bounced back. */
  sent: number;
  /** Sent, with a delivery, open or click event to prove it arrived. */
  delivered: number;
  opened: number;
  clicked: number;
  openedNoClick: number;
  clickedWithoutOpen: number;
  notOpened: number;
  bounced: number;
  failed: number;
  invalid: number;
  complained: number;
  pending: number;
  canceled: number;
  rates: {
    sent: number | null;
    delivered: number | null;
    open: number | null;
    click: number | null;
    clickToOpen: number | null;
    bounce: number | null;
    complaint: number | null;
  };
  segmentCounts: Record<RecipientSegment, number>;
  timeline: Timeline | null;
  topLinks: Array<{ url: string; clicks: number; share: number }>;
  linkClicks: number;
  domains: DomainRow[];
  timeToOpen: {
    measured: number;
    medianMs: number | null;
    within1h: number;
    within24h: number;
  };
  firstSentAt: string | null;
  lastActivityAt: string | null;
  byJob: Map<string, JobDeliveryStats>;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOURLY_MAX_SPAN_MS = 72 * HOUR_MS;
const TIME_ZONE = "Europe/Sofia";

const sofiaPartsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type SofiaParts = { y: string; m: string; d: string; hh: string; mm: string };

function sofiaParts(ms: number): SofiaParts {
  const out: Record<string, string> = {};
  for (const part of sofiaPartsFormat.formatToParts(new Date(ms))) {
    out[part.type] = part.value;
  }
  return {
    y: out.year ?? "",
    m: out.month ?? "",
    d: out.day ?? "",
    hh: out.hour === "24" ? "00" : (out.hour ?? ""),
    mm: out.minute ?? "",
  };
}

/** `03.11 10:30` this year, `03.11.2025 10:30` otherwise — Europe/Sofia. */
export function formatSofiaShort(
  value: string | null | undefined,
  now = Date.now(),
): string {
  const ms = toMs(value);
  if (ms === null) return "—";
  const p = sofiaParts(ms);
  const year = sofiaParts(now).y === p.y ? "" : `.${p.y}`;
  return `${p.d}.${p.m}${year} ${p.hh}:${p.mm}`;
}

/** `03.11.2026 10:30` — Europe/Sofia. */
export function formatSofiaFull(value: string | null | undefined): string {
  const ms = toMs(value);
  if (ms === null) return "—";
  const p = sofiaParts(ms);
  return `${p.d}.${p.m}.${p.y} ${p.hh}:${p.mm}`;
}

function sofiaDayKey(ms: number): string {
  const p = sofiaParts(ms);
  return `${p.y}-${p.m}-${p.d}`;
}

function dayKeyLabel(key: string, withYear: boolean): string {
  const [y, m, d] = key.split("-");
  return withYear ? `${d}.${m}.${y}` : `${d}.${m}`;
}

function dayKeyToUtcNoon(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

function utcNoonToDayKey(ms: number): string {
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Unique opens and clicks over time. ZeptoMail reports only the first open and
 * the first click per recipient, so each person counts once per series.
 */
export function buildTimeline(
  rows: ReportDelivery[],
  startHint?: string | null,
): Timeline | null {
  const opens: number[] = [];
  const clicks: number[] = [];
  let firstSent: number | null = null;

  for (const row of rows) {
    const opened = toMs(row.opened_at);
    const clicked = toMs(row.clicked_at);
    const sent = toMs(row.sent_at);
    if (opened !== null) opens.push(opened);
    if (clicked !== null) clicks.push(clicked);
    if (sent !== null && (firstSent === null || sent < firstSent)) {
      firstSent = sent;
    }
  }

  if (opens.length === 0 && clicks.length === 0) {
    return null;
  }

  // A loop, not Math.min(...list): 50k+ spread arguments can overflow the stack.
  let firstEvent = Infinity;
  let lastEvent = -Infinity;
  for (const ms of opens.concat(clicks)) {
    if (ms < firstEvent) firstEvent = ms;
    if (ms > lastEvent) lastEvent = ms;
  }
  const hint = toMs(startHint ?? null);
  const start = Math.min(firstEvent, firstSent ?? firstEvent, hint ?? firstEvent);
  const span = lastEvent - start;

  if (span <= HOURLY_MAX_SPAN_MS) {
    const firstHour = Math.floor(start / HOUR_MS);
    const lastHour = Math.floor(lastEvent / HOUR_MS);
    const buckets: TimelineBucket[] = [];
    for (let hour = firstHour; hour <= lastHour; hour += 1) {
      const at = sofiaParts(hour * HOUR_MS);
      const until = sofiaParts((hour + 1) * HOUR_MS);
      buckets.push({
        key: String(hour),
        // Midnight shows the date so a 72-hour axis still reads as days.
        label: at.hh === "00" ? `${at.d}.${at.m}` : `${at.hh}:${at.mm}`,
        longLabel: `${at.d}.${at.m}.${at.y} ${at.hh}:${at.mm}–${until.hh}:${until.mm}`,
        opens: 0,
        clicks: 0,
      });
    }
    for (const ms of opens) buckets[Math.floor(ms / HOUR_MS) - firstHour].opens += 1;
    for (const ms of clicks) buckets[Math.floor(ms / HOUR_MS) - firstHour].clicks += 1;
    return { unit: "hour", buckets, opens: opens.length, clicks: clicks.length };
  }

  const firstDay = dayKeyToUtcNoon(sofiaDayKey(start));
  const lastDay = dayKeyToUtcNoon(sofiaDayKey(lastEvent));
  const buckets: TimelineBucket[] = [];
  const index = new Map<string, number>();
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const key = utcNoonToDayKey(day);
    index.set(key, buckets.length);
    buckets.push({
      key,
      label: dayKeyLabel(key, false),
      longLabel: dayKeyLabel(key, true),
      opens: 0,
      clicks: 0,
    });
  }
  for (const ms of opens) {
    const at = index.get(sofiaDayKey(ms));
    if (at !== undefined) buckets[at].opens += 1;
  }
  for (const ms of clicks) {
    const at = index.get(sofiaDayKey(ms));
    if (at !== undefined) buckets[at].clicks += 1;
  }
  return { unit: "day", buckets, opens: opens.length, clicks: clicks.length };
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "(no domain)";
}

const TOP_DOMAINS = 10;
const TOP_LINKS = 10;

function buildDomains(rows: ReportDelivery[]): DomainRow[] {
  const byDomain = new Map<string, DomainRow>();

  for (const row of rows) {
    const state = recipientState(row);
    if (state === "canceled") continue;
    const domain = emailDomain(row.recipient);
    const current =
      byDomain.get(domain) ??
      ({
        domain,
        recipients: 0,
        sent: 0,
        opened: 0,
        clicked: 0,
        problems: 0,
        openRate: null,
        clickRate: null,
      } satisfies DomainRow);
    current.recipients += 1;
    if (state === "bounced" || state === "failed" || state === "invalid") {
      current.problems += 1;
    } else if (state !== "pending") {
      current.sent += 1;
    }
    if (row.opened_at) current.opened += 1;
    if (row.clicked_at) current.clicked += 1;
    byDomain.set(domain, current);
  }

  const sorted = [...byDomain.values()].sort(
    (a, b) => b.recipients - a.recipients || a.domain.localeCompare(b.domain),
  );
  const top = sorted.slice(0, TOP_DOMAINS);
  const rest = sorted.slice(TOP_DOMAINS);

  if (rest.length > 0) {
    top.push(
      rest.reduce<DomainRow>(
        (acc, row) => ({
          ...acc,
          recipients: acc.recipients + row.recipients,
          sent: acc.sent + row.sent,
          opened: acc.opened + row.opened,
          clicked: acc.clicked + row.clicked,
          problems: acc.problems + row.problems,
        }),
        {
          domain: `${rest.length.toLocaleString("bg-BG")} other domains`,
          recipients: 0,
          sent: 0,
          opened: 0,
          clicked: 0,
          problems: 0,
          openRate: null,
          clickRate: null,
        },
      ),
    );
  }

  return top.map((row) => ({
    ...row,
    openRate: ratio(row.opened, row.sent),
    clickRate: ratio(row.clicked, row.sent),
  }));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function buildCampaignReport(
  rows: ReportDelivery[],
  options: { sendAt?: string | null } = {},
): CampaignReport {
  const stats = emptyStats();
  const byJob = new Map<string, JobDeliveryStats>();
  const segmentCounts = Object.fromEntries(
    RECIPIENT_SEGMENTS.map((s) => [s.id, 0]),
  ) as Record<RecipientSegment, number>;
  const links = new Map<string, number>();
  const openDelays: number[] = [];
  let delivered = 0;
  let clickedWithoutOpen = 0;
  let firstSent: number | null = null;
  let lastActivity: number | null = null;

  for (const row of rows) {
    addDeliveryRow(stats, row);
    let jobStats = byJob.get(row.job_id);
    if (!jobStats) {
      jobStats = emptyStats();
      byJob.set(row.job_id, jobStats);
    }
    addDeliveryRow(jobStats, row);

    for (const segment of RECIPIENT_SEGMENTS) {
      if (matchesSegment(row, segment.id)) segmentCounts[segment.id] += 1;
    }

    // An open, a click or a spam report also proves the email arrived.
    const state = recipientState(row);
    if (
      state === "clicked" ||
      state === "opened" ||
      state === "delivered" ||
      state === "complained"
    ) {
      delivered += 1;
    }

    if (row.clicked_at && !row.opened_at) clickedWithoutOpen += 1;

    if (row.clicked_at) {
      const url = row.clicked_url?.trim() || "(link not reported)";
      links.set(url, (links.get(url) ?? 0) + 1);
    }

    const sent = toMs(row.sent_at);
    const opened = toMs(row.opened_at);
    if (sent !== null && (firstSent === null || sent < firstSent)) firstSent = sent;
    if (sent !== null && opened !== null) openDelays.push(Math.max(0, opened - sent));

    for (const value of [row.opened_at, row.clicked_at, row.complained_at, row.delivered_at]) {
      const ms = toMs(value);
      if (ms !== null && (lastActivity === null || ms > lastActivity)) lastActivity = ms;
    }
  }

  const recipients = Math.max(0, stats.total - stats.canceled);
  const linkClicks = [...links.values()].reduce((sum, n) => sum + n, 0);
  const topLinks = [...links.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_LINKS)
    .map(([url, clicks]) => ({ url, clicks, share: linkClicks ? clicks / linkClicks : 0 }));

  return {
    stats,
    recipients,
    sent: stats.sent,
    delivered,
    opened: stats.opened,
    clicked: stats.clicked,
    openedNoClick: segmentCounts.opened_no_click,
    clickedWithoutOpen,
    notOpened: segmentCounts.not_opened,
    bounced: stats.bounced,
    failed: stats.failed,
    invalid: stats.invalid,
    complained: stats.complained,
    pending: stats.pending,
    canceled: stats.canceled,
    rates: {
      sent: ratio(stats.sent, recipients),
      delivered: ratio(delivered, stats.sent),
      open: ratio(stats.opened, stats.sent),
      click: ratio(stats.clicked, stats.sent),
      clickToOpen: ratio(stats.clicked, stats.opened),
      bounce: ratio(stats.bounced, stats.sent + stats.bounced),
      complaint: ratio(stats.complained, stats.sent),
    },
    segmentCounts,
    timeline: buildTimeline(rows, options.sendAt ?? null),
    topLinks,
    linkClicks,
    domains: buildDomains(rows),
    timeToOpen: {
      measured: openDelays.length,
      medianMs: median(openDelays),
      within1h: openDelays.filter((ms) => ms <= HOUR_MS).length,
      within24h: openDelays.filter((ms) => ms <= DAY_MS).length,
    },
    firstSentAt: firstSent === null ? null : new Date(firstSent).toISOString(),
    lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
    byJob,
  };
}

export type RecipientSort = "email" | "status" | "sent" | "opened" | "clicked";
export type SortDir = "asc" | "desc";

export type RecipientQuery = {
  segment: RecipientSegment;
  q: string;
  sort: RecipientSort;
  dir: SortDir;
  page: number;
};

export const RECIPIENT_PAGE_SIZE = 100;

const SORTS = new Set<RecipientSort>(["email", "status", "sent", "opened", "clicked"]);

export function defaultSortFor(segment: RecipientSegment): { sort: RecipientSort; dir: SortDir } {
  if (segment === "opened" || segment === "opened_no_click") {
    return { sort: "opened", dir: "desc" };
  }
  if (segment === "clicked") {
    return { sort: "clicked", dir: "desc" };
  }
  return { sort: "email", dir: "asc" };
}

export function parseRecipientQuery(params: {
  seg?: string;
  rq?: string;
  sort?: string;
  dir?: string;
  rp?: string;
}): RecipientQuery {
  const segment = isRecipientSegment(params.seg) ? params.seg : "all";
  const fallback = defaultSortFor(segment);
  const sort = SORTS.has(params.sort as RecipientSort)
    ? (params.sort as RecipientSort)
    : fallback.sort;
  const dir: SortDir =
    params.dir === "asc" || params.dir === "desc"
      ? params.dir
      : params.sort && SORTS.has(params.sort as RecipientSort)
        ? sort === "email" || sort === "status"
          ? "asc"
          : "desc"
        : fallback.dir;
  const page = Math.max(1, Math.floor(Number(params.rp) || 1));

  return {
    segment,
    q: (params.rq ?? "").trim().toLowerCase().slice(0, 200),
    sort,
    dir,
    page,
  };
}

function sortValue(row: ReportDelivery, sort: RecipientSort): string | number | null {
  switch (sort) {
    case "email":
      return row.recipient;
    case "status":
      return STATE_ORDER.indexOf(recipientState(row));
    case "sent":
      return toMs(row.sent_at);
    case "opened":
      return toMs(row.opened_at);
    case "clicked":
      return toMs(row.clicked_at);
  }
}

export function filterRecipients(
  rows: ReportDelivery[],
  query: Pick<RecipientQuery, "segment" | "q" | "sort" | "dir">,
): ReportDelivery[] {
  const needle = query.q;
  const filtered = rows.filter(
    (row) =>
      matchesSegment(row, query.segment) &&
      (!needle ||
        row.recipient.includes(needle) ||
        (row.clicked_url ?? "").toLowerCase().includes(needle) ||
        (row.error ?? "").toLowerCase().includes(needle)),
  );
  const direction = query.dir === "asc" ? 1 : -1;

  return filtered.sort((a, b) => {
    const av = sortValue(a, query.sort);
    const bv = sortValue(b, query.sort);
    // Empty values go last whichever way the column is sorted.
    if (av === null && bv === null) return a.recipient.localeCompare(b.recipient);
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp =
      typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
    return cmp !== 0 ? cmp * direction : a.recipient.localeCompare(b.recipient);
  });
}

export function paginateRecipients<T>(
  rows: T[],
  page: number,
  size = RECIPIENT_PAGE_SIZE,
): { rows: T[]; page: number; pages: number; total: number; from: number; to: number } {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  const slice = rows.slice(start, start + size);
  return {
    rows: slice,
    page: current,
    pages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}

/**
 * Addresses to prefill when resending to a segment. Spam reports, invalid
 * addresses and people removed from the job are never included.
 */
export function resendRecipientsForSegment(
  rows: ReportDelivery[],
  segment: RecipientSegment,
): string[] {
  if (!RESENDABLE_SEGMENTS.has(segment)) return [];
  const blocked = new Set(
    rows
      .filter(
        (row) =>
          row.complained_at ||
          row.status === "canceled" ||
          isInvalidDeliveryError(row.error),
      )
      .map((row) => row.recipient.toLowerCase()),
  );
  const out = new Set<string>();
  for (const row of rows) {
    const email = row.recipient.toLowerCase();
    if (!blocked.has(email) && matchesSegment(row, segment)) out.add(email);
  }
  return [...out];
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // Spreadsheet apps run cells that start with these as formulas.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function recipientsCsv(
  rows: ReportDelivery[],
  pocketByJobId?: Map<string, number>,
): string {
  const header = [
    "email",
    "result",
    "pocket",
    "sent_at",
    "delivered_at",
    "opened_at",
    "clicked_at",
    "clicked_url",
    "spam_report_at",
    "error",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.recipient,
        RECIPIENT_STATE_LABEL[recipientState(row)],
        pocketByJobId?.get(row.job_id) ?? "",
        row.sent_at,
        row.delivered_at,
        row.opened_at,
        row.clicked_at,
        row.clicked_url,
        row.complained_at,
        row.error,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // BOM so Excel opens Cyrillic and other UTF-8 text correctly.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function formatRate(value: number | null, digits = 1): string {
  if (value === null) return "—";
  const pct = value * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(pct >= 99.95 || pct === 0 ? 0 : digits)}%`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}
