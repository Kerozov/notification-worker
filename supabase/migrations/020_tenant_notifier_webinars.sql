-- Webinars through Notifier, per client.
--
-- With the flag on, a registration for a webinar is handed to Notifier
-- (`POST /api/v1/webinars/<id>/registrants`) with the client's Notifier key:
-- Notifier then sends the reminders with the join link and records who
-- joined Zoom. Off by default — no existing client changes behaviour.
-- `notifier_webinar_id` is the webinar used when the caller names none.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notifier_webinars boolean NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notifier_webinar_id text;
