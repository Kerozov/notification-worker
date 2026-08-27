import { NextRequest } from "next/server";
import {
  internalUnauthorizedResponse,
  verifyInternalBearer,
} from "@/lib/internal-auth";
import { healOpenCampaigns } from "@/lib/jobs/campaign";
import { processPendingJobs } from "@/lib/jobs/process";

export const maxDuration = 300;

async function drain() {
  const healed = await healOpenCampaigns(10);
  const processed = await processPendingJobs(30);
  return {
    channel: "email" as const,
    healedCampaigns: healed.campaigns,
    createdSendJobs: healed.created,
    ...processed,
  };
}

/** Safety net: send jobs that were stored but never given a Trigger.dev run. */
export async function POST(request: NextRequest) {
  if (!verifyInternalBearer(request)) {
    return internalUnauthorizedResponse();
  }

  try {
    return Response.json(await drain());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Email drain failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** Same as POST — for ops calls that prefer GET. */
export async function GET(request: NextRequest) {
  return POST(request);
}
