const { Pool } = require('pg');
require('dotenv').config();

// Supabase PostgreSQL connection via session pooler
const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 3, // Keep at 3 for concurrent DB operations
  min: 0, // Allow all connections to close when idle (saves ~10MB native)
  idleTimeoutMillis: 10000, // Close idle connections after 10s (was 20s)
  connectionTimeoutMillis: 5000 // Fail fast if no connection available
});

// CRITICAL: handle background errors from idle pooled connections.
// Supabase's pooler drops idle/half-open connections routinely; without this
// listener pg emits 'error' on the pool with no handler → uncaught exception
// → process crash (giant Client dump in logs followed by restart).
pool.on('error', (err) => {
  console.error('⚠️ pg pool: idle client error (connection reset by pooler):', err.message);
});

// CRITICAL FIX: pg Pool does NOT have endIdleClients() — implement it manually
// This drains idle connections to free native TLS buffers (~5-10MB per idle connection)
// Without this, native memory grows unbounded and causes OOM at 512MB
// pg-pool v3 stores IdleItem wrappers ({ client, idleListener, timeoutId }) in
// this._idle — we must unwrap the client and use pool._remove() so the pool's
// bookkeeping (_clients, idle timers, listeners) stays consistent. Calling
// .end() on the wrapper itself silently no-ops and leaks/orphans connections.
pool.endIdleClients = function() {
  let closed = 0;
  while (this._idle && this._idle.length > 0) {
    const item = this._idle[this._idle.length - 1];
    const client = item && item.client ? item.client : item;
    try {
      if (typeof this._remove === 'function') {
        // Proper path: clears idle timer, detaches listeners,
        // removes from _clients, and ends the connection
        this._remove(client);
      } else {
        this._idle.pop();
        if (item && item.timeoutId) clearTimeout(item.timeoutId);
        client.end();
      }
      closed++;
    } catch (e) {
      // Ensure we always make progress even if removal throws
      if (this._idle[this._idle.length - 1] === item) this._idle.pop();
    }
  }
  return closed;
};

console.log(`📊 Supabase DB URL: ${process.env.SUPABASE_DB_URL ? 'Configured' : 'MISSING'}`);
console.log('📊 Using Supabase (PostgreSQL)');

// Helper function to get current UTC timestamp in ISO format
function getUTCTimestamp() {
  return new Date().toISOString();
}

module.exports.getUTCTimestamp = getUTCTimestamp;

// Convert ? placeholders to $1, $2, $3... for PostgreSQL
function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

// Universal database adapter (Now Supabase/PostgreSQL)
class DatabaseAdapter {
  constructor() {}

  getDB(table) {
    return 'SUPABASE';
  }

  // Execute a raw SQL query
  async query(sql, params = []) {
    const start = Date.now();
    const pgSql = convertPlaceholders(sql);
    const values = params.map(v => v === undefined ? null : v);
    const result = await pool.query(pgSql, values);
    const duration = Date.now() - start;
    
    // Log slow queries (>100ms)
    if (duration > 100) {
      console.warn(`⚠️ SLOW QUERY (${duration}ms): ${sql.substring(0, 100)}`);
    }
    
    return result.rows;
  }

