import { describe, expect, test } from "bun:test";
import {
  containsCyrillic,
  containsEmoji,
  extractHttpUrls,
  formatNotifierError,
  smsContentLimit,
  validateSmsContent,
} from "../lib/sms/notifier";

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
