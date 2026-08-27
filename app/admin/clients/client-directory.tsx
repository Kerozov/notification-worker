"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import styles from "../admin.module.css";
import { formatDateTime } from "../components";

type ClientRow = {
  id: string;
  slug: string;
  name: string;
  default_from: string | null;
  default_sms_sender: string | null;
  notifier_configured: boolean;
  created_at: string;
};

export function ClientDirectory({ tenants }: { tenants: ClientRow[] }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      tenants.filter((tenant) => {
        if (!query) {
          return true;
        }

        return (
          tenant.name.toLowerCase().includes(query) ||
          tenant.slug.toLowerCase().includes(query) ||
          (tenant.default_from ?? "").toLowerCase().includes(query) ||
          (tenant.default_sms_sender ?? "").toLowerCase().includes(query)
        );
      }),
    [tenants, query],
  );

  return (
    <>
      <label className={styles.directorySearch}>
        <span className={styles.filterLabel}>Find a client</span>
        <input
          className={styles.filterInput}
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Name, slug, from address…"
          autoComplete="off"
        />
      </label>

      {filtered.length === 0 ? (
        <div className={styles.empty}>
          {tenants.length === 0 ? (
            <>
              No clients yet.{" "}
              <Link className={styles.actionLink} href="/admin/clients/new">
                Add the first client
              </Link>
            </>
          ) : (
            `No clients match “${q}”.`
          )}
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Email from</th>
                <th>SMS</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tenant) => (
                <tr key={tenant.id} className={styles.dataRow}>
                  <td className={styles.tenantCell}>
                    <Link
                      className={styles.jobSubjectLink}
                      href={`/admin/clients/${tenant.slug}`}
                    >
                      {tenant.name}
                    </Link>
                  </td>
                  <td className={styles.mono}>{tenant.slug}</td>
                  <td className={styles.truncateWide}>
                    {tenant.default_from ?? "—"}
                  </td>
                  <td className={styles.metricCell}>
                    {tenant.default_sms_sender ?? "—"}
                    {tenant.notifier_configured ? (
                      <span className={styles.configOk}> · Notifier OK</span>
                    ) : (
                      <span className={styles.configMissing}> · no Notifier</span>
                    )}
                  </td>
                  <td className={styles.timeCell}>
                    {formatDateTime(tenant.created_at)}
                  </td>
                  <td className={styles.actionsCell}>
                    <Link
                      className={styles.viewButton}
                      href={`/admin/clients/${tenant.slug}`}
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
