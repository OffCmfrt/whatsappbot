-- Prevent Future Duplicate Orders in Shoppers Hub
-- This script adds additional constraints and indexes to prevent duplicates

-- Add a UNIQUE index on order_id alone (since each order should only appear once in shoppers hub)
-- Note: The existing UNIQUE(phone, order_id) constraint allows the same order_id with different phones
-- This new constraint ensures each order_id appears only once
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_shoppers_order_id_unique ON store_shoppers(order_id);

-- Verify the constraint is working
-- Run this query to check for any remaining duplicates:
-- SELECT order_id, COUNT(*) as count FROM store_shoppers GROUP BY order_id HAVING COUNT(*) > 1;
