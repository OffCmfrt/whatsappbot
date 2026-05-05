require('dotenv').config();
const { tursoClient } = require('./src/database/db');

async function run() {
    // Ensure conversations table has correct schema with UNIQUE constraint
    // (create if not exists — won't affect existing data)
    await tursoClient.execute(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_phone TEXT NOT NULL UNIQUE,
        state TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ conversations table schema verified');

    // Also ensure support_tickets table exists
    await tursoClient.execute(`CREATE TABLE IF NOT EXISTS support_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_phone TEXT NOT NULL,
        customer_name TEXT,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ support_tickets table schema verified');
    process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
