/**
 * Final investigation - Where are the messages?
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
    const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    
    console.log('='.repeat(70));
    console.log('FINAL INVESTIGATION: Order 55622');
    console.log('='.repeat(70));
    
    try {
        const phone = '8309302779';
        
        // 1. Search broadcast_queue by phone
        console.log('\n📋 [1] Searching broadcast_queue for this phone...');
        const queue = await pool.query(
            `SELECT bq.*, b.title as broadcast_title 
             FROM broadcast_queue bq
             LEFT JOIN broadcasts b ON bq.broadcast_id = b.id
             WHERE bq.phone = $1 OR bq.phone = $2 OR bq.phone = $3
             LIMIT 10`,
            [phone, `+91${phone}`, `91${phone}`]
        );
        if (queue.rows.length > 0) {
            console.log(`   ✅ Found ${queue.rows.length} broadcast message(s):`);
            for (const q of queue.rows) {
                console.log(`      Broadcast: ${q.broadcast_title || 'N/A'}`);
                console.log(`      Phone: ${q.phone} | Status: ${q.status} | Attempts: ${q.attempts}`);
                console.log(`      Message: ${(q.message || '').substring(0, 80)}...`);
            }
        } else {
            console.log('   ❌ No broadcast messages found');
        }
        
        // 2. Check ALL tables for this phone
        console.log('\n📋 [2] Searching ALL tables for phone...');
        const tables = await pool.query(
            `SELECT table_name FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        );
        
        let foundInTables = [];
        for (const t of tables.rows) {
            const tableName = t.table_name;
            try {
                const colCheck = await pool.query(
                    `SELECT column_name FROM information_schema.columns 
                     WHERE table_name = $1 AND (column_name LIKE '%phone%' OR column_name LIKE '%mobile%')`,
                    [tableName]
                );
                
                for (const col of colCheck.rows) {
                    const result = await pool.query(
                        `SELECT COUNT(*) FROM ${tableName} WHERE ${col.column_name}::text LIKE $1`,
                        [`%${phone}%`]
                    );
                    if (result.rows[0].count !== '0') {
                        foundInTables.push(`${tableName}.${col.column_name}: ${result.rows[0].count}`);
                    }
                }
            } catch (e) { /* Skip */ }
        }
        
        if (foundInTables.length > 0) {
            console.log('   Found phone in:');
            for (const f of foundInTables) {
                console.log(`      ✅ ${f}`);
            }
        } else {
            console.log('   ❌ Phone not found in any table');
        }
        
        // 3. Sample phones in messages table
        console.log('\n📋 [3] Sample phones in messages table...');
        const sample = await pool.query(
            `SELECT customer_phone, COUNT(*) as cnt FROM messages 
             GROUP BY customer_phone 
             LIMIT 15`
        );
        console.log('   Phones in messages:');
        for (const s of sample.rows) {
            console.log(`      "${s.customer_phone}" (len:${s.customer_phone?.length}) - ${s.cnt} msgs`);
        }
        
        // 4. Full store_shoppers record
        console.log('\n📋 [4] store_shoppers record for order 55622...');
        const shopper = await pool.query(
            `SELECT * FROM store_shoppers WHERE order_id = '55622'`
        );
        if (shopper.rows.length > 0) {
            const s = shopper.rows[0];
            console.log(`   phone: "${s.phone}" (length: ${s.phone?.length})`);
            console.log(`   name: ${s.name}`);
            console.log(`   status: ${s.status}`);
            console.log(`   customer_message: ${s.customer_message || 'N/A'}`);
            console.log(`   last_response_at: ${s.last_response_at}`);
            console.log(`   response_count: ${s.response_count}`);
            console.log(`   created_at: ${s.created_at}`);
        }
        
        // 5. Check support_tickets with exact phone match
        console.log('\n📋 [5] support_tickets for this phone...');
        const tickets = await pool.query(
            `SELECT * FROM support_tickets 
             WHERE customer_phone = $1 OR customer_phone = $2 OR customer_phone = $3 OR customer_phone = $4`,
            [phone, `+91${phone}`, `91${phone}`, `${phone} `]  // Include trailing space variant
        );
        if (tickets.rows.length > 0) {
            console.log(`   ✅ Found ${tickets.rows.length} ticket(s):`);
            for (const t of tickets.rows) {
                console.log(`      ID: ${t.id} | Phone: "${t.customer_phone}" | Status: ${t.status}`);
            }
        } else {
            console.log('   ❌ No support tickets');
        }
        
        console.log('\n' + '='.repeat(70));
        console.log('SUMMARY:');
        console.log('='.repeat(70));
        console.log(`Phone in store_shoppers: "${shopper.rows[0]?.phone}" (with trailing space)`);
        console.log(`Phone variations checked: ${phone}, +91${phone}, 91${phone}`);
        console.log(`Messages found: ${foundInTables.filter(f => f.includes('messages')).length > 0 ? 'YES' : 'NO'}`);
        console.log(`Broadcast queue entries: ${queue.rows.length}`);
        
    } finally {
        await pool.end();
    }
    process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
