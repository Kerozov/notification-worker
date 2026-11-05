import { NextRequest, NextResponse } from "next/server";
import { hasAdminSession } from "@/lib/auth/admin";
import {
  filterRecipients,
  parseRecipientQuery,
  recipientsCsv,
} from "@/lib/admin/campaign-report";
import { getDeliveriesForJobs } from "@/lib/deliveries/store";
import { isCampaignJob, listChildJobs } from "@/lib/jobs/campaign";
import { getJobById } from "@/lib/jobs/query";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** CSV of one campaign's recipients, filtered the same way as the admin table. */
export async function GET(request: NextRequest, context: RouteContext) {
  if (!(await hasAdminSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const job = await getJobById(id);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  const children = isCampaignJob(job) ? await listChildJobs(job.id) : [];
  const deliveries = await getDeliveriesForJobs(
    [job.id, ...children.map((child) => child.id)],
    job.tenant_id,
  );
  const search = request.nextUrl.searchParams;
  const query = parseRecipientQuery({
    seg: search.get("seg") ?? undefined,
    rq: search.get("rq") ?? undefined,
  });
  const rows = filterRecipients(deliveries, query);
  const pockets = new Map(children.map((child, index) => [child.id, index + 1]));
  const name = `${(job.idempotency_key ?? job.id).replace(/[^\w.-]+/g, "_").slice(0, 60)}-${query.segment}.csv`;

  return new NextResponse(recipientsCsv(rows, children.length ? pockets : undefined), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
