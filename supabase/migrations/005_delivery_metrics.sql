-- Click + spam complaint (feedback loop) tracking

ALTER TABLE email_deliveries
  DROP CONSTRAINT IF EXISTS email_deliveries_status_check;

ALTER TABLE email_deliveries
  ADD CONSTRAINT email_deliveries_status_check
  CHECK (status IN (
    'pending', 'sent', 'failed', 'delivered', 'opened',
    'clicked', 'bounced', 'complained'
  ));

ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_url text,
  ADD COLUMN IF NOT EXISTS complained_at timestamptz;

CREATE INDEX IF NOT EXISTS email_deliveries_complained_at_idx
  ON email_deliveries (complained_at)
  WHERE complained_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_deliveries_clicked_at_idx
  ON email_deliveries (clicked_at)
  WHERE clicked_at IS NOT NULL;
