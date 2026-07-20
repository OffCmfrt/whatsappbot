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

// CRITICAL FIX: pg Pool does NOT have endIdleClients() — implement it manually
// This drains idle connections to free native TLS buffers (~5-10MB per idle connection)
// Without this, native memory grows unbounded and causes OOM at 512MB
// pg-pool v3 stores idle clients in this._idle array
pool.endIdleClients = function() {
  let closed = 0;
  // Drain all idle clients from the pool's idle queue
  while (this._idle && this._idle.length > 0) {
    const client = this._idle.pop();
    if (client) {
      try {
        client.end();
        closed++;
      } catch (e) { /* already closed */ }
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
    const result = await pool.query(pgSql, values);
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
    
    // Initialize Performance Indexes
    await initializePerformanceIndexes();
    
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
      { name: 'conversation_lock_until', type: 'TIMESTAMP' }
    ];

    for (const col of columns) {
      await addColumnIfNotExists('store_shoppers', col.name, col.type);
    }
    
    // Create indexes
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_phone ON store_shoppers(phone)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_store_shoppers_order_id ON store_shoppers(order_id)');
    
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

    // Add portal_id to support_tickets if missing
    await addColumnIfNotExists('support_tickets', 'portal_id', 'INTEGER');
    await addColumnIfNotExists('support_tickets', 'ticket_number', 'VARCHAR(50)');
    await addColumnIfNotExists('support_tickets', 'is_read', 'BOOLEAN DEFAULT false');
    
    // Set existing tickets as read
    await pool.query('UPDATE support_tickets SET is_read = true WHERE is_read IS NULL');

    // Add re-engagement columns
    await addColumnIfNotExists('support_tickets', 'reengagement_sent', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('support_tickets', 'reengagement_sent_at', 'TIMESTAMP');

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
    
    // Index for orders table (JOIN operations)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
    
    // Index for message_reads (EXISTS subquery in unread queries)
    await pool.query('CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id)');
    
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
