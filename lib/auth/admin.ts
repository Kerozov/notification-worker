import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const ADMIN_COOKIE = "admin_secret";

export async function isAdminAuthorized(request: NextRequest): Promise<boolean> {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    return false;
  }

  const querySecret = request.nextUrl.searchParams.get("secret");
  if (querySecret && querySecret === adminSecret) {
    return true;
  }

  const cookieStore = await cookies();
  const cookieSecret = cookieStore.get(ADMIN_COOKIE)?.value;
  return cookieSecret === adminSecret;
}

export function getAdminCookieName(): string {
  return ADMIN_COOKIE;
}
