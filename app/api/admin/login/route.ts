import { NextRequest, NextResponse } from "next/server";
import { getAdminCookieName } from "@/lib/auth/admin";

function loginRedirect(request: NextRequest, secret: string | null) {
  const response = NextResponse.redirect(new URL("/admin", request.url));
  const adminSecret = process.env.ADMIN_SECRET;

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

export async function GET(request: NextRequest) {
  return loginRedirect(request, request.nextUrl.searchParams.get("secret"));
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  return loginRedirect(request, String(form.get("secret") ?? ""));
}
