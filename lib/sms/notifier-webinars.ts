import type { Tenant } from "@/lib/db/supabase";
import { formatNotifierError } from "@/lib/sms/notifier";
import { normalizePhoneToE164 } from "@/lib/validation/sms-job";
import type { WebinarRegistrationRecord } from "@/lib/sms/webinar-history";

/**
 * Webinars live in Notifier: it sends the reminders with the join link and
 * records who joined Zoom. We only hand it the people who signed up — one
 * request per person, with the client's own Notifier key (the SMS key).
 */

const NOTIFIER_BASE_URL =
  process.env.NOTIFIER_BASE_URL?.trim() || "https://notifierbg.com";

const WEBINAR_ID_RE = /^[a-z0-9]{8,64}$/i;
const TIMEOUT_MS = 15_000;

/**
 * The webinar id from whatever the owner pasted: the bare id, the registrants
 * URL from „Add leads → API“, or the portal URL of the webinar. A join link
 * (`/join/<code>`) is not the webinar id — it is the code of the public page,
 * and posting registrants to it would fail on every signup.
 */
export function parseNotifierWebinarId(input: string | null | undefined): string | null {
  const raw = input?.trim() ?? "";
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw) || raw.includes("/")) {
    if (/\/join\//i.test(raw)) return null;
    const match = raw.match(/\/webinars\/([a-z0-9]+)/i);
    return match && WEBINAR_ID_RE.test(match[1]) ? match[1] : null;
  }

  return WEBINAR_ID_RE.test(raw) ? raw : null;
}

export function notifierRegistrantsUrl(webinarId: string): string {
  return `${NOTIFIER_BASE_URL}/api/v1/webinars/${encodeURIComponent(webinarId)}/registrants`;
}

export type WebinarRegistrant = {
  name: string | null;
  phone: string | null;
  email: string | null;
};

const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed ? trimmed : null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A person Notifier can reach: a valid email or a phone. Name is optional. */
export function readWebinarRegistrant(
  body: Record<string, unknown>,
): { ok: true; registrant: WebinarRegistrant } | { ok: false; error: string } {
  const rawEmail = clean(body.email, 254)?.toLowerCase() ?? null;
  const rawPhone = clean(body.phone, 32);
  const name = clean(body.name, 200);
  // Notifier refuses the whole person for one bad field. A phone we can't read
  // or a broken email is dropped when the other one still reaches them.
  const phone = rawPhone ? normalizePhoneToE164(rawPhone) : null;
  const email = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : null;

  if (rawEmail && !email && !phone) {
    return { ok: false, error: "email is not a valid address" };
  }

  if (!email && !phone) {
    return { ok: false, error: "email or phone is required" };
  }

  return { ok: true, registrant: { name, phone, email } };
}

export type RegistrantOutcome =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number; error: string };

/**
 * Hand one person to Notifier. 409 means Notifier already has them — that is
 * the outcome we wanted, not an error (a person who signs up twice is one
 * registrant). Retries once on 5xx / network: a lost signup is a person who
 * never gets the reminder.
 */
export async function addNotifierWebinarRegistrant(
  apiKey: string,
  webinarId: string,
  registrant: WebinarRegistrant,
): Promise<RegistrantOutcome> {
  // Notifier refuses the whole person over one field it doesn't like ("Input
  // validation failed"). Each fallback keeps a way to reach them: without the
  // phone, then the email alone, then the phone alone.
  const candidates = webinarPayloads(registrant);
  let last: RegistrantOutcome = { ok: false, status: 502, error: "Notifier did not answer" };
  for (const payload of candidates) {
    last = await postRegistrant(apiKey, webinarId, payload);
    if (last.ok || !isValidationRefusal(last.status)) return last;
  }
  return last;
}

const isValidationRefusal = (status: number) => status === 400 || status === 422;

