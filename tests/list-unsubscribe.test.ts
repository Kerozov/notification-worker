import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  listUnsubscribeHeaders,
  planZeptoRequests,
  sendEmailBatch,
} from "@/lib/email/send";
import {
  batchJobsBodySchema,
  parseJobMerge,
  scheduleJobBodySchema,
  sendJobBodySchema,
} from "@/lib/validation/email-job";

const realFetch = globalThis.fetch;
const realEnv = {
  key: process.env.ZEPTOMAIL_API_KEY,
  url: process.env.ZEPTOMAIL_API_URL,
  flag: process.env.EMAIL_LIST_UNSUBSCRIBE,
};

type ZeptoBody = {
  to: { email_address: { address: string }; merge_info?: Record<string, string> }[];
  mime_headers?: Record<string, string>;
};

let bodies: ZeptoBody[] = [];

beforeEach(() => {
  bodies = [];
  process.env.ZEPTOMAIL_API_KEY = "test-key";
  delete process.env.ZEPTOMAIL_API_URL;
  delete process.env.EMAIL_LIST_UNSUBSCRIBE;
  // No real request: every call answers like ZeptoMail with its own request id.
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ request_id: `req-${bodies.length}` });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of [
    ["ZEPTOMAIL_API_KEY", realEnv.key],
    ["ZEPTOMAIL_API_URL", realEnv.url],
    ["EMAIL_LIST_UNSUBSCRIBE", realEnv.flag],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const UNSUB_A =
  "https://healthyandconfident.bg/api/unsubscribe?token=a.sig&locale=bg";
const UNSUB_B =
  "https://healthyandconfident.bg/api/unsubscribe?token=b.sig&locale=en";

const baseInput = {
  from: "Healthy & Confident <news@example.com>",
  subject: "Hi {{name}}",
  html: "<p>Hi {{name}} <a href=\"{{unsubscribe_url}}\">Отписване</a></p>",
  clientReference: "job-1",
};

describe("listUnsubscribeHeaders", () => {
  test("https link gives both RFC 8058 headers", () => {
    expect(listUnsubscribeHeaders(UNSUB_A)).toEqual({
      "List-Unsubscribe": `<${UNSUB_A}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  test("trims surrounding spaces", () => {
    expect(listUnsubscribeHeaders(`  ${UNSUB_A} `)?.["List-Unsubscribe"]).toBe(
      `<${UNSUB_A}>`,
    );
  });

  test("no headers for missing, empty, http or broken values", () => {
    expect(listUnsubscribeHeaders(undefined)).toBeNull();
    expect(listUnsubscribeHeaders("")).toBeNull();
    expect(listUnsubscribeHeaders("   ")).toBeNull();
    expect(listUnsubscribeHeaders("http://example.com/u?t=1")).toBeNull();
    expect(listUnsubscribeHeaders("mailto:unsub@example.com")).toBeNull();
    expect(listUnsubscribeHeaders("not a url")).toBeNull();
    expect(listUnsubscribeHeaders("{{unsubscribe_url}}")).toBeNull();
  });

  test("a value that could inject another header line is refused", () => {
    expect(
      listUnsubscribeHeaders("https://example.com/u\r\nBcc: x@evil.test"),
    ).toBeNull();
    expect(listUnsubscribeHeaders("https://example.com/u>, <https://evil.test")).toBeNull();
  });
});

describe("planZeptoRequests", () => {
  test("people with an unsubscribe link get a request each; the rest share one", () => {
    const plans = planZeptoRequests(
      ["a@x.com", "plain1@x.com", "b@x.com", "plain2@x.com"],
      {
        "a@x.com": { name: "Ana", unsubscribe_url: UNSUB_A },
        "b@x.com": { unsubscribe_url: UNSUB_B },
        "plain1@x.com": { name: "No link" },
      },
    );

    expect(plans).toEqual([
      {
        recipients: ["a@x.com"],
        headers: {
          "List-Unsubscribe": `<${UNSUB_A}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
      {
        recipients: ["b@x.com"],
        headers: {
          "List-Unsubscribe": `<${UNSUB_B}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
      { recipients: ["plain1@x.com", "plain2@x.com"] },
    ]);
  });

  test("without links the batches of 50 stay as they were", () => {
    const recipients = Array.from({ length: 120 }, (_, i) => `p${i}@x.com`);
    const plans = planZeptoRequests(recipients, undefined);
    expect(plans.map((p) => p.recipients.length)).toEqual([50, 50, 20]);
    expect(plans.every((p) => p.headers === undefined)).toBe(true);
    expect(plans.flatMap((p) => p.recipients)).toEqual(recipients);
  });

  test("turned off: everyone batched, no headers", () => {
    const plans = planZeptoRequests(
      ["a@x.com", "b@x.com"],
      {
        "a@x.com": { unsubscribe_url: UNSUB_A },
        "b@x.com": { unsubscribe_url: UNSUB_B },
      },
      false,
    );
    expect(plans).toEqual([{ recipients: ["a@x.com", "b@x.com"] }]);
  });
});

describe("sendEmailBatch with one-click unsubscribe", () => {
  test("campaign: each linked recipient's request carries their own headers and merge", async () => {
    const result = await sendEmailBatch({
      ...baseInput,
      recipients: ["a@x.com", "b@x.com", "plain@x.com"],
      merge: {
        "a@x.com": { name: "Ana", unsubscribe_url: UNSUB_A },
        "b@x.com": { name: "Bob", unsubscribe_url: UNSUB_B },
      },
    });

    expect(bodies).toHaveLength(3);

    expect(bodies[0].to.map((t) => t.email_address.address)).toEqual(["a@x.com"]);
    expect(bodies[0].mime_headers).toEqual({
      "List-Unsubscribe": `<${UNSUB_A}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(bodies[0].to[0].merge_info).toEqual({ name: "Ana", unsubscribe_url: UNSUB_A });

    expect(bodies[1].to.map((t) => t.email_address.address)).toEqual(["b@x.com"]);
    expect(bodies[1].mime_headers?.["List-Unsubscribe"]).toBe(`<${UNSUB_B}>`);

    expect(bodies[2].to.map((t) => t.email_address.address)).toEqual(["plain@x.com"]);
    expect(bodies[2].mime_headers).toBeUndefined();

    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.deliveries).toEqual([
      { recipient: "a@x.com", providerMessageId: "req-1" },
      { recipient: "b@x.com", providerMessageId: "req-2" },
      { recipient: "plain@x.com", providerMessageId: "req-3" },
    ]);
  });

  test("automation (one person per job) gets the headers", async () => {
    await sendEmailBatch({
      ...baseInput,
      recipients: ["ana@x.com"],
      merge: { "ana@x.com": { name: "Ana", unsubscribe_url: UNSUB_A } },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].mime_headers).toEqual({
      "List-Unsubscribe": `<${UNSUB_A}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  test("onChunk runs after every request, so a crash cannot resend anyone", async () => {
    const seen: string[][] = [];
    await sendEmailBatch({
      ...baseInput,
      recipients: ["a@x.com", "b@x.com"],
      merge: {
        "a@x.com": { unsubscribe_url: UNSUB_A },
        "b@x.com": { unsubscribe_url: UNSUB_B },
      },
      onChunk: async (chunk) => {
        seen.push(chunk.map((d) => d.recipient));
      },
    });
    expect(seen).toEqual([["a@x.com"], ["b@x.com"]]);
  });

  test("EMAIL_LIST_UNSUBSCRIBE=off sends one batch without headers", async () => {
    process.env.EMAIL_LIST_UNSUBSCRIBE = "off";
    await sendEmailBatch({
      ...baseInput,
      recipients: ["a@x.com", "b@x.com"],
      merge: {
        "a@x.com": { unsubscribe_url: UNSUB_A },
        "b@x.com": { unsubscribe_url: UNSUB_B },
      },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].to).toHaveLength(2);
    expect(bodies[0].mime_headers).toBeUndefined();
  });
});

describe("merge[email].unsubscribe_url is the one way in, on every endpoint", () => {
  const job = {
    subject: "Напомняне",
    // Link written into the HTML, no {{unsubscribe_url}} tag (automations, reminders).
    html: `<p>Здравей</p><a href="${UNSUB_A}">Отписване</a>`,
    recipients: ["Ana@X.com"],
    merge: { "Ana@X.com": { unsubscribe_url: UNSUB_A } },
  };

  function headersAfterIntake(merge: unknown, recipients: string[]) {
    // What createEmailJob stores (lowercased keys, listed recipients only)
    // and what the send step then plans from it.
    const stored = parseJobMerge(merge, new Set(recipients));
    return planZeptoRequests(recipients, stored);
  }

  test("/api/v1/send keeps it", () => {
    const parsed = sendJobBodySchema.parse(job);
    expect(headersAfterIntake(parsed.merge, ["ana@x.com"])[0].headers).toEqual({
      "List-Unsubscribe": `<${UNSUB_A}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  test("/api/v1/schedule keeps it", () => {
    const parsed = scheduleJobBodySchema.parse({
      ...job,
      sendAt: "2026-12-01T09:00:00.000Z",
    });
    expect(headersAfterIntake(parsed.merge, ["ana@x.com"])[0].headers?.["List-Unsubscribe"]).toBe(
      `<${UNSUB_A}>`,
    );
  });

  test("each /api/v1/jobs/batch item keeps its own", () => {
    const parsed = batchJobsBodySchema.parse({
      jobs: [
        { ...job, sendAt: "2026-12-01T09:00:00.000Z" },
        {
          ...job,
          recipients: ["bob@x.com"],
          merge: { "bob@x.com": { unsubscribe_url: UNSUB_B } },
          sendAt: "2026-12-02T09:00:00.000Z",
        },
      ],
    });
    expect(headersAfterIntake(parsed.jobs[0].merge, ["ana@x.com"])[0].headers?.["List-Unsubscribe"]).toBe(
      `<${UNSUB_A}>`,
    );
    expect(headersAfterIntake(parsed.jobs[1].merge, ["bob@x.com"])[0].headers?.["List-Unsubscribe"]).toBe(
      `<${UNSUB_B}>`,
    );
  });

  test("a job without the key (admin notification, login code) gets no headers", async () => {
    const parsed = sendJobBodySchema.parse({
      subject: "Код за вход",
      html: "<p>123456</p>",
      recipients: ["owner@x.com"],
    });
    await sendEmailBatch({
      ...baseInput,
      subject: parsed.subject,
      html: parsed.html,
      recipients: parsed.recipients,
      merge: parseJobMerge(parsed.merge, new Set(parsed.recipients)),
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].mime_headers).toBeUndefined();
    expect(bodies[0].to[0].merge_info).toBeUndefined();
  });
});
