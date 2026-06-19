import { NextRequest } from "next/server";
import {
  internalUnauthorizedResponse,
  verifyInternalBearer,
} from "@/lib/internal-auth";
import { recordCronRun } from "@/lib/jobs/process";
import { processSmsJobById } from "@/lib/jobs/process-sms";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  if (!verifyInternalBearer(request)) {
    return internalUnauthorizedResponse();
  }

  const { id } = await context.params;

  try {
    const result = await processSmsJobById(id);

    if (result) {
      await recordCronRun();
    }

    return Response.json({
      channel: "sms",
      jobId: id,
      processed: Boolean(result),
      result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "SMS job processing failed";

    return Response.json({ error: message }, { status: 500 });
  }
}
