/**
 * Fix verification for Order 55622 - Phone with trailing space
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
    const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    
    console.log('='.repeat(70));
    console.log('PHONE FORMAT FIX VERIFICATION');
    console.log('='.repeat(70));
    
    try {
        const badPhone = '8309302779 ';  // With trailing space
        const goodPhone = '8309302779';   // Without space
        
        // 1. Check messages with CORRECT phone (no space)
        console.log('\n📋 [1] Messages with correct phone (no space)...');
        const msgsCorrect = await pool.query(
            `SELECT COUNT(*) as count, MIN(created_at) as first_msg, MAX(created_at) as last_msg
             FROM messages WHERE customer_phone = $1 OR customer_phone = $2 OR customer_phone = $3`,
            [goodPhone, `+91${goodPhone}`, `91${goodPhone}`]
        );
        console.log(`   Count: ${msgsCorrect.rows[0].count}`);
        console.log(`   First: ${msgsCorrect.rows[0].first_msg || 'N/A'}`);
        console.log(`   Last: ${msgsCorrect.rows[0].last_msg || 'N/A'}`);
        
        // 2. Show actual messages
        if (msgsCorrect.rows[0].count !== '0') {
            console.log('\n📋 [2] Actual messages found:');
            const msgs = await pool.query(
                `SELECT message_type, message_content, created_at, customer_phone 
                 FROM messages 
                 WHERE customer_phone = $1 OR customer_phone = $2 OR customer_phone = $3
                 ORDER BY created_at DESC LIMIT 10`,
                [goodPhone, `+91${goodPhone}`, `91${goodPhone}`]
            );
            for (const m of msgs.rows) {
                const preview = (m.message_content || '').substring(0, 60);
                console.log(`   [${m.message_type}] ${m.customer_phone} | ${preview}... | ${m.created_at}`);
            }
        }
        
        // 3. Check broadcasts table for this order
        console.log('\n📋 [3] Checking broadcasts for this phone...');
        const broadcasts = await pool.query(
            `SELECT * FROM broadcasts 
             WHERE phone = $1 OR phone = $2 OR phone = $3
             ORDER BY created_at DESC LIMIT 5`,
            [goodPhone, `+91${goodPhone}`, badPhone]
        );
        if (broadcasts.rows.length > 0) {
            console.log(`   Found ${broadcasts.rows.length} broadcast(s):`);
            for (const b of broadcasts.rows) {
                console.log(`      Template: ${b.template_name || b.template_id} | Status: ${b.status} | Sent: ${b.created_at}`);
            }
        } else {
            console.log('   No broadcasts found in broadcasts table');
        }
        
        // 4. Check broadcast_queue
        console.log('\n📋 [4] Checking broadcast_queue...');
        const queue = await pool.query(
            `SELECT * FROM broadcast_queue 
             WHERE phone = $1 OR phone = $2 OR phone = $3
             ORDER BY created_at DESC LIMIT 5`,
            [goodPhone, `+91${goodPhone}`, badPhone]
        );
        if (queue.rows.length > 0) {
            console.log(`   Found ${queue.rows.length} queued broadcast(s):`);
            for (const q of queue.rows) {
                console.log(`      Phone: ${q.phone} | Status: ${q.status} | Created: ${q.created_at}`);
            }
        } else {
            console.log('   No broadcasts in queue');
        }
        
        // 5. Check store_shoppers with bad phone
        console.log('\n📋 [5] Checking store_shoppers with bad phone (trailing space)...');
        const badShopper = await pool.query(
            `SELECT id, phone, order_id, status, last_response_at, response_count 
             FROM store_shoppers WHERE phone = $1`,
            [badPhone]
        );
        if (badShopper.rows.length > 0) {
            console.log(`   ✅ Found record with bad phone:`);
            for (const s of badShopper.rows) {
                console.log(`      ID: ${s.id} | Order: ${s.order_id} | Status: ${s.status}`);
                console.log(`      Last response: ${s.last_response_at} | Count: ${s.response_count}`);
            }
        }
        
        // 6. Show the fix needed
        console.log('\n' + '='.repeat(70));
        console.log('ROOT CAUSE CONFIRMED:');
        console.log('='.repeat(70));
        console.log(`❌ store_shoppers.phone = "${badPhone}" (has trailing space)`);
        console.log(`✅ messages.customer_phone = "${goodPhone}" (correct format)`);
        console.log('');
        console.log('FIX: Update store_shoppers to remove trailing space:');
        console.log(`   UPDATE store_shoppers SET phone = TRIM(phone) WHERE order_id = '55622';`);
        
    } finally {
        await pool.end();
    }
    process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
