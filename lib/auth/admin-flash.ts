import { cookies } from "next/headers";

const REVEAL_COOKIE = "admin_reveal_api_key";

export async function stashRevealedApiKey(apiKey: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(REVEAL_COOKIE, apiKey, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 120,
    path: "/admin",
  });
}

export async function takeRevealedApiKey(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(REVEAL_COOKIE)?.value ?? null;

  if (value) {
    cookieStore.delete(REVEAL_COOKIE);
  }

  return value;
}
