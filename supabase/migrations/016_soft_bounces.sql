-- Soft bounces: a temporary refusal from the recipient's server. ZeptoMail
-- keeps retrying and usually delivers, so a soft bounce no longer ends the
-- delivery. Only a hard bounce marks the row bounced.

ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS soft_bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS soft_bounce_reason text;

-- From 2026-10-22 abv.bg answered whole campaigns with soft bounces, and the
-- webhook stored every one as a final bounce (ZeptoMail that day: 238 soft,
-- 27 hard, 505 of 564 delivered). The stored text ("relaying-issues: ...")
-- cannot tell soft from hard, so an abv.bg row is put back only when the last
-- email to that address before the wave got through: the mailbox existed a
-- week earlier. Addresses whose last email before it failed stay bounced.
UPDATE email_deliveries d
SET
  status = CASE
    WHEN d.clicked_at IS NOT NULL THEN 'clicked'
    WHEN d.opened_at IS NOT NULL THEN 'opened'
    ELSE 'sent'
  END,
  soft_bounced_at = d.updated_at,
  soft_bounce_reason = d.error,
  error = NULL,
  updated_at = now()
WHERE d.status = 'bounced'
  AND d.sent_at IS NOT NULL
  AND d.recipient LIKE '%@abv.bg'
  AND d.created_at >= '2026-10-20'
  AND (
    SELECT earlier.status
    FROM email_deliveries earlier
    WHERE earlier.tenant_id = d.tenant_id
      AND earlier.recipient = d.recipient
      AND earlier.created_at < '2026-10-20'
      AND earlier.status NOT IN ('pending', 'canceled')
    ORDER BY coalesce(earlier.sent_at, earlier.created_at) DESC
    LIMIT 1
  ) IN ('sent', 'delivered', 'opened', 'clicked');
