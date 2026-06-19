import { NextRequest } from "next/server";

export function verifyInternalBearer(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return false;
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  return Boolean(token && token === cronSecret);
}

export function internalUnauthorizedResponse() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
