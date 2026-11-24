import { notFound, redirect } from "next/navigation";
import { peekRevealedApiKey } from "@/lib/auth/admin-flash";
import { hasAdminSession } from "@/lib/auth/admin";
import { getAdminChrome } from "@/lib/admin/chrome";
import { listWebinarRegistrations } from "@/lib/sms/webinar-history";
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
  const [extraKeys, webinarRegistrations] = await Promise.all([
    listTenantExtraKeys(tenant.id),
    listWebinarRegistrations(tenant.id),
  ]);

  return (
    <AdminShell
      active="clients"
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
      overdue={chrome.overdue}
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
            notifierWebinars: tenant.notifier_webinars === true,
            notifierWebinarId: tenant.notifier_webinar_id ?? null,
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
          <h2 className={styles.sectionTitle}>Webinar registrations</h2>
          <p className={styles.sectionHint}>
            Everyone handed to a Notifier webinar for this client — latest 200
          </p>
        </div>
        {webinarRegistrations.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Webinar</th>
                  <th>Person</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {webinarRegistrations.map((row) => (
                  <tr key={row.id}>
                    <td className={styles.mono}>
                      {new Date(row.created_at).toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })}
                    </td>
                    <td className={styles.mono}>{row.webinar_id}</td>
                    <td>
                      {[row.name, row.email, row.phone].filter(Boolean).join(" · ")}
                    </td>
                    <td>
                      <span
                        className={`${styles.badge} ${
                          row.status === "failed"
                            ? styles.badgeFailed
                            : row.status === "duplicate"
                              ? styles.badgeCanceled
                              : styles.badgeSent
                        }`}
                      >
                        {row.status === "added" ? "added" : row.status === "duplicate" ? "already there" : "failed"}
                      </span>
                      {row.error ? (
                        <div className={styles.mono}>
                          {row.http_status ? `${row.http_status}: ` : ""}
                          {row.error}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>No webinar registrations yet.</p>
        )}
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
