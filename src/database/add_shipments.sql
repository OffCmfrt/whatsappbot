-- Migration: Add shipments table for the Shopper Hub shipping module
-- Tracks every shipment created from the dashboard (any carrier) with a full
-- request/response audit trail.

CREATE TABLE IF NOT EXISTS shipments (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(100) NOT NULL,
    shopper_id TEXT,
    carrier VARCHAR(50) NOT NULL,
    carrier_shipment_id VARCHAR(100),
    carrier_order_id VARCHAR(100),
    awb VARCHAR(100),
    courier_name VARCHAR(100),
    status VARCHAR(50) DEFAULT 'created',
    payment_mode VARCHAR(20),
    cod_amount DECIMAL(10, 2) DEFAULT 0,
    weight_grams INTEGER,
    length_cm DECIMAL(6, 1),
    breadth_cm DECIMAL(6, 1),
    height_cm DECIMAL(6, 1),
    freight_charge DECIMAL(10, 2),
    label_url TEXT,
    manifest_url TEXT,
    invoice_url TEXT,
    pickup_date DATE,
    pickup_token VARCHAR(100),
    tracking_url TEXT,
    request_payload JSONB,
    response_payload JSONB,
    error_message TEXT,
    shipped_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_awb ON shipments(awb);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);

-- Idempotency guard: only ONE active (non-cancelled/non-failed) shipment per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_active_order
    ON shipments(order_id)
    WHERE status NOT IN ('cancelled', 'failed');
