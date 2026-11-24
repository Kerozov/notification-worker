import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Tenant } from "@/lib/db/supabase";
import {
  addNotifierWebinarRegistrant,
  parseNotifierWebinarId,
  readWebinarRegistrant,
  registerForTenantWebinar,
} from "@/lib/sms/notifier-webinars";

const tenant = (extra: Partial<Tenant> = {}): Tenant => ({
  id: "id-svetoslava",
  slug: "svetoslava",
  name: "Svetoslava",
  api_key_hash: "hash",
  default_from: null,
  default_reply_to: null,
  default_sms_sender: null,
  notifier_api_key: "nk_live",
  created_at: "2026-01-01T00:00:00Z",
  ...extra,
});

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
let reply: () => Response = () => Response.json({ id: "r1" }, { status: 201 });

beforeEach(() => {
  calls = [];
  reply = () => Response.json({ id: "r1" }, { status: 201 });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let current: Tenant = tenant();
const post = (body: Record<string, unknown>) =>
  registerForTenantWebinar(current, body, current.notifier_api_key);

describe("parseNotifierWebinarId", () => {
  test("takes the id from what Notifier shows", () => {
    expect(parseNotifierWebinarId("xi52mkgrtq3rxz1r9xxkvb65")).toBe("xi52mkgrtq3rxz1r9xxkvb65");
    expect(
      parseNotifierWebinarId(
        "https://notifierbg.com/api/v1/webinars/xi52mkgrtq3rxz1r9xxkvb65/registrants",
      ),
    ).toBe("xi52mkgrtq3rxz1r9xxkvb65");
  });

  test("a join link is not the webinar id", () => {
    expect(parseNotifierWebinarId("https://notifierbg.com/bg/join/dtux26rg")).toBeNull();
    expect(parseNotifierWebinarId("")).toBeNull();
    expect(parseNotifierWebinarId("not an id!")).toBeNull();
  });
});

describe("readWebinarRegistrant", () => {
  test("needs an email or a phone", () => {
    expect(readWebinarRegistrant({ name: "Мария" }).ok).toBe(false);
    expect(readWebinarRegistrant({ email: "не-имейл" }).ok).toBe(false);
    const ok = readWebinarRegistrant({ email: " Maria@Example.com ", phone: "+359888123456" });
    expect(ok.ok && ok.registrant).toEqual({
      name: null,
      email: "maria@example.com",
      phone: "+359888123456",
    });
  });
});

describe("addNotifierWebinarRegistrant", () => {
  test("posts name, phone and email with the client's key", async () => {
    const outcome = await addNotifierWebinarRegistrant("Bearer nk_live", "abc12345", {
      name: "Мария",
      phone: "+359888123456",
      email: "m@example.com",
    });
    expect(outcome).toEqual({ ok: true, duplicate: false });
    expect(calls[0].url).toBe("https://notifierbg.com/api/v1/webinars/abc12345/registrants");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer nk_live");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "Мария",
      phone: "+359888123456",
      email: "m@example.com",
    });
  });

  test("already registered is success", async () => {
    reply = () => Response.json({ error: "exists" }, { status: 409 });
    expect(await addNotifierWebinarRegistrant("k", "abc12345", { name: null, phone: null, email: "a@b.co" })).toEqual({
      ok: true,
      duplicate: true,
    });
  });

  test("retries once on 5xx, not on 4xx", async () => {
    reply = () => Response.json({ error: "boom" }, { status: 500 });
    const failed = await addNotifierWebinarRegistrant("k", "abc12345", { name: null, phone: null, email: "a@b.co" });
    expect(failed.ok).toBe(false);
    expect(calls.length).toBe(2);

    calls = [];
    reply = () => Response.json({ error: "bad phone" }, { status: 422 });
    await addNotifierWebinarRegistrant("k", "abc12345", { name: null, phone: "1", email: null });
    expect(calls.length).toBe(1);
  });
});

describe("registerForTenantWebinar", () => {
  test("without the switch the default webinar is not used", async () => {
    current = tenant({ notifier_webinars: false, notifier_webinar_id: "abc12345" });
    const res = await post({ email: "a@b.co" });
    expect(res.status).toBe(409);
    expect(calls.length).toBe(0);
  });

  test("a named webinar goes through without the switch — Notifier decides", async () => {
    current = tenant({ notifier_webinars: false, notifier_webinar_id: null });
    const res = await post({ webinarId: "zzz98765", email: "a@b.co" });
    expect(res.status).toBe(200);
    expect(calls[0].url).toContain("/webinars/zzz98765/registrants");
  });

  test("uses the client's default webinar when none is named", async () => {
    current = tenant({ notifier_webinars: true, notifier_webinar_id: "abc12345" });
    const res = await post({ name: "Мария", email: "a@b.co" });
    expect(res.status).toBe(200);
    expect(calls[0].url).toContain("/webinars/abc12345/registrants");
  });

  test("a named webinar wins, and a join link is refused rather than defaulted", async () => {
    current = tenant({ notifier_webinars: true, notifier_webinar_id: "abc12345" });
    await post({ webinarId: "zzz99999", email: "a@b.co" });
    expect(calls[0].url).toContain("/webinars/zzz99999/");

    calls = [];
    const res = await post({ webinarId: "https://notifierbg.com/bg/join/dtux26rg", email: "a@b.co" });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("no Notifier key is 412, never a send with someone else's key", async () => {
    current = tenant({ notifier_webinars: true, notifier_webinar_id: "abc12345", notifier_api_key: null });
    const res = await post({ email: "a@b.co" });
    expect(res.status).toBe(412);
    expect(calls.length).toBe(0);
  });
});
