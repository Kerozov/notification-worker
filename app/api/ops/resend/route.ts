import { NextRequest } from "next/server";
import { z } from "zod";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { resendJob } from "@/lib/ops/jobs";

export const maxDuration = 300;

const Body = z.object({
  jobId: z.string().uuid(),
  mode: z.enum(["failed", "list"]),
  recipients: z.array(z.string().max(320)).max(50_000).optional(),
});

/** Same as admin "Resend failed" / "Resend to list": a new job with the same content, sent now. */
export async function POST(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "jobId (uuid) and mode failed|list are required" }, { status: 400 });
  const { jobId, mode, recipients } = parsed.data;
  if (mode === "list" && !recipients?.length) return Response.json({ error: "recipients are required for mode list" }, { status: 400 });
  try {
    return Response.json(await resendJob(jobId, mode, recipients));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Resend failed";
    return Response.json({ error: message }, { status: /not found/i.test(message) ? 404 : 500 });
  }
}
