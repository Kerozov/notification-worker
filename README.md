# Email Worker

Minimal dispatch service for queued email sending via Resend. Each tenant site enqueues jobs through a Bearer API key; a single Vercel cron worker processes pending jobs.

## Stack

- Next.js 15 (App Router) + TypeScript
- Supabase Postgres (service role on server only)
- Resend batch API (50 emails per request)
- Vercel cron once daily on Hobby (see `vercel.json`; Pro uses `vercel.pro.json`)

## Setup

1. Copy env file:

```bash
cp .env.example .env.local
```

2. Run the Supabase migration:

```sql
-- supabase/migrations/001_init.sql
```

3. Install dependencies:

```bash
bun install
```

4. Seed tenants:

```bash
bun run seed
```

5. Start dev server:

```bash
bun run dev
```

## API

All tenant endpoints require:

```http
Authorization: Bearer <tenant-api-key>
Content-Type: application/json
```

Body fields:

- `from` — sender address from the calling app, e.g. `hello@yourdomain.com` or `Brand Name <hello@yourdomain.com>`
- If omitted, worker uses tenant `default_from` from the database (set via seed env)
- `replyTo` — optional; falls back to tenant `default_reply_to`

Resend still uses one worker `RESEND_API_KEY`, but each email can have a different verified `from` domain.

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
  -d '{"subject":"Test","html":"<p>Hi</p>","from":"FunnelBrand <hello@funnelbrand.com>","recipients":["you@example.com"]}'
```

Response:

```json
{
  "jobId": "uuid",
  "status": "sent",
  "sent": 1,
  "failed": 0
}
```

### Schedule for later

```bash
curl -X POST https://YOUR_WORKER/api/v1/schedule \
  -H "Authorization: Bearer fb_xxx" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Reminder","html":"<p>Tomorrow</p>","from":"FunnelBrand <hello@funnelbrand.com>","recipients":["a@b.com"],"sendAt":"2026-06-15T09:00:00.000Z","idempotencyKey":"campaign-123"}'
```

Response:

```json
{
  "jobId": "uuid",
  "status": "pending",
  "sendAt": "2026-06-15T09:00:00.000Z"
}
```

### Cancel pending job

```bash
curl -X DELETE https://YOUR_WORKER/api/v1/jobs/JOB_ID \
  -H "Authorization: Bearer fb_xxx"
```

### Cron processor

Called by Vercel cron (once daily on Hobby) or manually:

```bash
curl https://YOUR_WORKER/api/cron/process \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

Or use **Run cron now** in `/admin` (uses `ADMIN_SECRET`, no `CRON_SECRET` needed in browser).

## Vercel plans (cron)

| Plan | Cron frequency | This repo |
|------|----------------|-----------|
| **Hobby (free)** | Max once per day | `vercel.json` → `0 9 * * *` (09:00 UTC daily) |
| **Pro** | Every minute | Copy `vercel.pro.json` over `vercel.json` → `*/5 * * * *` |

Hobby cannot deploy `*/5 * * * *` — deployment will fail.

**Free-tier workflow:**

- `POST /api/v1/send` → sends immediately, no cron needed
- `POST /api/v1/schedule` → pending until cron runs
- Use admin **Run cron now** for pending jobs between daily runs
- Upgrade to Pro when you need automatic 5-minute processing

## Admin panel

Open `/admin?secret=YOUR_ADMIN_SECRET` or visit `/api/admin/login?secret=YOUR_ADMIN_SECRET` once to set the auth cookie. Shows cron status, 24h job counts, tenants, and recent failed jobs.

## Limits (v1)

- Max 500 recipients per job
- Max 10 jobs/minute per tenant
- Cron processes up to 20 pending jobs per run
- Idempotency: same `tenant + idempotencyKey` returns the existing job

## Integration (later)

FunnelBrand and custom client sites should call:

- `POST /api/v1/send` for immediate campaigns
- `POST /api/v1/schedule` for scheduled campaigns

Each site uses its own tenant API key.

## Project structure

```
app/api/v1/send/route.ts
app/api/v1/schedule/route.ts
app/api/v1/jobs/[id]/route.ts
app/api/cron/process/route.ts
app/admin/page.tsx
lib/db/supabase.ts
lib/email/send.ts
lib/auth/tenant.ts
lib/jobs/process.ts
supabase/migrations/001_init.sql
scripts/seed.ts
vercel.json
```
