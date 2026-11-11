import { NextRequest } from "next/server";
import { z } from "zod";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { jobDetail } from "@/lib/ops/jobs";

const Query = z.object({ id: z.string().uuid(), channel: z.enum(["email", "sms"]).default("email") });

/** One job: counts by delivery status and the failed addresses. ?id=<uuid>&channel=email|sms */
export async function GET(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const parsed = Query.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) return Response.json({ error: "id (uuid) is required" }, { status: 400 });
  try {
    const detail = await jobDetail(parsed.data.id, parsed.data.channel);
    return detail ? Response.json(detail) : Response.json({ error: "Job not found" }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Job failed" }, { status: 500 });
  }
}
