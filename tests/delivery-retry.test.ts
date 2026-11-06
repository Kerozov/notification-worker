import { describe, expect, test } from "bun:test";
import {
  bounceTypeOf,
  canRetryDelivery,
  isTemporaryDeliveryError,
  MAX_DELIVERY_RETRIES,
  nextRetryAt,
  retryNote,
  stripRetryNote,
} from "../lib/deliveries/retry";
import {
  domainBucket,
  limitForBucket,
  nextWindowStart,
  parseDomainLimits,
  pickWithinQuota,
} from "../lib/email/throttle";
import { nextStepFor } from "../lib/jobs/process";
import { isUnstartedPocket, pickNextPocket } from "../lib/trigger/schedule";
import { apiJobStatus, resolveDisplayStatus } from "../lib/deliveries/stats";
import { contentUpdateRefusal } from "../lib/jobs/update-content";

describe("isTemporaryDeliveryError", () => {
  test("abv.bg 'Host not reachable' is temporary", () => {
    expect(isTemporaryDeliveryError("bad-domain: Host not reachable.")).toBe(true);
  });

  test("typo domains are permanent", () => {
    expect(
      isTemporaryDeliveryError(
        "bad-domain: 5.4.4 DNS error:NXDOMAIN. Domain not found :mail.dg",
      ),
    ).toBe(false);
    expect(
      isTemporaryDeliveryError(
        "bad-domain: 5.4.4 DNS error:NXDOMAIN. Domain not found :abv.bga",
      ),
    ).toBe(false);
  });

  test("dead mailboxes, invalid addresses and spam reports are permanent", () => {
    expect(isTemporaryDeliveryError("bad-mailbox: 550 5.1.1 User unknown")).toBe(false);
    expect(isTemporaryDeliveryError("Invalid email address (not sent)")).toBe(false);
    expect(isTemporaryDeliveryError("Reported as spam (feedback loop)")).toBe(false);
    expect(isTemporaryDeliveryError("Flagged as spam")).toBe(false);
  });

  test("busy servers and ZeptoMail outages are temporary", () => {
    expect(isTemporaryDeliveryError("421 Too many connections, try again later")).toBe(true);
    expect(isTemporaryDeliveryError("451 4.7.1 Greylisted")).toBe(true);
    expect(isTemporaryDeliveryError("Connection timed out")).toBe(true);
    expect(isTemporaryDeliveryError("fetch failed")).toBe(true);
    expect(isTemporaryDeliveryError("ZeptoMail request failed with status 503")).toBe(true);
    expect(isTemporaryDeliveryError("ZeptoMail request failed with status 429")).toBe(true);
  });

  test("ZeptoMail rejecting the request itself is not retried", () => {
    expect(isTemporaryDeliveryError("ZeptoMail request failed with status 400")).toBe(false);
    expect(isTemporaryDeliveryError("Invalid from address")).toBe(false);
    expect(isTemporaryDeliveryError(null)).toBe(false);
  });
});

describe("canRetryDelivery", () => {
  const base = {
    status: "bounced",
    error: "bad-domain: Host not reachable.",
    opened_at: null,
    clicked_at: null,
    complained_at: null,
  };

  test("a temporary bounce can be retried", () => {
    expect(canRetryDelivery(base)).toBe(true);
    expect(canRetryDelivery({ ...base, status: "failed", error: "fetch failed" })).toBe(true);
  });

  test("not when the mail arrived anyway, or the error is permanent", () => {
    expect(canRetryDelivery({ ...base, opened_at: "2026-10-28T17:30:00Z" })).toBe(false);
    expect(canRetryDelivery({ ...base, complained_at: "2026-10-28T17:30:00Z" })).toBe(false);
    expect(canRetryDelivery({ ...base, status: "sent" })).toBe(false);
    expect(
      canRetryDelivery({ ...base, error: "bad-domain: 5.4.4 DNS error:NXDOMAIN" }),
    ).toBe(false);
  });
});

describe("bounce type and retry timing", () => {
  test("soft vs hard from the ZeptoMail event name", () => {
    expect(bounceTypeOf(["softbounce"])).toBe("soft");
    expect(bounceTypeOf(["soft bounce"])).toBe("soft");
    expect(bounceTypeOf(["hardbounce"])).toBe("hard");
    expect(bounceTypeOf(["hard bounce"])).toBe("hard");
  });

  test("bounce retries back off and stop growing after the last step", () => {
    const now = Date.parse("2026-11-06T10:00:00Z");
    expect(nextRetryAt(1, "bounce", now).toISOString()).toBe("2026-11-06T10:15:00.000Z");
    expect(nextRetryAt(2, "bounce", now).toISOString()).toBe("2026-11-06T11:00:00.000Z");
    expect(nextRetryAt(3, "bounce", now).toISOString()).toBe("2026-11-06T14:00:00.000Z");
    expect(nextRetryAt(9, "bounce", now).toISOString()).toBe("2026-11-06T14:00:00.000Z");
    expect(nextRetryAt(1, "send", now).toISOString()).toBe("2026-11-06T10:01:00.000Z");
    expect(MAX_DELIVERY_RETRIES).toBe(3);
  });

  test("retry notes do not pile up", () => {
    const first = retryNote(1, "bad-domain: Host not reachable.");
    const second = retryNote(2, first);
    expect(second).toBe(
      "Temporary problem, retry 2/3 scheduled: bad-domain: Host not reachable.",
    );
    expect(stripRetryNote(retryNote(1, "x", { manual: true }))).toBe("x");
  });
});

