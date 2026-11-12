import { NextRequest } from "next/server";
import { opsUnauthorized, verifyOpsBearer } from "@/lib/ops/auth";
import { healOpenCampaigns } from "@/lib/jobs/campaign";
import { processPendingJobs } from "@/lib/jobs/process";
import { processPendingSmsJobs } from "@/lib/jobs/process-sms";

export const maxDuration = 300;

/**
 * Sends what is due and was never picked up, email and SMS, and resumes email
 * jobs stuck in "processing". Unlike the automatic safety net it has no age
 * limit: it runs only after the owner approved it.
 */
export async function POST(request: NextRequest) {
  if (!verifyOpsBearer(request)) return opsUnauthorized();
  try {
    const healed = await healOpenCampaigns(10, { windowMs: null });
    const email = await processPendingJobs(30, { windowMs: null });
    const sms = await processPendingSmsJobs(30);
    return Response.json({
      healedCampaigns: healed.campaigns,
      createdSendJobs: healed.created,
      email: { processed: email.processed, leftForNextDrain: email.skipped },
      sms: { processed: sms.processed },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Drain failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
