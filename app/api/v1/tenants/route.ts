import { NextRequest } from "next/server";
import { canActForTenants } from "@/lib/auth/sms-tenant";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import { listTenantsForAdmin } from "@/lib/tenants/store";

/**
 * Every client profile, for a caller that may act for them (the platform's
 * admin panel assigns its users to these). Keys never leave: only whether a
 * Notifier key is set and which sender name goes out.
 */
export async function GET(request: NextRequest) {
  const caller = await resolveTenantFromRequest(request);

  if (!caller) {
    return unauthorizedResponse();
  }

  if (!canActForTenants(caller)) {
    return Response.json(
      { error: "This API key may not list other clients" },
      { status: 403 },
    );
  }

  try {
    const tenants = await listTenantsForAdmin();

    return Response.json({
      self: caller.slug,
      tenants: tenants.map((tenant) => ({
        slug: tenant.slug,
        name: tenant.name,
        smsReady: tenant.notifier_configured,
        sender: tenant.default_sms_sender,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list clients";

    return Response.json({ error: message }, { status: 500 });
  }
}
