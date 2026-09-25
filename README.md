# Email Worker

Minimal multi-tenant dispatch service for queued email sending via **ZeptoMail**.
Each tenant site enqueues jobs through a Bearer API key; the worker stores `send_at`
in the database; **Trigger.dev** fires one run per scheduled job at `send_at`.

## Architecture

```
FunnelBrand / client sites
    │  POST /api/v1/send       (immediate — worker sends now, no Trigger)
    │  POST /api/v1/schedule   (send_at in the future)
    ▼
Notification Worker (Next.js on Vercel)
    │  writes email_jobs (pending) in Supabase
    │  schedule → Trigger.dev task delayed until send_at
    ▼
Trigger.dev  ──at send_at──▶ POST /api/internal/process/email/{id}
    ▼
Worker sends ──▶ ZeptoMail batch API
    ▼
ZeptoMail webhook ──▶ POST /api/webhooks/zeptomail ──▶ email_deliveries
```

- **Immediate send** (`/send`, `/sms/send`) — processed in the worker on the request, no Trigger.dev
- **Scheduled send** (`/schedule`) — one Trigger.dev run per job at `send_at`

## Stack

- Next.js 15 (App Router) + TypeScript
- Supabase Postgres (service role on server only)
- ZeptoMail batch API (50 recipients per request)
- Trigger.dev tasks (`src/trigger/send-email-job.ts`, `send-sms-job.ts`)

## Setup

1. Copy env file:

```bash
cp .env.example .env.local
```

2. Run the Supabase setup (SQL editor) — see [`supabase/SETUP.md`](supabase/SETUP.md):

```
supabase/scripts/SETUP_DATABASE.sql
```

For incremental schema changes after CI is enabled, add numbered files under `supabase/migrations/` (e.g. `012_your_change.sql`).

3. Install dependencies and seed tenants:

```bash
bun install
bun run seed
```

4. Start dev server:

```bash
bun run dev
```

## ZeptoMail setup

1. Create an **Agent** in ZeptoMail and verify your sending domain (DKIM/SPF).
2. Copy the **Send Mail Token** → `ZEPTOMAIL_API_KEY` (value after `Zoho-enczapikey `, or the whole token — the worker sends it as `Zoho-enczapikey <token>`).
3. Add a **Webhook** on the Agent:
   - URL: `https://YOUR_WORKER/api/webhooks/zeptomail?key=YOUR_WEBHOOK_SECRET`
   - Events: **Open**, **Hard bounce**, **Soft bounce**, **Delivered**
   - Set `ZEPTOMAIL_WEBHOOK_SECRET` to the same `YOUR_WEBHOOK_SECRET` value.

The worker correlates webhook events to recipients via `client_reference` (the job id)
plus the recipient address — no per-recipient provider id needed.

## API

All tenant endpoints require:

```http
Authorization: Bearer <tenant-api-key>
Content-Type: application/json
```

- `recipients` — array of addresses, max 50,000. The worker stores the full list on a **campaign** job (the admin view), then splits it into send jobs of 250. Do not fan out one job per person. Automations stay one job per person.
- `merge` — optional map of email → `{ key: value }` used as ZeptoMail merge fields (`{{name}}`, `{{unsubscribe_url}}`, …)

- `from` — sender address from the calling app, e.g. `hello@yourdomain.com` or `Brand Name <hello@yourdomain.com>` (must be a ZeptoMail-verified domain)
- If omitted, worker uses tenant `default_from` from the database (set via seed env)
- `replyTo` — optional; falls back to tenant `default_reply_to`
- `attachments` — optional, max 5. Each item is `{ filename, url, contentType }` with an **https** URL. The worker stores them on the job and fetches the files at send time (needed for scheduled mail). Max 8MB per file.

One worker `ZEPTOMAIL_API_KEY` sends for all tenants; each email can use a different verified `from` domain.

### Add a new app (no worker code changes)

1. Add env vars (local + Vercel):

```env
TENANT_CLIENT_B_KEY=cb_xxxxxxxx
TENANT_CLIENT_B_NAME=Client B
TENANT_CLIENT_B_FROM=Client B <mail@client-b.com>
TENANT_CLIENT_B_REPLY_TO=hello@client-b.com
```

