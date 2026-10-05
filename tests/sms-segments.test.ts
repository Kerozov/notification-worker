import { afterEach, describe, expect, test } from "bun:test";
import { cleanSmsLinksInText, cleanSmsUrl } from "../lib/sms/links";
import {
  prepareNotifierMessageContent,
  validateSmsContent,
} from "../lib/sms/notifier";
import { countSmsSegments, resolveSmsMaxSegments } from "../lib/sms/segments";

describe("countSmsSegments", () => {
  test("GSM-7 fits 160 in one part, 153 per part after", () => {
    expect(countSmsSegments("a".repeat(160)).segments).toBe(1);
    expect(countSmsSegments("a".repeat(161)).segments).toBe(2);
    expect(countSmsSegments("a".repeat(306)).segments).toBe(2);
    expect(countSmsSegments("a".repeat(307)).segments).toBe(3);
  });

  test("UCS-2 fits 70 in one part, 67 per part after", () => {
    expect(countSmsSegments("я".repeat(70)).segments).toBe(1);
    expect(countSmsSegments("я".repeat(71)).segments).toBe(2);
    expect(countSmsSegments("я".repeat(134)).segments).toBe(2);
    expect(countSmsSegments("я".repeat(135)).segments).toBe(3);
  });

  test("extended GSM characters take two positions", () => {
    const count = countSmsSegments("Cena 15€");
    expect(count.encoding).toBe("GSM-7");
    expect(count.units).toBe(9);
  });

  test("a curly quote makes Latin text UCS-2", () => {
    const count = countSmsSegments("Hi “friend”");
    expect(count.encoding).toBe("UCS-2");
    expect(count.nonGsmChars).toEqual(["“", "”"]);
  });

  test("an extended character never straddles two parts", () => {
    // 152 single positions + € (2) does not fit the first 153-part.
    const count = countSmsSegments("a".repeat(152) + "€" + "a".repeat(10));
    expect(count.segments).toBe(2);
    expect(count.remainingInSegment).toBe(153 - 12);
  });

  test("max segments from env is clamped", () => {
    expect(resolveSmsMaxSegments(undefined)).toBe(1);
    expect(resolveSmsMaxSegments("3")).toBe(3);
    expect(resolveSmsMaxSegments("99")).toBe(6);
    expect(resolveSmsMaxSegments("nope")).toBe(1);
  });
});

describe("cleanSmsUrl", () => {
  test("drops tracking params, keeps the rest", () => {
    expect(
      cleanSmsUrl("https://site.bg/p?utm_source=fb&id=7&fbclid=xyz"),
    ).toBe("https://site.bg/p?id=7");
  });

  test("encodes Cyrillic so the SMS stays GSM-7", () => {
    const url = cleanSmsUrl("https://site.bg/курс");
    expect(url).toBe("https://site.bg/%D0%BA%D1%83%D1%80%D1%81");
    expect(countSmsSegments(url).encoding).toBe("GSM-7");
  });

  test("trims sentence punctuation but keeps a bracket the URL opened", () => {
    expect(cleanSmsLinksInText("Виж https://site.bg/a.").text).toBe(
      "Виж https://site.bg/a.",
    );
    expect(
      cleanSmsUrl("https://en.wikipedia.org/wiki/Foo_(bar)"),
    ).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
});

describe("validateSmsContent", () => {
  const original = process.env.SMS_MAX_SEGMENTS;
  afterEach(() => {
    if (original === undefined) delete process.env.SMS_MAX_SEGMENTS;
    else process.env.SMS_MAX_SEGMENTS = original;
  });

  test("counts Latin text with a curly quote against 70, not 160", () => {
    const text = "“" + "a".repeat(80);
    expect(validateSmsContent(text)).toContain("70");
  });

  test("counts € as two", () => {
    expect(validateSmsContent("a".repeat(159) + "€")).toContain("160");
  });

  test("allows longer text when SMS_MAX_SEGMENTS allows it", () => {
    process.env.SMS_MAX_SEGMENTS = "2";
    expect(validateSmsContent("я".repeat(134))).toBeNull();
    expect(validateSmsContent("я".repeat(135))).toContain("134");
  });
});

describe("prepareNotifierMessageContent", () => {
  test("cleans links even when it does not shorten them", async () => {
    const out = await prepareNotifierMessageContent(
      "key",
      "Go https://site.bg/x?utm_source=sms now",
      false,
    );
    expect(out).toBe("Go https://site.bg/x now");
  });
});