  // Execute a raw SQL statement (INSERT, UPDATE, DELETE) and return metadata
  async run(sql, params = []) {
    const pgSql = convertPlaceholders(sql);
    const values = params.map(v => v === undefined ? null : v);
    // Postgres only exposes the inserted id via RETURNING — append it for
    // INSERTs so callers relying on lastInsertRowid (status updates,
    // idempotency flags) actually get the row id
    const trimmed = pgSql.trim();
    const needsReturning = /^INSERT/i.test(trimmed) && !/RETURNING/i.test(trimmed);
    let result;
    try {
      result = await pool.query(needsReturning ? `${trimmed} RETURNING id` : pgSql, values);
    } catch (err) {
      // Table has no `id` column — retry the INSERT without RETURNING
      if (needsReturning && /column "id" does not exist/i.test(err.message)) {
        result = await pool.query(pgSql, values);
      } else {
        throw err;
      }
    }
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows?.[0]?.id || null
    };
  }

  // Insert data
  async insert(table, data) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => v === undefined ? null : v);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await pool.query(sql, values);
    return result.rows[0] || { ...data };
  }

  // Select data
  async select(table, where = {}, options = {}) {
    let sql = `SELECT * FROM ${table}`;
    const params = [];
    let paramIndex = 1;

    if (Object.keys(where).length > 0) {
      const conditions = Object.keys(where).map(key => `${key} = $${paramIndex++}`).join(' AND ');
      sql += ` WHERE ${conditions}`;
      params.push(...Object.values(where).map(v => v === undefined ? null : v));
    }

    if (options.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }

    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const result = await pool.query(sql, params);
    return result.rows;
  }

  // Update data
  async update(table, data, where) {
    let paramIndex = 1;
    const setClause = Object.keys(data).map(key => `${key} = $${paramIndex++}`).join(', ');
    const whereClause = Object.keys(where).map(key => `${key} = $${paramIndex++}`).join(' AND ');
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const params = [
      ...Object.values(data).map(v => v === undefined ? null : v), 
      ...Object.values(where).map(v => v === undefined ? null : v)
    ];
    await pool.query(sql, params);
    return { success: true };
  }

  // Delete data
  async delete(table, where) {
    let paramIndex = 1;
    const whereClause = Object.keys(where).map(key => `${key} = $${paramIndex++}`).join(' AND ');
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
    const params = Object.values(where).map(v => v === undefined ? null : v);
    await pool.query(sql, params);
    return { success: true };
  }
}

// Test database connection
async function testConnection() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ Supabase PostgreSQL connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

