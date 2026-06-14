import { cookies } from "next/headers";

const ADMIN_COOKIE = "admin_secret";

export function getAdminCookieName(): string {
  return ADMIN_COOKIE;
}

export async function hasAdminSession(): Promise<boolean> {
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    return false;
  }

  const cookieStore = await cookies();
  return cookieStore.get(ADMIN_COOKIE)?.value === adminSecret;
}
