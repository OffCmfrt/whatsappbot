-- GoKwik integration fields for store_shoppers
-- Run via: node migrate_gokwik.js

ALTER TABLE store_shoppers ADD COLUMN IF NOT EXISTS gokwik_order_id TEXT;
ALTER TABLE store_shoppers ADD COLUMN IF NOT EXISTS rto_risk VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_store_shoppers_gokwik_order_id ON store_shoppers(gokwik_order_id);
