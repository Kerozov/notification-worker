import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAdminSession } from "@/lib/auth/admin";
import { getAdminChrome } from "@/lib/admin/chrome";
import { listTenantsForAdmin } from "@/lib/tenants/store";
import styles from "../admin.module.css";
import { AdminShell } from "../shell";
import { ClientDirectory } from "./client-directory";

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
  const [tenants, chrome] = await Promise.all([
    listTenantsForAdmin(),
    getAdminChrome(),
  ]);
  const workerUrl =
    process.env.WORKER_URL?.trim() ||
    "https://notification-worker-phi.vercel.app";

  return (
    <AdminShell
      active="clients"
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
      lastProcessed={chrome.lastCronRun}
    >
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Clients</h1>
          <p className={styles.pageSubtitle}>
            Tenants use <code>NOTIFICATION_WORKER_API_KEY</code> against{" "}
            <code>{workerUrl}</code>
          </p>
        </div>
        <Link className={styles.primaryButtonLink} href="/admin/clients/new">
          Add client
        </Link>
      </header>

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
          </div>
        </div>
        <ClientDirectory tenants={tenants} />
      </section>
    </AdminShell>
  );
}
