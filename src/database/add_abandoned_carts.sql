-- Abandoned Carts table (PostgreSQL/Supabase)
CREATE TABLE IF NOT EXISTS abandoned_carts (
    id SERIAL PRIMARY KEY,
    checkout_id TEXT UNIQUE NOT NULL,
    customer_phone VARCHAR(20) NOT NULL,
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    cart_items TEXT NOT NULL,
    total_amount DECIMAL(10,2),
    currency VARCHAR(10) DEFAULT 'INR',
    cart_url TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    first_reminder_sent_at TIMESTAMP,
    second_reminder_sent_at TIMESTAMP,
    recovered_at TIMESTAMP,
    expired_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status ON abandoned_carts(status);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_customer_phone ON abandoned_carts(customer_phone);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_customer_email ON abandoned_carts(customer_email);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_created_at ON abandoned_carts(created_at);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status_created ON abandoned_carts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_checkout_id ON abandoned_carts(checkout_id);

-- Trigger to update updated_at timestamp for abandoned_carts
CREATE OR REPLACE FUNCTION update_abandoned_carts_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_abandoned_carts_timestamp
BEFORE UPDATE ON abandoned_carts
FOR EACH ROW
EXECUTE FUNCTION update_abandoned_carts_timestamp();
