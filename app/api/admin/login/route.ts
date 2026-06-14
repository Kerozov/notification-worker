import { NextRequest, NextResponse } from "next/server";
import { getAdminCookieName } from "@/lib/auth/admin";

export async function GET(request: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  const secret = request.nextUrl.searchParams.get("secret");

  const response = NextResponse.redirect(new URL("/admin", request.url));

  if (adminSecret && secret === adminSecret) {
    response.cookies.set(getAdminCookieName(), adminSecret, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  }

  return response;
}
