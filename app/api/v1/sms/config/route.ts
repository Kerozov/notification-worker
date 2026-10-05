import { NextRequest } from "next/server";
import { resolveSmsTenant, smsTenantErrorResponse } from "@/lib/auth/sms-tenant";
import {
  resolveNotifierApiKey,
  resolveSmsSender,
} from "@/lib/jobs/process-sms";
import { smsMaxSegments } from "@/lib/sms/notifier";

/**
 * What a caller needs before it offers SMS: is there a Notifier key behind this
 * tenant, which sender name goes out, and how many parts one SMS may take.
 * Never returns the key itself.
 */
export async function GET(request: NextRequest) {
  const resolved = await resolveSmsTenant(request);

  if (!resolved.ok) {
    return smsTenantErrorResponse(resolved);
  }

  const { tenant } = resolved;

  return Response.json({
    tenant: { slug: tenant.slug, name: tenant.name },
    notifierConfigured: Boolean(resolveNotifierApiKey(tenant)),
    sender: resolveSmsSender(undefined, tenant),
    maxSegments: smsMaxSegments(),
  });
}
