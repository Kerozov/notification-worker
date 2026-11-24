import { getSupabaseAdmin } from "@/lib/db/supabase";

export type WebinarRegistrationStatus = "added" | "duplicate" | "failed";

export type WebinarRegistrationRecord = {
  tenantId: string;
  webinarId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: WebinarRegistrationStatus;
  httpStatus: number | null;
  error: string | null;
};

export type WebinarRegistrationRow = {
  id: string;
  webinar_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: WebinarRegistrationStatus;
  http_status: number | null;
  error: string | null;
  created_at: string;
};

/**
 * One row of history. A failed write is logged, never thrown: the person is
 * already in Notifier (or not) and the caller's answer must not change because
 * the history table was unreachable.
 */
export async function recordWebinarRegistration(record: WebinarRegistrationRecord): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().from("webinar_registrations").insert({
      tenant_id: record.tenantId,
      webinar_id: record.webinarId,
      name: record.name,
      email: record.email,
      phone: record.phone,
      status: record.status,
      http_status: record.httpStatus,
      error: record.error,
    });
    if (error) console.error(`[webinars] history row not saved: ${error.message}`);
  } catch (error) {
    console.error("[webinars] history row not saved", error);
  }
}

/** The latest registrations of one client, newest first. Empty on a read error. */
export async function listWebinarRegistrations(
  tenantId: string,
  limit = 200,
): Promise<WebinarRegistrationRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("webinar_registrations")
    .select("id, webinar_id, name, email, phone, status, http_status, error, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error(`[webinars] history not read: ${error.message}`);
    return [];
  }
  return (data ?? []) as WebinarRegistrationRow[];
}
