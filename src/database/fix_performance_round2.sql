-- Additional Performance Fixes: Replace LEFT JOIN with subqueries
-- Created: April 29, 2026 - Second optimization round

-- Index for message_reads EXISTS checks (critical for unread query performance)
CREATE INDEX IF NOT EXISTS idx_message_reads_lookup ON message_reads(message_id, read_at);

-- Index for messages filtered by type (speeds up unread inbox queries)
CREATE INDEX IF NOT EXISTS idx_messages_type_unread ON messages(message_type, customer_phone, created_at DESC);

-- Composite index for shoppers phone lookups with all common fields
CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone_lookup ON store_shoppers(phone, created_at DESC, status, order_id);

-- Index for customers phone (speeds up name lookups)
CREATE INDEX IF NOT EXISTS idx_customers_phone_name ON customers(phone, name);

-- Verify
SELECT '✅ Additional performance indexes created' as result;
