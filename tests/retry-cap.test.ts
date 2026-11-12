import { describe, expect, test } from "bun:test";
import { retryDelayMs, shouldGiveUpOnJob } from "@/lib/jobs/process";

const now = Date.parse("2026-11-12T20:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;

describe("retry cap", () => {
  test("keeps trying for 6 hours, then gives up", () => {
    expect(shouldGiveUpOnJob(ago(5 * 60 * MIN), now)).toBe(false);
    expect(shouldGiveUpOnJob(ago(6 * 60 * MIN), now)).toBe(true);
    expect(shouldGiveUpOnJob(null, now)).toBe(false);
  });

  test("backs off from 2 to 30 minutes", () => {
    expect(retryDelayMs(ago(1 * MIN), now)).toBe(2 * MIN);
    expect(retryDelayMs(ago(40 * MIN), now)).toBe(10 * MIN);
    expect(retryDelayMs(ago(5 * 60 * MIN), now)).toBe(30 * MIN);
    expect(retryDelayMs(undefined, now)).toBe(2 * MIN);
  });
});
