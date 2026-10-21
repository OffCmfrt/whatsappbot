-- Add wamid columns to track message IDs for abandoned cart reminders
-- This allows linking async delivery failures back to the cart

ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS first_reminder_wamid TEXT;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS second_reminder_wamid TEXT;

-- Index for fast lookups when processing webhook status updates
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_first_wamid ON abandoned_carts(first_reminder_wamid);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_second_wamid ON abandoned_carts(second_reminder_wamid);