// Helper: Add column if it doesn't exist (PostgreSQL)
async function addColumnIfNotExists(table, column, type) {
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE ${table} ADD COLUMN ${column} ${type};
      EXCEPTION WHEN duplicate_column THEN
        NULL;
      END $$;
    `);
  } catch (e) {
    // Ignore errors
  }
}

// Initialize database tables
async function initializeDatabase() {
  try {
    // Add order_count to customers if missing
    await addColumnIfNotExists('customers', 'order_count', 'INTEGER DEFAULT 0');

    // Add wa_message_id column to messages table
    await addColumnIfNotExists('messages', 'wa_message_id', 'TEXT');

    // Add tags column to orders table
    await addColumnIfNotExists('orders', 'tags', 'TEXT');

    // Add updated_at column to support_tickets table
    await addColumnIfNotExists('support_tickets', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    // Backfill existing rows
    await pool.query('UPDATE support_tickets SET updated_at = created_at WHERE updated_at IS NULL');

    // Initialize Shoppers Table
    await initializeShoppersTable();
    
    // Initialize Shopper Confirmations Table
    await initializeShopperConfirmationsTable();
    
    // Initialize Follow-Up Campaigns Tables
    await initializeFollowUpTables();
    
    // Initialize Message Reads Table
    await initializeMessageReadsTable();

    // Initialize Support Portals Table
    await initializeSupportPortalsTable();
    
    // Initialize Abandoned Carts Table
    await initializeAbandonedCartsTable();
    
    // Initialize Shipments Table (Shopper Hub shipping module)
    await initializeShipmentsTable();
    
    // Initialize Hub Operators Table (smart login: operator accounts + permissions)
    await initializeHubOperatorsTable();
    
    // Initialize AI Copilot Tables (pending actions, chat history, usage log)
    await initializeAiTables();
    
    // Initialize Performance Indexes
    await initializePerformanceIndexes();
    
    // Initialize Zoho Sync Tables
    try {
        const { initializeZohoTables } = require('../services/zohoService');
        await initializeZohoTables();
    } catch (e) {
        console.warn('⚠️ Zoho tables init skipped:', e.message);
    }
    
    console.log('ℹ️ Supabase database initialized');
    return true;
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    return false;
  }
}

async function initializeShoppersTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_shoppers (
        id TEXT PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        name VARCHAR(255),
        order_id VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone, order_id)
      )
    `);

    // Add missing columns defensively
    const columns = [
      { name: 'email', type: 'VARCHAR(255)' },
      { name: 'address', type: 'TEXT' },
      { name: 'city', type: 'VARCHAR(100)' },
      { name: 'province', type: 'VARCHAR(100)' },
      { name: 'zip', type: 'VARCHAR(20)' },
      { name: 'country', type: 'VARCHAR(100)' },
      { name: 'payment_method', type: 'VARCHAR(50)' },
      { name: 'items_json', type: 'TEXT' },
      { name: 'order_total', type: 'DECIMAL(10,2)' },
      { name: 'source', type: 'VARCHAR(50)' },
      { name: 'customer_message', type: 'TEXT' },
      { name: 'last_response_at', type: 'TIMESTAMP' },
      { name: 'response_count', type: 'INTEGER DEFAULT 0' },
      { name: 'delivery_type', type: 'VARCHAR(20)' },
      { name: 'confirmed_by', type: 'VARCHAR(50)' },
      { name: 'conversation_lock_until', type: 'TIMESTAMP' },
      { name: 'gokwik_order_id', type: 'TEXT' },
      { name: 'rto_risk', type: 'VARCHAR(20)' },
      { name: 'cancel_reason', type: 'TEXT' },
      { name: 'shopify_cancelled_at', type: 'TIMESTAMP' },
      { name: 'shopify_refund_amount', type: 'DECIMAL(10,2)' }
    ];

    for (const col of columns) {
      await addColumnIfNotExists('store_shoppers', col.name, col.type);
    }
    
    // Create indexes
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone ON store_shoppers(phone)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_order_id ON store_shoppers(order_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_gokwik_order_id ON store_shoppers(gokwik_order_id)');
    
    console.log('✅ Shoppers table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize shoppers table:', error.message);
  }
}

async function initializeShopperConfirmationsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shopper_confirmations (
        id TEXT PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        order_id VARCHAR(100) NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone, order_id)
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_phone ON shopper_confirmations(phone)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_order_id ON shopper_confirmations(order_id)');

    console.log('✅ Shopper confirmations table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize shopper_confirmations table:', error.message);
  }
}

