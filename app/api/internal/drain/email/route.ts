import { NextRequest } from "next/server";
import {
  internalUnauthorizedResponse,
  verifyInternalBearer,
} from "@/lib/internal-auth";
import { healOpenCampaigns } from "@/lib/jobs/campaign";
import { SAFETY_NET_WINDOW_MS } from "@/lib/jobs/drain";
import { processPendingJobs } from "@/lib/jobs/process";

export const maxDuration = 300;

async function drain() {
  const options = { windowMs: SAFETY_NET_WINDOW_MS };
  const healed = await healOpenCampaigns(10, options);
  const processed = await processPendingJobs(30, options);
  return {
    channel: "email" as const,
    healedCampaigns: healed.campaigns,
    createdSendJobs: healed.created,
    ...processed,
  };
}

/**
 * Safety net, every 5 minutes from the Trigger.dev schedule
 * `drain-email-safety-net`: sends what lost its own run (a failed trigger, a
 * step cut off by a timeout). Only jobs active in the last 24 h; older ones
 * stay for the owner (ops drain).
 */
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
