/**
 * Deep diagnostic for Order 55622 - Find missing messages
 */
require('dotenv').config();
const { Pool } = require('pg');

const ORDER_ID = '55622';
const PHONE = '8309302779';

async function main() {
    const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    
    console.log('='.repeat(70));
    console.log(`DEEP DIAGNOSIS: Order #${ORDER_ID} - Missing Messages`);
    console.log('='.repeat(70));
    
    try {
        // 1. Check ALL phone variations in messages table
        console.log('\n📋 [1] Searching messages with ALL phone variations...');
        const cleanPhone = PHONE.replace(/\D/g, '');
        const variations = [
            cleanPhone,                    // 8309302779
            `+${cleanPhone}`,              // +8309302779
            `91${cleanPhone}`,             // 918309302779
            `+91${cleanPhone}`,            // +918309302779
            `0${cleanPhone}`,              // 08309302779
            cleanPhone.substring(2),       // 9302779 (without 83)
        ];
        
        for (const v of variations) {
            const result = await pool.query(
                `SELECT COUNT(*) as count FROM messages WHERE customer_phone = $1`,
                [v]
            );
            if (result.rows[0].count !== '0') {
                console.log(`   ✅ Found ${result.rows[0].count} message(s) for phone: ${v}`);
            }
        }
        
        // 2. Search by partial phone match
        console.log('\n📋 [2] Searching by partial phone match (LIKE %8309302779%)...');
        const partial = await pool.query(
            `SELECT customer_phone, COUNT(*) as count FROM messages 
             WHERE customer_phone LIKE $1 
             GROUP BY customer_phone`,
            [`%${cleanPhone}%`]
        );
        if (partial.rows.length > 0) {
            console.log('   Found messages with phones:');
            for (const r of partial.rows) {
                console.log(`      ${r.customer_phone}: ${r.count} messages`);
            }
        } else {
            console.log('   ❌ No messages found with partial match');
        }
        
        // 3. Check if messages exist for this order_id in any table
        console.log('\n📋 [3] Checking store_shoppers for exact record...');
        const shopper = await pool.query(
            `SELECT * FROM store_shoppers WHERE order_id = $1`,
            [ORDER_ID]
        );
        if (shopper.rows.length > 0) {
            const s = shopper.rows[0];
            console.log(`   Phone in DB: "${s.phone}" (length: ${s.phone?.length})`);
            console.log(`   Name: ${s.name}`);
            console.log(`   Status: ${s.status}`);
            console.log(`   Customer message: ${s.customer_message || 'N/A'}`);
            console.log(`   Last response: ${s.last_response_at || 'N/A'}`);
            console.log(`   Response count: ${s.response_count || 0}`);
        }
        
        // 4. Check support_tickets table
        console.log('\n📋 [4] Checking support_tickets...');
        const tickets = await pool.query(
            `SELECT * FROM support_tickets 
             WHERE customer_phone LIKE $1 OR customer_phone LIKE $2 OR customer_phone LIKE $3 OR customer_phone LIKE $4
             ORDER BY created_at DESC LIMIT 5`,
            [`%${cleanPhone}`, `${cleanPhone}%`, `%${cleanPhone}%`, `+91${cleanPhone}`]
        );
        if (tickets.rows.length > 0) {
            console.log(`   ✅ Found ${tickets.rows.length} ticket(s):`);
            for (const t of tickets.rows) {
                console.log(`      ID: ${t.id} | Phone: ${t.customer_phone} | Status: ${t.status} | Created: ${t.created_at}`);
            }
        } else {
            console.log('   ❌ No support tickets found');
        }
        
        // 5. Check message_reads or any tracking
        console.log('\n📋 [5] Checking message_reads table...');
        const reads = await pool.query(
            `SELECT COUNT(*) FROM message_reads mr
             JOIN messages m ON mr.message_id = m.id
             WHERE m.customer_phone LIKE $1`,
            [`%${cleanPhone}%`]
        );
        console.log(`   Message reads: ${reads.rows[0].count}`);
        
        // 6. Check if ANY messages were sent to this phone recently
        console.log('\n📋 [6] Checking ALL outgoing messages to this phone (last 30 days)...');
        const outgoing = await pool.query(
            `SELECT message_type, message_content, created_at, customer_phone 
             FROM messages 
             WHERE customer_phone LIKE $1 
             AND created_at > NOW() - INTERVAL '30 days'
             ORDER BY created_at DESC LIMIT 10`,
            [`%${cleanPhone}%`]
        );
        if (outgoing.rows.length > 0) {
            console.log('   Found messages:');
            for (const m of outgoing.rows) {
                console.log(`      [${m.message_type}] ${m.customer_phone} | ${(m.message_content || '').substring(0, 50)}... | ${m.created_at}`);
            }
        } else {
            console.log('   ❌ No outgoing messages found in last 30 days');
        }
        
        // 7. Check broadcast/template messages
        console.log('\n📋 [7] Checking broadcast_logs or template messages...');
        try {
            const broadcasts = await pool.query(
                `SELECT table_name FROM information_schema.tables 
                 WHERE table_name LIKE '%broadcast%' OR table_name LIKE '%template%' OR table_name LIKE '%log%'`
            );
            console.log('   Related tables:', broadcasts.rows.map(r => r.table_name).join(', ') || 'None found');
        } catch (e) {
            console.log('   Could not check tables:', e.message);
        }
        
        // 8. Check if phone format is wrong in store_shoppers
        console.log('\n📋 [8] Checking phone format issue...');
        console.log(`   Expected formats: ${cleanPhone}, +91${cleanPhone}, 91${cleanPhone}`);
        console.log(`   Actual in DB: "${shopper.rows[0]?.phone}"`);
        
        // 9. Sample of recent messages in system to see phone format
        console.log('\n📋 [9] Sample of recent messages in system (phone formats)...');
        const sample = await pool.query(
            `SELECT DISTINCT customer_phone FROM messages ORDER BY created_at DESC LIMIT 10`
        );
        console.log('   Recent phone numbers in messages table:');
        for (const r of sample.rows) {
            console.log(`      "${r.customer_phone}"`);
        }
        
        console.log('\n' + '='.repeat(70));
        console.log('CONCLUSION:');
        console.log('='.repeat(70));
        console.log('If no messages found at all, the webhook/message handler');
        console.log('may have failed to record them. Check server logs around');
        console.log('the time templates were sent.');
        
    } finally {
        await pool.end();
    }
    process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
