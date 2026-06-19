import { NextRequest } from "next/server";
import {
  internalUnauthorizedResponse,
  verifyInternalBearer,
} from "@/lib/internal-auth";
import { processJobById, recordCronRun } from "@/lib/jobs/process";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  if (!verifyInternalBearer(request)) {
    return internalUnauthorizedResponse();
  }

  const { id } = await context.params;

  try {
    const result = await processJobById(id);

    if (result) {
      await recordCronRun();
    }

    return Response.json({
      channel: "email",
      jobId: id,
      processed: Boolean(result),
      result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Email job processing failed";

    return Response.json({ error: message }, { status: 500 });
  }
}
