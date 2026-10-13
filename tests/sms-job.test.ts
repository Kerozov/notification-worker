import { describe, expect, test } from "bun:test";
import {
  normalizePhoneNumbers,
  uniquePhones,
} from "../lib/validation/sms-job";
import { notifierSendAt } from "../lib/jobs/process-sms";

describe("normalizePhoneNumbers", () => {
  test("normalizes BG formats and drops duplicate numbers", () => {
    const { valid, invalid, duplicates } = normalizePhoneNumbers([
      "0888123456",
      "+359888123456",
      "359 888 123 456",
      "0888999999",
      "bad",
    ]);

    expect(valid).toEqual(["+359888123456", "+359888999999"]);
    expect(invalid).toEqual(["bad"]);
    expect(duplicates).toBe(2);
  });
});

describe("uniquePhones", () => {
  test("dedupes mixed formats before send", () => {
    expect(
      uniquePhones(["0888123456", "+359888123456", "0888777777"]),
    ).toEqual(["+359888123456", "+359888777777"]);
  });
});

describe("notifierSendAt", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");

  test("passes a future send time to Notifier as ISO", () => {
    expect(notifierSendAt("2026-10-13T12:00:00+00:00", now)).toBe(
      "2026-10-13T12:00:00.000Z",
    );
  });

  test("sends now when the time is past or within a minute", () => {
    expect(notifierSendAt("2026-10-13T09:00:00Z", now)).toBeNull();
    expect(notifierSendAt("2026-10-13T10:00:30Z", now)).toBeNull();
    expect(notifierSendAt(null, now)).toBeNull();
    expect(notifierSendAt("not a date", now)).toBeNull();
  });
});
