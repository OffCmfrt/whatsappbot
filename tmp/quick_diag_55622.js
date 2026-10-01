/**
 * Quick diagnostic for Order 55622 - bypasses heavy DB init
 */
require('dotenv').config();
const { Pool } = require('pg');

const ORDER_ID = process.argv.find(arg => arg.startsWith('--order='))?.split('=')[1] || '55622';

async function main() {
    const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    
    console.log('='.repeat(70));
    console.log(`QUICK DIAGNOSIS: Order #${ORDER_ID}`);
    console.log('='.repeat(70));
    
    try {
        // 1. Check store_shoppers
        console.log('\n📋 [1] store_shoppers table...');
        const shoppers = await pool.query(
            `SELECT id, phone, name, order_id, status, created_at 
             FROM store_shoppers 
             WHERE order_id = $1 OR order_id = $2`,
            [ORDER_ID, `#${ORDER_ID}`]
        );
        
        if (shoppers.rows.length === 0) {
            console.log('   ❌ NOT FOUND - Order not imported from Shopify!');
            console.log('\n💡 SOLUTION: Run backfill script:');
            console.log('   node scripts/backfill_shopify_shoppers.js --hours=72 --apply');
        } else {
            console.log(`   ✅ Found ${shoppers.rows.length} record(s):`);
            for (const s of shoppers.rows) {
                console.log(`      Phone: ${s.phone} | Name: ${s.name} | Status: ${s.status}`);
                
                // 2. Check messages
                console.log(`\n📋 [2] Messages for ${s.phone}...`);
                const cleanPhone = s.phone.replace(/\D/g, '');
                const variations = [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`];
                
                const msgs = await pool.query(
                    `SELECT COUNT(*) as count, MIN(created_at) as first_msg, MAX(created_at) as last_msg
                     FROM messages WHERE customer_phone = ANY($1)`,
                    [variations]
                );
                
                if (msgs.rows[0].count === '0') {
                    console.log('   ⚠️  NO MESSAGES - Customer never messaged on WhatsApp');
                } else {
                    console.log(`   ✅ ${msgs.rows[0].count} message(s) | First: ${msgs.rows[0].first_msg} | Last: ${msgs.rows[0].last_msg}`);
                }
                
                // 3. Check customers table
                console.log(`\n📋 [3] customers table...`);
                const customers = await pool.query(
                    `SELECT phone, name FROM customers WHERE phone = ANY($1)`,
                    [variations]
                );
                console.log(customers.rows.length ? `   ✅ ${customers.rows[0].name} (${customers.rows[0].phone})` : '   ⚠️  Not in customers table');
                
                // 4. Check orders table
                console.log(`\n📋 [4] orders table...`);
                const orders = await pool.query(
                    `SELECT order_id, customer_phone, status, awb FROM orders WHERE order_id = $1 OR order_id = $2`,
                    [ORDER_ID, `#${ORDER_ID}`]
                );
                console.log(orders.rows.length ? `   ✅ ${orders.rows.map(o => `${o.order_id} | ${o.customer_phone} | ${o.status} | AWB:${o.awb || 'N/A'}`).join('\n      ')}` : '   ⚠️  Not in orders table');
            }
        }
        
        console.log('\n' + '='.repeat(70));
    } finally {
        await pool.end();
    }
    process.exit(0);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
