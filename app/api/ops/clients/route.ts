import { NextRequest } from "next/server";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { listClients } from "@/lib/ops/jobs";

/** Every client profile for Jarvis. No keys leave: only whether an SMS key is set. */
export async function GET(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  try {
    return Response.json({ clients: await listClients() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Clients failed" }, { status: 500 });
  }
}
