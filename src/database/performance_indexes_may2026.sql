-- Additional Performance Optimization: May 2026
-- Addresses slow queries identified in production logs

-- 1. Follow-up recipients: Composite index for wa_message_id lookups with status
-- Optimizes: UPDATE follow_up_recipients SET delivered_at = ? WHERE wa_message_id = ?
CREATE INDEX IF NOT EXISTS idx_fu_recipients_wa_msg_status 
ON follow_up_recipients(wa_message_id, status);

-- 2. Abandoned carts: Phone index for webhook processing
-- Optimizes: SELECT * FROM abandoned_carts WHERE customer_phone = ? AND status IN (...) AND created_at >= ?
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_phone ON abandoned_carts(customer_phone);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_phone_status_date 
ON abandoned_carts(customer_phone, status, created_at DESC);

-- 3. Abandoned carts: Email index for webhook processing  
-- Optimizes: SELECT * FROM abandoned_carts WHERE customer_email = ? AND status IN (...) AND created_at >= ?
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_email_status_date 
ON abandoned_carts(customer_email, status, created_at DESC);

-- 4. Messages: Composite index for cleanup queries
-- Optimizes: Message queries filtered by phone and date
CREATE INDEX IF NOT EXISTS idx_messages_phone_created 
ON messages(customer_phone, created_at);

-- 5. Store shoppers: Optimize conversation lock queries
-- Optimizes: SELECT ... FROM store_shoppers WHERE phone = ? AND conversation_lock_until > ?
CREATE INDEX IF NOT EXISTS idx_shoppers_phone_lock 
ON store_shoppers(phone, conversation_lock_until);

-- 6. Support tickets: Optimize duplicate ticket check
-- Optimizes: SELECT id FROM support_tickets WHERE customer_phone = ? AND status = ?
CREATE INDEX IF NOT EXISTS idx_tickets_phone_status 
ON support_tickets(customer_phone, status);

-- 7. Follow-up recipients: Optimize campaign join queries
-- Optimizes: JOIN follow_up_campaigns c ON r.campaign_id = c.id WHERE r.phone = ?
CREATE INDEX IF NOT EXISTS idx_fu_recipients_phone_status 
ON follow_up_recipients(phone, status, response_type);

-- 8. Customers: Optimize COUNT queries with segment filters
-- Optimizes: SELECT COUNT(*) as total FROM customers WHERE created_at ...
CREATE INDEX IF NOT EXISTS idx_customers_created_at 
ON customers(created_at DESC);

-- 9. Orders: Optimize customer order lookups and MAX(order_date) aggregations
-- Optimizes: SELECT c.*, MAX(o.order_date) as last_order_at FROM customers c LEFT JOIN orders o ...
CREATE INDEX IF NOT EXISTS idx_orders_customer_date 
ON orders(customer_phone, order_date DESC);

-- 10. Orders: Optimize segment filtering by order date
-- Optimizes: WHERE phone IN (SELECT DISTINCT customer_phone FROM orders WHERE created_at >= ?)
CREATE INDEX IF NOT EXISTS idx_orders_created_at 
ON orders(created_at DESC);
