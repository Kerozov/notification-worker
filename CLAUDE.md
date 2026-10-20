# notification-worker

@.cursor/rules/agent-rules-sync.mdc
@.cursor/rules/supabase-migrations.mdc

## Supabase grants

Всяка миграция, която създава таблица или view в public, в същия файл добавя:
- grant select, insert, update, delete on public.<име> to service_role;
- ако има serial/bigserial колона: grant usage, select on sequence <секвенцията> to service_role;
- само ако публичният сайт чете таблицата с anon ключа: grant select on public.<име> to anon, authenticated; + RLS select policy.

RLS винаги включен. Никакви insert/update/delete за anon и authenticated.
