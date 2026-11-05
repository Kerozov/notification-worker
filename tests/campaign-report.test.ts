import { describe, expect, test } from "bun:test";
import {
  buildCampaignReport,
  buildTimeline,
  filterRecipients,
  formatRate,
  paginateRecipients,
  parseRecipientQuery,
  recipientState,
  recipientsCsv,
  resendRecipientsForSegment,
  type ReportDelivery,
} from "../lib/admin/campaign-report";
import { INVALID_EMAIL_ERROR, statsFromDeliveryRows } from "../lib/deliveries/stats";

let seq = 0;
function row(partial: Partial<ReportDelivery> & { recipient: string }): ReportDelivery {
  seq += 1;
  return {
    id: `d${seq}`,
    job_id: "job-1",
    status: "sent",
    error: null,
    sent_at: "2026-11-03T08:00:00.000Z",
    delivered_at: null,
    opened_at: null,
    clicked_at: null,
    clicked_url: null,
    complained_at: null,
    ...partial,
  };
}

const rows: ReportDelivery[] = [
  row({ recipient: "ana@gmail.com", status: "opened", opened_at: "2026-11-03T08:30:00.000Z" }),
  row({
    recipient: "boris@abv.bg",
    status: "clicked",
    opened_at: "2026-11-03T09:00:00.000Z",
    clicked_at: "2026-11-03T09:01:00.000Z",
    clicked_url: "https://shop.example/offer",
  }),
  row({
    recipient: "vera@gmail.com",
    status: "clicked",
    clicked_at: "2026-11-03T10:00:00.000Z",
    clicked_url: "https://shop.example/offer",
  }),
  row({ recipient: "georgi@abv.bg", status: "delivered", delivered_at: "2026-11-03T08:00:05.000Z" }),
  row({ recipient: "dimo@gmail.com" }),
  row({ recipient: "elena@abv.bg", status: "bounced", error: "Mailbox full" }),
  row({ recipient: "bad@", status: "failed", sent_at: null, error: INVALID_EMAIL_ERROR }),
  row({ recipient: "ivo@gmail.com", status: "failed", sent_at: null, error: "Timeout" }),
  row({
    recipient: "spam@gmail.com",
    status: "complained",
    opened_at: "2026-11-03T08:10:00.000Z",
    complained_at: "2026-11-03T08:12:00.000Z",
  }),
  row({ recipient: "wait@gmail.com", status: "pending", sent_at: null }),
  row({ recipient: "gone@gmail.com", status: "canceled", sent_at: null, error: "Removed from job" }),
];

describe("statsFromDeliveryRows", () => {
  test("pending and removed rows are not counted as sent", () => {
    const stats = statsFromDeliveryRows(rows);
    expect(stats.total).toBe(11);
    expect(stats.pending).toBe(1);
    expect(stats.canceled).toBe(1);
    expect(stats.invalid).toBe(1);
    expect(stats.bounced).toBe(1);
    expect(stats.failed).toBe(1);
    // ana, boris, vera, georgi, dimo, spam
    expect(stats.sent).toBe(6);
  });
});

describe("buildCampaignReport", () => {
  const report = buildCampaignReport(rows);

  test("counts the funnel from real delivery evidence", () => {
    expect(report.recipients).toBe(10);
    expect(report.sent).toBe(6);
    // ana, boris, vera (click proves it), georgi, spam report
    expect(report.delivered).toBe(5);
    expect(report.opened).toBe(3);
    expect(report.clicked).toBe(2);
    expect(report.clickedWithoutOpen).toBe(1);
  });

  test("not opened leaves out people who clicked or reported spam", () => {
    expect(report.segmentCounts.not_opened).toBe(2); // georgi, dimo
    expect(report.segmentCounts.opened_no_click).toBe(2); // ana, spam
  });

  test("rates use sent as the base", () => {
    expect(formatRate(report.rates.open)).toBe("50.0%");
    expect(formatRate(report.rates.click)).toBe("33.3%");
    expect(formatRate(report.rates.clickToOpen)).toBe("66.7%");
  });

  test("groups first clicks by link", () => {
    expect(report.topLinks).toEqual([
      { url: "https://shop.example/offer", clicks: 2, share: 1 },
    ]);
  });

  test("domains are sorted by size", () => {
    expect(report.domains[0].domain).toBe("gmail.com");
    expect(report.domains[1].domain).toBe("abv.bg");
    expect(report.domains[1].problems).toBe(1);
  });

  test("measures time from send to first open", () => {
    expect(report.timeToOpen.measured).toBe(3);
    expect(report.timeToOpen.medianMs).toBe(30 * 60 * 1000);
    expect(report.timeToOpen.within1h).toBe(3); // 10, 30 and 60 min
  });
});

