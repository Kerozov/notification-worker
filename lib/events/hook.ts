import { getSupabaseAdmin } from "@/lib/db/supabase";

/**
 * Delivery events pushed to the client that sent the mail.
 *
 * The provider tells us about an open, a click or a bounce the moment it
 * happens; the client used to find out only when it next asked for the job
 * report. Now the same event goes on to the address the client registered
 * (`POST /api/v1/events/hook`), so both sides count from one source.
 *
 * A failed push never fails the provider webhook: the row here is already
 * updated, and the client can still read it from the job report.
 */

export type DeliveryEventType =
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "delivered";

export type DeliveryEvent = {
  type: DeliveryEventType;
  /** The job that sent this address — a child job for a campaign. */
  jobId: string;
  email: string;
  at: string;
  error?: string;
  url?: string;
};

export type OutgoingDeliveryEvent = DeliveryEvent & {
  /** The campaign the child belongs to: the id the client got when it sent. */
  parentJobId?: string;
};

type Hook = { tenant_id: string; url: string; token: string };

const PUSH_TIMEOUT_MS = 4000;
const MAX_EVENTS_PER_PUSH = 500;

const isMissingTable = (error: { code?: string; message?: string }): boolean =>
  error.code === "42P01" ||
  error.code === "PGRST205" ||
  (error.message ?? "").includes("tenant_event_hooks");

/** https to a public host. Anything else is refused at registration. */
export function validateHookUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":")
  ) {
    return null;
  }
  url.hash = "";
  return url.toString();
}

export function validateHookToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return /^[A-Za-z0-9._~+/=-]{24,300}$/.test(token) ? token : null;
}

export async function saveTenantHook(
  tenantId: string,
  url: string,
  token: string,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("tenant_event_hooks")
    .upsert(
      { tenant_id: tenantId, url, token, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id" },
    );
  if (error) throw new Error(error.message);
}

export async function deleteTenantHook(tenantId: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("tenant_event_hooks")
    .delete()
    .eq("tenant_id", tenantId);
  if (error && !isMissingTable(error)) throw new Error(error.message);
}

export async function getTenantHook(tenantId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("tenant_event_hooks")
    .select("url, updated_at, last_ok_at, last_error, last_error_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(error.message);
  }
  return data;
}

/** Events grouped by the tenant that owns their job, with the parent id filled in. */
export function groupEventsByTenant(
  events: DeliveryEvent[],
  jobs: Array<{ id: string; tenant_id: string; parent_id: string | null }>,
): Map<string, OutgoingDeliveryEvent[]> {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const out = new Map<string, OutgoingDeliveryEvent[]>();
  for (const event of events) {
    const job = byId.get(event.jobId);
    if (!job) continue;
    const list = out.get(job.tenant_id) ?? [];
    list.push(job.parent_id ? { ...event, parentJobId: job.parent_id } : event);
    out.set(job.tenant_id, list);
  }
  return out;
}

async function push(hook: Hook, events: OutgoingDeliveryEvent[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  const now = () => new Date().toISOString();
  try {
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_PUSH) {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hook.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: events.slice(i, i + MAX_EVENTS_PER_PUSH) }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
    await supabase
      .from("tenant_event_hooks")
      .update({ last_ok_at: now() })
      .eq("tenant_id", hook.tenant_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "push failed";
    console.error(`[events] push to tenant ${hook.tenant_id} failed: ${message}`);
    await supabase
      .from("tenant_event_hooks")
      .update({ last_error: message.slice(0, 300), last_error_at: now() })
      .eq("tenant_id", hook.tenant_id);
  }
}

/** Send what just happened to whoever asked to hear it. Never throws. */
export async function notifyDeliveryEvents(events: DeliveryEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const supabase = getSupabaseAdmin();
    const jobIds = [...new Set(events.map((event) => event.jobId))];

    const { data: jobs, error: jobsError } = await supabase
      .from("email_jobs")
      .select("id, tenant_id, parent_id")
      .in("id", jobIds);
    if (jobsError || !jobs?.length) return;

    const byTenant = groupEventsByTenant(
      events,
      jobs as Array<{ id: string; tenant_id: string; parent_id: string | null }>,
    );
    if (byTenant.size === 0) return;

    const { data: hooks, error: hooksError } = await supabase
      .from("tenant_event_hooks")
      .select("tenant_id, url, token")
      .in("tenant_id", [...byTenant.keys()]);
    if (hooksError) {
      if (!isMissingTable(hooksError)) {
        console.error("[events] hook lookup failed:", hooksError.message);
      }
      return;
    }

    await Promise.all(
      ((hooks ?? []) as Hook[]).map((hook) =>
        push(hook, byTenant.get(hook.tenant_id) ?? []),
      ),
    );
  } catch (error) {
    console.error("[events] notify failed:", error);
  }
}
