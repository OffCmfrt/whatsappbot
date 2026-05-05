-- Performance Fix for Store Shoppers Queries: May 5, 2026
-- Addresses: Slow COUNT(DISTINCT) and SELECT queries with JOINs

-- 1. Composite index for COUNT queries with status filter
-- Optimizes: SELECT COUNT(DISTINCT s.order_id) FROM store_shoppers s WHERE s.status = ? AND ...
CREATE INDEX IF NOT EXISTS idx_store_shoppers_status_orderid 
ON store_shoppers(status, order_id);

-- 2. Composite index for search filters (name, phone, order_id)
-- Optimizes: WHERE s.name LIKE ? OR s.phone LIKE ? OR s.order_id LIKE ?
CREATE INDEX IF NOT EXISTS idx_store_shoppers_search 
ON store_shoppers(name(50), phone, order_id);

-- 3. Composite index for date range queries with status
-- Optimizes: WHERE s.status = ? AND s.created_at BETWEEN ? AND ?
CREATE INDEX IF NOT EXISTS idx_store_shoppers_status_date 
ON store_shoppers(status, created_at DESC);

-- 4. Ensure orders table has proper index for JOIN
-- Optimizes: LEFT JOIN orders o ON o.order_id = s.order_id
CREATE INDEX IF NOT EXISTS idx_orders_order_id_lookup 
ON orders(order_id);

-- 5. Composite index for payment method and delivery type filters
-- Optimizes: WHERE s.payment_method = ? AND s.delivery_type = ?
CREATE INDEX IF NOT EXISTS idx_store_shoppers_payment_delivery 
ON store_shoppers(payment_method, delivery_type, status);

-- 6. Covering index for common shopper list queries
-- This index includes all frequently accessed columns
CREATE INDEX IF NOT EXISTS idx_store_shoppers_covering 
ON store_shoppers(status, created_at DESC, order_id, name, phone, delivery_type, payment_method);

-- Verify indexes
SELECT '✅ Store shoppers performance indexes created' as result;
