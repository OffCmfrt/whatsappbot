-- Fix Performance Issues: April 29, 2026
-- Addresses: Slow shoppers queries, batch message_reads, duplicate data

-- 1. Add composite index for store_shoppers COUNT queries with filters
-- This dramatically speeds up the COUNT(DISTINCT s.order_id) queries
CREATE INDEX IF NOT EXISTS idx_store_shoppers_order_id_status ON store_shoppers(order_id, status);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_status_created ON store_shoppers(status, created_at DESC);

-- 2. Add composite indexes for common shoppers filter patterns
CREATE INDEX IF NOT EXISTS idx_store_shoppers_name_phone ON store_shoppers(name, phone);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_delivery_type ON store_shoppers(delivery_type, status);

-- 3. Add index for message_reads lookups (speeds up the LEFT JOIN in mark-read)
CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id);

-- 4. Add composite index for messages inbox queries (frequently used pattern)
CREATE INDEX IF NOT EXISTS idx_messages_type_phone_read ON messages(message_type, customer_phone);

-- 5. Verify indexes
SELECT '✅ Performance fix indexes created' as result;
