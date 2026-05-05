const { createClient: createLibSQLClient } = require('@libsql/client');
require('dotenv').config();

// Force Turso (libSQL)
const tursoClient = createLibSQLClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

console.log(`📊 libSQL URL Origin: ${process.env.TURSO_DATABASE_URL ? 'Environment' : 'MISSING'}`);
console.log('📊 Using Turso (SQLite)');

// Helper function to get current UTC timestamp in ISO format
function getUTCTimestamp() {
  return new Date().toISOString();
}

module.exports.getUTCTimestamp = getUTCTimestamp;

// Universal database adapter (Now Turso-only)
class DatabaseAdapter {
  constructor() {}

  // Always use Turso
  getDB(table) {
    return 'TURSO';
  }

  // Execute a raw SQL query
  async query(sql, params = []) {
    const start = Date.now();
    const values = params.map(v => v === undefined ? null : v);
    const result = await tursoClient.execute({ sql, args: values });
    const duration = Date.now() - start;
    
    // Log slow queries (>100ms)
    if (duration > 100) {
      console.warn(`⚠️ SLOW QUERY (${duration}ms): ${sql.substring(0, 100)}`);
    }
    
    return result.rows;
  }

  // Execute a raw SQL statement (INSERT, UPDATE, DELETE) and return metadata
  // Returns { changes: number, lastInsertRowid: number }
  async run(sql, params = []) {
    const values = params.map(v => v === undefined ? null : v);
    const result = await tursoClient.execute({ sql, args: values });
    return {
      changes: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid
    };
  }

  // Insert data
  async insert(table, data) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => v === undefined ? null : v);
    const placeholders = keys.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
    const result = await tursoClient.execute({ sql, args: values });
    return { ...data, id: result.lastInsertRowid ? String(result.lastInsertRowid) : data.id };
  }

  // Select data
  async select(table, where = {}, options = {}) {
    let sql = `SELECT * FROM ${table}`;
    const params = [];

    if (Object.keys(where).length > 0) {
      const conditions = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
      sql += ` WHERE ${conditions}`;
      params.push(...Object.values(where).map(v => v === undefined ? null : v));
    }

    if (options.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }

    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const result = await tursoClient.execute({ sql, args: params });
    return result.rows;
  }

  // Update data
  async update(table, data, where) {
    const setClause = Object.keys(data).map(key => `${key} = ?`).join(', ');
    const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const params = [
      ...Object.values(data).map(v => v === undefined ? null : v), 
      ...Object.values(where).map(v => v === undefined ? null : v)
    ];
    await tursoClient.execute({ sql, args: params });
    return { success: true };
  }

  // Delete data
  async delete(table, where) {
    const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
    const params = Object.values(where).map(v => v === undefined ? null : v);
    await tursoClient.execute({ sql, args: params });
    return { success: true };
  }
}

// Test database connection
async function testConnection() {
  try {
    await tursoClient.execute('SELECT 1');
    console.log('✅ Turso connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

// Initialize database tables
async function initializeDatabase() {
  try {
    // Proactively add order_count to customers if missing (User request)
    await tursoClient.execute("ALTER TABLE customers ADD COLUMN order_count INTEGER DEFAULT 0");
    console.log('✅ Added order_count column to customers table');
  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('duplicate column name')) {
      // Column already exists, ignore
    } else {
      console.error('ℹ️ Migration notice (order_count):', e.message);
    }
  }

  // Add wa_message_id column to messages table for delivery status tracking
  try {
    await tursoClient.execute('ALTER TABLE messages ADD COLUMN wa_message_id TEXT');
    console.log('✅ Added wa_message_id column to messages table');
  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('duplicate column name')) {
      // Column already exists, ignore
    } else {
      console.error('ℹ️ Migration notice (wa_message_id):', e.message);
    }
  }

  // Add tags column to orders table for Shiprocket order tags
  try {
    await tursoClient.execute('ALTER TABLE orders ADD COLUMN tags TEXT');
    console.log('✅ Added tags column to orders table');
  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('duplicate column name')) {
      // Column already exists, ignore
    } else {
      console.error('ℹ️ Migration notice (tags):', e.message);
    }
  }

  // Add updated_at column to support_tickets table
  // Note: SQLite ALTER TABLE doesn't support DEFAULT CURRENT_TIMESTAMP (non-constant),
  // so we add as TEXT with NULL default and backfill existing rows
  try {
    await tursoClient.execute('ALTER TABLE support_tickets ADD COLUMN updated_at TEXT');
    // Backfill existing rows with their created_at value
    await tursoClient.execute('UPDATE support_tickets SET updated_at = created_at WHERE updated_at IS NULL');
    console.log('✅ Added updated_at column to support_tickets table');
  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('duplicate column name')) {
      // Column already exists, ignore
    } else {
      console.error('ℹ️ Migration notice (support_tickets.updated_at):', e.message);
    }
  }

  // Initialize Shoppers Table
  await initializeShoppersTable();
  
  // Initialize Shopper Confirmations Table (for deduplication)
  await initializeShopperConfirmationsTable();
  
  // Initialize Follow-Up Campaigns Tables
  await initializeFollowUpTables();
  
  // Initialize Message Reads Table (for inbox unread tracking)
  await initializeMessageReadsTable();

  // Initialize Support Portals Table
  await initializeSupportPortalsTable();
  
  console.log('ℹ️ Turso database initialized');
  return true;
}

