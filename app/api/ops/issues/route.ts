import { NextRequest } from "next/server";
import { z } from "zod";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { fetchOverdueEmailJobs, fetchOverdueSmsJobs } from "@/lib/admin/overdue";

const Query = z.object({ channel: z.enum(["email", "sms"]).default("email"), reason: z.enum(["overdue", "stuck", "failed"]).optional(), page: z.coerce.number().int().min(1).max(100000).default(1) });
export async function GET(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  const parsed = Query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return Response.json({ error: "Invalid channel, reason or page" }, { status: 400 });
  const { channel, reason, page } = parsed.data;
  try {
    const result = channel === "email" ? await fetchOverdueEmailJobs(Date.now(), reason, page) : await fetchOverdueSmsJobs(Date.now(), reason, page);
    if (result.error) return Response.json({ error: result.error }, { status: 500 });
    return Response.json({ ...result, channel, page, pageSize: 100 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Read failed" }, { status: 500 });
  }
}
