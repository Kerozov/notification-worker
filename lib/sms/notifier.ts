const NOTIFIER_BASE_URL =
  process.env.NOTIFIER_BASE_URL?.trim() || "https://notifierbg.com";

export const NOTIFIER_LINKS_URL = `${NOTIFIER_BASE_URL}/api/v1/links`;
export const NOTIFIER_MESSAGES_URL = `${NOTIFIER_BASE_URL}/api/v1/messages`;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const DEFAULT_SEND_CONCURRENCY = 5;

const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/gi;
const CYRILLIC_RE = /[\u0400-\u04FF]/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const LINK_PLACEHOLDER = "[link]";

export type NotifierLinkResponse = {
  id: string;
  originalUrl: string;
  shortUrl: string;
  createdAt: string;
};

export type NotifierMessageResponse = {
  id: string;
  to: string;
  status: "Pending" | "Delivered" | "Failed";
  scheduledAt: string | null;
};

type NotifierIssue = {
  path?: string[];
  message?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeApiKey(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, "");
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${normalizeApiKey(apiKey)}`,
    "Content-Type": "application/json",
  };
}

/** Tolerates 422 array issues and string errors from every other status. */
export function formatNotifierError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;

    if (Array.isArray(error)) {
      const issues = error as NotifierIssue[];
      const parts = issues
        .map((issue) => {
          const path = issue.path?.join(".") ?? "request";
          const message = issue.message ?? "Validation failed";
          return `${path}: ${message}`;
        })
        .filter(Boolean);

      if (parts.length > 0) {
        return parts.join("; ");
      }
    }

    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  return `Notifier request failed with status ${status}`;
}

export function containsCyrillic(text: string): boolean {
  return CYRILLIC_RE.test(text);
}

export function containsEmoji(text: string): boolean {
  return EMOJI_RE.test(text);
}

export function smsContentLimit(text: string): number {
  return containsCyrillic(text) ? 70 : 160;
}

export function extractHttpUrls(text: string): string[] {
  const matches = text.match(HTTP_URL_RE) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of matches) {
    const trimmed = match.replace(/[.,;:!?)]+$/, "");
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      urls.push(trimmed);
    }
  }

  return urls;
}

export function validateSmsContent(content: string): string | null {
  const trimmed = content.trim();

  if (!trimmed) {
    return "SMS content must be at least 1 character";
  }

  if (trimmed.includes(LINK_PLACEHOLDER)) {
    return `SMS content must not contain the literal "${LINK_PLACEHOLDER}" placeholder`;
  }

  if (containsEmoji(trimmed)) {
    return "SMS content must not contain emoji";
  }

  const limit = smsContentLimit(trimmed);
  if (trimmed.length > limit) {
    return `SMS content exceeds ${limit} characters (${trimmed.length})`;
  }

  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 500;
}

async function notifierFetch(
  url: string,
  apiKey: string,
  init: RequestInit,
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...authHeaders(apiKey),
        ...(init.headers ?? {}),
      },
    });

    lastResponse = response;

    if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES - 1) {
      return response;
    }

    await sleep(RETRY_BASE_MS * 2 ** attempt);
  }

  return lastResponse!;
}

export async function createNotifierShortLink(
  apiKey: string,
  originalUrl: string,
): Promise<NotifierLinkResponse> {
  const response = await notifierFetch(NOTIFIER_LINKS_URL, apiKey, {
    method: "POST",
    body: JSON.stringify({ originalUrl }),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(formatNotifierError(body, response.status));
  }

  const row = body as Partial<NotifierLinkResponse>;
  if (!row.shortUrl || !row.id) {
    throw new Error("Notifier link response missing shortUrl");
  }

  return row as NotifierLinkResponse;
}

export async function shortenUrlsInContent(
  apiKey: string,
  content: string,
  cache: Map<string, string> = new Map(),
): Promise<string> {
  const urls = extractHttpUrls(content);
  if (urls.length === 0) {
    return content;
  }

  const missing = urls.filter((url) => !cache.has(url));
  if (missing.length > 0) {
    const created = await Promise.all(
      missing.map((originalUrl) => createNotifierShortLink(apiKey, originalUrl)),
    );
    for (let i = 0; i < missing.length; i++) {
      cache.set(missing[i], created[i].shortUrl);
    }
  }

  let next = content;
  for (const originalUrl of urls) {
    const shortUrl = cache.get(originalUrl);
    if (shortUrl) {
      next = next.split(originalUrl).join(shortUrl);
    }
  }

  return next;
}

export async function prepareNotifierMessageContent(
  apiKey: string,
  content: string,
  shortenLinks: boolean,
  linkCache: Map<string, string> = new Map(),
): Promise<string> {
  const prepared = shortenLinks
    ? await shortenUrlsInContent(apiKey, content, linkCache)
    : content;

  const validationError = validateSmsContent(prepared);
  if (validationError) {
    throw new Error(validationError);
  }

  return prepared;
}

function asMessageRow(
  row: Partial<NotifierMessageResponse>,
  fallbackPhone: string,
  sendAt?: string | null,
): NotifierMessageResponse {
  return {
    id: typeof row.id === "string" && row.id ? row.id : "unknown",
    to: typeof row.to === "string" && row.to ? row.to : fallbackPhone,
    status:
      row.status === "Delivered" || row.status === "Failed"
        ? row.status
        : "Pending",
    scheduledAt:
      typeof row.scheduledAt === "string" || row.scheduledAt === null
        ? (row.scheduledAt ?? sendAt ?? null)
        : (sendAt ?? null),
  };
}

/** Normalize single-object / array / { messages|data } bulk responses. */
export function parseNotifierMessageResponse(
  body: unknown,
  phones: string[],
  sendAt?: string | null,
): NotifierMessageResponse[] {
  if (Array.isArray(body)) {
    return body.map((row, index) =>
      asMessageRow(
        (row ?? {}) as Partial<NotifierMessageResponse>,
        phones[index] ?? phones[0] ?? "",
        sendAt,
      ),
    );
  }

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const nested = record.messages ?? record.data;
    if (Array.isArray(nested)) {
      return parseNotifierMessageResponse(nested, phones, sendAt);
    }

    if (typeof record.id === "string" && record.id) {
      if (phones.length <= 1) {
        return [asMessageRow(record as Partial<NotifierMessageResponse>, phones[0] ?? "", sendAt)];
      }

      // One bulk id for the whole cohort.
      return phones.map((phone) =>
        asMessageRow(
          { ...(record as Partial<NotifierMessageResponse>), to: phone },
          phone,
          sendAt,
        ),
      );
    }
  }

  throw new Error("Notifier message response missing id");
}

export type NotifierSendOutcome = {
  phone: string;
  message?: NotifierMessageResponse;
  error?: string;
};

function sendConcurrency(): number {
  const raw = Number.parseInt(
    process.env.NOTIFIER_SEND_CONCURRENCY?.trim() ?? "",
    10,
  );

  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(raw, 20);
  }

  return DEFAULT_SEND_CONCURRENCY;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

/**
 * Send one SMS. Notifier's /messages endpoint only accepts a singular `phone`,
 * so cohorts are fanned out one request per recipient.
 */
export async function sendNotifierMessage(
  apiKey: string,
  phone: string,
  content: string,
  sendAt?: string | null,
): Promise<NotifierMessageResponse> {
  const payload: Record<string, unknown> = { phone, content };

  if (sendAt) {
    payload.sendAt = sendAt;
  }

  const response = await notifierFetch(NOTIFIER_MESSAGES_URL, apiKey, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  // Already accepted by Notifier — treat as sent, not as an error.
  if (response.status === 409) {
    return {
      id: "duplicate",
      to: phone,
      status: "Pending",
      scheduledAt: sendAt ?? null,
    };
  }

  if (!response.ok) {
    throw new Error(formatNotifierError(body, response.status));
  }

  const [row] = parseNotifierMessageResponse(body, [phone], sendAt);
  if (!row) {
    throw new Error("Notifier message response missing id");
  }

  return row;
}

/**
 * Send the same content to every phone, one request each, with bounded
 * concurrency. Never throws: each recipient reports its own success or error
 * so one bad number cannot fail the whole cohort.
 */
export async function sendNotifierMessages(
  apiKey: string,
  phones: string[],
  content: string,
  sendAt?: string | null,
): Promise<NotifierSendOutcome[]> {
  if (phones.length === 0) {
    return [];
  }

  return mapWithConcurrency(phones, sendConcurrency(), async (phone) => {
    try {
      const message = await sendNotifierMessage(apiKey, phone, content, sendAt);
      return { phone, message } satisfies NotifierSendOutcome;
    } catch (error) {
      return {
        phone,
        error:
          error instanceof Error ? error.message : "Notifier request failed",
      } satisfies NotifierSendOutcome;
    }
  });
}
