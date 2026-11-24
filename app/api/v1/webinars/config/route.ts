import { NextRequest } from "next/server";
import { resolveSmsTenant, smsTenantErrorResponse } from "@/lib/auth/sms-tenant";
import { resolveNotifierApiKey } from "@/lib/jobs/process-sms";

/**
 * What a caller needs before it offers „Webinar through Notifier“: is the
 * method on for this client, which webinar is the default, and is there a
 * Notifier key to send with. Never returns the key.
 */
export async function GET(request: NextRequest) {
  const resolved = await resolveSmsTenant(request);
  if (!resolved.ok) return smsTenantErrorResponse(resolved);

  const { tenant } = resolved;

  return Response.json({
    tenant: { slug: tenant.slug, name: tenant.name },
    enabled: tenant.notifier_webinars === true,
    defaultWebinarId: tenant.notifier_webinar_id?.trim() || null,
    notifierConfigured: Boolean(resolveNotifierApiKey(tenant)),
  });
}
