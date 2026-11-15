import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  MAX_CONTENT_UPDATES,
  rescheduleJobsBodySchema,
} from "../lib/validation/email-job";
import { rescheduleRefusal, rescheduleRunKey } from "../lib/jobs/reschedule";
import { nextStepFor } from "../lib/jobs/process";
import { findPendingEmailJobIds, parseJobListFilters } from "../lib/admin/job-query";

/**
 * „Смених датата на автоматизацията, а 171 писма пак тръгват утре в 9:00.“
 *
 * An automation „на конкретна дата“ is one moment for everybody on it; the jobs
 * already waiting must move with it. And in the admin, an automation's waiting
 * jobs are found by its key and cancelled in one click, not one row at a time.
 */

describe("rescheduleJobsBodySchema", () => {
  test("ids and one time — nothing that re-addresses or rewrites", () => {
    const parsed = rescheduleJobsBodySchema.parse({
      jobIds: ["a", "b"],
      sendAt: "2026-11-15T13:30:00.000Z",
      recipients: ["someone@else.com"],
      html: "<p>other</p>",
    });
    expect(Object.keys(parsed).sort()).toEqual(["jobIds", "sendAt"]);
  });

  test("the batch has a ceiling and is never empty", () => {
    const ids = Array.from({ length: MAX_CONTENT_UPDATES + 1 }, (_, i) => String(i));
    const sendAt = "2026-11-15T13:30:00.000Z";
    expect(rescheduleJobsBodySchema.safeParse({ jobIds: ids, sendAt }).success).toBe(false);
    expect(rescheduleJobsBodySchema.safeParse({ jobIds: ids.slice(1), sendAt }).success).toBe(true);
    expect(rescheduleJobsBodySchema.safeParse({ jobIds: [], sendAt }).success).toBe(false);
  });
});

describe("rescheduleRefusal", () => {
  test("a waiting standalone job that sent nobody moves", () => {
    expect(
      rescheduleRefusal("j", { status: "pending", kind: "send", parent_id: null, sent_count: 0 }),
    ).toBeNull();
  });

  test("a job that started or finished keeps its time", () => {
    for (const status of ["processing", "sent", "failed", "canceled"] as const) {
      expect(rescheduleRefusal("j", { status, kind: "send", parent_id: null })?.outcome).toBe(
        "not_pending",
      );
    }
    // Pending again between paced steps: it is sending, not waiting.
    expect(
      rescheduleRefusal("j", { status: "pending", kind: "send", parent_id: null, sent_count: 3 }),
    ).toEqual({ jobId: "j", outcome: "not_pending", status: "processing" });
  });

  test("a campaign is one broadcast and its pockets do not move one by one", () => {
    expect(rescheduleRefusal("j", { status: "pending", kind: "campaign", parent_id: null })?.outcome).toBe(
      "not_editable",
    );
    expect(rescheduleRefusal("j", { status: "pending", kind: "send", parent_id: "p" })?.outcome).toBe(
      "not_editable",
    );
  });

  test("an unknown id is said out loud", () => {
    expect(rescheduleRefusal("j", null)).toEqual({ jobId: "j", outcome: "not_found" });
  });
});

describe("the run booked for the old time cannot send", () => {
  const now = Date.parse("2026-11-16T07:00:00.000Z"); // the old 9:00 Sofia
  const later = "2026-11-20T07:00:00.000Z";

  test("addresses moved later are not due when the old run wakes — it books the new time", () => {
    const step = nextStepFor(
      [
        { status: "pending", next_attempt_at: later },
        { status: "pending", next_attempt_at: later },
      ],
      now,
    );
    expect(step.dueNow).toBe(0);
    expect(step.at?.toISOString()).toBe(later);
  });

  test("an address without a time is due — which is why the move writes one on every row", () => {
    expect(nextStepFor([{ status: "pending", next_attempt_at: null }], now).dueNow).toBe(1);
  });

  test("one run per job per target minute", () => {
    const at = new Date("2026-11-15T13:30:20.000Z");
    expect(rescheduleRunKey("job-1", at)).toBe(rescheduleRunKey("job-1", new Date("2026-11-15T13:30:59.000Z")));
    expect(rescheduleRunKey("job-1", at)).not.toBe(rescheduleRunKey("job-1", new Date("2026-11-15T13:31:00.000Z")));
  });

  test("the move writes the address rows before the job", () => {
    const source = readFileSync("lib/jobs/reschedule.ts", "utf8");
    const body = source.slice(source.indexOf("export async function reschedulePendingJob("));
    expect(body.indexOf("moveDeliveries(")).toBeGreaterThan(-1);
    expect(body.indexOf("moveDeliveries(")).toBeLessThan(body.indexOf("moveJob("));
    expect(body.indexOf("moveJob(")).toBeLessThan(body.indexOf("bookRun("));
  });

  test("the route exists next to /jobs/update", () => {
    expect(existsSync("app/api/v1/jobs/reschedule/route.ts")).toBe(true);
  });
});

describe("Cancel all pending in this search", () => {
  test("an empty search cancels nothing — it would be every client's queue", async () => {
    const found = await findPendingEmailJobIds(parseJobListFilters({}), null);
    expect(found.ids).toEqual([]);
    expect(found.error).toBeTruthy();
  });

  test("the admin page shows the button only through the search views", () => {
    const page = readFileSync("app/admin/page.tsx", "utf8");
    expect(page.match(/<CancelSearchButton/g)?.length).toBe(2);
    const action = readFileSync("app/admin/actions.ts", "utf8");
    expect(action).toContain("export async function cancelPendingEmailSearch");
    expect(action).toContain("findPendingEmailJobIds(filters, tenantId)");
  });
});
