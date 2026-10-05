import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
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
  const tenant = await resolveTenantFromRequest(request);

  if (!tenant) {
    return unauthorizedResponse();
  }

  return Response.json({
    notifierConfigured: Boolean(resolveNotifierApiKey(tenant)),
    sender: resolveSmsSender(undefined, tenant),
    maxSegments: smsMaxSegments(),
  });
}
