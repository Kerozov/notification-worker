-- The caller may send links it already shortened — and counted the SMS with
-- them. Until now the worker shortened every link again at send time, so the
-- text that went out was not the text whose length was checked.
-- Default true keeps every existing caller exactly as before.
ALTER TABLE sms_jobs
  ADD COLUMN IF NOT EXISTS shorten_links boolean NOT NULL DEFAULT true;
