import { NextRequest } from "next/server";
import { resolveSmsTenant, smsTenantErrorResponse } from "@/lib/auth/sms-tenant";
import { resolveNotifierApiKey } from "@/lib/jobs/process-sms";
import { registerForTenantWebinar } from "@/lib/sms/notifier-webinars";
import { recordWebinarRegistration } from "@/lib/sms/webinar-history";

/**
 * One person signed up for a webinar → hand them to Notifier.
 *
 * Body: `{ webinarId?, name?, phone?, email? }`. Each webinar has its own id,
 * so the page names it; without one the client's default webinar is used.
 * Runs as the client named in `X-Act-As-Tenant` (platform key) or as the
 * key's own client. Refused unless the client has Notifier webinars on.
 */
export async function POST(request: NextRequest) {
  const resolved = await resolveSmsTenant(request);
  if (!resolved.ok) return smsTenantErrorResponse(resolved);

  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const result = await registerForTenantWebinar(
    resolved.tenant,
    body,
    resolveNotifierApiKey(resolved.tenant),
    recordWebinarRegistration,
  );

  return Response.json(result.body, { status: result.status });
}
