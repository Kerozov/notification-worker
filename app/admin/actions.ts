"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAdminCookieName } from "@/lib/auth/admin";
import { processPendingJobs, recordCronRun } from "@/lib/jobs/process";

async function isAdminAuthorized(): Promise<boolean> {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    return false;
  }

  const cookieStore = await cookies();
  return cookieStore.get(getAdminCookieName())?.value === adminSecret;
}

export async function runCronNow(): Promise<void> {
  if (!(await isAdminAuthorized())) {
    throw new Error("Unauthorized");
  }

  await processPendingJobs(20);
  await recordCronRun();
  revalidatePath("/admin");
}
