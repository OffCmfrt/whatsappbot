-- Turso (SQLite) Schema for WhatsApp Bot
-- SQLite-compatible version of the original PostgreSQL schema

-- Customers table
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT,
    order_count INTEGER DEFAULT 0,
    preferred_language TEXT DEFAULT 'en',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    customer_phone TEXT,
    shiprocket_order_id TEXT,
    awb TEXT,
    status TEXT,
    courier_name TEXT,
    product_name TEXT,
    order_date DATETIME,
    expected_delivery DATETIME,
    total REAL,
    payment_method TEXT,
    tracking_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT,
    state TEXT,
    context TEXT, -- JSON stored as TEXT
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT,
    message_type TEXT,
    message_content TEXT,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

CREATE INDEX IF NOT EXISTS idx_messages_customer_phone ON messages(customer_phone);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Broadcasts table
CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    message TEXT,
    segment TEXT,
    image_url TEXT,
    total_recipients INTEGER,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

-- Offers table
CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    description TEXT,
    discount_code TEXT,
    message TEXT,
    sent_to_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
);

-- Support Portals table
CREATE TABLE IF NOT EXISTS support_portals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    type TEXT DEFAULT 'manual',
    config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_portals_slug ON support_portals(slug);

-- Support Tickets table
CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT UNIQUE,
    customer_phone TEXT NOT NULL,
    customer_name TEXT,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    is_read BOOLEAN DEFAULT 0,
    portal_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (portal_id) REFERENCES support_portals(id)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_portal_id ON support_tickets(portal_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read ON support_tickets(is_read);
CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read_created ON support_tickets(is_read, created_at DESC);

-- Returns table
CREATE TABLE IF NOT EXISTS returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id TEXT UNIQUE NOT NULL,
    order_id TEXT,
    customer_phone TEXT,
    items TEXT NOT NULL, -- JSON stored as TEXT
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'initiated',
    shiprocket_return_id TEXT,
    pickup_scheduled_date DATE,
    refund_amount REAL,
    refund_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

CREATE INDEX IF NOT EXISTS idx_returns_order_id ON returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_customer_phone ON returns(customer_phone);

-- Exchanges table
CREATE TABLE IF NOT EXISTS exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id TEXT UNIQUE NOT NULL,
    order_id TEXT,
    customer_phone TEXT,
    old_items TEXT NOT NULL, -- JSON stored as TEXT
    new_items TEXT NOT NULL, -- JSON stored as TEXT
    reason TEXT NOT NULL,
    price_difference REAL,
    payment_link_id TEXT,
    payment_status TEXT DEFAULT 'pending',
    status TEXT DEFAULT 'initiated',
    shiprocket_exchange_id TEXT,
    pickup_scheduled_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

CREATE INDEX IF NOT EXISTS idx_exchanges_order_id ON exchanges(order_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_customer_phone ON exchanges(customer_phone);

-- Store Shoppers table (for Shopper Hub)
CREATE TABLE IF NOT EXISTS store_shoppers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    name TEXT,
    email TEXT,
    order_id TEXT NOT NULL,
    address TEXT,
    city TEXT,
    province TEXT,
    zip TEXT,
    country TEXT,
    payment_method TEXT,
    items_json TEXT, -- JSON stored as TEXT
    order_total REAL,
    delivery_type TEXT DEFAULT 'Standard',
    source TEXT DEFAULT 'shopify',
    status TEXT DEFAULT 'pending',
    customer_message TEXT,
    last_response_at DATETIME,
    confirmed_by TEXT,
    conversation_lock_until DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, order_id)
);

CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone ON store_shoppers(phone);
CREATE INDEX IF NOT EXISTS idx_store_shoppers_order_id ON store_shoppers(order_id);

-- Shopper Confirmations table (for deduplication)
CREATE TABLE IF NOT EXISTS shopper_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    order_id TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, order_id)
);

CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_phone ON shopper_confirmations(phone);
CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_order_id ON shopper_confirmations(order_id);

-- Trigger to update updated_at timestamp for customers
CREATE TRIGGER IF NOT EXISTS update_customers_timestamp 
AFTER UPDATE ON customers
BEGIN
    UPDATE customers SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Trigger to update updated_at timestamp for orders
CREATE TRIGGER IF NOT EXISTS update_orders_timestamp 
AFTER UPDATE ON orders
BEGIN
    UPDATE orders SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Trigger to update updated_at timestamp for conversations
CREATE TRIGGER IF NOT EXISTS update_conversations_timestamp 
AFTER UPDATE ON conversations
BEGIN
    UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Trigger to update updated_at timestamp for returns
CREATE TRIGGER IF NOT EXISTS update_returns_timestamp 
AFTER UPDATE ON returns
BEGIN
    UPDATE returns SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Trigger to update updated_at timestamp for exchanges
CREATE TRIGGER IF NOT EXISTS update_exchanges_timestamp 
AFTER UPDATE ON exchanges
BEGIN
    UPDATE exchanges SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Trigger to update updated_at timestamp for store_shoppers
CREATE TRIGGER IF NOT EXISTS update_store_shoppers_timestamp 
AFTER UPDATE ON store_shoppers
BEGIN
    UPDATE store_shoppers SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ============================================
-- Follow-Up System Tables
-- ============================================

-- Follow-up campaigns table
CREATE TABLE IF NOT EXISTS follow_up_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    template_name TEXT NOT NULL,
    message_content TEXT,
    status TEXT DEFAULT 'draft', -- draft, scheduled, running, completed, paused
    total_recipients INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    read_count INTEGER DEFAULT 0,
    responded_count INTEGER DEFAULT 0,
    confirmed_count INTEGER DEFAULT 0,
    cancelled_count INTEGER DEFAULT 0,
    edit_requested_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    scheduled_at DATETIME,
    started_at DATETIME,
    completed_at DATETIME,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Follow-up recipients tracking
CREATE TABLE IF NOT EXISTS follow_up_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER,
    shopper_id INTEGER,
    phone TEXT NOT NULL,
    order_id TEXT,
    status TEXT DEFAULT 'pending', -- pending, sent, delivered, read, responded, failed
    response_type TEXT, -- confirmed, cancelled, edit_details
    wa_message_id TEXT,
    sent_at DATETIME,
    delivered_at DATETIME,
    read_at DATETIME,
    responded_at DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES follow_up_campaigns(id),
    FOREIGN KEY (shopper_id) REFERENCES store_shoppers(id)
);

-- Indexes for follow-up tables
CREATE INDEX IF NOT EXISTS idx_follow_up_campaigns_status ON follow_up_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_campaign ON follow_up_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_status ON follow_up_recipients(status);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_shopper ON follow_up_recipients(shopper_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_phone ON follow_up_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_order ON follow_up_recipients(order_id);

-- Trigger to update updated_at timestamp for follow_up_campaigns
CREATE TRIGGER IF NOT EXISTS update_follow_up_campaigns_timestamp 
AFTER UPDATE ON follow_up_campaigns
BEGIN
    UPDATE follow_up_campaigns SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
