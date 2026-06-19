#!/usr/bin/env bun
import { config } from "dotenv";
import { getSupabaseAdmin } from "../lib/db/supabase";

config({ path: ".env.local" });

type Check = {
  name: string;
  ok: boolean;
  hint?: string;
};

async function tableExists(table: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(table).select("*").limit(1);

  if (!error) {
    return true;
  }

  if (error.message.includes("does not exist") || error.code === "42P01") {
    return false;
  }

  throw new Error(`${table}: ${error.message}`);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(table).select(column).limit(1);

  if (!error) {
    return true;
  }

  if (
    error.message.includes("does not exist") ||
    error.code === "42703" ||
    error.message.includes(column)
  ) {
    return false;
  }

  throw new Error(`${table}.${column}: ${error.message}`);
}

async function main(): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }

  const checks: Check[] = [];

  const tables = [
    "tenants",
    "email_jobs",
    "email_deliveries",
    "sms_jobs",
    "sms_deliveries",
    "worker_meta",
  ];

  for (const table of tables) {
    const ok = await tableExists(table);
    checks.push({
      name: `table ${table}`,
      ok,
      hint: ok ? undefined : "Run supabase/setup.sql or bun run db:setup",
    });
  }

  const columns: Array<[string, string]> = [
    ["tenants", "notifier_api_key"],
    ["tenants", "default_sms_sender"],
    ["email_deliveries", "clicked_at"],
    ["email_deliveries", "complained_at"],
    ["email_deliveries", "provider_message_id"],
  ];

  for (const [table, column] of columns) {
    const tableOk = checks.find((c) => c.name === `table ${table}`)?.ok;

    if (!tableOk) {
      continue;
    }

    const ok = await columnExists(table, column);
    checks.push({
      name: `${table}.${column}`,
      ok,
      hint: ok ? undefined : "Run missing migrations or supabase/setup.sql",
    });
  }

  console.log("\nDatabase verification\n");

  let failed = 0;

  for (const check of checks) {
    const mark = check.ok ? "OK" : "MISSING";
    console.log(`  [${mark}] ${check.name}`);

    if (!check.ok) {
      failed += 1;

      if (check.hint) {
        console.log(`         → ${check.hint}`);
      }
    }
  }

  console.log("");

  if (failed > 0) {
    console.log(`❌ ${failed} check(s) failed. See supabase/SETUP.md`);
    process.exit(1);
  }

  console.log("✅ Database schema looks good.");
  console.log("   Add clients via /admin/clients (no seed required).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
