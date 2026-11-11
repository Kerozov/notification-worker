import { NextRequest } from "next/server";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { listJobs } from "@/lib/ops/jobs";

/** Same list as the admin page: ?channel=email|sms&status=&tenant=<slug>&period=24h|7d|30d|all&q=&page= */
export async function GET(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  try {
    return Response.json(await listJobs(params));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Jobs failed";
    return Response.json({ error: message }, { status: message === "Client not found" ? 404 : 500 });
  }
}
