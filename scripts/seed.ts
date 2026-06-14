#!/usr/bin/env bun
import "dotenv/config";
import { hashApiKey } from "../lib/auth/tenant";
import { getSupabaseAdmin } from "../lib/db/supabase";

type SeedTenant = {
  slug: string;
  name: string;
  envKey: string;
  defaultReplyTo?: string;
};

const tenants: SeedTenant[] = [
  {
    slug: "funnelbrand",
    name: "FunnelBrand",
    envKey: "TENANT_KEY_FUNNELBRAND",
  },
  {
    slug: "client-a",
    name: "Client A",
    envKey: "TENANT_KEY_CLIENT_A",
  },
];

async function seedTenant(input: SeedTenant): Promise<void> {
  const apiKey = process.env[input.envKey];

  if (!apiKey) {
    console.warn(`Skipping ${input.slug}: ${input.envKey} is not set`);
    return;
  }

  const supabase = getSupabaseAdmin();
  const apiKeyHash = hashApiKey(apiKey);

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
    default_reply_to: input.defaultReplyTo ?? null,
  });

  if (insertError) {
    throw new Error(`Insert failed for ${input.slug}: ${insertError.message}`);
  }

  console.log(`Created tenant: ${input.slug}`);
}

async function main(): Promise<void> {
  for (const tenant of tenants) {
    await seedTenant(tenant);
  }

  console.log("Seed complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
