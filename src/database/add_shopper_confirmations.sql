-- Migration: Add shopper_confirmations table for deduplication
-- Tracks which order confirmations have been sent to prevent duplicates

-- For Turso (SQLite)
CREATE TABLE IF NOT EXISTS shopper_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    order_id TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, order_id)
);

CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_phone ON shopper_confirmations(phone);
CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_order_id ON shopper_confirmations(order_id);

-- For PostgreSQL (PlanetScale)
-- CREATE TABLE IF NOT EXISTS shopper_confirmations (
--     id SERIAL PRIMARY KEY,
--     phone VARCHAR(20) NOT NULL,
--     order_id VARCHAR(100) NOT NULL,
--     sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--     UNIQUE(phone, order_id)
-- );
-- 
-- CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_phone ON shopper_confirmations(phone);
-- CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_order_id ON shopper_confirmations(order_id);
