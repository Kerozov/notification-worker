#!/usr/bin/env bun
import { config } from "dotenv";
import { getSupabaseAdmin } from "../lib/db/supabase";
import { isGhlNotifierUrl } from "../lib/sms/send";

config({ path: ".env.local" });

const GHL_URL =
  process.env.NOTIFIER_API_URL?.trim() ||
  "https://notifierbg.com/api/integrations/callbacks/go-high-level";
const BULK_URL = "https://usenotifier.com/api/sms/bulk";
const TEST_PHONE = "+359888000001";

async function probeNotifier(
  label: string,
  url: string,
  apiKey: string,
  ghl: boolean,
): Promise<string> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: ghl ? apiKey : `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        ghl
          ? {
              phone: TEST_PHONE,
              customData: {
                content: "diagnostic ping — ignore",
                send_at: new Date().toISOString(),
              },
            }
          : [
              {
                to: TEST_PHONE,
                body: "diagnostic ping — ignore",
                uuid: `diag:${TEST_PHONE}`,
              },
            ],
      ),
    });
    const text = await response.text();
    return `${label}: HTTP ${response.status} — ${text.slice(0, 200)}`;
  } catch (error) {
    return `${label}: ${error instanceof Error ? error.message : "fetch failed"}`;
  }
}

async function main(): Promise<void> {
  console.log("NOTIFIER_API_URL env:", process.env.NOTIFIER_API_URL || "(not set → bulk default in code)");
  console.log("GHL mode for env URL:", isGhlNotifierUrl(GHL_URL));

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
    tenants?.find((t) => t.slug === "hc");

  if (!hc?.notifier_api_key) {
    console.log("\n❌ healthy-confident tenant has no notifier_api_key — run: bun run seed");
    return;
  }

  const key = (hc.notifier_api_key as string).trim();
  console.log("\nNotifier probes (test phone only, may not actually send):");
  console.log(await probeNotifier("GHL", GHL_URL, key, true));
  console.log(await probeNotifier("Bulk", BULK_URL, key, false));

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
