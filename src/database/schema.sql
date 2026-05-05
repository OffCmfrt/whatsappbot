-- Customers table
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    preferred_language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(100) UNIQUE NOT NULL,
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    shiprocket_order_id VARCHAR(100),
    awb VARCHAR(100),
    status VARCHAR(50),
    courier_name VARCHAR(100),
    product_name TEXT,
    order_date TIMESTAMP,
    expected_delivery TIMESTAMP,
    total DECIMAL(10, 2),
    payment_method VARCHAR(50),
    tracking_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Conversations table (for tracking multi-step interactions)
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    state VARCHAR(50),
    context JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table (for tracking all sent messages)
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    message_type VARCHAR(50), -- 'incoming', 'outgoing', 'broadcast', 'offer'
    message_content TEXT,
    status VARCHAR(50), -- 'sent', 'delivered', 'read', 'failed'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Broadcasts table (for tracking broadcast campaigns)
CREATE TABLE IF NOT EXISTS broadcasts (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255),
    message TEXT,
    segment VARCHAR(100), -- 'all', 'pending_orders', 'delivered', etc.
    total_recipients INTEGER,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- Offers table
CREATE TABLE IF NOT EXISTS offers (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255),
    description TEXT,
    discount_code VARCHAR(50),
    message TEXT,
    sent_to_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

-- Returns table
CREATE TABLE IF NOT EXISTS returns (
    id SERIAL PRIMARY KEY,
    return_id VARCHAR(100) UNIQUE NOT NULL,
    order_id VARCHAR(100) REFERENCES orders(order_id),
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    items JSONB NOT NULL,
    reason VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'initiated',
    shiprocket_return_id VARCHAR(100),
    pickup_scheduled_date DATE,
    refund_amount DECIMAL(10, 2),
    refund_status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Exchanges table
CREATE TABLE IF NOT EXISTS exchanges (
    id SERIAL PRIMARY KEY,
    exchange_id VARCHAR(100) UNIQUE NOT NULL,
    order_id VARCHAR(100) REFERENCES orders(order_id),
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    old_items JSONB NOT NULL,
    new_items JSONB NOT NULL,
    reason VARCHAR(100) NOT NULL,
    price_difference DECIMAL(10, 2),
    payment_link_id VARCHAR(100),
    payment_status VARCHAR(50) DEFAULT 'pending',
    status VARCHAR(50) DEFAULT 'initiated',
    shiprocket_exchange_id VARCHAR(100),
    pickup_scheduled_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Store Shoppers table (for Shopper Hub)
CREATE TABLE IF NOT EXISTS store_shoppers (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    order_id VARCHAR(100) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    province VARCHAR(100),
    zip VARCHAR(20),
    country VARCHAR(100),
    payment_method VARCHAR(50),
    items_json JSONB,
    order_total DECIMAL(10, 2),
    delivery_type VARCHAR(20) DEFAULT 'Standard',
    source VARCHAR(50) DEFAULT 'shopify',
    status VARCHAR(50) DEFAULT 'pending',
    customer_message TEXT,
    last_response_at TIMESTAMP,
    conversation_lock_until TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, order_id)
);

-- Shopper Confirmations table (for deduplication)
CREATE TABLE IF NOT EXISTS shopper_confirmations (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    order_id VARCHAR(100) NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, order_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
CREATE INDEX IF NOT EXISTS idx_messages_customer_phone ON messages(customer_phone);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_returns_order_id ON returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_customer_phone ON returns(customer_phone);
CREATE INDEX IF NOT EXISTS idx_exchanges_order_id ON exchanges(order_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_customer_phone ON exchanges(customer_phone);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone ON store_shoppers(phone);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_order_id ON store_shoppers(order_id);
CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_phone ON shopper_confirmations(phone);
CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_order_id ON shopper_confirmations(order_id);

-- ============================================
-- Follow-Up System Tables
-- ============================================

-- Follow-up campaigns table
CREATE TABLE IF NOT EXISTS follow_up_campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    message_content TEXT,
    status VARCHAR(50) DEFAULT 'draft',
    total_recipients INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    read_count INTEGER DEFAULT 0,
    responded_count INTEGER DEFAULT 0,
    confirmed_count INTEGER DEFAULT 0,
    cancelled_count INTEGER DEFAULT 0,
    edit_requested_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    scheduled_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Follow-up recipients tracking
CREATE TABLE IF NOT EXISTS follow_up_recipients (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER REFERENCES follow_up_campaigns(id),
    shopper_id INTEGER REFERENCES store_shoppers(id),
    phone VARCHAR(20) NOT NULL,
    order_id VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending',
    response_type VARCHAR(50),
    wa_message_id VARCHAR(100),
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    responded_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for follow-up tables
CREATE INDEX IF NOT EXISTS idx_follow_up_campaigns_status ON follow_up_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_campaign ON follow_up_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_status ON follow_up_recipients(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_shopper ON follow_up_recipients(shopper_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_phone ON follow_up_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_order ON follow_up_recipients(order_id);
