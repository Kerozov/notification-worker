import { describe, expect, test } from "bun:test";
import {
  normalizePhoneNumbers,
  uniquePhones,
} from "../lib/validation/sms-job";

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
