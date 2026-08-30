# Database setup — Notification Worker

## Option A — Supabase SQL Editor (препоръчително)

1. Отвори **worker** проекта в [Supabase Dashboard](https://supabase.com/dashboard)
2. **SQL Editor** → **New query**
3. Копирай целия файл [`scripts/SETUP_DATABASE.sql`](./scripts/SETUP_DATABASE.sql)
4. **Run**

Безопасно за повторно пускане: създава/надгражда worker таблиците, не трие jobs и tenants.

---

## Ако по грешка си пуснал Zara setup в worker базата

1. Отвори **worker** проекта (не Zara)
2. Пусни [`scripts/CLEANUP_ZARA_SETUP.sql`](./scripts/CLEANUP_ZARA_SETUP.sql)
3. После пусни [`scripts/SETUP_DATABASE.sql`](./scripts/SETUP_DATABASE.sql)

Cleanup-ът маха site таблиците (`subscribers`, `automations`, кампании, Zoom, …) и bucket-ите `product-images` / `automation-attachments`. **Не пипа** `tenants`, `email_jobs`, `sms_jobs`, deliveries, `worker_meta`. Ако `tenants` липсва, скриптът спира — за да не се пусне по грешка в Zara.

---

## Ако по грешка си пуснал healthyandconfident setup в worker базата

Пусни [`scripts/CLEANUP_HC_SETUP.sql`](./scripts/CLEANUP_HC_SETUP.sql), после [`scripts/SETUP_DATABASE.sql`](./scripts/SETUP_DATABASE.sql).

---

## Option B — от терминала

1. В `.env.local` добави database password:

```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_PASSWORD=your-database-password
```

Password: Supabase → **Project Settings** → **Database** → **Database password**

2. Пусни миграциите по ред (001 → 010):

```bash
bun run db:setup
```

3. Провери:

```bash
bun run db:verify
```

---

## Supabase CI migrations

При push към `main`, когато се променят файлове в `supabase/migrations/`, GitHub Actions пуска `supabase db push` срещу production. Workflow-ът baseline-ва миграции `001`–`010` (вече приложени ръчно чрез `SETUP_DATABASE.sql`) и пуска само нови — напр. `011_ci_test.sql` и следващите.

Добави тези **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Къде да го вземеш |
|--------|-------------------|
| `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_PROJECT_ID` | Project → Settings → General → Reference ID |
| `SUPABASE_DB_PASSWORD` | Project → Settings → Database → Database password |

След като secrets са зададени, merge в `main` — първият run трябва да приложи само `011_ci_test.sql` (no-op notice). Бъдещи schema промени: добави `012_your_change.sql`, push към `main`, CI ги прилага автоматично.

**Резултати от CI:** GitHub → **Actions** → workflow **„Supabase migrations“**.

**Статистика на worker-а** (jobs, opens, queue) не е в GitHub — виж [`/admin`](/admin) след login.

---

## Какво се създава

| Таблица | За какво |
|---------|----------|
| `tenants` | Клиенти + API key hash + email/SMS defaults + Notifier key |
| `email_jobs` | Email опашка |
| `email_deliveries` | Opens, clicks, bounces, spam (ZeptoMail webhook) |
| `sms_jobs` | SMS опашка |
| `sms_deliveries` | SMS delivery per recipient |
| `worker_meta` | Last processed timestamp (admin) |

---

## След setup

**Клиенти** — от admin UI, не от seed:

```
/admin/clients → Add client
```

Или (optional) `bun run seed` ако държиш tenants в env.

---

## Вече имаш база (partial migrations)

Не пускай отделните 001–010 ако вече си минал през `scripts/SETUP_DATABASE.sql`.

Ако липсват само нови колони, пак пусни `scripts/SETUP_DATABASE.sql` — `ADD COLUMN IF NOT EXISTS` е безопасен.

Или само липсващия файл от `supabase/migrations/`:

```
010_campaign_parent.sql
```

После: `bun run db:verify`

---

## Troubleshooting

| Грешка | Решение |
|--------|---------|
| `column notifier_api_key does not exist` | Пусни SETUP_DATABASE.sql |
| `column attachments does not exist` | Пусни SETUP_DATABASE.sql |
| `column kind / parent_id does not exist` | Пусни SETUP_DATABASE.sql |
| `relation sms_jobs does not exist` | Пусни SETUP_DATABASE.sql |
| `clicked_at does not exist` | Пусни SETUP_DATABASE.sql |
| Zara таблици в worker проекта | Пусни CLEANUP_ZARA_SETUP.sql |
| HC site таблици в worker проекта | Пусни CLEANUP_HC_SETUP.sql |
| Admin crash on load | `bun run db:verify` и попълни липсващите |
