import { describe, expect, test } from "bun:test";
import {
  containsCyrillic,
  containsEmoji,
  extractHttpUrls,
  formatNotifierError,
  parseNotifierMessageResponse,
  sendNotifierMessages,
  smsContentLimit,
  validateSmsContent,
} from "../lib/sms/notifier";
import { sendSmsBatch } from "../lib/sms/send";

describe("formatNotifierError", () => {
  test("formats 422 issue arrays", () => {
    const message = formatNotifierError(
      {
        error: [{ path: ["phone"], message: "Invalid phone number" }],
      },
      422,
    );
    expect(message).toBe("phone: Invalid phone number");
  });

  test("formats string errors", () => {
    expect(
      formatNotifierError({ error: "Invalid API key" }, 401),
    ).toBe("Invalid API key");
  });
});

describe("validateSmsContent", () => {
  test("rejects the [link] placeholder", () => {
    expect(validateSmsContent("Join us: [link]")).toContain("[link]");
  });

  test("rejects emoji", () => {
    expect(validateSmsContent("Hello 👋")).toContain("emoji");
  });

  test("enforces Cyrillic length limit", () => {
    const longBg = "а".repeat(71);
    expect(validateSmsContent(longBg)).toContain("70");
    expect(smsContentLimit(longBg)).toBe(70);
  });

  test("allows longer Latin-only messages", () => {
    const latin = "a".repeat(160);
    expect(validateSmsContent(latin)).toBeNull();
    expect(smsContentLimit(latin)).toBe(160);
  });
});

describe("extractHttpUrls", () => {
  test("finds absolute URLs and strips trailing punctuation", () => {
    const urls = extractHttpUrls(
      "Track: https://example.com/order/1. Thanks!",
    );
    expect(urls).toEqual(["https://example.com/order/1"]);
  });
});

describe("parseNotifierMessageResponse", () => {
  test("maps a single message object", () => {
    expect(
      parseNotifierMessageResponse(
        { id: "m1", to: "+359888111111", status: "Pending", scheduledAt: null },
        ["+359888111111"],
      ),
    ).toEqual([
      {
        id: "m1",
        to: "+359888111111",
        status: "Pending",
        scheduledAt: null,
      },
    ]);
  });

  test("expands one bulk id across all phones", () => {
    const rows = parseNotifierMessageResponse(
      { id: "batch-1", status: "Pending", scheduledAt: null },
      ["+359888111111", "+359888222222"],
    );
    expect(rows).toEqual([
      {
        id: "batch-1",
        to: "+359888111111",
        status: "Pending",
        scheduledAt: null,
      },
      {
        id: "batch-1",
        to: "+359888222222",
        status: "Pending",
        scheduledAt: null,
      },
    ]);
  });

  test("reads nested messages arrays", () => {
    const rows = parseNotifierMessageResponse(
      {
        messages: [
          { id: "a", to: "+359888111111", status: "Pending" },
          { id: "b", to: "+359888222222", status: "Pending" },
        ],
      },
      ["+359888111111", "+359888222222"],
    );
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("containsCyrillic", () => {
  test("detects Bulgarian text", () => {
    expect(containsCyrillic("Здравей")).toBe(true);
    expect(containsCyrillic("Hello")).toBe(false);
  });
});

describe("containsEmoji", () => {
  test("detects pictographic characters", () => {
    expect(containsEmoji("ok")).toBe(false);
    expect(containsEmoji("ok 🙂")).toBe(true);
  });
});

describe("sendNotifierMessages", () => {
  const realFetch = globalThis.fetch;

  function mockFetch(
    handler: (url: string, init: RequestInit) => Response,
  ): { calls: Array<{ url: string; body: unknown }> } {
    const calls: Array<{ url: string; body: unknown }> = [];

    globalThis.fetch = (async (input: unknown, init: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return handler(url, init);
    }) as unknown as typeof fetch;

    return { calls };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  test("posts one singular-phone request per recipient", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ id: "m1", status: "Pending", scheduledAt: null }),
    );

    try {
      const outcomes = await sendNotifierMessages(
        "key",
        ["+359888111111", "+359888222222"],
        "hi",
      );

      expect(calls).toHaveLength(2);
      expect(calls[0].body).toEqual({ phone: "+359888111111", content: "hi" });
      expect(calls[1].body).toEqual({ phone: "+359888222222", content: "hi" });
      expect(outcomes.map((o) => o.message?.to)).toEqual([
        "+359888111111",
        "+359888222222",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("passes sendAt through for scheduled messages", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ id: "m1", status: "Pending" }),
    );

    try {
      await sendNotifierMessages(
        "key",
        ["+359888111111"],
        "hi",
        "2026-08-30T10:00:00Z",
      );

      expect(calls[0].body).toEqual({
        phone: "+359888111111",
        content: "hi",
        sendAt: "2026-08-30T10:00:00Z",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("reports per-recipient errors without failing the cohort", async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { phone: string };
      return body.phone === "+359888222222"
        ? jsonResponse(
            { error: [{ path: ["phone"], message: "Invalid recipient phone number" }] },
            422,
          )
        : jsonResponse({ id: "m1", status: "Pending" });
    });

    try {
      const outcomes = await sendNotifierMessages(
        "key",
        ["+359888111111", "+359888222222"],
        "hi",
      );

      expect(outcomes[0].message?.id).toBe("m1");
      expect(outcomes[0].error).toBeUndefined();
      expect(outcomes[1].message).toBeUndefined();
      expect(outcomes[1].error).toBe("phone: Invalid recipient phone number");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("treats 409 duplicates as accepted", async () => {
    mockFetch(() => jsonResponse({ error: "Duplicate message" }, 409));

    try {
      const outcomes = await sendNotifierMessages("key", ["+359888111111"], "hi");
      expect(outcomes[0].message?.id).toBe("duplicate");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("sendSmsBatch", () => {
  const realFetch = globalThis.fetch;

  test("skips non-E.164 recipients and counts partial sends", async () => {
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { phone: string };
      return new Response(
        JSON.stringify(
          body.phone === "+359888222222"
            ? { error: [{ path: ["phone"], message: "Invalid recipient phone number" }] }
            : { id: "m1", status: "Pending" },
        ),
        {
          status: body.phone === "+359888222222" ? 422 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await sendSmsBatch({
        apiKey: "key",
        body: "hi",
        recipients: ["0888111111", "+359888222222", "not-a-phone"],
        jobId: "job-1",
        shortenLinks: false,
      });

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.deliveries).toHaveLength(3);
      expect(
        result.deliveries.find((d) => d.recipient === "not-a-phone")?.error,
      ).toBe("Invalid phone number (not sent)");
      expect(
        result.deliveries.find((d) => d.recipient === "+359888111111")
          ?.providerMessageId,
      ).toBe("m1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