describe("buildTimeline", () => {
  test("buckets by hour for a fresh send", () => {
    const timeline = buildTimeline(rows);
    expect(timeline?.unit).toBe("hour");
    expect(timeline?.opens).toBe(3);
    expect(timeline?.clicks).toBe(2);
    expect(timeline?.buckets.reduce((n, b) => n + b.opens, 0)).toBe(3);
  });

  test("switches to Sofia days for a long tail", () => {
    const timeline = buildTimeline([
      row({ recipient: "a@x.bg", opened_at: "2026-11-01T21:30:00.000Z" }), // 23:30 Sofia, 1 Nov
      row({ recipient: "b@x.bg", opened_at: "2026-11-01T22:30:00.000Z" }), // 00:30 Sofia, 2 Nov
      row({ recipient: "c@x.bg", opened_at: "2026-11-09T10:00:00.000Z" }),
    ]);
    expect(timeline?.unit).toBe("day");
    expect(timeline?.buckets[0].key).toBe("2026-11-01");
    expect(timeline?.buckets[0].opens).toBe(1);
    expect(timeline?.buckets[1].opens).toBe(1);
    expect(timeline?.buckets.at(-1)?.key).toBe("2026-11-09");
  });

  test("returns null when nobody opened or clicked", () => {
    expect(buildTimeline([row({ recipient: "x@y.bg" })])).toBeNull();
  });
});

describe("recipient listing", () => {
  test("opened segment sorts the latest open first", () => {
    const query = parseRecipientQuery({ seg: "opened" });
    const list = filterRecipients(rows, query).map((r) => r.recipient);
    expect(list).toEqual(["boris@abv.bg", "ana@gmail.com", "spam@gmail.com"]);
  });

  test("search matches the address and the clicked link", () => {
    const list = filterRecipients(rows, parseRecipientQuery({ rq: "OFFER" }));
    expect(list.map((r) => r.recipient).sort()).toEqual(["boris@abv.bg", "vera@gmail.com"]);
  });

  test("unknown params fall back to safe defaults", () => {
    expect(parseRecipientQuery({ seg: "drop table", rp: "-4", sort: "x" })).toEqual({
      segment: "all",
      q: "",
      sort: "email",
      dir: "asc",
      page: 1,
    });
  });

  test("pages clamp to the last page", () => {
    const page = paginateRecipients([1, 2, 3, 4, 5], 9, 2);
    expect(page).toEqual({ rows: [5], page: 3, pages: 3, total: 5, from: 5, to: 5 });
  });

  test("state picks the worst outcome", () => {
    expect(recipientState(rows[8])).toBe("complained");
    expect(recipientState(rows[6])).toBe("invalid");
    expect(recipientState(rows[2])).toBe("clicked");
  });
});

describe("resendRecipientsForSegment", () => {
  test("never resends to spam reports or removed people", () => {
    expect(resendRecipientsForSegment(rows, "opened").sort()).toEqual([
      "ana@gmail.com",
      "boris@abv.bg",
    ]);
    expect(resendRecipientsForSegment(rows, "complained")).toEqual([]);
  });
});

describe("recipientsCsv", () => {
  test("escapes quotes and blocks spreadsheet formulas", () => {
    const csv = recipientsCsv([
      row({ recipient: "x@y.bg", status: "failed", sent_at: null, error: '=HYPERLINK("evil")' }),
    ]);
    expect(csv.startsWith("﻿email,result,")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
  });
});
