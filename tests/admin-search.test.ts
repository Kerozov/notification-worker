import { describe, expect, test } from "bun:test";
import {
  buildEmailSearchOr,
  buildSmsSearchOr,
  isJobIdSearch,
  parseJobListFilters,
} from "../lib/admin/job-query";
import {
  adminIdempotencyLookupKeys,
  isAdminJobLookupTerm,
} from "../lib/admin/lookup";

describe("parseJobListFilters", () => {
  test("defaults period to all time when searching", () => {
    const filters = parseJobListFilters({ q: "ivan@example.com" });
    expect(filters.q).toBe("ivan@example.com");
    expect(filters.period).toBe("all");
  });

  test("keeps an explicit period while searching", () => {
    const filters = parseJobListFilters({ q: "welcome", period: "24h" });
    expect(filters.period).toBe("24h");
  });

  test("defaults period to 7 days without a query", () => {
    expect(parseJobListFilters({}).period).toBe("7d");
  });
});

describe("isJobIdSearch", () => {
  test("matches a full uuid and the 8-char prefix shown in the UI", () => {
    expect(isJobIdSearch("2c1a0b6e-9d34-4f1a-8c2b-7a91e0d44c11")).toBe(true);
    expect(isJobIdSearch("2c1a0b6e")).toBe(true);
    expect(isJobIdSearch("welcome")).toBe(false);
  });
});

describe("buildEmailSearchOr", () => {
  test("quotes ilike values so commas in the query cannot break PostgREST", () => {
    const or = buildEmailSearchOr("hello, world");
    expect(or).toContain('subject.ilike."%hello, world%"');
    expect(or).toContain('from_email.ilike."%hello, world%"');
    expect(or).not.toContain("recipients::text");
  });

  test("looks up an address on the recipient list and text fields", () => {
    const or = buildEmailSearchOr("Ivan@Example.COM");
    expect(or).toContain('recipients.cs.["ivan@example.com"]');
    expect(or).toContain('idempotency_key.ilike."%Ivan@Example.COM%"');
  });

  test("finds a job by uuid, including campaign children", () => {
    const id = "2c1a0b6e-9d34-4f1a-8c2b-7a91e0d44c11";
    const or = buildEmailSearchOr(id);
    expect(or).toContain(`id.eq.${id}`);
    expect(or).toContain(`parent_id.eq.${id}`);
  });
});

describe("admin campaign lookup", () => {
  test("treats worker uuids and app campaign keys as lookup terms", () => {
    expect(isAdminJobLookupTerm("2c1a0b6e-9d34-4f1a-8c2b-7a91e0d44c11")).toBe(
      true,
    );
    expect(isAdminJobLookupTerm("camp-2c1a0b6e-9d34-4f1a-8c2b-7a91e0d44c11")).toBe(
      true,
    );
    expect(isAdminJobLookupTerm("camp-abc~3")).toBe(true);
    expect(isAdminJobLookupTerm("zara-camp-abc")).toBe(true);
    expect(isAdminJobLookupTerm("platform-bcast-abc")).toBe(true);
    expect(isAdminJobLookupTerm("form-abc-bg-1")).toBe(true);
    expect(isAdminJobLookupTerm("ivan@example.com")).toBe(false);
    expect(isAdminJobLookupTerm("Welcome back")).toBe(false);
    expect(isAdminJobLookupTerm("2c1a0b6e")).toBe(false);
  });

  test("expands an app campaign uuid into the keys each product stores", () => {
    const id = "2c1a0b6e-9d34-4f1a-8c2b-7a91e0d44c11";
    expect(adminIdempotencyLookupKeys(id)).toEqual([
      id,
      `camp-${id}`,
      `zara-camp-${id}`,
      `platform-bcast-${id}`,
    ]);
    expect(adminIdempotencyLookupKeys(`camp-${id}`)).toEqual([`camp-${id}`]);
  });
});

describe("buildSmsSearchOr", () => {
  test("matches a phone number on the recipient list", () => {
    const or = buildSmsSearchOr("+359888123456");
    expect(or).toContain('recipients.cs.["+359888123456"]');
    expect(or).toContain('recipients.cs.["359888123456"]');
    expect(or).toContain('body.ilike."%+359888123456%"');
  });
});
