import { NextRequest } from "next/server";
import { z } from "zod";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { cancelJob } from "@/lib/ops/jobs";

const Body = z.object({ jobId: z.string().uuid(), channel: z.enum(["email", "sms"]).default("email") });

/**
 * Same as admin "Cancel": a pending or scheduled job (a campaign with its pending parts) stops.
 * A job stuck in "processing" whose step died (6+ min untouched) can be cancelled too.
 */
export async function POST(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "jobId (uuid) is required" }, { status: 400 });
  try {
    const job = await cancelJob(parsed.data.jobId, parsed.data.channel);
    if (!job) return Response.json({ jobId: parsed.data.jobId, outcome: "not_cancellable" });
    return Response.json({ jobId: parsed.data.jobId, outcome: "cancelled", job });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Cancel failed" }, { status: 500 });
  }
}
