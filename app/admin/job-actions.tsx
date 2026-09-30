"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import styles from "./admin.module.css";
import {
  cancelScheduledEmailJob,
  cancelScheduledSmsJob,
  sendScheduledEmailJob,
  sendScheduledSmsJob,
} from "./actions";
import { formatDateTime, formatRelative, StatusBadge } from "./components";
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
  tenant?: string | null;
  sent_count?: number;
  failed_count?: number;
  error?: string | null;
  created_at?: string;
};

type JobFormAction = (formData: FormData) => Promise<void>;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input:not([type="hidden"]), select, iframe, [tabindex]:not([tabindex="-1"])';

function PreviewModal({
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const pressStartedOnOverlay = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !panel) {
        return;
      }

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const { overflow, paddingRight } = document.body.style;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  // Portal to <body>: the triggers live inside sticky table cells within an
  // overflow container, which clips/traps a fixed overlay (notably in Safari).
  return createPortal(
    <div
      className={styles.modalOverlay}
      role="presentation"
      onMouseDown={(event) => {
        pressStartedOnOverlay.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressStartedOnOverlay.current && event.target === event.currentTarget) {
          onClose();
        }
        pressStartedOnOverlay.current = false;
      }}
    >
      <div
        ref={panelRef}
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.modalHeader}>
          <div className={styles.modalHeading}>
            <h3 id={titleId} className={styles.modalTitle}>
              {title}
            </h3>
            {subtitle ? (
              <div className={styles.modalSubtitle}>{subtitle}</div>
            ) : null}
          </div>
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
        {footer ? <div className={styles.modalFooter}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={`${styles.copyButton} ${copied ? styles.copyButtonDone : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          // Clipboard can be blocked (insecure context / permissions); the
          // value is still selectable in the dialog.
        }
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

function ScheduledJobButtons({
  jobId,
  channel,
  returnQuery,
  returnTo,
  recipientCount,
  sendAction,
  cancelAction,
}: {
  jobId: string;
  channel: ChannelView;
  returnQuery: string;
  returnTo?: string;
  recipientCount: number;
  sendAction: JobFormAction;
  cancelAction: JobFormAction;
}) {
  const [pending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<"send" | "cancel" | null>(
    null,
  );
  const recipientsLabel = `${recipientCount.toLocaleString("bg-BG")} recipient${
    recipientCount === 1 ? "" : "s"
  }`;

  const hiddenFields = (
    <>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="returnQuery" value={returnQuery} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
    </>
  );

  return (
    <>
      <form
        action={(formData) => {
          if (!window.confirm(`Send this job now to ${recipientsLabel}?`)) {
            return;
          }
          setPendingAction("send");
          startTransition(() => sendAction(formData));
        }}
      >
        {hiddenFields}
        <button className={styles.sendNowButton} type="submit" disabled={pending}>
          {pending && pendingAction === "send" ? "Sending…" : "Send now"}
        </button>
      </form>
      <form
        action={(formData) => {
          if (!window.confirm("Cancel this scheduled job? It will not be sent.")) {
            return;
          }
          setPendingAction("cancel");
          startTransition(() => cancelAction(formData));
        }}
      >
        {hiddenFields}
        <button className={styles.cancelButton} type="submit" disabled={pending}>
          {pending && pendingAction === "cancel" ? "Canceling…" : "Cancel"}
        </button>
      </form>
    </>
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
          <dt>Scheduled</dt>
          <dd>{formatDateTime(job.send_at)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={job.status} />
          </dd>
        </div>
      </dl>
      <div className={styles.previewBlock}>
        <div className={styles.previewBlockHead}>
          <span className={styles.previewBlockLabel}>
            Recipients · {job.recipients.length.toLocaleString("bg-BG")}
          </span>
          {job.recipients.length > 0 ? (
            <CopyButton value={job.recipients.join("\n")} label="Copy emails" />
          ) : null}
        </div>
        <textarea
          className={styles.previewRecipientList}
          readOnly
          rows={Math.min(8, Math.max(2, job.recipients.length))}
          value={job.recipients.join("\n")}
        />
      </div>
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

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

function smsStats(body: string): {
  length: number;
  segments: number;
  encoding: "GSM-7" | "Unicode";
} {
  let units = 0;
  for (const char of body) {
    if (GSM_BASIC.has(char)) {
      units += 1;
    } else if (GSM_EXTENDED.has(char)) {
      units += 2;
    } else {
      // Any non-GSM char (e.g. Cyrillic) switches the whole message to UCS-2.
      const length = body.length;
      return {
        length,
        segments: length <= 70 ? 1 : Math.ceil(length / 67),
        encoding: "Unicode",
      };
    }
  }

  return {
    length: units,
    segments: units <= 160 ? 1 : Math.ceil(units / 153),
    encoding: "GSM-7",
  };
}

function SmsPreviewContent({ job }: { job: SmsPreviewJob }) {
  const stats = smsStats(job.body);
  const hasResult =
    job.sent_count !== undefined || job.failed_count !== undefined;

  return (
    <div className={styles.previewMeta}>
      <dl className={styles.previewDl}>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={job.status} />
          </dd>
        </div>
        {job.tenant ? (
          <div>
            <dt>Client</dt>
            <dd>{job.tenant}</dd>
          </div>
        ) : null}
        <div>
          <dt>Sender</dt>
          <dd>{job.sender ?? "—"}</dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd title={formatRelative(job.send_at)}>
            {formatDateTime(job.send_at)}
          </dd>
        </div>
        {job.created_at ? (
          <div>
            <dt>Created</dt>
            <dd title={formatRelative(job.created_at)}>
              {formatDateTime(job.created_at)}
            </dd>
          </div>
        ) : null}
        {hasResult ? (
          <div>
            <dt>Result</dt>
            <dd>
              <span className={styles.resultSent}>
                {(job.sent_count ?? 0).toLocaleString("bg-BG")} sent
              </span>
              {" · "}
              <span
                className={(job.failed_count ?? 0) > 0 ? styles.failedCount : undefined}
              >
                {(job.failed_count ?? 0).toLocaleString("bg-BG")} failed
              </span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Job ID</dt>
          <dd className={styles.copyValue}>{job.id}</dd>
        </div>
      </dl>

      {job.error ? (
        <div className={styles.previewError}>
          <span className={styles.errorRowLabel}>Error</span>
          <span>{job.error}</span>
        </div>
      ) : null}

      <div className={styles.previewBlock}>
        <div className={styles.previewBlockHead}>
          <span className={styles.previewBlockLabel}>Message</span>
          <span className={styles.previewBlockMeta}>
            {stats.length.toLocaleString("bg-BG")} chars · {stats.segments}{" "}
            {stats.segments === 1 ? "segment" : "segments"} · {stats.encoding}
          </span>
          <CopyButton value={job.body} label="Copy text" />
        </div>
        <div className={styles.smsBubbleWrap}>
          {job.sender ? (
            <span className={styles.smsBubbleSender}>{job.sender}</span>
          ) : null}
          <p className={styles.smsBubble}>{job.body}</p>
        </div>
      </div>

      <div className={styles.previewBlock}>
        <div className={styles.previewBlockHead}>
          <span className={styles.previewBlockLabel}>
            Recipients · {job.recipients.length.toLocaleString("bg-BG")}
          </span>
          {job.recipients.length > 0 ? (
            <CopyButton value={job.recipients.join("\n")} label="Copy numbers" />
          ) : null}
        </div>
        {job.recipients.length > 0 ? (
          <textarea
            className={styles.previewRecipientList}
            readOnly
            rows={Math.min(8, Math.max(2, job.recipients.length))}
            value={job.recipients.join("\n")}
          />
        ) : (
          <p className={styles.previewEmpty}>No recipients.</p>
        )}
      </div>
    </div>
  );
}

function SmsPreviewDialog({
  job,
  open,
  onClose,
  channel,
  returnQuery,
  showSendNow,
}: {
  job: SmsPreviewJob;
  open: boolean;
  onClose: () => void;
  channel: ChannelView;
  returnQuery: string;
  showSendNow: boolean;
}) {
  return (
    <PreviewModal
      open={open}
      onClose={onClose}
      title="SMS message"
      subtitle={[job.tenant, job.sender].filter(Boolean).join(" · ") || undefined}
      footer={
        <>
          {showSendNow && job.status === "pending" ? (
            <ScheduledJobButtons
              jobId={job.id}
              channel={channel}
              returnQuery={returnQuery}
              recipientCount={job.recipients.length}
              sendAction={sendScheduledSmsJob}
              cancelAction={cancelScheduledSmsJob}
            />
          ) : null}
          <button type="button" className={styles.viewButton} onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <SmsPreviewContent job={job} />
    </PreviewModal>
  );
}

export function EmailJobActions({
  job,
  channel,
  returnQuery,
  showSendNow = false,
  detailHref,
}: {
  job: EmailPreviewJob;
  channel: ChannelView;
  returnQuery: string;
  showSendNow?: boolean;
  detailHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const canManage = showSendNow && job.status === "pending";

  return (
    <>
      <div className={styles.actionGroup}>
        {detailHref ? (
          <Link className={styles.viewButton} href={detailHref}>
            Open
          </Link>
        ) : null}
        <button
          type="button"
          className={styles.viewButton}
          onClick={() => setOpen(true)}
        >
          View
        </button>
        {canManage ? (
          <ScheduledJobButtons
            jobId={job.id}
            channel={channel}
            returnQuery={returnQuery}
            returnTo={detailHref}
            recipientCount={job.recipients.length}
            sendAction={sendScheduledEmailJob}
            cancelAction={cancelScheduledEmailJob}
          />
        ) : null}
      </div>
      <PreviewModal
        open={open}
        onClose={() => setOpen(false)}
        title={job.subject}
        subtitle={job.from_email ?? undefined}
        footer={
          <>
            {detailHref ? (
              <Link className={styles.viewButton} href={detailHref}>
                Open job
              </Link>
            ) : null}
            {canManage ? (
              <ScheduledJobButtons
                jobId={job.id}
                channel={channel}
                returnQuery={returnQuery}
                returnTo={detailHref}
                recipientCount={job.recipients.length}
                sendAction={sendScheduledEmailJob}
                cancelAction={cancelScheduledEmailJob}
              />
            ) : null}
            <button
              type="button"
              className={styles.viewButton}
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </>
        }
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
          <ScheduledJobButtons
            jobId={job.id}
            channel={channel}
            returnQuery={returnQuery}
            recipientCount={job.recipients.length}
            sendAction={sendScheduledSmsJob}
            cancelAction={cancelScheduledSmsJob}
          />
        ) : null}
      </div>
      <SmsPreviewDialog
        job={job}
        open={open}
        onClose={() => setOpen(false)}
        channel={channel}
        returnQuery={returnQuery}
        showSendNow={showSendNow}
      />
    </>
  );
}

/** Message text in the SMS table — clicking it opens the same preview. */
export function SmsMessageCell({
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

  return (
    <>
      <button
        type="button"
        className={styles.messageTrigger}
        title={job.body}
        onClick={() => setOpen(true)}
      >
        {job.body}
      </button>
      <SmsPreviewDialog
        job={job}
        open={open}
        onClose={() => setOpen(false)}
        channel={channel}
        returnQuery={returnQuery}
        showSendNow={showSendNow}
      />
    </>
  );
}
