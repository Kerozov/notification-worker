import { NextRequest } from "next/server";
import { z } from "zod";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { retryTemporaryFailures } from "@/lib/jobs/retry";

export const maxDuration = 300;

const Body = z.object({ jobId: z.string().uuid() });

/** Same as admin "Retry temporary bounces": typos and dead mailboxes stay out, sends are paced. */
export async function POST(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "jobId (uuid) is required" }, { status: 400 });
  try {
    return Response.json(await retryTemporaryFailures(parsed.data.jobId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retry failed";
    return Response.json({ error: message }, { status: message === "Job not found" ? 404 : 500 });
  }
}
