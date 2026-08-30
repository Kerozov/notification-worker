#!/usr/bin/env bun
import { config } from "dotenv";
import { getSupabaseAdmin } from "../lib/db/supabase";
import {
  NOTIFIER_LINKS_URL,
  NOTIFIER_MESSAGES_URL,
  formatNotifierError,
} from "../lib/sms/notifier";

config({ path: ".env.local" });

const TEST_PHONE = "+359888000001";

async function probeJson(
  label: string,
  url: string,
  apiKey: string,
  body: unknown,
): Promise<string> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const message =
        typeof parsed === "object" && parsed
          ? formatNotifierError(parsed, response.status)
          : text.slice(0, 200);
      return `${label}: HTTP ${response.status} — ${message}`;
    }

    return `${label}: HTTP ${response.status} — ${text.slice(0, 200)}`;
  } catch (error) {
    return `${label}: ${error instanceof Error ? error.message : "fetch failed"}`;
  }
}

async function main(): Promise<void> {
  console.log("Notifier links URL:", NOTIFIER_LINKS_URL);
  console.log("Notifier messages URL:", NOTIFIER_MESSAGES_URL);

  const supabase = getSupabaseAdmin();
  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("slug, name, notifier_api_key, default_sms_sender")
    .order("slug");

  if (error) {
    throw new Error(error.message);
  }

  console.log("\nTenants:");
  for (const t of tenants ?? []) {
    const key = (t.notifier_api_key as string | null)?.trim();
    console.log(
      `  ${t.slug}: notifier_key=${key ? `${key.slice(0, 8)}…` : "MISSING"}, sender=${t.default_sms_sender ?? "—"}`,
    );
  }

  const hc =
    tenants?.find((t) => t.slug === "healthyconfident") ??
    tenants?.find((t) => t.slug === "healthy-confident") ??
    tenants?.find((t) => t.slug === "hc") ??
    tenants?.find((t) => t.slug === "website-zara") ??
    tenants?.[0];

  if (!hc?.notifier_api_key) {
    console.log("\n❌ No tenant with notifier_api_key — run: bun run seed");
    return;
  }

  const key = (hc.notifier_api_key as string).trim();
  console.log(`\nNotifier probes for tenant "${hc.slug}" (test phone only):`);

  const linkProbe = await probeJson("Create link", NOTIFIER_LINKS_URL, key, {
    originalUrl: "https://example.com/diagnostic",
  });

  console.log(linkProbe);

  let shortUrl = "https://go.notifierbg.com/test";
  try {
    const parsed = JSON.parse(linkProbe.split(" — ").slice(1).join(" — "));
    if (typeof parsed?.shortUrl === "string") {
      shortUrl = parsed.shortUrl;
    }
  } catch {
    // keep fallback for message probe
  }

  console.log(
    await probeJson("Send message", NOTIFIER_MESSAGES_URL, key, {
      phone: TEST_PHONE,
      content: `diagnostic ping — ignore ${shortUrl}`,
    }),
  );

  const { data: tenantRow } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", hc.slug as string)
    .single();

  if (tenantRow?.id) {
    const { data: lastJob } = await supabase
      .from("sms_jobs")
      .select("id, status, sent_count, failed_count, error, created_at")
      .eq("tenant_id", tenantRow.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastJob) {
      console.log("\nLast SMS job for tenant:");
      console.log(JSON.stringify(lastJob, null, 2));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
