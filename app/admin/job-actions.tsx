"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import styles from "./admin.module.css";
import {
  cancelScheduledEmailJob,
  cancelScheduledSmsJob,
  sendScheduledEmailJob,
  sendScheduledSmsJob,
} from "./actions";
import { formatDateTime, formatRecipients } from "./components";
import type { ChannelView } from "./dashboard-ui";

export type EmailPreviewJob = {
  id: string;
  subject: string;
  from_email: string | null;
  recipients: string[];
  html: string;
  send_at: string;
  status: string;
};

export type SmsPreviewJob = {
  id: string;
  body: string;
  sender: string | null;
  recipients: string[];
  send_at: string;
  status: string;
};

function PreviewModal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className={styles.modalOverlay}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-preview-title"
      >
        <div className={styles.modalHeader}>
          <h3 id="job-preview-title" className={styles.modalTitle}>
            {title}
          </h3>
          <button
            type="button"
            className={styles.modalClose}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={styles.modalBody}>{children}</div>
      </div>
    </div>
  );
}

function EmailPreviewContent({ job }: { job: EmailPreviewJob }) {
  return (
    <div className={styles.previewMeta}>
      <dl className={styles.previewDl}>
        <div>
          <dt>From</dt>
          <dd>{job.from_email ?? "—"}</dd>
        </div>
        <div>
          <dt>Recipients</dt>
          <dd className={styles.previewRecipients}>
            {job.recipients.map((recipient) => (
              <span key={recipient} className={styles.recipientPill}>
                {recipient}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>{formatDateTime(job.send_at)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{job.status}</dd>
        </div>
      </dl>
      <div className={styles.previewFrameWrap}>
        <iframe
          className={styles.previewFrame}
          title={`Email preview: ${job.subject}`}
          sandbox=""
          srcDoc={job.html}
        />
      </div>
    </div>
  );
}

function SmsPreviewContent({ job }: { job: SmsPreviewJob }) {
  return (
    <div className={styles.previewMeta}>
      <dl className={styles.previewDl}>
        <div>
          <dt>Sender</dt>
          <dd>{job.sender ?? "—"}</dd>
        </div>
        <div>
          <dt>Recipients</dt>
          <dd>{formatRecipients(job.recipients)}</dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>{formatDateTime(job.send_at)}</dd>
        </div>
      </dl>
      <pre className={styles.smsPreviewBody}>{job.body}</pre>
    </div>
  );
}

export function EmailJobActions({
  job,
  channel,
  returnQuery,
  showSendNow = false,
}: {
  job: EmailPreviewJob;
  channel: ChannelView;
  returnQuery: string;
  showSendNow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <div className={styles.actionGroup}>
        <button
          type="button"
          className={styles.viewButton}
          onClick={() => setOpen(true)}
        >
          View
        </button>
        {showSendNow && job.status === "pending" ? (
          <form
            action={(formData) => {
              startTransition(() => sendScheduledEmailJob(formData));
            }}
          >
            <input type="hidden" name="jobId" value={job.id} />
            <input type="hidden" name="channel" value={channel} />
            <input type="hidden" name="returnQuery" value={returnQuery} />
            <button
              className={styles.sendNowButton}
              type="submit"
              disabled={pending}
            >
              {pending ? "Sending…" : "Send now"}
            </button>
          </form>
        ) : null}
        {showSendNow && job.status === "pending" ? (
          <form
            action={(formData) => {
              startTransition(() => cancelScheduledEmailJob(formData));
            }}
          >
            <input type="hidden" name="jobId" value={job.id} />
            <input type="hidden" name="channel" value={channel} />
            <input type="hidden" name="returnQuery" value={returnQuery} />
            <button
              className={styles.cancelButton}
              type="submit"
              disabled={pending}
            >
              Cancel
            </button>
          </form>
        ) : null}
      </div>
      <PreviewModal
        open={open}
        onClose={() => setOpen(false)}
        title={job.subject}
      >
        <EmailPreviewContent job={job} />
      </PreviewModal>
    </>
  );
}

export function SmsJobActions({
  job,
  channel,
  returnQuery,
  showSendNow = false,
}: {
  job: SmsPreviewJob;
  channel: ChannelView;
  returnQuery: string;
  showSendNow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <div className={styles.actionGroup}>
        <button
          type="button"
          className={styles.viewButton}
          onClick={() => setOpen(true)}
        >
          View
        </button>
        {showSendNow && job.status === "pending" ? (
          <form
            action={(formData) => {
              startTransition(() => sendScheduledSmsJob(formData));
            }}
          >
            <input type="hidden" name="jobId" value={job.id} />
            <input type="hidden" name="channel" value={channel} />
            <input type="hidden" name="returnQuery" value={returnQuery} />
            <button
              className={styles.sendNowButton}
              type="submit"
              disabled={pending}
            >
              {pending ? "Sending…" : "Send now"}
            </button>
          </form>
        ) : null}
        {showSendNow && job.status === "pending" ? (
          <form
            action={(formData) => {
              startTransition(() => cancelScheduledSmsJob(formData));
            }}
          >
            <input type="hidden" name="jobId" value={job.id} />
            <input type="hidden" name="channel" value={channel} />
            <input type="hidden" name="returnQuery" value={returnQuery} />
            <button
              className={styles.cancelButton}
              type="submit"
              disabled={pending}
            >
              Cancel
            </button>
          </form>
        ) : null}
      </div>
      <PreviewModal
        open={open}
        onClose={() => setOpen(false)}
        title="SMS message"
      >
        <SmsPreviewContent job={job} />
      </PreviewModal>
    </>
  );
}
