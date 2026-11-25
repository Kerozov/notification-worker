import { NextRequest } from "next/server";
import {
  resolveTenantFromRequest,
  unauthorizedResponse,
} from "@/lib/auth/tenant";
import {
  deleteTenantHook,
  getTenantHook,
  saveTenantHook,
  validateHookToken,
  validateHookUrl,
} from "@/lib/events/hook";

/**
 * Where this client wants opens, clicks and bounces sent as they happen.
 * `POST { url, token }` registers (or replaces) the address; every push carries
 * `Authorization: Bearer <token>`. `GET` shows the address and the last result.
 */
export async function POST(request: NextRequest) {
  const tenant = await resolveTenantFromRequest(request);
  if (!tenant) return unauthorizedResponse();

  let body: { url?: unknown; token?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = validateHookUrl(body.url);
  const token = validateHookToken(body.token);
  if (!url) {
    return Response.json({ error: "url must be a public https address" }, { status: 400 });
  }
  if (!token) {
    return Response.json({ error: "token must be 24–300 URL-safe characters" }, { status: 400 });
  }

  try {
    await saveTenantHook(tenant.id, url, token);
    return Response.json({ ok: true, url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save hook";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const tenant = await resolveTenantFromRequest(request);
  if (!tenant) return unauthorizedResponse();
  try {
    return Response.json({ hook: await getTenantHook(tenant.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read hook";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const tenant = await resolveTenantFromRequest(request);
  if (!tenant) return unauthorizedResponse();
  try {
    await deleteTenantHook(tenant.id);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete hook";
    return Response.json({ error: message }, { status: 500 });
  }
}
