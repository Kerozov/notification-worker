import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAdminSession } from "@/lib/auth/admin";
import styles from "../../admin.module.css";
import { AdminNav } from "../../nav";
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

  return (
    <main className={styles.adminPage}>
      <div className={styles.shell}>
        <Link className={styles.backLink} href="/admin/clients">
          ← Back to clients
        </Link>

        <header className={styles.header}>
          <div>
            <p className={styles.kicker}>Notification Worker</p>
            <h1 className={styles.title}>Add client</h1>
            <p className={styles.subtitle}>
              Creates tenant in database and generates a worker API key
            </p>
          </div>
        </header>

        <AdminNav active="clients" />

        {flashError ? (
          <section className={styles.errorBanner}>{flashError}</section>
        ) : null}

        <section className={styles.section}>
          <ClientForm mode="create" />
        </section>
      </div>
    </main>
  );
}
