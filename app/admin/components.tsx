import styles from "./admin.module.css";

const STATUS_CLASS: Record<string, string> = {
  pending: styles.badgePending,
  processing: styles.badgeProcessing,
  sent: styles.badgeSent,
  failed: styles.badgeFailed,
  canceled: styles.badgeCanceled,
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`${styles.badge} ${STATUS_CLASS[status] ?? styles.badgeCanceled}`}>
      {status}
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      {hint ? <div className={styles.statHint}>{hint}</div> : null}
    </div>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("bg-BG", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Sofia",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) {
    return "never";
  }

  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${hours} h ago`;
  }

  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

export function formatRecipients(recipients: string[] | null | undefined): string {
  if (!recipients?.length) {
    return "0";
  }

  if (recipients.length === 1) {
    return recipients[0];
  }

  return `${recipients.length} · ${recipients.slice(0, 2).join(", ")}${recipients.length > 2 ? "…" : ""}`;
}

export function shortId(value: string): string {
  return `${value.slice(0, 8)}…`;
}
