import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { takeRevealedApiKey } from "@/lib/auth/admin-flash";
import { hasAdminSession } from "@/lib/auth/admin";
import { getTenantBySlug } from "@/lib/tenants/store";
import styles from "../../admin.module.css";
import { AdminNav } from "../../nav";
import { ApiKeyReveal, ClientForm, RotateApiKeyForm } from "../client-forms";

type SearchParams = Promise<{
  error?: string;
  saved?: string;
  reveal?: string;
}>;

export default async function EditClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SearchParams;
}) {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  const { slug } = await params;
  const query = await searchParams;
  const tenant = await getTenantBySlug(slug);

  if (!tenant) {
    notFound();
  }

  const flashError = query.error ? decodeURIComponent(query.error) : null;
  const saved = query.saved === "1";
  const revealedApiKey =
    query.reveal === "1" ? await takeRevealedApiKey() : null;
  const workerUrl =
    process.env.WORKER_URL?.trim() ||
    "https://notification-worker-phi.vercel.app";

  return (
    <main className={styles.adminPage}>
      <div className={styles.shell}>
        <Link className={styles.backLink} href="/admin/clients">
          ← Back to clients
        </Link>

        <header className={styles.header}>
          <div>
            <p className={styles.kicker}>Notification Worker</p>
            <h1 className={styles.title}>{tenant.name}</h1>
            <p className={styles.subtitle}>
              Slug: <code>{tenant.slug}</code>
            </p>
          </div>
        </header>

        <AdminNav active="clients" />

        {flashError ? (
          <section className={styles.errorBanner}>{flashError}</section>
        ) : null}

        {saved && !revealedApiKey ? (
          <section className={styles.successBanner}>Changes saved.</section>
        ) : null}

        {revealedApiKey ? (
          <ApiKeyReveal apiKey={revealedApiKey} workerUrl={workerUrl} />
        ) : null}

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Settings</h2>
          </div>
          <ClientForm
            mode="edit"
            slug={tenant.slug}
            defaults={{
              name: tenant.name,
              defaultFrom: tenant.default_from,
              defaultReplyTo: tenant.default_reply_to,
              defaultSmsSender: tenant.default_sms_sender,
              notifierConfigured: Boolean(tenant.notifier_api_key),
            }}
          />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>API key</h2>
            <p className={styles.sectionHint}>
              Cannot view existing key — only rotate to a new one
            </p>
          </div>
          <RotateApiKeyForm slug={tenant.slug} />
        </section>

        <section className={styles.footerNote}>
          On the client site (backend only):{" "}
          <code>NOTIFICATION_WORKER_URL={workerUrl}</code>
          {" · "}
          <code>NOTIFICATION_WORKER_API_KEY=&lt;key from above&gt;</code>
        </section>
      </div>
    </main>
  );
}
