import { getSupabaseAdmin } from "@/lib/db/supabase";

// Opens within this window after send/delivery are usually provider prefetch
// (Gmail Image Proxy, Outlook scanners), not a human reading the email.
const DEFAULT_PREFETCH_WINDOW_MS = 45_000;

function prefetchWindowMs(): number {
  const seconds = Number(process.env.ZEPTOMAIL_OPEN_PREFETCH_SECONDS);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  return DEFAULT_PREFETCH_WINDOW_MS;
}

// Bots and link preview crawlers — never count as human opens.
const BOT_USER_AGENTS = [
  "facebookexternalhit",
  "slackbot",
  "whatsapp",
  "telegrambot",
  "twitterbot",
  "discordbot",
  "bingpreview",
  "linkedinbot",
  "proofpoint",
  "barracuda",
  "mimecast",
  "symantec",
  "cisco",
];

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isBotOpenUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false;
  }

  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some((agent) => ua.includes(agent));
}

export async function isPrefetchOpen(
  jobId: string,
  recipient: string,
  openedAt: string,
): Promise<boolean> {
  const windowMs = prefetchWindowMs();

  if (windowMs === 0) {
    return false;
  }

  const supabase = getSupabaseAdmin();

  const { data } = await supabase
    .from("email_deliveries")
    .select("sent_at, delivered_at")
    .eq("job_id", jobId)
    .eq("recipient", normalizeEmail(recipient))
    .maybeSingle();

  const anchor = data?.delivered_at ?? data?.sent_at;

  if (!anchor) {
    return false;
  }

  const deltaMs = new Date(openedAt).getTime() - new Date(anchor).getTime();

  return deltaMs >= 0 && deltaMs < windowMs;
}

export async function shouldIgnoreOpenEvent(
  jobId: string,
  recipient: string,
  openedAt: string,
  userAgent: string | undefined,
): Promise<"bot" | "prefetch" | null> {
  if (isBotOpenUserAgent(userAgent)) {
    return "bot";
  }

  if (await isPrefetchOpen(jobId, recipient, openedAt)) {
    return "prefetch";
  }

  return null;
}
