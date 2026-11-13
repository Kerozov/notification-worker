"use client";

import { useTransition } from "react";
import Link from "next/link";
import styles from "../admin.module.css";
import {
  cancelScheduledEmailJob,
  cancelScheduledSmsJob,
  dismissOverdueJob,
  retryFailedSmsJob,
  sendScheduledEmailJob,
  sendScheduledSmsJob,
} from "../actions";
import type { OverdueReason } from "@/lib/admin/overdue";

type JobFormAction = (formData: FormData) => Promise<void>;

const RETURN_TO = "/admin/overdue";

function ConfirmButton({
  jobId,
  channel,
  action,
  confirmText,
  label,
  busyLabel,
  className,
}: {
  jobId: string;
  channel: "email" | "sms";
  action: JobFormAction;
  confirmText: string;
  label: string;
  busyLabel: string;
  className: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        if (!window.confirm(confirmText)) {
          return;
        }
        startTransition(() => action(formData));
      }}
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="returnTo" value={RETURN_TO} />
      <button className={className} type="submit" disabled={pending}>
        {pending ? busyLabel : label}
      </button>
    </form>
  );
}

function recipientsLabel(count: number): string {
  return `${count.toLocaleString("bg-BG")} recipient${count === 1 ? "" : "s"}`;
}

export function OverdueEmailActions({
  jobId,
  reason,
  recipientCount,
}: {
  jobId: string;
  reason: OverdueReason;
  recipientCount: number;
}) {
  if (reason === "failed") {
    return (
      <div className={styles.actionGroup}>
        <Link className={styles.viewButton} href={`/admin/jobs/${jobId}`}>
          Open
        </Link>
        <Link className={styles.sendNowButton} href={`/admin/resend/${jobId}`}>
          Resend…
        </Link>
        <ConfirmButton
          jobId={jobId}
          channel="email"
          action={dismissOverdueJob}
          confirmText="Leave this job as failed and remove it from the list? Nothing will be sent."
          label="Dismiss"
          busyLabel="Dismissing…"
          className={styles.cancelButton}
        />
      </div>
    );
  }

  return (
    <div className={styles.actionGroup}>
      <Link className={styles.viewButton} href={`/admin/jobs/${jobId}`}>
        Open
      </Link>
      <ConfirmButton
        jobId={jobId}
        channel="email"
        action={sendScheduledEmailJob}
        confirmText={`Send this job now to ${recipientsLabel(recipientCount)}?`}
        label="Send now"
        busyLabel="Sending…"
        className={styles.sendNowButton}
      />
      <ConfirmButton
        jobId={jobId}
        channel="email"
        action={cancelScheduledEmailJob}
        confirmText="Cancel this job? It will not be sent."
        label="Cancel"
        busyLabel="Canceling…"
        className={styles.cancelButton}
      />
    </div>
  );
}

export function OverdueSmsActions({
  jobId,
  reason,
  recipientCount,
  sentCount,
}: {
  jobId: string;
  reason: OverdueReason;
  recipientCount: number;
  sentCount: number;
}) {
  if (reason === "overdue") {
    return (
      <div className={styles.actionGroup}>
        <ConfirmButton
          jobId={jobId}
          channel="sms"
          action={sendScheduledSmsJob}
          confirmText={`Send this SMS now to ${recipientsLabel(recipientCount)}?`}
          label="Send now"
          busyLabel="Sending…"
          className={styles.sendNowButton}
        />
        <ConfirmButton
          jobId={jobId}
          channel="sms"
          action={cancelScheduledSmsJob}
          confirmText="Cancel this SMS? It will not be sent."
          label="Cancel"
          busyLabel="Canceling…"
          className={styles.cancelButton}
        />
      </div>
    );
  }

  return (
    <div className={styles.actionGroup}>
      {reason === "failed" && sentCount === 0 ? (
        <ConfirmButton
          jobId={jobId}
          channel="sms"
          action={retryFailedSmsJob}
          confirmText={`Send this SMS again to ${recipientsLabel(recipientCount)}?`}
          label="Retry"
          busyLabel="Sending…"
          className={styles.sendNowButton}
        />
      ) : null}
      <ConfirmButton
        jobId={jobId}
        channel="sms"
        action={dismissOverdueJob}
        confirmText={
          reason === "stuck"
            ? "Remove this stuck SMS from the list? Check in Notifier whether it went out."
            : "Leave this SMS as failed and remove it from the list? Nothing will be sent."
        }
        label="Dismiss"
        busyLabel="Dismissing…"
        className={styles.cancelButton}
      />
    </div>
  );
}
