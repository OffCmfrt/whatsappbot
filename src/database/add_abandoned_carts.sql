-- Abandoned Carts table
CREATE TABLE IF NOT EXISTS abandoned_carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkout_id TEXT UNIQUE NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_name TEXT,
    customer_email TEXT,
    cart_items TEXT NOT NULL, -- JSON stored as TEXT
    total_amount REAL,
    currency TEXT DEFAULT 'INR',
    cart_url TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    first_reminder_sent_at DATETIME,
    second_reminder_sent_at DATETIME,
    recovered_at DATETIME,
    expired_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status ON abandoned_carts(status);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_customer_phone ON abandoned_carts(customer_phone);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_created_at ON abandoned_carts(created_at);

-- Trigger to update updated_at timestamp for abandoned_carts
CREATE TRIGGER IF NOT EXISTS update_abandoned_carts_timestamp 
AFTER UPDATE ON abandoned_carts
BEGIN
    UPDATE abandoned_carts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
