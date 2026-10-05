-- A tenant that may send SMS on behalf of other tenants (the platform).
--
-- The platform holds one API key, but each of its clients has their own
-- profile here (their Notifier key, their sender name). With this flag the
-- platform names the client in `X-Act-As-Tenant` and the job runs under that
-- client's profile. Off by default: no existing key gains anything.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS can_act_for_tenants boolean NOT NULL DEFAULT false;
