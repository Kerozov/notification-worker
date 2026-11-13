import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "../app/api/ops/dismiss/route";
import { GET } from "../app/api/ops/issues/route";
import { collectHealth } from "../lib/ops/health";

const originalFetch = globalThis.fetch;
const env = { OPS_API_KEY: process.env.OPS_API_KEY, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
process.env.OPS_API_KEY = "test-ops-key-with-more-than-24-characters";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const id = "11111111-1111-4111-8111-111111111111";
const request = (body: unknown, authorized = true) => new NextRequest("https://worker.test/api/ops/dismiss", {
  method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${process.env.OPS_API_KEY}` } : {}) }, body: JSON.stringify(body),
});
test("dismiss requires ops authentication and valid bounded job IDs", async () => {
  expect((await POST(request({ channel: "email", jobIds: [id] }, false))).status).toBe(401);
  for (const body of [{ channel: "wrong", jobIds: [id] }, { channel: "sms", jobIds: [] }, { channel: "email", jobIds: ["bad"] }, { channel: "sms", jobIds: Array(101).fill(id) }]) {
    expect((await POST(request(body))).status).toBe(400);
  }
});
test("dismiss only acknowledges, deduplicates IDs and reports already handled jobs", async () => {
  const calls: { url: URL; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), body: JSON.parse(String(init?.body)) });
    return Response.json(calls.length === 1 ? { id } : null);
  }) as typeof fetch;
  expect(await (await POST(request({ channel: "sms", jobIds: [id, id] }))).json()).toEqual({ results: [{ jobId: id, outcome: "dismissed" }] });
  expect(calls.length).toBe(1);
  expect(Object.keys(calls[0].body)).toEqual(["dismissed_at"]);
  expect(calls[0].url.searchParams.get("dismissed_at")).toBe("is.null");
  expect(calls[0].url.searchParams.get("or")).toContain("status.eq.pending");
  expect(await (await POST(request({ channel: "sms", jobIds: [id] }))).json()).toEqual({ results: [{ jobId: id, outcome: "unchanged" }] });
});
test("issue filters and pagination reach the database before limiting", async () => {
  let query: URL | undefined;
  globalThis.fetch = (async (url: string | URL | Request) => {
    query = new URL(String(url));
    return Response.json([], { headers: { "Content-Range": "*/0" } });
  }) as typeof fetch;
  const response = await GET(new NextRequest("https://worker.test/api/ops/issues?channel=email&reason=failed&page=2", { headers: { Authorization: `Bearer ${process.env.OPS_API_KEY}` } }));
  expect(response.status).toBe(200);
  expect(query?.searchParams.get("reason")).toBe("eq.failed");
  expect(query?.searchParams.get("offset")).toBe("100");
});
test("health excludes acknowledged jobs and their retryable deliveries", async () => {
  const queries: URL[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const query = new URL(String(url)); queries.push(query);
    return Response.json(query.pathname.endsWith("worker_meta") ? null : []);
  }) as typeof fetch;
  await collectHealth();
  const jobs = queries.filter(q => /\/(email_jobs|sms_jobs)$/.test(q.pathname));
  expect(jobs.length).toBe(6);
  for (const query of jobs) expect(query.searchParams.get("dismissed_at")).toBe("is.null");
  const deliveries = queries.find(q => q.pathname.endsWith("email_deliveries"));
  expect(deliveries?.searchParams.get("email_jobs.dismissed_at")).toBe("is.null");
  expect(deliveries?.searchParams.get("select")).toContain("email_jobs!inner");
});
