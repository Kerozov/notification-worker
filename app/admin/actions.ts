"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { hasAdminSession } from "@/lib/auth/admin";
import { processPendingJobs, recordCronRun } from "@/lib/jobs/process";

export async function runCronNow(): Promise<void> {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  let processed = 0;

  try {
    const result = await processPendingJobs(20);
    await recordCronRun();
    processed = result.processed;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Cron processing failed";
    redirect(`/admin?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin");
  redirect(`/admin?cronProcessed=${processed}`);
}