async function initializeFollowUpTables() {
  try {
    await pool.query(`
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
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add missing columns
    const columnsToAdd = [
      { name: 'message_content', type: 'TEXT' },
      { name: 'created_by', type: 'VARCHAR(100)' },
      { name: 'updated_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
      { name: 'started_at', type: 'TIMESTAMP' },
      { name: 'completed_at', type: 'TIMESTAMP' },
      { name: 'scheduled_at', type: 'TIMESTAMP' }
    ];
    
    for (const col of columnsToAdd) {
      await addColumnIfNotExists('follow_up_campaigns', col.name, col.type);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS follow_up_recipients (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES follow_up_campaigns(id),
        shopper_id INTEGER,
        phone VARCHAR(20) NOT NULL,
        order_id VARCHAR(100),
        status VARCHAR(50) DEFAULT 'pending',
        response_type VARCHAR(50),
        wa_message_id VARCHAR(100),
        sent_at TIMESTAMP,
        delivered_at TIMESTAMP,
        read_at TIMESTAMP,
        responded_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await addColumnIfNotExists('follow_up_recipients', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_campaign ON follow_up_recipients(campaign_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_phone ON follow_up_recipients(phone)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_status ON follow_up_recipients(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_wa_msg ON follow_up_recipients(wa_message_id)');

    console.log('✅ Follow-up tables initialized');
  } catch (error) {
    console.error('❌ Failed to initialize follow-up tables:', error.message);
  }
}

async function initializeMessageReadsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_reads (
        id SERIAL PRIMARY KEY,
        message_id INTEGER NOT NULL UNIQUE,
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        read_by VARCHAR(100)
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id)');

    console.log('✅ Message reads table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize message_reads table:', error.message);
  }
}

async function initializeSupportPortalsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_portals (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        type VARCHAR(50) DEFAULT 'manual',
        config TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Single-session enforcement for portals (same scheme as hub_operators)
    await addColumnIfNotExists('support_portals', 'active_session_id', 'VARCHAR(64)');

    // Add portal_id to support_tickets if missing
    await addColumnIfNotExists('support_tickets', 'portal_id', 'INTEGER');
    await addColumnIfNotExists('support_tickets', 'ticket_number', 'VARCHAR(50)');
    await addColumnIfNotExists('support_tickets', 'is_read', 'BOOLEAN DEFAULT false');
    
    // Set existing tickets as read
    await pool.query('UPDATE support_tickets SET is_read = true WHERE is_read IS NULL');

    // Add re-engagement columns
    await addColumnIfNotExists('support_tickets', 'reengagement_sent', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('support_tickets', 'reengagement_sent_at', 'TIMESTAMP');

    // Add AI classification columns (sentiment, confidence, scenario)
    await addColumnIfNotExists('support_tickets', 'sentiment', 'VARCHAR(20)');
    await addColumnIfNotExists('support_tickets', 'ai_confidence', 'DECIMAL(3,2)');
    await addColumnIfNotExists('support_tickets', 'ai_scenario', 'VARCHAR(50)');
    await addColumnIfNotExists('support_tickets', 'source', "VARCHAR(20) DEFAULT 'whatsapp'");

    // AI classification indexes
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tickets_sentiment ON support_tickets(sentiment) WHERE sentiment IS NOT NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tickets_ai_scenario ON support_tickets(ai_scenario) WHERE ai_scenario IS NOT NULL');

    // Dashboard ticket list: default view is "newest first, status-filtered" —
    // covering index lets Postgres walk the index instead of sorting the table
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tickets_created_desc ON support_tickets(created_at DESC, id DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tickets_status_created ON support_tickets(status, created_at DESC)');

    // Create re-engagement index
    await pool.query('CREATE INDEX IF NOT EXISTS idx_reengagement_pending ON support_tickets(reengagement_sent, status, created_at)');

    // Add advanced distribution columns to support_portals
    const portalColumns = [
      { name: 'max_tickets', type: 'INTEGER' },
      { name: 'shift_start', type: 'TEXT' },
      { name: 'shift_end', type: 'TEXT' },
      { name: 'is_active', type: 'BOOLEAN DEFAULT true' },
      { name: 'distribution_rule', type: 'TEXT' },
      { name: 'assigned_count', type: 'INTEGER DEFAULT 0' },
      { name: 'priority_level', type: 'INTEGER DEFAULT 0' }
    ];

    for (const col of portalColumns) {
      await addColumnIfNotExists('support_portals', col.name, col.type);
    }

    // Create distribution_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS distribution_history (
        id SERIAL PRIMARY KEY,
        distribution_type VARCHAR(100) NOT NULL,
        portal_count INTEGER,
        ticket_count INTEGER,
        filters_applied TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_distribution_history_created ON distribution_history(created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_distribution_history_type ON distribution_history(distribution_type)');

    // Create indexes for support_tickets
    await pool.query('CREATE INDEX IF NOT EXISTS idx_support_portals_slug ON support_portals(slug)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_portal_id ON support_tickets(portal_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read ON support_tickets(is_read)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read_created ON support_tickets(is_read, created_at DESC)');

    console.log('✅ Support portals table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize support portals table:', error.message);
  }
}

async function initializeAbandonedCartsTable() {
  try {
    await pool.query(`
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
      )
    `);

    // Create indexes for abandoned_carts
    await pool.query('CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status ON abandoned_carts(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_abandoned_carts_customer_phone ON abandoned_carts(customer_phone)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_abandoned_carts_customer_email ON abandoned_carts(customer_email)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_abandoned_carts_created_at ON abandoned_carts(created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status_created ON abandoned_carts(status, created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_abandoned_carts_checkout_id ON abandoned_carts(checkout_id)');

    console.log('✅ Abandoned carts table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize abandoned carts table:', error.message);
  }
}

async function initializeShipmentsTable() {
  try {
    await pool.query(`
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
        reship_of_shipment_id INTEGER,
        reship_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Re-ship audit columns (added later — safe on existing tables)
    await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS reship_of_shipment_id INTEGER');
    await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS reship_reason TEXT');

    // Delivery timestamp — stamped when status sync marks a shipment/order
    // delivered (return/exchange window is measured from this, not order date)
    await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP');
    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP');
    } catch (e) { /* orders table provisioned by external schema — ignore */ }

    await pool.query('CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_shipments_awb ON shipments(awb)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status)');
    // Idempotency guard: only one OPEN shipment per order. Terminal states
    // (cancelled/failed/delivered/rto) release the slot so the order can be
    // re-shipped: replacement after delivery, forward-ship after RTO, retry
    // after cancellation/failure.
    await pool.query('DROP INDEX IF EXISTS idx_shipments_active_order');
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_open_order
        ON shipments(order_id)
        WHERE status NOT IN ('cancelled', 'failed', 'delivered', 'rto')
    `);

    console.log('✅ Shipments table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize shipments table:', error.message);
  }
}

async function initializeHubOperatorsTable() {
  try {
    // Operator accounts for Shoppers Hub smart login (admin-created, role-scoped)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hub_operators (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(255),
        password_hash TEXT NOT NULL,
        permissions JSONB NOT NULL DEFAULT '[]',
        is_active BOOLEAN DEFAULT TRUE,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hub_operators_username ON hub_operators(username)');

    // Single-session enforcement: only the login whose session id matches may
    // use the account. A new login overwrites this and instantly kills the old one.
    await addColumnIfNotExists('hub_operators', 'active_session_id', 'VARCHAR(64)');
    await addColumnIfNotExists('hub_operators', 'session_ip', 'VARCHAR(64)');
    await addColumnIfNotExists('hub_operators', 'session_started_at', 'TIMESTAMP');

    // Activity log: every operator action the admin wants to audit
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hub_operator_activity (
        id SERIAL PRIMARY KEY,
        operator_id INTEGER,
        username VARCHAR(100),
        action VARCHAR(100) NOT NULL,
        detail TEXT,
        ip VARCHAR(64),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hub_operator_activity_op_created ON hub_operator_activity(operator_id, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hub_operator_activity_created ON hub_operator_activity(created_at DESC)');

    console.log('✅ Hub operators tables initialized');
  } catch (error) {
    console.error('❌ Failed to initialize hub operators tables:', error.message);
  }
}

async function initializeAiTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_pending_actions (
        id SERIAL PRIMARY KEY,
        actor VARCHAR(100) NOT NULL,
        tool_name VARCHAR(100) NOT NULL,
        tool_args JSONB,
        summary TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        result JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_actor_status ON ai_pending_actions(actor, status)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_chat_history (
        id SERIAL PRIMARY KEY,
        actor VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_chat_history_actor_id ON ai_chat_history(actor, id DESC)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_usage_log (
        id SERIAL PRIMARY KEY,
        actor VARCHAR(100) NOT NULL,
        kind VARCHAR(30) DEFAULT 'chat',
        model VARCHAR(100),
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cost_usd DECIMAL(12, 6) DEFAULT 0,
        tool_calls TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_usage_log_actor_created ON ai_usage_log(actor, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_usage_log_kind_created ON ai_usage_log(kind, created_at DESC)');

    // Learned replies: question → approved agent reply, reinforced over time.
    // Full-text searched ('simple' config) to inject few-shot examples into AI suggestions.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_learned_replies (
        id SERIAL PRIMARY KEY,
        customer_question TEXT NOT NULL,
        agent_reply TEXT NOT NULL,
        customer_phone VARCHAR(20),
        uses INTEGER DEFAULT 1,
        resolved_boost INTEGER DEFAULT 0,
        pinned BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('ALTER TABLE ai_learned_replies ADD COLUMN IF NOT EXISTS resolved_boost INTEGER DEFAULT 0');
    await pool.query('ALTER TABLE ai_learned_replies ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE');
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_learned_replies_tsv ON ai_learned_replies
      USING GIN (to_tsvector('simple', customer_question || ' ' || agent_reply))`);

    // Optional semantic search: pgvector embedding column (Gemini gemini-embedding-001,
    // 768 dims). If the extension isn't available, full-text search still works.
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query('ALTER TABLE ai_learned_replies ADD COLUMN IF NOT EXISTS embedding vector(768)');
      console.log('✅ pgvector enabled for AI learned replies');
    } catch (vectorError) {
      console.warn('⚠️ pgvector unavailable, AI learning falls back to full-text search:', vectorError.message);
    }

    // Seed SOP golden learned replies from Support Agent Workflow Framework
    try {
      const { seedSopLearnedReplies } = require('../services/ai/learning');
      await seedSopLearnedReplies();
    } catch (seedErr) {
      console.warn('⚠️ SOP seeding skipped:', seedErr.message);
    }

    console.log('✅ AI copilot tables initialized');
  } catch (error) {
    console.error('❌ Failed to initialize AI copilot tables:', error.message);
  }
}

