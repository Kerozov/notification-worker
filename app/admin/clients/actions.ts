"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { stashRevealedApiKey } from "@/lib/auth/admin-flash";
import { hasAdminSession } from "@/lib/auth/admin";
import {
  createTenant,
  normalizeTenantSlug,
  rotateTenantApiKey,
  updateTenant,
} from "@/lib/tenants/store";

async function requireAdmin(): Promise<void> {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }
}

function clientsRedirect(
  path: string,
  params: Record<string, string>,
): never {
  const search = new URLSearchParams(params);
  redirect(`${path}?${search.toString()}`);
}

export async function createClientAction(formData: FormData): Promise<void> {
  await requireAdmin();

  const slug = normalizeTenantSlug(String(formData.get("slug") ?? ""));
  const name = String(formData.get("name") ?? "").trim();

  let apiKey: string | null = null;
  let errorMessage: string | null = null;

  try {
    const result = await createTenant({
      slug,
      name,
      defaultFrom: String(formData.get("defaultFrom") ?? ""),
      defaultReplyTo: String(formData.get("defaultReplyTo") ?? ""),
      defaultSmsSender: String(formData.get("defaultSmsSender") ?? ""),
      notifierApiKey: String(formData.get("notifierApiKey") ?? ""),
    });
    apiKey = result.apiKey;
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Failed to create client";
  }

  if (errorMessage) {
    clientsRedirect("/admin/clients/new", { error: errorMessage });
  }

  if (!apiKey || !slug) {
    clientsRedirect("/admin/clients/new", {
      error: "Client was created but API key was missing — try rotating the key",
    });
  }

  await stashRevealedApiKey(apiKey);

  revalidatePath("/admin");
  revalidatePath("/admin/clients");
  clientsRedirect(`/admin/clients/${slug}`, {
    saved: "1",
    reveal: "1",
  });
}

export async function updateClientAction(formData: FormData): Promise<void> {
  await requireAdmin();

  const slug = String(formData.get("slug") ?? "");

  if (!slug) {
    clientsRedirect("/admin/clients", { error: "missing-client" });
  }

  let errorMessage: string | null = null;

  try {
    await updateTenant(slug, {
      name: String(formData.get("name") ?? ""),
      defaultFrom: String(formData.get("defaultFrom") ?? ""),
      defaultReplyTo: String(formData.get("defaultReplyTo") ?? ""),
      defaultSmsSender: String(formData.get("defaultSmsSender") ?? ""),
      notifierApiKey: String(formData.get("notifierApiKey") ?? ""),
      clearNotifierKey: formData.get("clearNotifierKey") === "on",
    });
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Failed to update client";
  }

  if (errorMessage) {
    clientsRedirect(`/admin/clients/${slug}`, { error: errorMessage });
  }

  revalidatePath("/admin");
  revalidatePath("/admin/clients");
  revalidatePath(`/admin/clients/${slug}`);
  clientsRedirect(`/admin/clients/${slug}`, { saved: "1" });
}

export async function rotateClientApiKeyAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();

  const slug = String(formData.get("slug") ?? "");

  if (!slug) {
    clientsRedirect("/admin/clients", { error: "missing-client" });
  }

  let apiKey: string | null = null;
  let errorMessage: string | null = null;

  try {
    const result = await rotateTenantApiKey(slug);
    apiKey = result.apiKey;
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Failed to rotate API key";
  }

  if (errorMessage) {
    clientsRedirect(`/admin/clients/${slug}`, { error: errorMessage });
  }

  if (!apiKey) {
    clientsRedirect(`/admin/clients/${slug}`, {
      error: "Failed to generate API key",
    });
  }

  await stashRevealedApiKey(apiKey);

  revalidatePath("/admin");
  revalidatePath("/admin/clients");
  revalidatePath(`/admin/clients/${slug}`);
  clientsRedirect(`/admin/clients/${slug}`, {
    saved: "1",
    reveal: "1",
  });
}
