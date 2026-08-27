import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <div className={styles.main}>
        <div className={styles.intro}>
          <h1>Notification Worker</h1>
          <p>
            Multi-tenant email and SMS dispatch. Open the dashboard to search
            jobs, watch queues, and manage clients.
          </p>
        </div>
        <div className={styles.ctas}>
          <Link className={styles.primary} href="/admin">
            Open dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
