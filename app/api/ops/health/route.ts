import { NextRequest } from "next/server";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { assessHealth, collectHealth } from "@/lib/ops/health";

export const dynamic = "force-dynamic";

/** Read-only health for Jarvis: failed, stuck and overdue jobs, retryable bounces. */
export async function GET(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  try {
    return Response.json(assessHealth(await collectHealth()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Health check failed";
    return Response.json({ status: "critical", error: message }, { status: 500 });
  }
}
