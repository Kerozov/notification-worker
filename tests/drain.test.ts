import { describe, expect, test } from "bun:test";
import {
  DRAIN_GRACE_MS,
  isRecentJob,
  planDrain,
  queueStateFor,
  SAFETY_NET_WINDOW_MS,
  type DrainJob,
  type DrainPlanInput,
  type QueueState,
} from "../lib/jobs/drain";
import { STALE_PROCESSING_MS, staleCheckAt } from "../lib/jobs/process";
import { cancellableSendState, DEAD_STEP_MS } from "../lib/jobs/campaign";

const now = Date.parse("2026-11-12T10:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const job = (id: string, extra: Partial<DrainJob> = {}): DrainJob => ({
  id,
  status: "pending",
  parent_id: null,
  sent_count: 0,
  failed_count: 0,
  send_at: ago(30 * MIN),
  updated_at: ago(30 * MIN),
  ...extra,
});

const plan = (input: Partial<DrainPlanInput>) =>
  planDrain({
    pending: [],
    staleProcessing: [],
    queue: new Map<string, QueueState>(),
    siblings: [],
    now,
    windowMs: SAFETY_NET_WINDOW_MS,
    limit: 30,
    ...input,
  });

describe("queueStateFor", () => {
  test("no delivery rows at all: the job was never started", () => {
    expect(queueStateFor(null, false, now)).toBe("overdue");
  });

  test("rows but none pending: claiming only closes the job", () => {
    expect(queueStateFor(null, true, now)).toBe("empty");
  });

  test("a pending address without a planned time is due", () => {
    expect(queueStateFor({ next_attempt_at: null }, true, now)).toBe("overdue");
  });

  test("a planned retry later is waiting", () => {
    expect(queueStateFor({ next_attempt_at: ago(-HOUR) }, true, now)).toBe("waiting");
  });

  test("a retry that just became due is left to its own run", () => {
    expect(queueStateFor({ next_attempt_at: ago(MIN) }, true, now)).toBe("due-soon");
  });

  test("a retry due for longer than the grace period lost its run", () => {
    expect(queueStateFor({ next_attempt_at: ago(DRAIN_GRACE_MS) }, true, now)).toBe("overdue");
  });
});

describe("isRecentJob", () => {
  test("sent or touched within the window", () => {
    expect(isRecentJob({ send_at: ago(2 * DAY), updated_at: ago(HOUR) }, now, DAY)).toBe(true);
    expect(isRecentJob({ send_at: ago(HOUR), updated_at: ago(3 * DAY) }, now, DAY)).toBe(true);
  });

  test("the September drips are not recent", () => {
    expect(
      isRecentJob(
        { send_at: "2026-09-12T06:00:00+00:00", updated_at: "2026-09-12T06:00:49+00:00" },
        now,
        SAFETY_NET_WINDOW_MS,
      ),
    ).toBe(false);
  });
});

