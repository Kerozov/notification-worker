# Database setup — Notification Worker

## Option A — Supabase SQL Editor (препоръчително)

1. Отвори [Supabase Dashboard](https://supabase.com/dashboard) → твоя проект
2. **SQL Editor** → **New query**
3. Копирай целия файл [`setup.sql`](./setup.sql)
4. **Run**

Подходящо за **нов** проект или пълен fresh start.

---

## Option B — от терминала

1. В `.env.local` добави database password:

```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_PASSWORD=your-database-password
```

Password: Supabase → **Project Settings** → **Database** → **Database password**

2. Пусни миграциите по ред (001 → 007):

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

Не пускай целия `setup.sql` — ще гърми на съществуващи таблици.

Пусни **само липсващите** файлове от `supabase/migrations/`:

```
005_delivery_metrics.sql   ← clicks, spam
006_sms.sql                ← SMS
007_tenant_notifier_key.sql
```

После: `bun run db:verify`

---

## Troubleshooting

| Грешка | Решение |
|--------|---------|
| `column notifier_api_key does not exist` | Пусни 007 или setup.sql |
| `relation sms_jobs does not exist` | Пусни 006 |
| `clicked_at does not exist` | Пусни 005 |
| Admin crash on load | `bun run db:verify` и попълни липсващите |
