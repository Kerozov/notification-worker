import { describe, expect, test } from "bun:test";
import { assessHealth, CRON_SILENT_MS, FAILED_CRITICAL, splitStale, type HealthSnapshot, type JobRef } from "../lib/ops/health";

const job = (id: string, extra: Partial<JobRef> = {}): JobRef => ({
  id, channel: "email", tenant: "launchify", title: "Покана", error: null, failed: 0, sent: 0,
  updatedAt: "2026-11-11T10:00:00.000Z", ...extra,
});
const empty: HealthSnapshot = { failed: [], stuck: [], overdue: [], retryable: [], lastCronRun: null };
const now = Date.parse("2026-11-11T12:00:00.000Z");

describe("assessHealth", () => {
  test("nothing wrong is ok", () => {
    const report = assessHealth({ ...empty, lastCronRun: "2026-11-11T11:55:00.000Z", lastDrainRun: "2026-11-11T11:56:00.000Z" }, now);
    expect(report.status).toBe("ok");
    expect(report.problems).toEqual([]);
  });

  test("a stuck or overdue job is critical", () => {
    expect(assessHealth({ ...empty, stuck: [job("a")] }, now).status).toBe("critical");
    expect(assessHealth({ ...empty, overdue: [job("b")] }, now).status).toBe("critical");
  });

  test("a few failed jobs warn, many are critical", () => {
    expect(assessHealth({ ...empty, failed: [job("a")] }, now).status).toBe("warn");
    const many = Array.from({ length: FAILED_CRITICAL }, (_, i) => job(`f${i}`));
    expect(assessHealth({ ...empty, failed: many }, now).status).toBe("critical");
  });

  test("retryable bounces are summed and keyed by job", () => {
    const report = assessHealth({ ...empty, retryable: [{ jobId: "j1", tenant: "t", count: 3 }, { jobId: "j2", tenant: "t", count: 2 }] }, now);
    expect(report.status).toBe("warn");
    expect(report.problems[0].text).toContain("5 address");
    expect(report.problems[0].jobIds).toEqual(["j1", "j2"]);
  });

  test("problem keys do not depend on order, so Jarvis alerts once", () => {
    const a = assessHealth({ ...empty, failed: [job("x"), job("y")] }, now).problems[0].key;
    const b = assessHealth({ ...empty, failed: [job("y"), job("x")] }, now).problems[0].key;
    expect(a).toBe(b);
  });

  test("a silent safety-net drain warns; per-job runs do not count", () => {
    const old = new Date(now - CRON_SILENT_MS - 60_000).toISOString();
    expect(assessHealth({ ...empty, lastDrainRun: old }, now).problems.map((p) => p.key)).toEqual(["cron-silent"]);
    expect(assessHealth({ ...empty, lastCronRun: old }, now).problems).toEqual([]);
  });

  test("a drain that never ran says so once, with a fixed key", () => {
    expect(assessHealth({ ...empty, lastDrainRun: null }, now).problems.map((p) => p.key)).toEqual(["drain-missing"]);
  });

  test("retryable key stays the same while the counts move", () => {
    const a = assessHealth({ ...empty, retryable: [{ jobId: "j1", tenant: "t", count: 7 }] }, now).problems[0].key;
    const b = assessHealth({ ...empty, retryable: [{ jobId: "j1", tenant: "t", count: 5 }] }, now).problems[0].key;
    expect(a).toBe(b);
  });

  test("leftovers older than a day are stale, a warning and not an alarm", () => {
    const old = job("old", { updatedAt: "2026-09-12T18:30:00.000Z", sendAt: "2026-09-12T18:30:00.000Z" });
    const fresh = job("new", { updatedAt: "2026-11-11T11:00:00.000Z" });
    const split = splitStale([old, fresh], now);
    expect(split.stale.map((j) => j.id)).toEqual(["old"]);
    expect(split.fresh.map((j) => j.id)).toEqual(["new"]);
    const report = assessHealth({ ...empty, stale: split.stale }, now);
    expect(report.status).toBe("warn");
    expect(report.problems[0].key).toBe("stale");
  });
});