describe("planDrain", () => {
  test("an overdue pending job is picked", () => {
    expect(plan({ pending: [job("a")] })).toEqual(["a"]);
  });

  test("the automatic drain leaves old jobs for the owner", () => {
    const september = job("sept", {
      send_at: "2026-09-12T06:00:00+00:00",
      updated_at: "2026-09-12T06:00:49+00:00",
    });
    const stuck = job("stuck", {
      status: "processing",
      send_at: "2026-09-13T15:30:00+00:00",
      updated_at: "2026-09-13T15:30:06+00:00",
    });
    // The Svetoslava pocket: last step three days ago.
    const pocket = job("pocket", {
      parent_id: "camp",
      sent_count: 226,
      failed_count: 21,
      send_at: "2026-11-05T11:56:28+00:00",
      updated_at: "2026-11-09T11:58:26+00:00",
    });
    expect(plan({ pending: [september, pocket], staleProcessing: [stuck] })).toEqual([]);
    expect(
      plan({ pending: [september, pocket], staleProcessing: [stuck], windowMs: null }),
    ).toEqual(["stuck", "sept", "pocket"]);
  });

  test("stuck processing jobs come first", () => {
    const stuck = job("stuck", { status: "processing", updated_at: ago(10 * MIN) });
    expect(plan({ pending: [job("a")], staleProcessing: [stuck] })).toEqual(["stuck", "a"]);
  });

  test("a job that just became due or was just touched is left to its own run", () => {
    expect(plan({ pending: [job("fresh", { send_at: ago(MIN), updated_at: ago(HOUR) })] })).toEqual([]);
    expect(plan({ pending: [job("live", { updated_at: ago(MIN) })] })).toEqual([]);
  });

  test("a job waiting for a planned retry is skipped", () => {
    const queue = new Map<string, QueueState>([
      ["waiting", "waiting"],
      ["soon", "due-soon"],
      ["done", "empty"],
    ]);
    expect(
      plan({ pending: [job("waiting"), job("soon"), job("done")], queue }),
    ).toEqual(["done"]);
  });

  test("starts at most one unstarted pocket per campaign", () => {
    const p1 = job("p1", { parent_id: "camp" });
    const p2 = job("p2", { parent_id: "camp" });
    const other = job("o1", { parent_id: "other" });
    expect(plan({ pending: [p1, p2, other], siblings: [p1, p2, other] })).toEqual(["p1", "o1"]);
  });

  test("no new pocket while another pocket of the campaign is sending", () => {
    const sending = job("sending", { parent_id: "camp", status: "processing", sent_count: 40, updated_at: ago(MIN) });
    const next = job("next", { parent_id: "camp" });
    expect(plan({ pending: [next], siblings: [sending, next] })).toEqual([]);
  });

  test("a started pocket that lost its run is resumed instead of starting a new one", () => {
    const started = job("started", { parent_id: "camp", sent_count: 40 });
    const next = job("next", { parent_id: "camp" });
    expect(plan({ pending: [next, started], siblings: [next, started] })).toEqual(["started"]);
  });

  test("a pocket waiting for retries does not hold the next pocket back", () => {
    const waiting = job("waiting", { parent_id: "camp", sent_count: 250, updated_at: ago(HOUR) });
    const next = job("next", { parent_id: "camp" });
    const queue = new Map<string, QueueState>([["waiting", "waiting"]]);
    expect(plan({ pending: [waiting, next], siblings: [waiting, next], queue })).toEqual(["next"]);
  });

  test("respects the limit", () => {
    expect(plan({ pending: [job("a"), job("b"), job("c")], limit: 2 })).toEqual(["a", "b"]);
  });
});

describe("cancellableSendState", () => {
  test("a pending job can be cancelled", () => {
    expect(cancellableSendState({ status: "pending", updated_at: ago(MIN) }, now)).toBe("pending");
  });

  test("a job whose step died long ago can be cancelled", () => {
    expect(
      cancellableSendState({ status: "processing", updated_at: "2026-09-13T15:30:06.424+00:00" }, now),
    ).toBe("dead-step");
    expect(cancellableSendState({ status: "processing", updated_at: ago(DEAD_STEP_MS) }, now)).toBe("dead-step");
  });

  test("a job that is sending right now cannot", () => {
    expect(cancellableSendState({ status: "processing", updated_at: ago(MIN) }, now)).toBeNull();
  });

  test("finished jobs cannot", () => {
    expect(cancellableSendState({ status: "sent", updated_at: ago(DAY) }, now)).toBeNull();
    expect(cancellableSendState({ status: "canceled", updated_at: ago(DAY) }, now)).toBeNull();
  });
});

describe("staleCheckAt", () => {
  test("comes back just after the job would count as stale", () => {
    const updatedAt = ago(MIN);
    expect(staleCheckAt(updatedAt)?.getTime()).toBe(
      Date.parse(updatedAt) + STALE_PROCESSING_MS + 30_000,
    );
  });

  test("a broken date gives no check-back", () => {
    expect(staleCheckAt("not a date")).toBeNull();
  });
});
