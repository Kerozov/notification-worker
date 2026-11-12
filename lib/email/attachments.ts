import type { EmailAttachment } from "@/lib/validation/email-job";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "169.254.169.254",
  "metadata.google.internal",
]);

/**
 * An attachment that can never be sent as it is: too large, empty, a bad URL.
 * Retrying only downloads the same file again (a 17.7 MB PDF retried every
 * 2 minutes used up a tenant's whole Supabase egress quota in a day), so the
 * job fails its pending recipients instead of being rescheduled.
 */
export class PermanentAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentAttachmentError";
  }
}

export type ZeptoAttachment = {
  content: string;
  mime_type: string;
  name: string;
};

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOSTS.has(hostname.toLowerCase())) {
    return true;
  }

  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  if (/^10\./.test(host) || /^127\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }

  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    return true;
  }

  if (host.includes(":")) {
    if (
      host === "::1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    ) {
      return true;
    }
  }

  return false;
}

function assertSafeHttpsUrl(raw: string, filename: string): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new PermanentAttachmentError(`Invalid attachment URL (${filename})`);
  }

  if (url.protocol !== "https:") {
    throw new PermanentAttachmentError(`Attachment URL must be https (${filename})`);
  }

  if (isBlockedHost(url.hostname)) {
    throw new PermanentAttachmentError(`Attachment URL host is not allowed (${filename})`);
  }

  return url;
}

function safeFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop()?.trim() || "attachment";
  return base.slice(0, 200);
}

async function fetchWithSafeRedirects(
  start: URL,
  filename: string,
  contentType: string,
): Promise<Response> {
  let current = start;

  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: contentType || "*/*" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Attachment URL redirected without Location (${filename})`);
      }
      current = new URL(location, current);
      assertSafeHttpsUrl(current.toString(), filename);
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects for attachment ${filename}`);
}

/** Reads the body but stops as soon as it passes the limit (no Content-Length). */
async function readCapped(response: Response, filename: string): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      await reader.cancel().catch(() => {});
      throw new PermanentAttachmentError(
        `Attachment ${filename} is too large (max ${MAX_ATTACHMENT_BYTES} bytes)`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchAttachment(att: EmailAttachment): Promise<ZeptoAttachment> {
  const filename = safeFilename(att.filename);
  const url = assertSafeHttpsUrl(att.url, filename);

  let response: Response;

  try {
    response = await fetchWithSafeRedirects(url, filename, att.contentType);
  } catch (error) {
    if (error instanceof PermanentAttachmentError) throw error;
    const message =
      error instanceof Error ? error.message : "Attachment fetch failed";
    throw new Error(`Could not fetch attachment ${filename}: ${message}`);
  }

  if (response.status === 404 || response.status === 410) {
    throw new PermanentAttachmentError(
      `Attachment ${filename} not found (HTTP ${response.status})`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Attachment fetch failed for ${filename} (HTTP ${response.status})`,
    );
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_ATTACHMENT_BYTES) {
    // Do not pull the rest of the body over the wire.
    await response.body?.cancel().catch(() => {});
    throw new PermanentAttachmentError(
      `Attachment ${filename} is too large (max ${MAX_ATTACHMENT_BYTES} bytes)`,
    );
  }

  const bytes = await readCapped(response, filename);

  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new PermanentAttachmentError(
      `Attachment ${filename} is too large (max ${MAX_ATTACHMENT_BYTES} bytes)`,
    );
  }

  if (bytes.byteLength === 0) {
    throw new PermanentAttachmentError(`Attachment ${filename} is empty`);
  }

  return {
    content: Buffer.from(bytes).toString("base64"),
    mime_type: att.contentType.trim() || "application/octet-stream",
    name: filename,
  };
}

export async function loadZeptoAttachments(
  attachments: EmailAttachment[] | null | undefined,
): Promise<ZeptoAttachment[]> {
  if (!attachments?.length) {
    return [];
  }

  const loaded: ZeptoAttachment[] = [];

  for (const att of attachments) {
    loaded.push(await fetchAttachment(att));
  }

  return loaded;
}
