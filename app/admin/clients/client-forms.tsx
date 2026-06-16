import styles from "../admin.module.css";
import {
  createClientAction,
  rotateClientApiKeyAction,
  updateClientAction,
} from "./actions";

export function ApiKeyReveal({
  apiKey,
  workerUrl,
}: {
  apiKey: string;
  workerUrl: string;
}) {
  return (
    <section className={styles.apiKeyReveal}>
      <h2 className={styles.apiKeyRevealTitle}>Copy API key now</h2>
      <p className={styles.apiKeyRevealHint}>
        Shown once. Put it on the client site backend as{" "}
        <code>NOTIFICATION_WORKER_API_KEY</code>.
      </p>
      <div className={styles.apiKeyBox}>
        <code>{apiKey}</code>
      </div>
      <p className={styles.apiKeyRevealMeta}>
        Worker URL: <code>{workerUrl}</code>
      </p>
    </section>
  );
}

export function ClientForm({
  mode,
  slug,
  defaults,
}: {
  mode: "create" | "edit";
  slug?: string;
  defaults?: {
    name?: string;
    defaultFrom?: string | null;
    defaultReplyTo?: string | null;
    defaultSmsSender?: string | null;
    notifierConfigured?: boolean;
  };
}) {
  const action = mode === "create" ? createClientAction : updateClientAction;

  return (
    <form className={styles.clientForm} action={action}>
      {mode === "edit" && slug ? (
        <input type="hidden" name="slug" value={slug} />
      ) : null}

      <div className={styles.formGrid}>
        {mode === "create" ? (
          <label className={styles.formField}>
            <span className={styles.formLabel}>Slug</span>
            <input
              className={styles.formInput}
              name="slug"
              required
              placeholder="healthy-confident"
              pattern="[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?"
              title="Lowercase letters, numbers, hyphens"
            />
            <span className={styles.formHint}>
              URL id — e.g. healthy-confident (cannot change later)
            </span>
          </label>
        ) : (
          <div className={styles.formField}>
            <span className={styles.formLabel}>Slug</span>
            <div className={styles.formReadonly}>{slug}</div>
          </div>
        )}

        <label className={styles.formField}>
          <span className={styles.formLabel}>Display name</span>
          <input
            className={styles.formInput}
            name="name"
            required
            defaultValue={defaults?.name ?? ""}
            placeholder="Healthy and Confident"
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>Default email from</span>
          <input
            className={styles.formInput}
            name="defaultFrom"
            defaultValue={defaults?.defaultFrom ?? ""}
            placeholder='Vessie Ney <hello@example.com>'
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>Reply-To (optional)</span>
          <input
            className={styles.formInput}
            name="defaultReplyTo"
            defaultValue={defaults?.defaultReplyTo ?? ""}
            placeholder="hello@example.com"
          />
        </label>

        <label className={styles.formField}>
          <span className={styles.formLabel}>SMS sender label (optional)</span>
          <input
            className={styles.formInput}
            name="defaultSmsSender"
            defaultValue={defaults?.defaultSmsSender ?? ""}
            placeholder="Vessie"
          />
        </label>

        <label className={`${styles.formField} ${styles.formFieldWide}`}>
          <span className={styles.formLabel}>Notifier API key (optional)</span>
          <input
            className={styles.formInput}
            name="notifierApiKey"
            type="password"
            autoComplete="off"
            placeholder={
              mode === "edit" && defaults?.notifierConfigured
                ? "Leave blank to keep current key"
                : "Paste key from notifierbg.com"
            }
          />
          {mode === "edit" && defaults?.notifierConfigured ? (
            <label className={styles.formCheckbox}>
              <input type="checkbox" name="clearNotifierKey" />
              Remove Notifier key
            </label>
          ) : null}
        </label>
      </div>

      <div className={styles.formActions}>
        <button className={styles.primaryButton} type="submit">
          {mode === "create" ? "Create client" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

export function RotateApiKeyForm({ slug }: { slug: string }) {
  return (
    <form className={styles.rotateKeyForm} action={rotateClientApiKeyAction}>
      <input type="hidden" name="slug" value={slug} />
      <p className={styles.rotateKeyHint}>
        Generates a new worker API key. The old key stops working immediately.
      </p>
      <button className={styles.cancelButton} type="submit">
        Generate new API key
      </button>
    </form>
  );
}
