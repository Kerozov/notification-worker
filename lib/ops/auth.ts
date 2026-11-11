import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";

/**
 * Ops access for the owner's assistant (Jarvis): its own key, separate from
 * CRON_SECRET and from tenant keys, so it can be rotated or switched off alone.
 */
export function verifyOpsBearer(request: NextRequest): boolean {
  const key = process.env.OPS_API_KEY;
  if (!key || key.length < 24) return false;

  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
  const a = Buffer.from(token);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function opsUnauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
