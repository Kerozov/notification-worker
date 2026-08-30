const NOTIFIER_BASE_URL =
  process.env.NOTIFIER_BASE_URL?.trim() || "https://notifierbg.com";

export const NOTIFIER_LINKS_URL = `${NOTIFIER_BASE_URL}/api/v1/links`;
export const NOTIFIER_MESSAGES_URL = `${NOTIFIER_BASE_URL}/api/v1/messages`;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

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
  cache: Map<string, string>,
): Promise<string> {
  const urls = extractHttpUrls(content);
  if (urls.length === 0) {
    return content;
  }

  let next = content;

  for (const originalUrl of urls) {
    let shortUrl = cache.get(originalUrl);

    if (!shortUrl) {
      const link = await createNotifierShortLink(apiKey, originalUrl);
      shortUrl = link.shortUrl;
      cache.set(originalUrl, shortUrl);
    }

    next = next.split(originalUrl).join(shortUrl);
  }

  return next;
}

export async function prepareNotifierMessageContent(
  apiKey: string,
  content: string,
  shortenLinks: boolean,
  linkCache: Map<string, string>,
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

export async function sendNotifierMessage(
  apiKey: string,
  phone: string,
  content: string,
  sendAt?: string | null,
): Promise<NotifierMessageResponse> {
  const payload: Record<string, string> = {
    phone,
    content,
  };

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

  const row = body as Partial<NotifierMessageResponse>;
  if (!row.id) {
    throw new Error("Notifier message response missing id");
  }

  return row as NotifierMessageResponse;
}