/** The full person first, then smaller versions that still reach them. */
export function webinarPayloads(registrant: WebinarRegistrant): Record<string, string>[] {
  const build = (fields: Partial<WebinarRegistrant>) => {
    const payload: Record<string, string> = {};
    if (fields.name) payload.name = fields.name;
    if (fields.phone) payload.phone = fields.phone;
    if (fields.email) payload.email = fields.email;
    return payload;
  };
  const all = [
    build(registrant),
    build({ name: registrant.name, email: registrant.email }),
    build({ email: registrant.email }),
    build({ phone: registrant.phone }),
  ].filter((payload) => payload.email || payload.phone);
  const seen = new Set<string>();
  return all.filter((payload) => {
    const key = JSON.stringify(payload);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function postRegistrant(
  apiKey: string,
  webinarId: string,
  payload: Record<string, string>,
): Promise<RegistrantOutcome> {
  let last: RegistrantOutcome = {
    ok: false,
    status: 502,
    error: "Notifier did not answer",
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(notifierRegistrantsUrl(webinarId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.status === 409) return { ok: true, duplicate: true };
      if (response.ok) return { ok: true, duplicate: false };

      const body = await response.json().catch(() => null);
      last = {
        ok: false,
        status: response.status,
        error: formatNotifierError(body, response.status),
      };

      if (response.status < 500) return last;
    } catch (error) {
      last = {
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : "Notifier request failed",
      };
    }
  }

  return last;
}

export type RegisterResult = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * The whole decision for one signup, without the request: the client must have
 * Notifier webinars on (otherwise any caller could add people to a webinar the
 * owner never connected), the webinar is the one the page named — each webinar
 * has its own id — or the client's default, and the key is the client's own.
 */
export async function registerForTenantWebinar(
  tenant: Tenant,
  body: Record<string, unknown>,
  notifierKey: string | null,
  record: (row: WebinarRegistrationRecord) => Promise<void> = async () => {},
): Promise<RegisterResult> {
  // A page that names its webinar has decided: the client's Notifier subscription
  // is what accepts or refuses it. The switch here only governs the fallback to
  // the client's default webinar.
  const named = typeof body.webinarId === "string" ? body.webinarId.trim() : "";
  if (!named && tenant.notifier_webinars !== true) {
    return {
      status: 409,
      body: { error: `Notifier webinars are off for client "${tenant.slug}"` },
    };
  }

  const webinarId = named
    ? parseNotifierWebinarId(named)
    : parseNotifierWebinarId(tenant.notifier_webinar_id);

  if (!webinarId) {
    return {
      status: 400,
      body: {
        error: named
          ? "webinarId is not a Notifier webinar id (a join link is not one)"
          : "No webinar: pass webinarId or set the client's default webinar",
      },
    };
  }

  const person = readWebinarRegistrant(body);
  if (!person.ok) return { status: 400, body: { error: person.error } };

  const history = (status: WebinarRegistrationRecord["status"], httpStatus: number | null, error: string | null) =>
    record({
      tenantId: tenant.id,
      webinarId,
      ...person.registrant,
      status,
      httpStatus,
      error,
    });

  if (!notifierKey) {
    await history("failed", 412, "No Notifier API key");
    return {
      status: 412,
      body: { error: `Client "${tenant.slug}" has no Notifier API key` },
    };
  }

  const outcome = await addNotifierWebinarRegistrant(notifierKey, webinarId, person.registrant);

  if (!outcome.ok) {
    await history("failed", outcome.status, outcome.error);
    console.error(
      `[webinars] registrant not added tenant=${tenant.slug} webinar=${webinarId} status=${outcome.status}: ${outcome.error}`,
    );
    return {
      status: outcome.status >= 500 ? 502 : outcome.status,
      body: { error: outcome.error, webinarId },
    };
  }

  await history(outcome.duplicate ? "duplicate" : "added", null, null);
  return { status: 200, body: { ok: true, webinarId, duplicate: outcome.duplicate } };
}
