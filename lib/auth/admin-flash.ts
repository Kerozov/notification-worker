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

/** Read-only — safe in Server Components (no cookie mutation). */
export async function peekRevealedApiKey(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(REVEAL_COOKIE)?.value ?? null;
}

export async function clearRevealedApiKey(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(REVEAL_COOKIE);
}
