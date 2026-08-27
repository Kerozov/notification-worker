"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import styles from "./admin.module.css";
import type { ChannelView } from "./dashboard-ui";

export function GlobalSearch({
  q,
  channel,
  tenant,
}: {
  q: string;
  channel: ChannelView;
  tenant?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }

      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const resetHref =
    channel === "all"
      ? "/admin"
      : `/admin?channel=${channel}${
          tenant && tenant !== "all" ? `&tenant=${encodeURIComponent(tenant)}` : ""
        }`;

  return (
    <form
      className={styles.globalSearch}
      method="get"
      action="/admin"
      role="search"
    >
      {channel !== "all" ? (
        <input type="hidden" name="channel" value={channel} />
      ) : null}
      {tenant && tenant !== "all" ? (
        <input type="hidden" name="tenant" value={tenant} />
      ) : null}
      <input type="hidden" name="period" value="all" />
      <div className={styles.searchField}>
        <input
          key={q}
          ref={inputRef}
          className={styles.globalSearchInput}
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Job id, campaign id, camp-…, email, subject"
          title="Paste a Funnel/Zara/HC campaign id, camp-… key, or worker job id to open the parent campaign"
          aria-label="Search jobs"
          autoComplete="off"
          enterKeyHint="search"
        />
        <kbd className={styles.searchKbd}>/</kbd>
      </div>
      <button className={styles.globalSearchButton} type="submit">
        Search
      </button>
      {q ? (
        <Link className={styles.globalSearchClear} href={resetHref}>
          Clear
        </Link>
      ) : null}
    </form>
  );
}
