import { getSupabaseAdmin } from "@/lib/db/supabase";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOOKUP_KEY_RE =
  /^(camp-|zara-camp-|platform-bcast-|form-|camp-resend-)/i;

type JobRef = {
  id: string;
  parent_id: string | null;
};

export function isAdminJobLookupTerm(term: string): boolean {
  const q = term.trim();
  if (!q) return false;
  return UUID_RE.test(q) || LOOKUP_KEY_RE.test(q);
}

export function adminIdempotencyLookupKeys(term: string): string[] {
  const q = term.trim();
  if (!q) return [];

  const keys = [q];
  if (UUID_RE.test(q)) {
    keys.push(`camp-${q}`, `zara-camp-${q}`, `platform-bcast-${q}`);
  }

  return [...new Set(keys)];
}

function campaignJobId(row: JobRef): string {
  return row.parent_id || row.id;
}

function uniqueCampaignId(rows: JobRef[]): string | null {
  const ids = [...new Set(rows.map(campaignJobId))];
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Resolve a pasted worker job id, app campaign id, or idempotency key
 * to the parent campaign (or the single send job).
 */
export async function resolveAdminEmailJobId(
  term: string,
  tenantId?: string | null,
): Promise<string | null> {
  const q = term.trim();
  if (!q || !isAdminJobLookupTerm(q)) return null;

  const supabase = getSupabaseAdmin();

  if (UUID_RE.test(q)) {
    let query = supabase.from("email_jobs").select("id, parent_id").eq("id", q);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data } = await query.maybeSingle();
    if (data) return campaignJobId(data as JobRef);
  }

  for (const key of adminIdempotencyLookupKeys(q)) {
    let query = supabase
      .from("email_jobs")
      .select("id, parent_id")
      .eq("idempotency_key", key)
      .limit(4);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data } = await query;
    const id = uniqueCampaignId((data ?? []) as JobRef[]);
    if (id) return id;
  }

  if (UUID_RE.test(q)) {
    let query = supabase
      .from("email_jobs")
      .select("id, parent_id")
      .ilike("idempotency_key", `form-${q}%`)
      .limit(8);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data } = await query;
    const id = uniqueCampaignId((data ?? []) as JobRef[]);
    if (id) return id;
  }

  return null;
}
