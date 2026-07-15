import { randomBytes } from "crypto";
import { hashApiKey } from "@/lib/auth/tenant";
import { asTenant, getSupabaseAdmin, Tenant } from "@/lib/db/supabase";
import { clearTenantCache } from "@/lib/tenants/cache";

export type TenantAdminRow = {
  id: string;
  slug: string;
  name: string;
  default_from: string | null;
  default_reply_to: string | null;
  default_sms_sender: string | null;
  notifier_configured: boolean;
  created_at: string;
};

export type CreateTenantInput = {
  slug: string;
  name: string;
  defaultFrom?: string | null;
  defaultReplyTo?: string | null;
  defaultSmsSender?: string | null;
  notifierApiKey?: string | null;
};

export type UpdateTenantInput = {
  name: string;
  defaultFrom?: string | null;
  defaultReplyTo?: string | null;
  defaultSmsSender?: string | null;
  notifierApiKey?: string | null;
  clearNotifierKey?: boolean;
};

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export function normalizeTenantSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isValidTenantSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

export function generateTenantApiKey(slug: string): string {
  const prefix = slug.replace(/-/g, "").slice(0, 12) || "tenant";
  const secret = randomBytes(24).toString("base64url");
  return `${prefix}_${secret}`;
}

function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function listTenantsForAdmin(): Promise<TenantAdminRow[]> {
  const supabase = getSupabaseAdmin();

  const full = await supabase
    .from("tenants")
    .select(
      "id, slug, name, default_from, default_reply_to, default_sms_sender, notifier_api_key, created_at",
    )
    .order("name");

  const result =
    full.error &&
    (full.error.code === "42703" ||
      full.error.message.includes("notifier_api_key") ||
      full.error.message.includes("default_sms_sender"))
      ? await supabase
          .from("tenants")
          .select("id, slug, name, default_from, default_reply_to, created_at")
          .order("name")
      : full;

  if (result.error) {
    throw new Error(result.error.message);
  }

  return (result.data ?? []).map((row) => ({
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    default_from: row.default_from as string | null,
    default_reply_to: row.default_reply_to as string | null,
    default_sms_sender:
      "default_sms_sender" in row
        ? (row.default_sms_sender as string | null)
        : null,
    notifier_configured:
      "notifier_api_key" in row
        ? Boolean(row.notifier_api_key)
        : false,
    created_at: row.created_at as string,
  }));
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? asTenant(data) : null;
}

export async function createTenant(
  input: CreateTenantInput,
): Promise<{ tenant: Tenant; apiKey: string }> {
  const slug = normalizeTenantSlug(input.slug);
  const name = input.name.trim();

  if (!isValidTenantSlug(slug)) {
    throw new Error(
      "Slug must be 2–48 characters: lowercase letters, numbers, hyphens",
    );
  }

  if (!name) {
    throw new Error("Name is required");
  }

  const apiKey = generateTenantApiKey(slug);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .insert({
      slug,
      name,
      api_key_hash: hashApiKey(apiKey),
      default_from: emptyToNull(input.defaultFrom),
      default_reply_to: emptyToNull(input.defaultReplyTo),
      default_sms_sender: emptyToNull(input.defaultSmsSender),
      notifier_api_key: emptyToNull(input.notifierApiKey),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(`Client slug "${slug}" already exists`);
    }

    throw new Error(error.message);
  }

  return { tenant: asTenant(data), apiKey };
}

export async function updateTenant(
  slug: string,
  input: UpdateTenantInput,
): Promise<Tenant> {
  const name = input.name.trim();

  if (!name) {
    throw new Error("Name is required");
  }

  const patch: Record<string, string | null> = {
    name,
    default_from: emptyToNull(input.defaultFrom),
    default_reply_to: emptyToNull(input.defaultReplyTo),
    default_sms_sender: emptyToNull(input.defaultSmsSender),
  };

  if (input.clearNotifierKey) {
    patch.notifier_api_key = null;
  } else if (input.notifierApiKey?.trim()) {
    patch.notifier_api_key = input.notifierApiKey.trim();
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .update(patch)
    .eq("slug", slug)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Client not found");
  }

  clearTenantCache();
  return asTenant(data);
}

export async function rotateTenantApiKey(
  slug: string,
): Promise<{ tenant: Tenant; apiKey: string }> {
  const apiKey = generateTenantApiKey(slug);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tenants")
    .update({ api_key_hash: hashApiKey(apiKey) })
    .eq("slug", slug)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Client not found");
  }

  clearTenantCache();
  return { tenant: asTenant(data), apiKey };
}

export async function deleteTenantBySlug(slug: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.from("tenants").delete().eq("slug", slug);

  if (error) {
    throw new Error(error.message);
  }

  clearTenantCache();
}
