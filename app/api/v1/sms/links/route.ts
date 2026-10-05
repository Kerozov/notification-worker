import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveSmsTenant, smsTenantErrorResponse } from "@/lib/auth/sms-tenant";
import {
  checkTenantJobRateLimit,
  rateLimitResponse,
} from "@/lib/rate-limit/tenant";
import { resolveNotifierApiKey } from "@/lib/jobs/process-sms";
import { cleanSmsUrl } from "@/lib/sms/links";
import { createNotifierShortLink } from "@/lib/sms/notifier";

const bodySchema = z.object({
  url: z.string().min(1).max(2048),
});

/**
 * Make the short link now, not at send time.
 *
 * The composer counts the SMS while the owner types. A link shortened only when
 * the job runs has a length nobody knew, so a text that "fit" could be refused
 * after it was scheduled. The caller puts the returned `shortUrl` in the text
 * and sends with `shortenLinks: false` — the counted text is the sent text.
 */
export async function POST(request: NextRequest) {
  const resolved = await resolveSmsTenant(request);

  if (!resolved.ok) {
    return smsTenantErrorResponse(resolved);
  }

  const { tenant } = resolved;

  const rateLimit = await checkTenantJobRateLimit(tenant.id);

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfterSeconds);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const cleanedUrl = cleanSmsUrl(parsed.data.url);

  if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(cleanedUrl)) {
    return Response.json(
      { error: "url must be an absolute http(s) address" },
      { status: 400 },
    );
  }

  const apiKey = resolveNotifierApiKey(tenant);

  if (!apiKey) {
    return Response.json(
      {
        error:
          "Notifier API key is not configured for this tenant. Set TENANT_*_NOTIFIER_KEY and run seed.",
      },
      { status: 400 },
    );
  }

  try {
    const link = await createNotifierShortLink(apiKey, cleanedUrl);

    return Response.json({
      originalUrl: parsed.data.url,
      cleanedUrl,
      shortUrl: link.shortUrl,
      id: link.id,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create short link";

    return Response.json({ error: message, cleanedUrl }, { status: 502 });
  }
}
