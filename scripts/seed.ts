#!/usr/bin/env bun
import { config } from "dotenv";
import { hashApiKey } from "../lib/auth/tenant";
import { getSupabaseAdmin } from "../lib/db/supabase";

config({ path: ".env.local" });

type SeedTenant = {
  slug: string;
  name: string;
  apiKey: string;
  defaultFrom?: string;
  defaultReplyTo?: string;
};

function envSuffixToSlug(suffix: string): string {
  return suffix.toLowerCase().replace(/_/g, "-");
}

function slugToName(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function discoverTenantsFromEnv(): SeedTenant[] {
  const tenants: SeedTenant[] = [];

  for (const [key, apiKey] of Object.entries(process.env)) {
    const match = key.match(/^TENANT_(.+)_KEY$/);

    if (!match || !apiKey?.trim()) {
      continue;
    }

    const suffix = match[1];
    const slug = envSuffixToSlug(suffix);
    const name = process.env[`TENANT_${suffix}_NAME`]?.trim() || slugToName(slug);
    const defaultFrom = process.env[`TENANT_${suffix}_FROM`]?.trim();
    const defaultReplyTo = process.env[`TENANT_${suffix}_REPLY_TO`]?.trim();

    tenants.push({
      slug,
      name,
      apiKey: apiKey.trim(),
      defaultFrom,
      defaultReplyTo,
    });
  }

  return tenants.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function seedTenant(input: SeedTenant): Promise<void> {
  const supabase = getSupabaseAdmin();
  const apiKeyHash = hashApiKey(input.apiKey);

  const { data: existing, error: lookupError } = await supabase
    .from("tenants")
    .select("id, slug")
    .eq("slug", input.slug)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Lookup failed for ${input.slug}: ${lookupError.message}`);
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("tenants")
      .update({
        name: input.name,
        api_key_hash: apiKeyHash,
        default_from: input.defaultFrom ?? null,
        default_reply_to: input.defaultReplyTo ?? null,
      })
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Update failed for ${input.slug}: ${updateError.message}`);
    }

    console.log(`Updated tenant: ${input.slug}`);
    return;
  }

  const { error: insertError } = await supabase.from("tenants").insert({
    slug: input.slug,
    name: input.name,
    api_key_hash: apiKeyHash,
    default_from: input.defaultFrom ?? null,
    default_reply_to: input.defaultReplyTo ?? null,
  });

  if (insertError) {
    throw new Error(`Insert failed for ${input.slug}: ${insertError.message}`);
  }

  console.log(`Created tenant: ${input.slug}`);
}

async function main(): Promise<void> {
  const tenants = discoverTenantsFromEnv();

  if (tenants.length === 0) {
    console.warn(
      "No tenants found. Add env vars like TENANT_FUNNELBRAND_KEY=fb_xxx",
    );
    return;
  }

  for (const tenant of tenants) {
    await seedTenant(tenant);
  }

  console.log(`Seed complete (${tenants.length} tenant(s))`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
