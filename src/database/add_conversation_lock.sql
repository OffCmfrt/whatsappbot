-- Add conversation lock tracking to store_shoppers table
-- This enables the 48-hour quiet period after order confirmation template is sent

-- Add the column if it doesn't exist
ALTER TABLE store_shoppers ADD COLUMN IF NOT EXISTS conversation_lock_until TIMESTAMP NULL;

-- Add index for performance on quiet period queries
CREATE INDEX IF NOT EXISTS idx_conversation_lock ON store_shoppers(phone, conversation_lock_until);