2. Run `bun run seed`
3. Give `TENANT_CLIENT_B_KEY` value to the new app (FunnelBrand env, site env, etc.)
4. The app sends `from` in each API call from its own settings — worker code stays unchanged

Optional `TENANT_*_FROM` is only a fallback when the app omits `from` in the request.

### Send immediately

```bash
curl -X POST https://YOUR_WORKER/api/v1/send \
  -H "Authorization: Bearer fb_xxx" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Test","html":"<p>Hi</p>","from":"FunnelBrand <hello@funnel-brand.com>","recipients":["you@example.com"]}'
```

Response:

```json
{ "jobId": "uuid", "status": "sent", "sent": 1, "failed": 0 }
```

### Schedule for later

```bash
curl -X POST https://YOUR_WORKER/api/v1/schedule \
  -H "Authorization: Bearer fb_xxx" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Reminder","html":"<p>Tomorrow</p>","from":"FunnelBrand <hello@funnel-brand.com>","recipients":["a@b.com"],"sendAt":"2026-06-15T09:00:00.000Z","idempotencyKey":"campaign-123"}'
```

Response:

```json
{ "jobId": "uuid", "status": "pending", "sendAt": "2026-06-15T09:00:00.000Z" }
```

### Job status + open tracking

```bash
curl https://YOUR_WORKER/api/v1/jobs/JOB_ID \
  -H "Authorization: Bearer fb_xxx"
```

Response includes a `tracking` summary: `opened`, `notOpened`, `sent`, `failed`.
A campaign job also returns `kind: "campaign"` and `jobs` — the 250-recipient send pockets. Tracking is the union of those pockets.

Per-recipient details:

```bash
curl "https://YOUR_WORKER/api/v1/jobs/JOB_ID?recipients=true" \
  -H "Authorization: Bearer fb_xxx"
```

Only emails not opened yet:

```bash
curl "https://YOUR_WORKER/api/v1/jobs/JOB_ID?notOpened=true" \
  -H "Authorization: Bearer fb_xxx"
```

Returns `notOpenedEmails: ["a@b.com", ...]` plus the `tracking` summary.

### Cancel pending job

Cancel a pending send job, or a campaign (remaining pending pockets stop; already-sent mail is left alone).

```bash
curl -X DELETE https://YOUR_WORKER/api/v1/jobs/JOB_ID \
  -H "Authorization: Bearer fb_xxx"
```

### Cancel many pending jobs (signup / unsubscribe)

Cancel by job id and/or the idempotency key used when the job was scheduled (`platform-auto-{automationId}-{email}`). Pending rows become `canceled`; already-sending jobs are left alone.

```bash
curl -X POST https://YOUR_WORKER/api/v1/jobs/cancel \
  -H "Authorization: Bearer fb_xxx" \
  -H "Content-Type: application/json" \
  -d '{"jobIds":["JOB_ID"],"idempotencyKeys":["platform-auto-AUTO_ID-user@example.com"]}'
```

### Change the text of scheduled jobs (automation edited)

Rewrites `subject` and `html` of jobs that are still `pending`. Recipients, sender and `sendAt` are not accepted — a content edit cannot move or re-address a scheduled email. Up to 100 jobs per call.

The update is guarded by `status = 'pending'` in the same statement as the claim, so each job either takes the new text or has already started with the old one. Only standalone send jobs: a campaign parent and its pockets answer `not_editable`.

```bash
curl -X POST https://YOUR_WORKER/api/v1/jobs/update \
  -H "Authorization: Bearer fb_xxx" \
  -H "Content-Type: application/json" \
  -d '{"jobs":[{"jobId":"JOB_ID","subject":"New subject","html":"<p>New text</p>"}]}'
```

Response — always 200, one outcome per job:

```json
{
  "updated": 1,
  "results": [
    { "jobId": "JOB_ID", "outcome": "updated" },
    { "jobId": "OTHER", "outcome": "not_pending", "status": "sent" }
  ]
}
```

