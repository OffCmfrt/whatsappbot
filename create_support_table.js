require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

async function run() {
    await dbAdapter.query(`CREATE TABLE IF NOT EXISTS support_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_phone TEXT NOT NULL,
        customer_name TEXT,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ support_tickets table ready');
    process.exit(0);
}
run().catch(err => { console.error(err); process.exit(1); });
