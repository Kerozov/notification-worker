import { describe, expect, test } from "bun:test";
import {
  MAX_RECIPIENTS_PER_JOB,
  SEND_CHUNK_SIZE,
  chunkItems,
  normalizeRecipients,
  parseJobMerge,
  sendJobBodySchema,
} from "../lib/validation/email-job";
import {
  campaignStatusFromChildren,
  childIdempotencyKey,
  combineCampaignStatus,
  missingRecipientChunks,
  nextChildChunkIndex,
  uncoveredRecipients,
} from "../lib/jobs/campaign";
import { isStaleProcessing } from "../lib/jobs/process";

describe("normalizeRecipients", () => {
  test("trims, lowercases, and drops duplicate addresses", () => {
    const { valid, invalid, duplicates } = normalizeRecipients([
      "  Ivan@Example.COM ",
      "ivan@example.com",
      "IVAN@example.com",
      "other@example.com",
      "",
      "not-an-email",
    ]);
    expect(valid).toEqual(["ivan@example.com", "other@example.com"]);
    expect(invalid).toEqual(["not-an-email"]);
    expect(duplicates).toBe(2);
  });
});

describe("parseJobMerge", () => {
  test("keeps only valid keys for listed recipients", () => {
    const merge = parseJobMerge(
      {
        "  A@X.com ": { name: "Ana", "bad-key": "no", unsubscribe_url: "https://x" },
        "skip@x.com": { name: "Skip" },
        nope: "x",
      },
      new Set(["a@x.com"]),
    );
    expect(merge).toEqual({
      "a@x.com": { name: "Ana", unsubscribe_url: "https://x" },
    });
  });
});

describe("sendJobBodySchema", () => {
  test("accepts a campaign-sized recipient list", () => {
    const parsed = sendJobBodySchema.safeParse({
      subject: "Hi {{name}}",
      html: "<p>Hi {{name}}</p>",
      recipients: ["a@x.com", "b@x.com"],
      merge: { "a@x.com": { name: "A" } },
    });
    expect(parsed.success).toBe(true);
    expect(MAX_RECIPIENTS_PER_JOB).toBe(50_000);
    expect(SEND_CHUNK_SIZE).toBe(250);
  });
});

describe("chunkItems", () => {
  test("fills a send job then opens the next", () => {
    const emails = Array.from({ length: 501 }, (_, i) => `a${i}@x.com`);
    const chunks = chunkItems(emails);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(SEND_CHUNK_SIZE);
    expect(chunks[1]).toHaveLength(SEND_CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(1);
  });
});

describe("campaign parent", () => {
  test("child keys do not collide with the parent key", () => {
    expect(childIdempotencyKey("camp-abc", 0)).toBe("camp-abc~0");
    expect(childIdempotencyKey("camp-abc", 1)).toBe("camp-abc~1");
  });

  test("status follows the send jobs, not a single pocket", () => {
    expect(
      combineCampaignStatus([
        { status: "pending" },
        { status: "pending" },
      ]),
    ).toBe("pending");
    expect(
      combineCampaignStatus([
        { status: "sent" },
        { status: "pending" },
      ]),
    ).toBe("processing");
    expect(
      combineCampaignStatus([
        { status: "sent" },
        { status: "failed" },
      ]),
    ).toBe("sent");
    expect(
      combineCampaignStatus([
        { status: "canceled" },
        { status: "canceled" },
      ]),
    ).toBe("canceled");
  });

  test("missing children are the parent addresses not already covered", () => {
    const parent = Array.from({ length: 501 }, (_, i) => `a${i}@x.com`);
    const first = parent.slice(0, SEND_CHUNK_SIZE);
    const missing = missingRecipientChunks(parent, [{ recipients: first }]);
    expect(missing).toHaveLength(2);
    expect(missing[0]).toHaveLength(SEND_CHUNK_SIZE);
    expect(missing[1]).toEqual(["a500@x.com"]);
    expect(
      uncoveredRecipients(parent, [
        { recipients: first },
        { recipients: parent.slice(SEND_CHUNK_SIZE) },
      ]),
    ).toEqual([]);
    expect(
      uncoveredRecipients(["A@X.com"], [{ recipients: ["a@x.com"] }]),
    ).toEqual([]);
  });

  test("next child key continues after the highest ~N already stored", () => {
    expect(nextChildChunkIndex([])).toBe(0);
    expect(
      nextChildChunkIndex([
        { idempotency_key: "camp-abc~0" },
        { idempotency_key: "camp-abc~19" },
      ]),
    ).toBe(20);
  });

  test("a canceled campaign does not reopen when some addresses have no child", () => {
    expect(
      campaignStatusFromChildren("canceled", ["a@x.com", "b@x.com"], [
        { status: "canceled", recipients: ["a@x.com"] },
      ]),
    ).toBe("canceled");
    expect(
      campaignStatusFromChildren("processing", ["a@x.com", "b@x.com"], [
        { status: "sent", recipients: ["a@x.com"] },
      ]),
    ).toBe("processing");
    expect(
      campaignStatusFromChildren("processing", ["a@x.com"], [
        { status: "sent", recipients: ["a@x.com"] },
      ]),
    ).toBe("sent");
  });
});

describe("stale processing", () => {
  test("a job that heartbeat within 3 minutes is not stale", () => {
    expect(isStaleProcessing(new Date().toISOString())).toBe(false);
  });

  test("a job untouched for 3 minutes is stale", () => {
    const old = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    expect(isStaleProcessing(old)).toBe(true);
  });
});
