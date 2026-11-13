import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { hasAdminSession } from "@/lib/auth/admin";
import { isCampaignJob, listChildJobs, resolveSendContent } from "@/lib/jobs/campaign";
import { getJobById } from "@/lib/jobs/query";
import { getDeliveriesForJobs } from "@/lib/deliveries/store";
import { getAdminChrome } from "@/lib/admin/chrome";
import { AdminShell } from "../../shell";
import { CampaignReportView, type ReportSearchParams } from "./campaign-report-view";
import styles from "./report.module.css";

export default async function AdminJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ReportSearchParams>;
}) {
  if (!(await hasAdminSession())) {
    redirect("/admin?error=unauthorized");
  }

  const { id } = await params;
  const query = await searchParams;
  const [job, chrome] = await Promise.all([getJobById(id), getAdminChrome()]);

  if (!job) {
    return (
      <AdminShell
        active="email"
        channel="email"
        emailPending={chrome.emailPending}
        smsPending={chrome.smsPending}
        overdue={chrome.overdue}
      >
        <div className={styles.report}>
          <nav className={styles.crumbs} aria-label="Breadcrumb">
            <Link href="/admin?channel=email">Email jobs</Link>
          </nav>
          <p className={styles.emptyNote}>
            No email job with id <code className={styles.code}>{id}</code>. Paste a campaign
            id, a camp-… key or a worker job id into the search box above.
          </p>
        </div>
      </AdminShell>
    );
  }

  const supabase = getSupabaseAdmin();
  const [{ data: tenant }, children, parent, content] = await Promise.all([
    supabase.from("tenants").select("slug, name").eq("id", job.tenant_id).maybeSingle(),
    isCampaignJob(job) ? listChildJobs(job.id) : Promise.resolve([]),
    job.parent_id ? getJobById(job.parent_id) : Promise.resolve(null),
    resolveSendContent(job),
  ]);

  // One read of every delivery row; the report, the stats and the recipient
  // table are all computed from it.
  const deliveries = await getDeliveriesForJobs(
    [job.id, ...children.map((child) => child.id)],
    job.tenant_id,
  );

  return (
    <AdminShell
      active="email"
      channel="email"
      q=""
      emailPending={chrome.emailPending}
      smsPending={chrome.smsPending}
      overdue={chrome.overdue}
    >
      <CampaignReportView
        job={job}
        tenant={tenant ? { slug: String(tenant.slug), name: String(tenant.name) } : null}
        pockets={children}
        parent={parent}
        content={content}
        deliveries={deliveries}
        query={query}
      />
    </AdminShell>
  );
}
