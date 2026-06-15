# Email Worker

Minimal multi-tenant dispatch service for queued email sending via **ZeptoMail**.
Each tenant site enqueues jobs through a Bearer API key; the worker stores `send_at`
in the database and **Trigger.dev** drains the queue every minute.

## Architecture

```
FunnelBrand / client sites
    │  POST /api/v1/send       (immediate)
    │  POST /api/v1/schedule   (send_at in the future)
    ▼
Email Worker (Next.js on Vercel Free)
    │  writes email_jobs (pending) in Supabase
    ▼
Trigger.dev  ──every 1 min──▶ GET /api/cron/process (Bearer CRON_SECRET)
    ▼
Worker claims due jobs ──▶ ZeptoMail batch API (track_opens=true)
    ▼
ZeptoMail webhook ──▶ POST /api/webhooks/zeptomail ──▶ email_deliveries (opened/bounced)
```

- **send_at** lives in the worker DB (source of truth, supports cancel + idempotency)
- **Trigger.dev** polls `/api/cron/process` every minute (production scheduler)
- **ZeptoMail** only sends + reports opens via webhook (no native scheduling)

## Stack

- Next.js 15 (App Router) + TypeScript
- Supabase Postgres (service role on server only)
- ZeptoMail batch API (50 recipients per request)
- Trigger.dev scheduled task (`src/trigger/process-emails.ts`)

## Setup

1. Copy env file:

```bash
cp .env.example .env.local
```

2. Run the Supabase migrations (SQL editor), in order:

```
supabase/migrations/001_init.sql
supabase/migrations/002_from_address.sql
supabase/migrations/003_email_deliveries.sql
supabase/migrations/004_zeptomail.sql
```

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

Body fields:

- `from` — sender address from the calling app, e.g. `hello@yourdomain.com` or `Brand Name <hello@yourdomain.com>` (must be a ZeptoMail-verified domain)
- If omitted, worker uses tenant `default_from` from the database (set via seed env)
- `replyTo` — optional; falls back to tenant `default_reply_to`

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

```bash
curl -X DELETE https://YOUR_WORKER/api/v1/jobs/JOB_ID \
  -H "Authorization: Bearer fb_xxx"
```

### Cron processor

Called by **Trigger.dev** in production (or manually from admin):

```bash
curl https://YOUR_WORKER/api/cron/process \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

Or use **Process queue now** in `/admin` (uses `ADMIN_SECRET`, no `CRON_SECRET` in the browser).

## Scheduling: Trigger.dev

`src/trigger/process-emails.ts` polls `/api/cron/process` every minute.
Deploy to Trigger.dev (project `proj_txagoerfovcysbewkqzq`) with:

- `WORKER_URL` — e.g. `https://notification-worker-phi.vercel.app`
- `CRON_SECRET` — same value as the worker

```bash
bun run trigger:dev      # local dev (syncs tasks to Trigger.dev)
bun run trigger:deploy   # production
```

No Vercel cron is configured — scheduling is entirely on Trigger.dev.

## Admin panel

Sign in via `/api/admin/login?secret=YOUR_ADMIN_SECRET` (sets a cookie), then open `/admin`.
Shows last queue run, 24h job counts, per-tenant activity, pending queue, recent jobs with
open counts, failed jobs, and a **Process queue now** button.

## Limits (v1)

- Max 500 recipients per job
- Max 10 jobs/minute per tenant
- Cron processes up to 20 pending jobs per run
- Idempotency: same `tenant + idempotencyKey` returns the existing job

## Project structure

```
app/api/v1/send/route.ts
app/api/v1/schedule/route.ts
app/api/v1/jobs/[id]/route.ts
app/api/cron/process/route.ts
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
src/trigger/process-emails.ts  # Trigger.dev scheduler
trigger.config.ts
scripts/seed.ts
scripts/migrate.ts
supabase/migrations/*.sql
```
