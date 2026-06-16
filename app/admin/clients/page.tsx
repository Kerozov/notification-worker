import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAdminSession } from "@/lib/auth/admin";
import { listTenantsForAdmin } from "@/lib/tenants/store";
import styles from "../admin.module.css";
import { AdminNav } from "../nav";
import { formatDateTime } from "../components";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  const params = await searchParams;
  const flashError = params.error ? decodeURIComponent(params.error) : null;
  const saved = params.saved === "1";
  const tenants = await listTenantsForAdmin();
  const workerUrl =
    process.env.WORKER_URL?.trim() ||
    "https://notification-worker-phi.vercel.app";

  return (
    <main className={styles.adminPage}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.kicker}>Notification Worker</p>
            <h1 className={styles.title}>Clients</h1>
            <p className={styles.subtitle}>
              Add and configure tenants — no manual database or seed required
            </p>
          </div>
          <Link className={styles.primaryButtonLink} href="/admin/clients/new">
            + Add client
          </Link>
        </header>

        <AdminNav active="clients" />

        {flashError ? (
          <section className={styles.errorBanner}>{flashError}</section>
        ) : null}

        {saved ? (
          <section className={styles.successBanner}>Client saved.</section>
        ) : null}

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>
                All clients
                <span className={styles.sectionBadge}>{tenants.length}</span>
              </h2>
              <p className={styles.sectionHint}>
                Site backend uses{" "}
                <code>NOTIFICATION_WORKER_API_KEY</code> +{" "}
                <code>{workerUrl}</code>
              </p>
            </div>
          </div>

          {tenants.length === 0 ? (
            <div className={styles.empty}>
              No clients yet.{" "}
              <Link className={styles.actionLink} href="/admin/clients/new">
                Add the first client
              </Link>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Slug</th>
                    <th>Email from</th>
                    <th>SMS</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((tenant) => (
                    <tr key={tenant.id}>
                      <td className={styles.tenantCell}>{tenant.name}</td>
                      <td className={styles.mono}>{tenant.slug}</td>
                      <td className={styles.truncateWide}>
                        {tenant.default_from ?? "—"}
                      </td>
                      <td className={styles.metricCell}>
                        {tenant.default_sms_sender ?? "—"}
                        {tenant.notifier_configured ? (
                          <span className={styles.configOk}> · Notifier OK</span>
                        ) : (
                          <span className={styles.configMissing}>
                            {" "}
                            · no Notifier
                          </span>
                        )}
                      </td>
                      <td className={styles.timeCell}>
                        {formatDateTime(tenant.created_at)}
                      </td>
                      <td>
                        <Link
                          className={styles.actionLink}
                          href={`/admin/clients/${tenant.slug}`}
                        >
                          Edit
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
