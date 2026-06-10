-- Supabase (PostgreSQL) Schema for WhatsApp Bot
-- Migrated from Turso (SQLite)

-- Customers table
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    order_count INTEGER DEFAULT 0,
    preferred_language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

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
    tags TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    customer_phone VARCHAR(20) UNIQUE REFERENCES customers(phone),
    state VARCHAR(50),
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    message_type VARCHAR(50),
    message_content TEXT,
    status VARCHAR(50),
    wa_message_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_customer_phone ON messages(customer_phone);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Broadcasts table
CREATE TABLE IF NOT EXISTS broadcasts (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255),
    message TEXT,
    segment VARCHAR(100),
    image_url TEXT,
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

-- Support Portals table
CREATE TABLE IF NOT EXISTS support_portals (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'manual',
    config TEXT,
    max_tickets INTEGER,
    shift_start TEXT,
    shift_end TEXT,
    is_active BOOLEAN DEFAULT true,
    distribution_rule TEXT,
    assigned_count INTEGER DEFAULT 0,
    priority_level INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_portals_slug ON support_portals(slug);

-- Support Tickets table
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    ticket_number VARCHAR(50) UNIQUE,
    customer_phone VARCHAR(20) NOT NULL,
    customer_name VARCHAR(255),
    message TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'open',
    is_read BOOLEAN DEFAULT false,
    portal_id INTEGER REFERENCES support_portals(id),
    reengagement_sent BOOLEAN DEFAULT false,
    reengagement_sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_portal_id ON support_tickets(portal_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read ON support_tickets(is_read);
CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read_created ON support_tickets(is_read, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_ticket_number ON support_tickets(ticket_number);
CREATE INDEX IF NOT EXISTS idx_reengagement_pending ON support_tickets(reengagement_sent, status, created_at);

-- Returns table
CREATE TABLE IF NOT EXISTS returns (
    id SERIAL PRIMARY KEY,
    return_id VARCHAR(100) UNIQUE NOT NULL,
    order_id VARCHAR(100) REFERENCES orders(order_id),
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    items TEXT NOT NULL,
    reason VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'initiated',
    shiprocket_return_id VARCHAR(100),
    pickup_scheduled_date DATE,
    refund_amount DECIMAL(10, 2),
    refund_status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_returns_order_id ON returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_customer_phone ON returns(customer_phone);

-- Exchanges table
CREATE TABLE IF NOT EXISTS exchanges (
    id SERIAL PRIMARY KEY,
    exchange_id VARCHAR(100) UNIQUE NOT NULL,
    order_id VARCHAR(100) REFERENCES orders(order_id),
    customer_phone VARCHAR(20) REFERENCES customers(phone),
    old_items TEXT NOT NULL,
    new_items TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_exchanges_order_id ON exchanges(order_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_customer_phone ON exchanges(customer_phone);

-- Store Shoppers table (for Shopper Hub)
CREATE TABLE IF NOT EXISTS store_shoppers (
    id TEXT PRIMARY KEY,
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
    items_json TEXT,
    order_total DECIMAL(10, 2),
    delivery_type VARCHAR(20) DEFAULT 'Standard',
    source VARCHAR(50) DEFAULT 'shopify',
    status VARCHAR(50) DEFAULT 'pending',
    customer_message TEXT,
    last_response_at TIMESTAMP,
    response_count INTEGER DEFAULT 0,
    confirmed_by VARCHAR(50),
    conversation_lock_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, order_id)
);

CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone ON store_shoppers(phone);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_order_id ON store_shoppers(order_id);

-- Shopper Confirmations table (for deduplication)
CREATE TABLE IF NOT EXISTS shopper_confirmations (
    id TEXT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    order_id VARCHAR(100) NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, order_id)
);

CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_phone ON shopper_confirmations(phone);
CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_order_id ON shopper_confirmations(order_id);

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

CREATE INDEX IF NOT EXISTS idx_follow_up_campaigns_status ON follow_up_campaigns(status);

-- Follow-up recipients tracking
CREATE TABLE IF NOT EXISTS follow_up_recipients (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER REFERENCES follow_up_campaigns(id),
    shopper_id TEXT,
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

CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_campaign ON follow_up_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_status ON follow_up_recipients(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_shopper ON follow_up_recipients(shopper_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_phone ON follow_up_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_order ON follow_up_recipients(order_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_wa_msg ON follow_up_recipients(wa_message_id);

-- Message Reads table (for inbox unread tracking)
CREATE TABLE IF NOT EXISTS message_reads (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL UNIQUE,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    read_by VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id);

-- Distribution History table
CREATE TABLE IF NOT EXISTS distribution_history (
    id SERIAL PRIMARY KEY,
    distribution_type VARCHAR(100) NOT NULL,
    portal_count INTEGER,
    ticket_count INTEGER,
    filters_applied TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_distribution_history_created ON distribution_history(created_at);
CREATE INDEX IF NOT EXISTS idx_distribution_history_type ON distribution_history(distribution_type);

-- Broadcast Queue table
CREATE TABLE IF NOT EXISTS broadcast_queue (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    message TEXT,
    image_url TEXT,
    delay_seconds INTEGER DEFAULT 3,
    broadcast_id INTEGER,
    attempts INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    template_data TEXT
);

-- System Settings table
CREATE TABLE IF NOT EXISTS system_settings (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
