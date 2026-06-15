import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { hasAdminSession } from "@/lib/auth/admin";
import { getDeliveriesForJob } from "@/lib/deliveries/store";
import {
  getDeliveryStatsByJobIds,
  getJobDisplayCounts,
  isInvalidDeliveryError,
  resolveDisplayStatus,
} from "@/lib/deliveries/stats";
import { getJobById } from "@/lib/jobs/query";
import {
  resendFromPaste,
  resendFromUpload,
  resendSameRecipients,
} from "../../actions";
import styles from "../../admin.module.css";
import { formatDateTime, shortId, StatusBadge } from "../../components";

type SearchParams = Promise<{
  error?: string;
  ok?: string;
  newJobId?: string;
  sent?: string;
  failed?: string;
  invalid?: string;
  status?: string;
}>;

export default async function ResendPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  const { id } = await params;
  const query = await searchParams;
  const job = await getJobById(id);

  if (!job) {
    return (
      <main className={styles.adminPage}>
        <div className={styles.shell}>
          <p>Job not found.</p>
          <Link href="/admin">← Back to admin</Link>
        </div>
      </main>
    );
  }

  const supabase = getSupabaseAdmin();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("slug, name")
    .eq("id", job.tenant_id)
    .maybeSingle();

  const deliveries = await getDeliveriesForJob(job.id, job.tenant_id);
  const deliveryStatsMap = await getDeliveryStatsByJobIds([job.id]);
  const stats = deliveryStatsMap.get(job.id);
  const counts = getJobDisplayCounts(job, stats);
  const displayStatus = resolveDisplayStatus(job, stats);
  const invalidDeliveries = deliveries.filter((d) =>
    isInvalidDeliveryError(d.error),
  );

  const flashError = query.error ? decodeURIComponent(query.error) : null;
  const success = query.ok === "1";

  return (
    <main className={styles.adminPage}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <Link href="/admin" className={styles.backLink}>
              ← Back to admin
            </Link>
            <h1 className={styles.title}>Resend campaign</h1>
            <p className={styles.subtitle}>
              Clone subject and HTML into a new send job
            </p>
          </div>
        </header>

        {flashError ? (
          <section className={styles.errorBanner}>{flashError}</section>
        ) : null}

        {success ? (
          <section className={styles.successBanner}>
            New job {query.newJobId ? shortId(query.newJobId) : "created"}.
            {query.sent ? ` Sent: ${query.sent}.` : ""}
            {query.failed ? ` Failed/invalid: ${query.failed}.` : ""}
            {query.invalid && Number(query.invalid) > 0
              ? ` Invalid (not sent): ${query.invalid}.`
              : ""}
          </section>
        ) : null}

        <section className={styles.resendCard}>
          <div className={styles.resendMeta}>
            <div>
              <strong>Tenant</strong>
              <span>{tenant?.slug ?? shortId(job.tenant_id)}</span>
            </div>
            <div>
              <strong>Status</strong>
              <StatusBadge status={displayStatus} />
            </div>
            <div>
              <strong>Subject</strong>
              <span>{job.subject}</span>
            </div>
            <div>
              <strong>From</strong>
              <span>{job.from_email ?? "—"}</span>
            </div>
            <div>
              <strong>Requested</strong>
              <span>{counts.requested}</span>
            </div>
            <div>
              <strong>Sent / invalid / failed</strong>
              <span>
                {counts.sent} sent · {counts.invalid} invalid · {counts.failed}{" "}
                failed
              </span>
            </div>
            <div>
              <strong>Original send</strong>
              <span>{formatDateTime(job.send_at)}</span>
            </div>
          </div>

          {invalidDeliveries.length > 0 ? (
            <div className={styles.invalidBox}>
              <strong>Invalid addresses from last run (not sent):</strong>
              <ul>
                {invalidDeliveries.map((d) => (
                  <li key={d.id}>{d.recipient}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className={styles.resendCard}>
          <h2 className={styles.sectionTitle}>1. Same recipient list</h2>
          <p className={styles.sectionHint}>
            Resend immediately to the same {job.recipients.length} addresses.
          </p>
          <form action={resendSameRecipients}>
            <input type="hidden" name="jobId" value={job.id} />
            <button className={styles.primaryButton} type="submit">
              Resend to same list
            </button>
          </form>
        </section>

        <section className={styles.resendCard}>
          <h2 className={styles.sectionTitle}>2. Upload Excel / CSV</h2>
          <p className={styles.sectionHint}>
            First column with emails. Supports .xlsx, .xls, .csv, .txt
          </p>
          <form action={resendFromUpload} encType="multipart/form-data">
            <input type="hidden" name="jobId" value={job.id} />
            <input
              className={styles.fileInput}
              type="file"
              name="file"
              accept=".xlsx,.xls,.csv,.txt"
              required
            />
            <button className={styles.primaryButton} type="submit">
              Upload and send
            </button>
          </form>
        </section>

        <section className={styles.resendCard}>
          <h2 className={styles.sectionTitle}>3. Paste emails</h2>
          <p className={styles.sectionHint}>
            One email per line, or comma-separated. Invalid addresses are
            marked failed and not sent.
          </p>
          <form action={resendFromPaste}>
            <input type="hidden" name="jobId" value={job.id} />
            <textarea
              className={styles.textarea}
              name="recipients"
              rows={8}
              placeholder={"user1@example.com\nuser2@example.com"}
              required
            />
            <button className={styles.primaryButton} type="submit">
              Paste and send
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
