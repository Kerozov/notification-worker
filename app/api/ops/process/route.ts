import { NextRequest } from "next/server";
import { z } from "zod";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { processJobById } from "@/lib/jobs/process";
import { processSmsJobById } from "@/lib/jobs/process-sms";

export const maxDuration = 300;

const Body = z.object({ jobId: z.string().uuid(), channel: z.enum(["email", "sms"]).default("email") });

/** Runs one pending or stuck job now (a stale "processing" job is released first). */
export async function POST(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "jobId (uuid) is required" }, { status: 400 });
  const { jobId, channel } = parsed.data;
  try {
    const result = channel === "sms" ? await processSmsJobById(jobId) : await processJobById(jobId);
    if (!result) return Response.json({ jobId, outcome: "not_claimable" });
    return Response.json({ jobId, outcome: "processed", result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Process failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
