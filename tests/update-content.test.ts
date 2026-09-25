import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MAX_CONTENT_UPDATES,
  updateJobsContentBodySchema,
} from "../lib/validation/email-job";
import { contentUpdateRefusal } from "../lib/jobs/update-content";

/**
 * A scheduled automation email can take new text until the moment it is
 * claimed — and nothing else about it can change through this door.
 */

describe("updateJobsContentBodySchema", () => {
  test("accepts subject + html per job", () => {
    const parsed = updateJobsContentBodySchema.safeParse({
      jobs: [{ jobId: "a", subject: "Нова тема", html: "<p>Нов текст</p>" }],
    });
    expect(parsed.success).toBe(true);
  });

  test("drops anything that would move or re-address the email", () => {
    const parsed = updateJobsContentBodySchema.parse({
      jobs: [
        {
          jobId: "a",
          subject: "s",
          html: "<p>h</p>",
          sendAt: "2030-01-01T00:00:00.000Z",
          recipients: ["someone@else.com"],
          from: "Other <x@y.com>",
        },
      ],
    });
    expect(Object.keys(parsed.jobs[0]).sort()).toEqual(["html", "jobId", "subject"]);
  });

  test("an empty subject or body is refused, not stored", () => {
    expect(
      updateJobsContentBodySchema.safeParse({ jobs: [{ jobId: "a", subject: "", html: "<p>h</p>" }] })
        .success,
    ).toBe(false);
    expect(
      updateJobsContentBodySchema.safeParse({ jobs: [{ jobId: "a", subject: "s", html: "" }] }).success,
    ).toBe(false);
  });

  test("the batch has a ceiling", () => {
    const jobs = Array.from({ length: MAX_CONTENT_UPDATES + 1 }, (_, i) => ({
      jobId: String(i),
      subject: "s",
      html: "<p>h</p>",
    }));
    expect(updateJobsContentBodySchema.safeParse({ jobs }).success).toBe(false);
    expect(updateJobsContentBodySchema.safeParse({ jobs: jobs.slice(1) }).success).toBe(true);
  });
});

describe("contentUpdateRefusal", () => {
  test("a job that started or finished keeps the text it had", () => {
    for (const status of ["processing", "sent", "failed", "canceled"] as const) {
      expect(contentUpdateRefusal("j", { status, kind: "send", parent_id: null })).toEqual({
        jobId: "j",
        outcome: "not_pending",
        status,
      });
    }
  });

  test("a campaign and its pockets are not edited here", () => {
    expect(contentUpdateRefusal("j", { status: "pending", kind: "campaign", parent_id: null }).outcome).toBe(
      "not_editable",
    );
    expect(contentUpdateRefusal("j", { status: "pending", kind: "send", parent_id: "p" }).outcome).toBe(
      "not_editable",
    );
  });

  test("an unknown id is said out loud", () => {
    expect(contentUpdateRefusal("j", null)).toEqual({ jobId: "j", outcome: "not_found" });
  });
});

describe("the update never races the send", () => {
  const source = readFileSync("lib/jobs/update-content.ts", "utf8");

  test("the write is guarded by status = pending in the same statement", () => {
    // Read-then-write would let a claim slip between the two and send a
    // half-edited job; the guard makes „new text“ and „already sending“ the
    // only two outcomes.
    const guarded = source.slice(source.indexOf("async function guardedUpdate"));
    expect(guarded).toContain('.eq("status", "pending")');
    expect(guarded).toContain('.eq("tenant_id", tenantId)');
  });

  test("only subject and html are written", () => {
    const patch = source.slice(source.indexOf("const patch = {"), source.indexOf("};", source.indexOf("const patch = {")));
    expect(patch).toContain("subject");
    expect(patch).toContain("html");
    for (const column of ["send_at", "recipients", "from_email", "reply_to", "merge", "status"]) {
      expect(patch).not.toContain(column);
    }
  });
});
