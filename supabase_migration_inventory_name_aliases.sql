-- ============================================================
-- Inventory name aliases: human-confirmed mapping between the
-- product names that appear in order items (store_shoppers.items_json)
-- and the real Shopify catalog product/variant.
--
-- Fixes SKUs showing 0 selling in the Inventory Control Tower when an
-- order item's stored name no longer matches the current catalog title
-- (product renamed, GoKwik/manual source names, etc.).
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_name_aliases (
    id BIGSERIAL PRIMARY KEY,
    raw_name TEXT NOT NULL,               -- product title as stored in order items
    raw_size TEXT DEFAULT '',             -- extracted size (extractItemSize output), may be empty
    product_id BIGINT NOT NULL,           -- Shopify catalog product id
    variant_id BIGINT NOT NULL,           -- Shopify catalog variant id
    created_by TEXT,                      -- admin who mapped it
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT inventory_name_aliases_unique UNIQUE (raw_name, raw_size)
);

CREATE INDEX IF NOT EXISTS idx_inventory_name_aliases_raw
    ON inventory_name_aliases (raw_name);
