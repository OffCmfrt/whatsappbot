-- ============================================================
-- Zoho Middleware Sync Tables
-- Shopify → Zoho Books + Inventory integration
-- ============================================================

-- Sync log: tracks every Shopify order pushed to Zoho
CREATE TABLE IF NOT EXISTS zoho_sync_log (
  id SERIAL PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  zoho_invoice_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/synced/failed/retry
  transformation JSONB NOT NULL DEFAULT '{}',
  original_payload JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tax corrections applied by the middleware
CREATE TABLE IF NOT EXISTS zoho_tax_corrections (
  id SERIAL PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  original_tax JSONB,
  corrected_tax JSONB,
  correction_type TEXT,  -- rate_fix / state_fix
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Return/RTO tracking
CREATE TABLE IF NOT EXISTS zoho_returns (
  id SERIAL PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  shopify_return_id TEXT,
  zoho_credit_note_id TEXT,
  return_type TEXT,  -- return / rto / exchange
  original_items JSONB,
  corrected_items JSONB,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- COD payment reconciliation
CREATE TABLE IF NOT EXISTS zoho_cod_payments (
  id SERIAL PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  zoho_invoice_id TEXT,
  zoho_payment_id TEXT,
  amount DECIMAL(12,2),
  payment_status TEXT DEFAULT 'pending',  -- pending/reconciled/failed
  carrier TEXT,
  awb TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reconciled_at TIMESTAMPTZ
);

-- Bundle mapping config (SKU → component breakdown)
CREATE TABLE IF NOT EXISTS zoho_bundle_map (
  id SERIAL PRIMARY KEY,
  bundle_sku TEXT NOT NULL UNIQUE,
  component_sku TEXT NOT NULL,
  component_qty INT NOT NULL DEFAULT 1,
  gst_rate DECIMAL(5,2) NOT NULL DEFAULT 5.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_zoho_sync_order ON zoho_sync_log(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_zoho_sync_status ON zoho_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_zoho_sync_created ON zoho_sync_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zoho_tax_order ON zoho_tax_corrections(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_zoho_tax_type ON zoho_tax_corrections(correction_type);
CREATE INDEX IF NOT EXISTS idx_zoho_tax_created ON zoho_tax_corrections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zoho_returns_order ON zoho_returns(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_zoho_returns_status ON zoho_returns(status);
CREATE INDEX IF NOT EXISTS idx_zoho_returns_created ON zoho_returns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zoho_cod_order ON zoho_cod_payments(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_zoho_cod_status ON zoho_cod_payments(payment_status);
CREATE INDEX IF NOT EXISTS idx_zoho_cod_created ON zoho_cod_payments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zoho_bundle_sku ON zoho_bundle_map(bundle_sku);