describe("per-domain throttle", () => {
  test("gbg.bg shares abv.bg's mail servers", () => {
    expect(domainBucket("Ivan@GBG.bg")).toBe("abv.bg");
    expect(domainBucket("ivan@abv.bg")).toBe("abv.bg");
    expect(domainBucket("ivan@gmail.com")).toBe("gmail.com");
  });

  test("limits: defaults, env override and fallback", () => {
    const defaults = parseDomainLimits(undefined);
    expect(limitForBucket("abv.bg", defaults)).toBe(40);
    expect(limitForBucket("example.org", defaults)).toBe(600);

    const custom = parseDomainLimits("abv.bg=25, *=200, bad=x, mail.bg=0");
    expect(limitForBucket("abv.bg", custom)).toBe(25);
    expect(limitForBucket("example.org", custom)).toBe(200);
    expect(limitForBucket("mail.bg", custom)).toBe(60);
  });

  test("takes the granted number per domain, keeps list order, defers the rest", () => {
    const list = [
      "a@abv.bg",
      "b@gmail.com",
      "c@abv.bg",
      "d@gbg.bg",
      "e@gmail.com",
    ];
    const { send, deferred } = pickWithinQuota(list, { "abv.bg": 2, "gmail.com": 5 });
    expect(send).toEqual(["a@abv.bg", "b@gmail.com", "c@abv.bg", "e@gmail.com"]);
    expect(deferred).toEqual(["d@gbg.bg"]);
  });

  test("next window starts on the next minute", () => {
    const now = Date.parse("2026-11-06T10:00:42Z");
    expect(nextWindowStart(now).toISOString()).toBe("2026-11-06T10:01:02.000Z");
  });
});

describe("nextStepFor", () => {
  const now = Date.parse("2026-11-06T10:00:30Z");

  test("addresses held back by the quota go in the next minute", () => {
    const step = nextStepFor(
      [
        { status: "sent", next_attempt_at: null },
        { status: "pending", next_attempt_at: null },
        { status: "pending", next_attempt_at: "2026-11-06T10:15:00Z" },
      ],
      now,
    );
    expect(step.dueNow).toBe(1);
    expect(step.at?.toISOString()).toBe("2026-11-06T10:01:02.000Z");
  });

  test("only queued retries left: come back when the first one is due", () => {
    const step = nextStepFor(
      [
        { status: "pending", next_attempt_at: "2026-11-06T11:00:00Z" },
        { status: "pending", next_attempt_at: "2026-11-06T10:15:00Z" },
        { status: "bounced", next_attempt_at: null },
      ],
      now,
    );
    expect(step.dueNow).toBe(0);
    expect(step.at?.toISOString()).toBe("2026-11-06T10:15:00.000Z");
  });

  test("nothing pending: no next step", () => {
    expect(nextStepFor([{ status: "sent", next_attempt_at: null }], now)).toEqual({
      dueNow: 0,
      at: null,
    });
  });
});

describe("pocket chain", () => {
  const pocket = (
    id: string,
    status: string,
    sent_count = 0,
    failed_count = 0,
  ) => ({ id, status, sent_count, failed_count });

  test("an unstarted pocket is pending with nothing counted on it", () => {
    expect(isUnstartedPocket(pocket("a", "pending"))).toBe(true);
    expect(isUnstartedPocket(pocket("a", "pending", 40))).toBe(false);
    expect(isUnstartedPocket(pocket("a", "pending", 0, 3))).toBe(false);
    expect(isUnstartedPocket(pocket("a", "sent"))).toBe(false);
  });

  test("picks the first unstarted pocket anywhere in the list, not only after the finished one", () => {
    // List order is by random id, so the pocket that went first can sit in the middle.
    const children = [
      pocket("b", "pending"),
      pocket("a", "sent", 250),
      pocket("c", "pending"),
    ];
    expect(pickNextPocket(children, "a")?.id).toBe("b");
  });

  test("skips the finished pocket itself, started pockets and retries", () => {
    const children = [
      pocket("a", "pending", 0),
      pocket("r", "pending", 120, 10), // reopened for a retry
      pocket("h", "pending", 40), // between paced steps
      pocket("x", "canceled"),
      pocket("n", "pending"),
    ];
    expect(pickNextPocket(children, "a")?.id).toBe("n");
    expect(pickNextPocket(children, null)?.id).toBe("a");
  });

  test("nothing left to start", () => {
    expect(pickNextPocket([pocket("a", "sent", 250), pocket("b", "canceled")], "a")).toBeNull();
  });
});

describe("status of a paced job", () => {
  test("pending with mail already out reads as processing", () => {
    expect(apiJobStatus({ status: "pending", sent_count: 12 })).toBe("processing");
    expect(apiJobStatus({ status: "pending", sent_count: 0 })).toBe("pending");
    expect(apiJobStatus({ status: "sent", sent_count: 12 })).toBe("sent");
    expect(
      resolveDisplayStatus({ status: "pending", sent_count: 12, failed_count: 0 }),
    ).toBe("processing");
    expect(
      resolveDisplayStatus({ status: "pending", sent_count: 0, failed_count: 0 }),
    ).toBe("pending");
  });

  test("a content update refused mid-send says it is processing", () => {
    expect(
      contentUpdateRefusal("j", {
        status: "pending",
        kind: "send",
        parent_id: null,
        sent_count: 5,
      }),
    ).toEqual({ jobId: "j", outcome: "not_pending", status: "processing" });
  });

  test("soft bounce read from event_data.object as well as the event name", () => {
    expect(bounceTypeOf(["bounce", "softbounce"])).toBe("soft");
    expect(bounceTypeOf(["bounce", "hardbounce"])).toBe("hard");
  });
});
