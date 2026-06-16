import Link from "next/link";
import styles from "./admin.module.css";

export type AdminNavTab = "dashboard" | "clients";

export function AdminNav({ active }: { active: AdminNavTab }) {
  return (
    <nav className={styles.adminNav} aria-label="Admin sections">
      <Link
        href="/admin"
        className={`${styles.adminNavLink} ${
          active === "dashboard" ? styles.adminNavLinkActive : ""
        }`}
      >
        Dashboard
      </Link>
      <Link
        href="/admin/clients"
        className={`${styles.adminNavLink} ${
          active === "clients" ? styles.adminNavLinkActive : ""
        }`}
      >
        Clients
      </Link>
    </nav>
  );
}