Outcomes: `updated`, `not_pending` (claimed / sent / failed / canceled — it goes, or went, with the old text), `not_editable` (campaign), `not_found`, `error` (that row only).

### Internal process (Trigger.dev only)

When a scheduled job fires, Trigger.dev calls:

```bash
curl -X POST https://YOUR_WORKER/api/internal/process/email/JOB_ID \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

## Scheduling: Trigger.dev

Per scheduled job, the worker calls Trigger.dev with `delay: sendAt`.
At that time Trigger hits `POST /api/internal/process/email/{id}` (or `/sms/{id}`).

**Vercel env:** `TRIGGER_SECRET_KEY` is required for delayed `/schedule`, `/sms/schedule`, and `/jobs/batch`. Without it the worker returns **503** instead of pretending the job is queued.

**Trigger.dev project env:**

- `WORKER_URL` — e.g. `https://notification-worker-phi.vercel.app`
- `CRON_SECRET` — same value as the worker

```bash
bun run trigger:dev      # local dev (syncs tasks to Trigger.dev)
bun run trigger:deploy   # production — redeploy after task changes
```

Disable or delete any old Trigger.dev scheduled tasks (e.g. `process-emails`, `process-queue-backup`) in the dashboard so runs are only per-job.

## Admin panel

Sign in via `/api/admin/login?secret=YOUR_ADMIN_SECRET` (sets a cookie), then open `/admin`.
Shows last processed send, 24h job counts, per-tenant activity, pending queue, recent jobs with
open counts, failed jobs, and cancel for pending scheduled jobs.

Worker stats live in the admin panel — not in GitHub Actions.

## Supabase CI migrations

On push to `main`, when files under `supabase/migrations/` change, GitHub Actions runs
`supabase db push` against production. The workflow baselines migrations `001`–`010`
(already applied manually via `SETUP_DATABASE.sql`) and only runs new ones such as
`011_ci_test.sql` and anything after.

Add these **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Where to get it |
|--------|-----------------|
| `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_PROJECT_ID` | Project → Settings → General → Reference ID |
| `SUPABASE_DB_PASSWORD` | Project → Settings → Database → Database password |

After the secrets are set, merge to `main` — the first run should apply only
`011_ci_test.sql` (a no-op notice). Future schema changes: add `012_your_change.sql`,
push to `main`, CI applies it automatically.

**CI results:** GitHub → **Actions** → workflow **„Supabase migrations“**.

Details: [`supabase/SETUP.md`](supabase/SETUP.md).

## Limits (v1)

- Max 50,000 recipients per HTTP request. The worker keeps that list on a parent campaign job and sends in pockets of 250 (ZeptoMail is batched 50/request).
- Admin lists the campaign. Open / expand it to cancel the campaign, one pocket, or one address, and to resend failures.
- Max 500 jobs/minute per tenant (override with `MAX_JOBS_PER_MINUTE`)
- Idempotency: same `tenant + idempotencyKey` returns the existing job
- Optional `merge`: `{ "person@x.com": { "name": "Ivan", "unsubscribe_url": "https://…" } }` for ZeptoMail `{{name}}` tags in subject/html
- `POST /api/v1/jobs/:id/recipients/remove` drops addresses from a pending job (unsubscribe)

## Project structure

```
app/api/v1/send/route.ts
app/api/v1/schedule/route.ts
app/api/v1/jobs/[id]/route.ts
app/api/internal/process/email/[id]/route.ts
app/api/internal/process/sms/[id]/route.ts
app/api/webhooks/zeptomail/route.ts
app/api/admin/login/route.ts
app/admin/page.tsx
lib/db/supabase.ts
lib/email/send.ts          # ZeptoMail batch adapter
lib/deliveries/store.ts    # per-recipient open/bounce tracking
lib/auth/tenant.ts
lib/auth/admin.ts
lib/jobs/process.ts
lib/jobs/query.ts
lib/rate-limit/tenant.ts
lib/validation/email-job.ts
src/trigger/send-email-job.ts
src/trigger/send-sms-job.ts
trigger.config.ts
scripts/seed.ts
scripts/migrate.ts
supabase/scripts/SETUP_DATABASE.sql
supabase/migrations/*.sql
```
