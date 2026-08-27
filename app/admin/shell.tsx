import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./admin.module.css";
import { formatDateTime, formatRelative } from "./components";
import type { ChannelView } from "./dashboard-ui";
import { GlobalSearch } from "./global-search";
import { AdminNav, type AdminNavTab } from "./nav";

export function AdminShell({
  active,
  q = "",
  channel = "all",
  tenant,
  emailPending = 0,
  smsPending = 0,
  lastProcessed,
  children,
}: {
  active: AdminNavTab;
  q?: string;
  channel?: ChannelView;
  tenant?: string;
  emailPending?: number;
  smsPending?: number;
  lastProcessed?: string | null;
  children: ReactNode;
}) {
  return (
    <main className={styles.adminPage}>
      <header className={styles.topBar}>
        <div className={styles.topBarInner}>
          <Link href="/admin" className={styles.brand}>
            Worker
          </Link>
          <AdminNav
            active={active}
            emailPending={emailPending}
            smsPending={smsPending}
            q={q}
          />
          <GlobalSearch q={q} channel={channel} tenant={tenant} />
        </div>
      </header>

      <div className={styles.shell}>
        {lastProcessed !== undefined ? (
          <p className={styles.processedHint}>
            Last send processed{" "}
            <strong>{formatRelative(lastProcessed ?? null)}</strong>
            <span className={styles.processedHintMeta}>
              {formatDateTime(lastProcessed ?? null)} · Europe/Sofia
            </span>
          </p>
        ) : null}
        {children}
      </div>
    </main>
  );
}

export function AdminLogin() {
  return (
    <main className={styles.unauthorized}>
      <div className={styles.unauthorizedCard}>
        <p className={styles.kicker}>Notification Worker</p>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>
          Monitor email and SMS queues, delivery, and clients.
        </p>
        <form className={styles.loginForm} method="post" action="/api/admin/login">
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>Admin secret</span>
            <input
              className={styles.filterInput}
              type="password"
              name="secret"
              required
              autoFocus
              autoComplete="current-password"
              placeholder="ADMIN_SECRET"
            />
          </label>
          <button className={styles.filterApplyButton} type="submit">
            Open dashboard
          </button>
        </form>
      </div>
    </main>
  );
}
