-- PlanetScale Schema for WhatsApp Bot
-- MySQL-compatible version of the original PostgreSQL schema

-- Customers table
CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    preferred_language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_customers_phone (phone)
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(100) UNIQUE NOT NULL,
    customer_phone VARCHAR(20),
    shiprocket_order_id VARCHAR(100),
    awb VARCHAR(100),
    status VARCHAR(50),
    courier_name VARCHAR(100),
    product_name TEXT,
    order_date TIMESTAMP NULL,
    expected_delivery TIMESTAMP NULL,
    total DECIMAL(10, 2),
    payment_method VARCHAR(50),
    tracking_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_orders_customer_phone (customer_phone),
    INDEX idx_orders_order_id (order_id),
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_phone VARCHAR(20),
    state VARCHAR(50),
    context JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_phone VARCHAR(20),
    message_type VARCHAR(50),
    message_content TEXT,
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_messages_customer_phone (customer_phone),
    INDEX idx_messages_created_at (created_at),
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

-- Broadcasts table
CREATE TABLE IF NOT EXISTS broadcasts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255),
    message TEXT,
    segment VARCHAR(100),
    total_recipients INT,
    sent_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    created_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL
);

-- Offers table
CREATE TABLE IF NOT EXISTS offers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255),
    description TEXT,
    discount_code VARCHAR(50),
    message TEXT,
    sent_to_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL
);

-- Returns table
CREATE TABLE IF NOT EXISTS returns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    return_id VARCHAR(100) UNIQUE NOT NULL,
    order_id VARCHAR(100),
    customer_phone VARCHAR(20),
    items JSON NOT NULL,
    reason VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'initiated',
    shiprocket_return_id VARCHAR(100),
    pickup_scheduled_date DATE,
    refund_amount DECIMAL(10, 2),
    refund_status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_returns_order_id (order_id),
    INDEX idx_returns_customer_phone (customer_phone),
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);

-- Exchanges table
CREATE TABLE IF NOT EXISTS exchanges (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exchange_id VARCHAR(100) UNIQUE NOT NULL,
    order_id VARCHAR(100),
    customer_phone VARCHAR(20),
    old_items JSON NOT NULL,
    new_items JSON NOT NULL,
    reason VARCHAR(100) NOT NULL,
    price_difference DECIMAL(10, 2),
    payment_link_id VARCHAR(100),
    payment_status VARCHAR(50) DEFAULT 'pending',
    status VARCHAR(50) DEFAULT 'initiated',
    shiprocket_exchange_id VARCHAR(100),
    pickup_scheduled_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_exchanges_order_id (order_id),
    INDEX idx_exchanges_customer_phone (customer_phone),
    FOREIGN KEY (order_id) REFERENCES orders(order_id),
    FOREIGN KEY (customer_phone) REFERENCES customers(phone)
);
