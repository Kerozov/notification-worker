/**
 * Which delivery errors are worth sending again later, and when.
 *
 * A temporary error means the address is fine but the provider did not take
 * the mail right now: the receiving server refused the connection or asked us
 * to slow down (abv.bg "Host not reachable"), or ZeptoMail's own API was down.
 * A permanent error (domain or mailbox does not exist, spam block) is never
 * retried: sending again only hurts the sender's reputation.
 */

export const MAX_DELIVERY_RETRIES = 3;

/** Wait before retry 1, 2, 3 after a temporary bounce. */
const BOUNCE_RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

/** Wait before retry 1, 2, 3 after ZeptoMail's API failed the request. */
const SEND_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 20 * 60_000];

const PERMANENT_PATTERNS: RegExp[] = [
  /nxdomain/i,
  /domain not found/i,
  /no such (user|domain|mailbox|recipient)/i,
  /(user|recipient|address|mailbox) (unknown|not found|does not exist|doesn't exist)/i,
  /unknown (user|recipient|mailbox)/i,
  /does not exist/i,
  /mailbox unavailable/i,
  /inactive[- ]mailbox/i,
  /bad[- ]mailbox/i,
  /invalid (recipient|address|mailbox|email)/i,
  /\b5\.1\.[0-3]\b/,
  /spam|blacklist|blocklist|black listed|virus/i,
  /reported as spam/i,
  /invalid email address \(not sent\)/i,
];

const TEMPORARY_PATTERNS: RegExp[] = [
  /host not reachable/i,
  /host unreachable/i,
  /connection (refused|timed out|reset|lost|closed|error)/i,
  /timed? ?out/i,
  /temporar/i,
  /try (again|later)/i,
  /gr[ae]y ?list/i,
  /too many (connections|messages|recipients|requests)/i,
  /rate[- ]?limit/i,
  /throttl/i,
  /service (not available|unavailable)/i,
  /deferred/i,
  /over ?quota|quota exceeded|mailbox (is )?full/i,
  /\b4\.\d{1,3}\.\d{1,3}\b/,
  /\b(421|450|451|452)\b/,
  // ZeptoMail API request itself failed (network or their side).
  /fetch failed|socket hang up|econnreset|econnrefused|etimedout|enotfound/i,
  /zeptomail request failed with status (429|5\d\d)/i,
];

/** ZeptoMail "softbounce" / "soft bounce" is temporary; anything else is hard. */
export function bounceTypeOf(eventNames: string[]): "soft" | "hard" {
  return eventNames.some((name) => /soft/i.test(name)) ? "soft" : "hard";
}

/** True when the error says "not now", not "never". */
export function isTemporaryDeliveryError(
  error: string | null | undefined,
): boolean {
  if (!error) return false;
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(error))) return false;
  return TEMPORARY_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * A bounced or failed address that may be sent again: the cause was
 * temporary and nothing shows the mail arrived anyway.
 */
export function canRetryDelivery(row: {
  status: string;
  error: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  complained_at: string | null;
}): boolean {
  return (
    (row.status === "bounced" || row.status === "failed") &&
    !row.opened_at &&
    !row.clicked_at &&
    !row.complained_at &&
    isTemporaryDeliveryError(row.error)
  );
}

/** When retry number `attempt` (1-based) should go out. */
export function nextRetryAt(
  attempt: number,
  kind: "bounce" | "send",
  now = Date.now(),
): Date {
  const delays = kind === "bounce" ? BOUNCE_RETRY_DELAYS_MS : SEND_RETRY_DELAYS_MS;
  const index = Math.min(Math.max(attempt, 1), delays.length) - 1;
  return new Date(now + delays[index]);
}

export function retryNote(
  attempt: number,
  error: string,
  options?: { manual?: boolean },
): string {
  const label = options?.manual
    ? "Sending again (manual retry)"
    : `Temporary problem, retry ${attempt}/${MAX_DELIVERY_RETRIES} scheduled`;
  return `${label}: ${stripRetryNote(error)}`;
}

/** Drop an earlier "retry scheduled:" prefix so notes do not pile up. */
export function stripRetryNote(error: string): string {
  return error.replace(
    /^(Temporary problem, retry \d+\/\d+ scheduled|Sending again \(manual retry\)): /,
    "",
  );
}
