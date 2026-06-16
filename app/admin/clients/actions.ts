"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

  try {
    const { apiKey } = await createTenant({
      slug,
      name,
      defaultFrom: String(formData.get("defaultFrom") ?? ""),
      defaultReplyTo: String(formData.get("defaultReplyTo") ?? ""),
      defaultSmsSender: String(formData.get("defaultSmsSender") ?? ""),
      notifierApiKey: String(formData.get("notifierApiKey") ?? ""),
    });

    revalidatePath("/admin");
    revalidatePath("/admin/clients");
    clientsRedirect(`/admin/clients/${slug}`, {
      saved: "1",
      apiKey,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create client";
    clientsRedirect("/admin/clients/new", { error: message });
  }
}

export async function updateClientAction(formData: FormData): Promise<void> {
  await requireAdmin();

  const slug = String(formData.get("slug") ?? "");

  if (!slug) {
    clientsRedirect("/admin/clients", { error: "missing-client" });
  }

  try {
    await updateTenant(slug, {
      name: String(formData.get("name") ?? ""),
      defaultFrom: String(formData.get("defaultFrom") ?? ""),
      defaultReplyTo: String(formData.get("defaultReplyTo") ?? ""),
      defaultSmsSender: String(formData.get("defaultSmsSender") ?? ""),
      notifierApiKey: String(formData.get("notifierApiKey") ?? ""),
      clearNotifierKey: formData.get("clearNotifierKey") === "on",
    });

    revalidatePath("/admin");
    revalidatePath("/admin/clients");
    revalidatePath(`/admin/clients/${slug}`);
    clientsRedirect(`/admin/clients/${slug}`, { saved: "1" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update client";
    clientsRedirect(`/admin/clients/${slug}`, { error: message });
  }
}

export async function rotateClientApiKeyAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();

  const slug = String(formData.get("slug") ?? "");

  if (!slug) {
    clientsRedirect("/admin/clients", { error: "missing-client" });
  }

  try {
    const { apiKey } = await rotateTenantApiKey(slug);

    revalidatePath("/admin");
    revalidatePath("/admin/clients");
    revalidatePath(`/admin/clients/${slug}`);
    clientsRedirect(`/admin/clients/${slug}`, {
      saved: "1",
      apiKey,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to rotate API key";
    clientsRedirect(`/admin/clients/${slug}`, { error: message });
  }
}
