-- Performance Optimization: Add Missing Indexes
-- Run this once to dramatically improve query speed and reduce Turso reads

-- Messages table indexes (high read volume)
CREATE INDEX IF NOT EXISTS idx_messages_customer_phone ON messages(customer_phone);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_wa_message_id ON messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

-- Orders table indexes
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_awb ON orders(awb);

-- Store shoppers indexes (frequently filtered)
CREATE INDEX IF NOT EXISTS idx_store_shoppers_created_at ON store_shoppers(created_at);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_status ON store_shoppers(status);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone ON store_shoppers(phone);

-- Support tickets indexes
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_portal_id ON support_tickets(portal_id);

-- Support portals index
CREATE INDEX IF NOT EXISTS idx_support_portals_slug ON support_portals(slug);

-- Broadcast queue indexes
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_status ON broadcast_queue(status);

-- Follow-up recipients indexes
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_campaign_status ON follow_up_recipients(campaign_id, status);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_messages_phone_date ON messages(customer_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_phone_date ON orders(customer_phone, created_at DESC);

-- Chat/Inbox optimization: composite indexes for filtered queries
-- These dramatically speed up the chat history, mark-read, and inbox queries
-- that filter by customer_phone AND message_type
CREATE INDEX IF NOT EXISTS idx_messages_phone_type ON messages(customer_phone, message_type);
CREATE INDEX IF NOT EXISTS idx_messages_phone_type_date ON messages(customer_phone, message_type, created_at DESC);

-- Store shoppers: composite index for phone-based lookups with ordering
CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone_created ON store_shoppers(phone, created_at DESC);

-- Messages: index on wa_message_id for status update lookups
CREATE INDEX IF NOT EXISTS idx_messages_wa_message_id ON messages(wa_message_id);

-- Abandoned carts: missing email index for lookup by email
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_customer_email ON abandoned_carts(customer_email);

-- Abandoned carts: composite for phone+status lookups in cron
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_phone_status ON abandoned_carts(customer_phone, status);

SELECT '✅ All performance indexes created successfully' as result;
