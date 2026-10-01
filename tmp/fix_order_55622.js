/**
 * Fix Order 55622 - Trim phone and check for messages
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
    const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    
    console.log('='.repeat(70));
    console.log('FIX: Order 55622 - Phone Number Correction');
    console.log('='.repeat(70));
    
    try {
        const badPhone = '8309302779 ';  // With trailing space
        const goodPhone = '8309302779';   // Without space
        const webhookPhone = '918309302779';  // With country code (from WhatsApp)
        const formattedPhone = '+918309302779';  // With + prefix
        
        // 1. Check messages with ALL possible formats
        console.log('\n📋 [1] Checking messages with all phone formats...');
        const allFormats = [goodPhone, webhookPhone, formattedPhone, `+${webhookPhone}`, badPhone];
        
        for (const phone of allFormats) {
            const result = await pool.query(
                `SELECT COUNT(*) as count FROM messages WHERE customer_phone = $1`,
                [phone]
            );
            if (result.rows[0].count !== '0') {
                console.log(`   ✅ Found ${result.rows[0].count} message(s) for: "${phone}"`);
            }
        }
        
        // 2. Fix the phone in store_shoppers
        console.log('\n📋 [2] Fixing phone in store_shoppers...');
        const updateResult = await pool.query(
            `UPDATE store_shoppers 
             SET phone = $1 
             WHERE phone = $2 AND order_id = '55622'
             RETURNING id, phone, order_id`,
            [goodPhone, badPhone]
        );
        
        if (updateResult.rows.length > 0) {
            console.log(`   ✅ Fixed phone for shopper ID: ${updateResult.rows[0].id}`);
            console.log(`      Old: "${badPhone}" → New: "${goodPhone}"`);
        } else {
            console.log('   ⚠️  No record updated (phone may already be correct)');
        }
        
        // 3. Check customer_message field (where edit details are stored)
        console.log('\n📋 [3] Checking customer_message field...');
        const shopper = await pool.query(
            `SELECT customer_message, response_count, last_response_at 
             FROM store_shoppers WHERE order_id = '55622'`
        );
        
        if (shopper.rows.length > 0) {
            const s = shopper.rows[0];
            console.log(`   response_count: ${s.response_count}`);
            console.log(`   last_response_at: ${s.last_response_at}`);
            console.log(`   customer_message: ${s.customer_message || '(empty)'}`);
            
            if (s.customer_message) {
                console.log('\n   ✅ Customer edit details FOUND in customer_message field!');
                console.log('   This is the message the customer typed when editing details.');
            }
        }
        
        // 4. Check conversations table
        console.log('\n📋 [4] Checking conversations table...');
        const convs = await pool.query(
            `SELECT * FROM conversations 
             WHERE customer_phone = $1 OR customer_phone = $2 OR customer_phone = $3
             ORDER BY updated_at DESC LIMIT 5`,
            [goodPhone, webhookPhone, formattedPhone]
        );
        
        if (convs.rows.length > 0) {
            console.log(`   ✅ Found ${convs.rows.length} conversation(s):`);
            for (const c of convs.rows) {
                console.log(`      Phone: ${c.customer_phone} | State: ${c.state} | Context: ${c.context || 'N/A'}`);
            }
        } else {
            console.log('   ❌ No conversations found');
        }
        
        // 5. Summary
        console.log('\n' + '='.repeat(70));
        console.log('SUMMARY:');
        console.log('='.repeat(70));
        console.log(`Phone fixed in store_shoppers: ${updateResult.rows.length > 0 ? 'YES' : 'NO'}`);
        console.log(`Customer message exists: ${shopper.rows[0]?.customer_message ? 'YES' : 'NO'}`);
        console.log(`Messages in messages table: Check above for all formats`);
        console.log('');
        console.log('NOTE: The customer\'s edit details are stored in');
        console.log('store_shoppers.customer_message, NOT in the messages table.');
        console.log('This is by design for the "Edit Details" flow.');
        
    } finally {
        await pool.end();
    }
    process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
