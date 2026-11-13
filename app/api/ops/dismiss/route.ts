import { NextRequest } from "next/server";
import { z } from "zod";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { dismissJob } from "@/lib/admin/overdue";

const Body = z.object({ jobIds: z.array(z.string().uuid()).min(1).max(100), channel: z.enum(["email", "sms"]) });

/** Acknowledge notifications only; never send, cancel or delete jobs. */
export async function POST(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "channel and 1–100 UUID jobIds required" }, { status: 400 });
  const results = [];
  for (const jobId of new Set(parsed.data.jobIds)) {
    try {
      const dismissed = await dismissJob(parsed.data.channel === "email" ? "email_jobs" : "sms_jobs", jobId);
      results.push({ jobId, outcome: dismissed ? "dismissed" : "unchanged" });
    } catch (error) {
      results.push({ jobId, outcome: "error", error: error instanceof Error ? error.message : "Dismiss failed" });
    }
  }
  return Response.json({ results });
}
