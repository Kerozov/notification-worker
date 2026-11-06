import { getSupabaseAdmin } from "@/lib/db/supabase";

/**
 * Per-domain send pacing. Every send step asks for quota per mail domain in a
 * one-minute window; whatever does not fit stays pending and goes out in the
 * next window. Limits are per domain bucket for the whole worker (all pockets,
 * all clients), because they all leave from the same ZeptoMail servers.
 */

export const THROTTLE_WINDOW_SECONDS = 60;

/** Domains that share one mail server count as one bucket. */
const DOMAIN_BUCKETS: Record<string, string> = {
  "gbg.bg": "abv.bg", // MX pmx.abv.bg / smx.abv.bg
};

/**
 * Sends per minute. abv.bg answered a burst of ~250 with "Host not reachable",
 * so the Bulgarian providers get a gentle rate; everyone else a high one.
 * Override with EMAIL_DOMAIN_LIMITS="abv.bg=40,mail.bg=60,*=600".
 */
const DEFAULT_LIMITS: Record<string, number> = {
  "abv.bg": 40,
  "mail.bg": 60,
  "dir.bg": 60,
  "*": 600,
};

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

export function domainBucket(email: string): string {
  const domain = domainOf(email);
  return DOMAIN_BUCKETS[domain] ?? domain;
}

export function parseDomainLimits(
  raw: string | undefined,
): Record<string, number> {
  const limits = { ...DEFAULT_LIMITS };
  if (!raw?.trim()) return limits;

  for (const part of raw.split(",")) {
    const [key, value] = part.split("=").map((s) => s.trim().toLowerCase());
    const limit = Number(value);
    if (key && Number.isFinite(limit) && limit > 0) {
      limits[key] = Math.floor(limit);
    }
  }

  return limits;
}

export function limitForBucket(
  bucket: string,
  limits: Record<string, number>,
): number {
  return limits[bucket] ?? limits["*"] ?? DEFAULT_LIMITS["*"];
}

/** Recipients grouped by bucket, in list order. */
export function groupByBucket(recipients: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const recipient of recipients) {
    const bucket = domainBucket(recipient);
    const list = groups.get(bucket) ?? [];
    list.push(recipient);
    groups.set(bucket, list);
  }
  return groups;
}

/** Take the first `granted[bucket]` recipients of each bucket, keeping list order. */
export function pickWithinQuota(
  recipients: string[],
  granted: Record<string, number>,
): { send: string[]; deferred: string[] } {
  const left = new Map<string, number>(Object.entries(granted));
  const send: string[] = [];
  const deferred: string[] = [];

  for (const recipient of recipients) {
    const bucket = domainBucket(recipient);
    const remaining = left.get(bucket) ?? 0;
    if (remaining > 0) {
      send.push(recipient);
      left.set(bucket, remaining - 1);
    } else {
      deferred.push(recipient);
    }
  }

  return { send, deferred };
}

/** Start of the next window, plus a small margin for clock drift. */
export function nextWindowStart(now = Date.now()): Date {
  const windowMs = THROTTLE_WINDOW_SECONDS * 1000;
  return new Date((Math.floor(now / windowMs) + 1) * windowMs + 2_000);
}

function isMissingQuotaFunction(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.code === "42P01" ||
    message.includes("reserve_email_domain_quota") ||
    message.includes("email_domain_send_windows")
  );
}

/**
 * Asks the database for this window's quota. Without migration 017 every
 * bucket gets its full per-window limit for this step (no sharing between
 * parallel pockets, but still no 250-address burst to one domain).
 */
export async function reserveDomainQuota(
  recipients: string[],
): Promise<Record<string, number>> {
  const limits = parseDomainLimits(process.env.EMAIL_DOMAIN_LIMITS);
  const requests: Record<string, { want: number; limit: number }> = {};

  for (const [bucket, list] of groupByBucket(recipients)) {
    requests[bucket] = {
      want: list.length,
      limit: limitForBucket(bucket, limits),
    };
  }

  const fallback = () =>
    Object.fromEntries(
      Object.entries(requests).map(([bucket, r]) => [
        bucket,
        Math.min(r.want, r.limit),
      ]),
    );

  if (Object.keys(requests).length === 0) return {};

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("reserve_email_domain_quota", {
    p_requests: requests,
    p_window_seconds: THROTTLE_WINDOW_SECONDS,
  });

  if (error) {
    if (!isMissingQuotaFunction(error)) {
      console.error("reserveDomainQuota:", error.message);
    }
    return fallback();
  }

  const granted = (data as { granted?: Record<string, unknown> } | null)
    ?.granted;
  if (!granted || typeof granted !== "object") return fallback();

  const result: Record<string, number> = {};
  for (const bucket of Object.keys(requests)) {
    const value = Number(granted[bucket] ?? 0);
    result[bucket] = Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  return result;
}