async function initializeShoppersTable() {
  try {
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS store_shoppers (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT,
        order_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    
    // Add missing columns defensively
    const columns = [
      { name: 'email', type: 'TEXT' },
      { name: 'address', type: 'TEXT' },
      { name: 'city', type: 'TEXT' },
      { name: 'province', type: 'TEXT' },
      { name: 'zip', type: 'TEXT' },
      { name: 'country', type: 'TEXT' },
      { name: 'payment_method', type: 'TEXT' },
      { name: 'items_json', type: 'TEXT' },
      { name: 'order_total', type: 'REAL' },
      { name: 'source', type: 'TEXT' },
      { name: 'customer_message', type: 'TEXT' },
      { name: 'last_response_at', type: 'TEXT' },
      { name: 'response_count', type: 'INTEGER' },
      { name: 'delivery_type', type: 'TEXT' },
      { name: 'confirmed_by', type: 'TEXT' },
      { name: 'conversation_lock_until', type: 'TEXT' }
    ];

    for (const col of columns) {
      try {
        await tursoClient.execute(`ALTER TABLE store_shoppers ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {}
    }
    
    console.log('✅ Shoppers table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize shoppers table:', error.message);
  }
}

async function initializeShopperConfirmationsTable() {
  try {
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS shopper_confirmations (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        order_id TEXT NOT NULL,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone, order_id)
      )
    `);

    // Create indexes for faster lookups
    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_phone ON shopper_confirmations(phone)
    `);
    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_shopper_confirmations_order_id ON shopper_confirmations(order_id)
    `);

    console.log('✅ Shopper confirmations table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize shopper_confirmations table:', error.message);
  }
}

async function initializeFollowUpTables() {
  try {
    // Create follow_up_campaigns table
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS follow_up_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        template_name TEXT NOT NULL,
        message_content TEXT,
        status TEXT DEFAULT 'draft',
        total_recipients INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        delivered_count INTEGER DEFAULT 0,
        read_count INTEGER DEFAULT 0,
        responded_count INTEGER DEFAULT 0,
        confirmed_count INTEGER DEFAULT 0,
        cancelled_count INTEGER DEFAULT 0,
        edit_requested_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add missing columns to existing follow_up_campaigns table (migration)
    const columnsToAdd = [
      { name: 'message_content', type: 'TEXT' },
      { name: 'created_by', type: 'TEXT' },
      { name: 'updated_at', type: 'TEXT DEFAULT CURRENT_TIMESTAMP' },
      { name: 'started_at', type: 'TEXT' },
      { name: 'completed_at', type: 'TEXT' },
      { name: 'scheduled_at', type: 'TEXT' }
    ];
    
    for (const col of columnsToAdd) {
      try {
        await tursoClient.execute(`ALTER TABLE follow_up_campaigns ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Added ${col.name} column to follow_up_campaigns`);
      } catch (e) {
        if (!e.message.includes('duplicate column')) console.log(`ℹ️ ${col.name} column:`, e.message);
      }
    }

    // Create follow_up_recipients table
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS follow_up_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER,
        shopper_id INTEGER,
        phone TEXT NOT NULL,
        order_id TEXT,
        status TEXT DEFAULT 'pending',
        response_type TEXT,
        wa_message_id TEXT,
        sent_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        responded_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES follow_up_campaigns(id),
        FOREIGN KEY (shopper_id) REFERENCES store_shoppers(id)
      )
    `);

    // Add missing columns to existing follow_up_recipients table (migration)
    try {
      await tursoClient.execute(`ALTER TABLE follow_up_recipients ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`);
      console.log('✅ Added created_at column to follow_up_recipients');
    } catch (e) {
      if (!e.message.includes('duplicate column')) console.log('ℹ️ created_at column:', e.message);
    }

    // Create indexes for faster lookups
    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_campaign ON follow_up_recipients(campaign_id)
    `);
    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_phone ON follow_up_recipients(phone)
    `);
    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_status ON follow_up_recipients(status)
    `);
    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_follow_up_recipients_wa_msg ON follow_up_recipients(wa_message_id)
    `);

    console.log('✅ Follow-up tables initialized');
  } catch (error) {
    console.error('❌ Failed to initialize follow-up tables:', error.message);
  }
}

async function initializeMessageReadsTable() {
  try {
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS message_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        read_at TEXT DEFAULT CURRENT_TIMESTAMP,
        read_by TEXT,
        UNIQUE(message_id)
      )
    `);

    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id)
    `);

    console.log('✅ Message reads table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize message_reads table:', error.message);
  }
}

async function initializeSupportPortalsTable() {
  try {
    // Create support_portals table
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS support_portals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        type TEXT DEFAULT 'manual',
        config TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add portal_id to support_tickets if missing
    try {
      await tursoClient.execute(`ALTER TABLE support_tickets ADD COLUMN portal_id INTEGER`);
      console.log('✅ Added portal_id column to support_tickets');
    } catch (e) {
      if (!e.message.includes('duplicate column')) {
        console.log('ℹ️ portal_id column:', e.message);
      }
    }

    // Add ticket_number column to support_tickets if missing
    try {
      await tursoClient.execute(`ALTER TABLE support_tickets ADD COLUMN ticket_number TEXT`);
      console.log('✅ Added ticket_number column to support_tickets');
    } catch (e) {
      if (!e.message.includes('duplicate column')) {
        console.log('ℹ️ ticket_number column:', e.message);
      }
    }

    // Add is_read column to support_tickets if missing
    try {
      await tursoClient.execute(`ALTER TABLE support_tickets ADD COLUMN is_read BOOLEAN DEFAULT 0`);
      console.log('✅ Added is_read column to support_tickets');
    } catch (e) {
      if (!e.message.includes('duplicate column')) {
        console.log('ℹ️ is_read column:', e.message);
      }
    }

    // Set existing tickets as read (backward compatibility)
    try {
      await tursoClient.execute(`UPDATE support_tickets SET is_read = 1 WHERE is_read IS NULL`);
      console.log('✅ Set existing tickets as read');
    } catch (e) {
      console.log('ℹ️ Update is_read:', e.message);
    }

    // Add re-engagement tracking columns to support_tickets
    try {
      await tursoClient.execute(`ALTER TABLE support_tickets ADD COLUMN reengagement_sent BOOLEAN DEFAULT 0`);
      console.log('✅ Added reengagement_sent column to support_tickets');
    } catch (e) {
      if (!e.message.includes('duplicate column')) {
        console.log('ℹ️ reengagement_sent column:', e.message);
      }
    }

    try {
      await tursoClient.execute(`ALTER TABLE support_tickets ADD COLUMN reengagement_sent_at TEXT`);
      console.log('✅ Added reengagement_sent_at column to support_tickets');
    } catch (e) {
      if (!e.message.includes('duplicate column')) {
        console.log('ℹ️ reengagement_sent_at column:', e.message);
      }
    }

    // Create index for re-engagement queries
    try {
      await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_reengagement_pending ON support_tickets(reengagement_sent, status, created_at)`);
      console.log('✅ Created idx_reengagement_pending index');
    } catch (e) {
      if (!e.message.includes('already exists')) {
        console.log('ℹ️ idx_reengagement_pending index:', e.message);
      }
    }

    // Add advanced distribution columns to support_portals
    const portalColumns = [
      { name: 'max_tickets', sql: 'ALTER TABLE support_portals ADD COLUMN max_tickets INTEGER' },
      { name: 'shift_start', sql: 'ALTER TABLE support_portals ADD COLUMN shift_start TEXT' },
      { name: 'shift_end', sql: 'ALTER TABLE support_portals ADD COLUMN shift_end TEXT' },
      { name: 'is_active', sql: 'ALTER TABLE support_portals ADD COLUMN is_active BOOLEAN DEFAULT 1' },
      { name: 'distribution_rule', sql: 'ALTER TABLE support_portals ADD COLUMN distribution_rule TEXT' },
      { name: 'assigned_count', sql: 'ALTER TABLE support_portals ADD COLUMN assigned_count INTEGER DEFAULT 0' },
      { name: 'priority_level', sql: 'ALTER TABLE support_portals ADD COLUMN priority_level INTEGER DEFAULT 0' }
    ];

    for (const col of portalColumns) {
      try {
        await tursoClient.execute(col.sql);
        console.log(`✅ Added ${col.name} column to support_portals`);
      } catch (e) {
        if (!e.message.includes('duplicate column')) {
          console.log(`ℹ️ ${col.name} column:`, e.message);
        }
      }
    }

    // Create distribution_history table
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS distribution_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        distribution_type TEXT NOT NULL,
        portal_count INTEGER,
        ticket_count INTEGER,
        filters_applied TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_distribution_history_created ON distribution_history(created_at)`);
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_distribution_history_type ON distribution_history(distribution_type)`);
    console.log('✅ Created distribution_history table');

    // Create indexes
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_support_portals_slug ON support_portals(slug)`);
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_support_tickets_portal_id ON support_tickets(portal_id)`);
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)`);
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at)`);
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read ON support_tickets(is_read)`);
    await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read_created ON support_tickets(is_read, created_at DESC)`);
    await tursoClient.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_ticket_number ON support_tickets(ticket_number)`);

    console.log('✅ Support portals table initialized');
  } catch (error) {
    console.error('❌ Failed to initialize support portals table:', error.message);
  }
}

module.exports = {
  tursoClient,
  dbAdapter: new DatabaseAdapter(),
  testConnection,
  initializeDatabase
};
