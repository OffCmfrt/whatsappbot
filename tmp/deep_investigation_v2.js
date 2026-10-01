/**
 * Deep investigation v2 - Where are the messages?
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
    const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    
    console.log('='.repeat(70));
    console.log('DEEP INVESTIGATION: Order 55622');
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
             ORDER BY bq.created_at DESC LIMIT 10`,
            [phone, `+91${phone}`, `91${phone}`]
        );
        if (queue.rows.length > 0) {
            console.log(`   ✅ Found ${queue.rows.length} broadcast message(s):`);
            for (const q of queue.rows) {
                console.log(`      Broadcast: ${q.broadcast_title || 'N/A'}`);
                console.log(`      Phone: ${q.phone} | Status: ${q.status} | Attempts: ${q.attempts}`);
                console.log(`      Message: ${(q.message || '').substring(0, 80)}...`);
                console.log(`      Created: ${q.created_at}`);
            }
        } else {
            console.log('   ❌ No broadcast messages found for this phone');
        }
        
        // 2. Check ALL tables for this phone number
        console.log('\n📋 [2] Searching ALL tables for phone mentions...');
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
            } catch (e) {
                // Skip
            }
        }
        
        if (foundInTables.length > 0) {
            console.log('   Found phone in these tables:');
            for (const f of foundInTables) {
                console.log(`      ✅ ${f}`);
            }
        } else {
            console.log('   ❌ Phone not found in any table');
        }
        
        // 3. Check messages table - sample phones
        console.log('\n📋 [3] Sample phones in messages table...');
        const sample = await pool.query(
            `SELECT customer_phone, COUNT(*) as cnt FROM messages 
             GROUP BY customer_phone 
             ORDER BY MAX(created_at) DESC 
             LIMIT 15`
        );
        console.log('   Phone numbers in messages:');
        for (const s of sample.rows) {
            console.log(`      "${s.customer_phone}" (len:${s.customer_phone?.length}) - ${s.cnt} msgs`);
        }
        
        // 4. Check store_shoppers for order 55622 details
        console.log('\n📋 [4] Full store_shoppers record for order 55622...');
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
        
        // 5. Check if there's a webhook_log or similar
        console.log('\n📋 [5] Checking for webhook/message logs...');
        const logTables = await pool.query(
            `SELECT table_name FROM information_schema.tables 
             WHERE table_schema = 'public' AND (table_name LIKE '%log%' OR table_name LIKE '%webhook%' OR table_name LIKE '%audit%')`
        );
        console.log('   Log tables:', logTables.rows.map(r => r.table_name).join(', ') || 'None');
        
        // 6. Check audit_log_entries for this phone
        console.log('\n📋 [6] Checking audit_log_entries...');
        try {
            const audit = await pool.query(
                `SELECT * FROM audit_log_entries 
                 WHERE details::text LIKE $1 
                 ORDER BY created_at DESC LIMIT 5`,
                [`%${phone}%`]
            );
            if (audit.rows.length > 0) {
                console.log(`   Found ${audit.rows.length} audit entries:`);
                for (const a of audit.rows) {
                    console.log(`      ${a.action} | ${(a.details || '').substring(0, 100)}... | ${a.created_at}`);
                }
            } else {
                console.log('   No audit entries for this phone');
            }
        } catch (e) {
            console.log('   Could not query audit_log:', e.message);
        }
        
        console.log('\n' + '='.repeat(70));
        console.log('CONCLUSION:');
        console.log('='.repeat(70));
        
    } finally {
        await pool.end();
    }
    process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
