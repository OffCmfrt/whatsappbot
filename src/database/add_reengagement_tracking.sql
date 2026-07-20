-- Add re-engagement tracking to support_tickets table
-- This enables automated re-engagement messages 20 hours after ticket creation

-- Add columns if they don't exist
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reengagement_sent BOOLEAN DEFAULT 0;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reengagement_sent_at DATETIME NULL;

-- Add index for performance on re-engagement queries
CREATE INDEX IF NOT EXISTS idx_reengagement_pending ON support_tickets(reengagement_sent, status, created_at);
