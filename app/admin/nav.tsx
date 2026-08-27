import Link from "next/link";
import styles from "./admin.module.css";

export type AdminNavTab = "overview" | "email" | "sms" | "clients";

export function AdminNav({
  active,
  emailPending = 0,
  smsPending = 0,
  q = "",
}: {
  active: AdminNavTab;
  emailPending?: number;
  smsPending?: number;
  q?: string;
}) {
  const search = q.trim()
    ? `&q=${encodeURIComponent(q.trim())}&period=all`
    : "";

  const tabs: Array<{
    id: AdminNavTab;
    href: string;
    label: string;
    count?: number;
  }> = [
    { id: "overview", href: q.trim() ? `/admin?q=${encodeURIComponent(q.trim())}&period=all` : "/admin", label: "Overview" },
    {
      id: "email",
      href: `/admin?channel=email${search}`,
      label: "Email",
      count: emailPending,
    },
    {
      id: "sms",
      href: `/admin?channel=sms${search}`,
      label: "SMS",
      count: smsPending,
    },
    { id: "clients", href: "/admin/clients", label: "Clients" },
  ];

  return (
    <nav className={styles.adminNav} aria-label="Admin">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={`${styles.adminNavLink} ${
            active === tab.id ? styles.adminNavLinkActive : ""
          }`}
        >
          {tab.label}
          {tab.count ? (
            <span className={styles.adminNavCount}>{tab.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
