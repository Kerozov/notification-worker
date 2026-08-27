# Database setup — Notification Worker

## Option A — Supabase SQL Editor (препоръчително)

1. Отвори **worker** проекта в [Supabase Dashboard](https://supabase.com/dashboard)
2. **SQL Editor** → **New query**
3. Копирай целия файл [`setup-all.sql`](./setup-all.sql)
4. **Run**

Безопасно за повторно пускане: създава/надгражда worker таблиците, не трие jobs и tenants.

---

## Ако по грешка си пуснал Zara setup в worker базата

1. Отвори **worker** проекта (не Zara)
2. Пусни [`CLEANUP_ZARA_SETUP.sql`](./CLEANUP_ZARA_SETUP.sql)
3. После пусни [`setup-all.sql`](./setup-all.sql)

Cleanup-ът маха site таблиците (`subscribers`, `automations`, кампании, Zoom, …) и bucket-ите `product-images` / `automation-attachments`. **Не пипа** `tenants`, `email_jobs`, `sms_jobs`, deliveries, `worker_meta`. Ако `tenants` липсва, скриптът спира — за да не се пусне по грешка в Zara.

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

Не пускай отделните 001–010 ако вече си минал през `setup-all.sql`.

Ако липсват само нови колони, пак пусни `setup-all.sql` — `ADD COLUMN IF NOT EXISTS` е безопасен.

Или само липсващия файл от `supabase/migrations/`:

```
010_campaign_parent.sql
```

После: `bun run db:verify`

---

## Troubleshooting

| Грешка | Решение |
|--------|---------|
| `column notifier_api_key does not exist` | Пусни setup-all.sql |
| `column attachments does not exist` | Пусни setup-all.sql |
| `column kind / parent_id does not exist` | Пусни setup-all.sql |
| `relation sms_jobs does not exist` | Пусни setup-all.sql |
| `clicked_at does not exist` | Пусни setup-all.sql |
| Zara таблици в worker проекта | Пусни CLEANUP_ZARA_SETUP.sql |
| Admin crash on load | `bun run db:verify` и попълни липсващите |
