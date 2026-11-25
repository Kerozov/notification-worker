import { describe, expect, test } from "bun:test";
import {
  groupEventsByTenant,
  validateHookToken,
  validateHookUrl,
  type DeliveryEvent,
} from "@/lib/events/hook";

describe("event hook address", () => {
  test("a public https address is accepted", () => {
    expect(validateHookUrl("https://launchifybg.com/api/worker/events")).toBe(
      "https://launchifybg.com/api/worker/events",
    );
  });

  test("anything that is not public https is refused", () => {
    for (const bad of [
      "http://launchifybg.com/x",
      "https://localhost/x",
      "https://10.0.0.5/x",
      "https://intranet/x",
      "https://api.internal/x",
      "https://user:pw@example.com/x",
      "https://[::1]/x",
      "ftp://example.com",
      "not a url",
      42,
    ]) {
      expect(validateHookUrl(bad)).toBeNull();
    }
  });

  test("the token has to be long enough to be a secret", () => {
    expect(validateHookToken("short")).toBeNull();
    expect(validateHookToken("a".repeat(32))).toBe("a".repeat(32));
    expect(validateHookToken("has spaces in it, and is long enough")).toBeNull();
  });
});

describe("events go to the client that sent the mail", () => {
  const event = (jobId: string, email: string): DeliveryEvent => ({
    type: "opened",
    jobId,
    email,
    at: "2026-11-26T10:00:00Z",
  });

  test("each event lands with its job's tenant", () => {
    const grouped = groupEventsByTenant(
      [event("j1", "a@b.bg"), event("j2", "c@d.bg"), event("j1", "e@f.bg")],
      [
        { id: "j1", tenant_id: "t1", parent_id: null },
        { id: "j2", tenant_id: "t2", parent_id: null },
      ],
    );
    expect(grouped.get("t1")?.map((e) => e.email)).toEqual(["a@b.bg", "e@f.bg"]);
    expect(grouped.get("t2")?.map((e) => e.email)).toEqual(["c@d.bg"]);
  });

  test("a campaign child carries the campaign id the client knows", () => {
    const grouped = groupEventsByTenant(
      [event("child", "a@b.bg")],
      [{ id: "child", tenant_id: "t1", parent_id: "campaign" }],
    );
    expect(grouped.get("t1")?.[0]).toMatchObject({ jobId: "child", parentJobId: "campaign" });
  });

  test("an event for a job we cannot find goes to nobody", () => {
    expect(groupEventsByTenant([event("gone", "a@b.bg")], []).size).toBe(0);
  });
});
