import { notFound, redirect } from "next/navigation";
import { peekRevealedApiKey } from "@/lib/auth/admin-flash";
import { hasAdminSession } from "@/lib/auth/admin";
import { getAdminChrome } from "@/lib/admin/chrome";
import { getTenantBySlug, listTenantExtraKeys } from "@/lib/tenants/store";
import styles from "../../admin.module.css";
import { AdminShell } from "../../shell";
import {
  ApiKeyReveal,
  ClientForm,
  DeleteClientForm,
  ExtraKeysSection,
  RotateApiKeyForm,
} from "../client-forms";

type SearchParams = Promise<{
  error?: string;
  saved?: string;
  reveal?: string;
  extra?: string;
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
    query.reveal === "1" ? await peekRevealedApiKey() : null;
  const workerUrl =
    process.env.WORKER_URL?.trim() ||
    "https://notification-worker-phi.vercel.app";
  const chrome = await getAdminChrome();
  const extraKeys = await listTenantExtraKeys(tenant.id);

  return (
    <AdminShell
      active="clients"
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
    >
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{tenant.name}</h1>
          <p className={styles.pageSubtitle}>
            Slug <code>{tenant.slug}</code>
          </p>
        </div>
      </header>

      {flashError ? (
        <section className={styles.errorBanner}>{flashError}</section>
      ) : null}

      {saved && !revealedApiKey ? (
        <section className={styles.successBanner}>Changes saved.</section>
      ) : null}

      {revealedApiKey ? (
        <ApiKeyReveal
          apiKey={revealedApiKey}
          workerUrl={workerUrl}
          extra={query.extra === "1"}
        />
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
            canActForTenants: tenant.can_act_for_tenants === true,
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

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Extra keys (LaunchifyBG)</h2>
          <p className={styles.sectionHint}>
            Same client, own key — revoke one without touching the others
          </p>
        </div>
        <ExtraKeysSection slug={tenant.slug} keys={extraKeys} />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Danger zone</h2>
          <p className={styles.sectionHint}>Permanent action</p>
        </div>
        <DeleteClientForm slug={tenant.slug} />
      </section>

      <section className={styles.footerNote}>
        On the client site (backend only):{" "}
        <code>NOTIFICATION_WORKER_URL={workerUrl}</code>
        {" · "}
        <code>NOTIFICATION_WORKER_API_KEY=&lt;key from above&gt;</code>
      </section>
    </AdminShell>
  );
}
