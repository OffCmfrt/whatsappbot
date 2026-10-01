/**
 * Deep investigation - Where are the messages?
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
        
        // 1. Check broadcasts table schema
        console.log('\n📋 [1] Broadcasts table columns...');
        const cols = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'broadcasts'`
        );
        console.log('   Columns:', cols.rows.map(r => r.column_name).join(', '));
        
        // 2. Check broadcast_queue schema
        console.log('\n📋 [2] Broadcast_queue table columns...');
        const bqCols = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'broadcast_queue'`
        );
        console.log('   Columns:', bqCols.rows.map(r => r.column_name).join(', '));
        
        // 3. Search broadcasts by recipient_phone or similar
        console.log('\n📋 [3] Searching broadcasts for this phone...');
        const broadcasts = await pool.query(
            `SELECT * FROM broadcasts 
             WHERE recipient_phone = $1 OR recipient_phone = $2 OR recipient_phone = $3
             ORDER BY created_at DESC LIMIT 5`,
            [phone, `+91${phone}`, `91${phone}`]
        );
        if (broadcasts.rows.length > 0) {
            console.log(`   Found ${broadcasts.rows.length} broadcast(s):`);
            for (const b of broadcasts.rows) {
                console.log(`      To: ${b.recipient_phone} | Template: ${b.template_name || 'N/A'} | Status: ${b.status}`);
            }
        } else {
            console.log('   No broadcasts found');
        }
        
        // 4. Search broadcast_queue
        console.log('\n📋 [4] Searching broadcast_queue...');
        const queue = await pool.query(
            `SELECT * FROM broadcast_queue 
             WHERE recipient_phone = $1 OR recipient_phone = $2 OR recipient_phone = $3
             ORDER BY created_at DESC LIMIT 5`,
            [phone, `+91${phone}`, `91${phone}`]
        );
        if (queue.rows.length > 0) {
            console.log(`   Found ${queue.rows.length} queued message(s):`);
            for (const q of queue.rows) {
                console.log(`      To: ${q.recipient_phone} | Status: ${q.status} | Created: ${q.created_at}`);
            }
        } else {
            console.log('   No queued broadcasts');
        }
        
        // 5. Check ALL tables for this phone number
        console.log('\n📋 [5] Searching ALL tables for phone mentions...');
        const tables = await pool.query(
            `SELECT table_name FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        );
        
        for (const t of tables.rows.slice(0, 30)) {
            const tableName = t.table_name;
            try {
                const colCheck = await pool.query(
                    `SELECT column_name FROM information_schema.columns 
                     WHERE table_name = $1 AND (column_name LIKE '%phone%' OR column_name LIKE '%mobile%' OR column_name LIKE '%contact%')`,
                    [tableName]
                );
                
                for (const col of colCheck.rows) {
                    const result = await pool.query(
                        `SELECT COUNT(*) FROM ${tableName} WHERE ${col.column_name}::text LIKE $1`,
                        [`%${phone}%`]
                    );
                    if (result.rows[0].count !== '0') {
                        console.log(`   ✅ ${tableName}.${col.column_name}: ${result.rows[0].count} match(es)`);
                    }
                }
            } catch (e) {
                // Skip tables that error
            }
        }
        
        // 6. Check messages table for recent entries
        console.log('\n📋 [6] Recent messages in system (last 100)...');
        const recent = await pool.query(
            `SELECT customer_phone, message_type, created_at FROM messages 
             ORDER BY created_at DESC LIMIT 20`
        );
        console.log('   Recent message phones:');
        const phones = [...new Set(recent.rows.map(r => r.customer_phone))];
        for (const p of phones) {
            console.log(`      "${p}" (len: ${p?.length})`);
        }
        
        // 7. Check if messages table has any entries for this order's timeframe
        console.log('\n📋 [7] Messages around order creation time...');
        const shopper = await pool.query(
            `SELECT created_at FROM store_shoppers WHERE order_id = '55622'`
        );
        if (shopper.rows.length > 0) {
            const orderDate = shopper.rows[0].created_at;
            console.log(`   Order created: ${orderDate}`);
            const nearby = await pool.query(
                `SELECT customer_phone, message_type, created_at FROM messages 
                 WHERE created_at BETWEEN $1::timestamp - INTERVAL '1 day' AND $1::timestamp + INTERVAL '7 days'
                 ORDER BY created_at LIMIT 10`,
                [orderDate]
            );
            if (nearby.rows.length > 0) {
                console.log('   Messages around that time:');
                for (const m of nearby.rows) {
                    console.log(`      ${m.customer_phone} | ${m.message_type} | ${m.created_at}`);
                }
            }
        }
        
        console.log('\n' + '='.repeat(70));
        
    } finally {
        await pool.end();
    }
    process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
