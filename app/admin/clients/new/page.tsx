import { redirect } from "next/navigation";
import { hasAdminSession } from "@/lib/auth/admin";
import { getAdminChrome } from "@/lib/admin/chrome";
import styles from "../../admin.module.css";
import { AdminShell } from "../../shell";
import { ClientForm } from "../client-forms";

export default async function NewClientPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  const params = await searchParams;
  const flashError = params.error ? decodeURIComponent(params.error) : null;
  const chrome = await getAdminChrome();

  return (
    <AdminShell
      active="clients"
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
    >
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Add client</h1>
          <p className={styles.pageSubtitle}>
            Creates a tenant and a worker API key. No seed script required.
          </p>
        </div>
      </header>

      {flashError ? (
        <section className={styles.errorBanner}>{flashError}</section>
      ) : null}

      <section className={styles.section}>
        <ClientForm mode="create" />
      </section>
    </AdminShell>
  );
}
