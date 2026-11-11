import { NextRequest } from "next/server";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { healOpenCampaigns } from "@/lib/jobs/campaign";
import { processPendingJobs } from "@/lib/jobs/process";
import { processPendingSmsJobs } from "@/lib/jobs/process-sms";

export const maxDuration = 300;

/** Sends what is due and was never picked up (same as the cron safety net), email and SMS. */
export async function POST(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  try {
    const healed = await healOpenCampaigns(10);
    const email = await processPendingJobs(30);
    const sms = await processPendingSmsJobs(30);
    return Response.json({
      healedCampaigns: healed.campaigns,
      createdSendJobs: healed.created,
      email: { processed: email.processed },
      sms: { processed: sms.processed },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Drain failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