async function initializePerformanceIndexes() {
  try {
    // Indexes for messages table (chat/unread queries)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_type_created ON messages(message_type, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_phone_type ON messages(customer_phone, message_type)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC)');
    
    // Composite index for store_shoppers (recent-confirmed and shoppers list queries)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_status_updated ON store_shoppers(status, updated_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_order_updated ON store_shoppers(order_id, updated_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_created_at ON store_shoppers(created_at DESC)');
    // Composite index for inventory intelligence (status + created_at for filtering; items_json fetched from heap)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_status_created ON store_shoppers(status, created_at DESC)');
    
    // Index for orders table (JOIN operations)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
    // Composite index for order status filtering (used in inventory JOINs)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
    
    // Index for message_reads (EXISTS subquery in unread queries)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id)');

    // ── Returns & Exchanges: composite index for status + date filtering ──
    await pool.query('CREATE INDEX IF NOT EXISTS idx_returns_status_created ON returns(status, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_exchanges_status_created ON exchanges(status, created_at DESC)');

    // ── zoho_bundle_map: simple index for full-scan reads (covering index not needed for small tables) ──
    await pool.query('CREATE INDEX IF NOT EXISTS idx_zoho_bundle_map_sku ON zoho_bundle_map(bundle_sku)');

    // ── Chat / messages: composite index for unread queries ──
    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_phone_type_created ON messages(customer_phone, message_type, created_at DESC)');

    // ── store_shoppers: composite for order_id dedup self-join ──
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_orderid_updated ON store_shoppers(order_id, updated_at DESC)');
    // ── store_shoppers: composite for phone dedup (chat unread JOIN) ──
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone_created ON store_shoppers(phone, created_at DESC)');
    
    console.log('✅ Performance indexes initialized');
  } catch (error) {
    console.error('❌ Failed to initialize performance indexes:', error.message);
  }
}

module.exports = {
  pool,
  dbAdapter: new DatabaseAdapter(),
  testConnection,
  initializeDatabase
};
