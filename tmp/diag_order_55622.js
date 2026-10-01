/**
 * Diagnostic script for Order 55622 missing chat details
 * 
 * Usage:
 *   node tmp/diag_order_55622.js
 *   node tmp/diag_order_55622.js --order=55622
 */

require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');

const ORDER_ID = process.argv.find(arg => arg.startsWith('--order='))?.split('=')[1] || '55622';

async function diagnose() {
    await initializeDatabase();
    
    console.log('='.repeat(70));
    console.log(`DIAGNOSIS: Order #${ORDER_ID} - Missing Chat Details`);
    console.log('='.repeat(70));
    
    // 1. Check store_shoppers table
    console.log('\n📋 [1/4] Checking store_shoppers table...');
    const shoppers = await dbAdapter.query(
        `SELECT id, phone, name, email, order_id, status, created_at, updated_at 
         FROM store_shoppers 
         WHERE order_id = ? OR order_id = ? OR order_id = ?`,
        [ORDER_ID, `#${ORDER_ID}`, ORDER_ID.toString()]
    );
    
    if (shoppers.length === 0) {
        console.log('   ❌ ORDER NOT FOUND in store_shoppers table!');
        console.log('   → This is the root cause: the order was never imported from Shopify.');
        console.log('   → Run: node scripts/backfill_shopify_shoppers.js --hours=72 --apply');
    } else {
        console.log(`   ✅ Found ${shoppers.length} shopper record(s):`);
        for (const s of shoppers) {
            console.log(`      - ID: ${s.id}`);
            console.log(`        Phone: ${s.phone}`);
            console.log(`        Name: ${s.name}`);
            console.log(`        Status: ${s.status}`);
            console.log(`        Created: ${s.created_at}`);
            
            // 2. Check messages for this phone
            console.log(`\n📋 [2/4] Checking messages for phone: ${s.phone}...`);
            const cleanPhone = s.phone.replace(/\D/g, '');
            const phoneVariations = [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`];
            
            const messages = await dbAdapter.query(
                `SELECT COUNT(*) as count, MIN(created_at) as first_msg, MAX(created_at) as last_msg
                 FROM messages 
                 WHERE customer_phone IN (?, ?, ?, ?)`,
                phoneVariations
            );
            
            const msgCount = messages[0]?.count || 0;
            if (msgCount === 0) {
                console.log('   ⚠️  NO MESSAGES found for this phone number!');
                console.log('   → The customer has never messaged on WhatsApp.');
                console.log('   → This is expected behavior if no conversation occurred.');
            } else {
                console.log(`   ✅ Found ${msgCount} message(s):`);
                console.log(`      First message: ${messages[0].first_msg}`);
                console.log(`      Last message: ${messages[0].last_msg}`);
                
                // Show sample messages
                const sampleMsgs = await dbAdapter.query(
                    `SELECT message_type, message_content, created_at 
                     FROM messages 
                     WHERE customer_phone IN (?, ?, ?, ?)
                     ORDER BY created_at DESC LIMIT 3`,
                    phoneVariations
                );
                console.log('   Recent messages:');
                for (const m of sampleMsgs) {
                    const preview = (m.message_content || '').substring(0, 50);
                    console.log(`      [${m.message_type}] ${preview}... (${m.created_at})`);
                }
            }
            
            // 3. Check customers table
            console.log(`\n📋 [3/4] Checking customers table...`);
            const customers = await dbAdapter.query(
                `SELECT phone, name, email, created_at 
                 FROM customers 
                 WHERE phone IN (?, ?, ?, ?)`,
                phoneVariations
            );
            
            if (customers.length === 0) {
                console.log('   ⚠️  Customer NOT in customers table!');
                console.log('   → Phone may not have triggered a WhatsApp conversation yet.');
            } else {
                console.log(`   ✅ Found customer: ${customers[0].name} (${customers[0].phone})`);
            }
            
            // 4. Check orders table
            console.log(`\n📋 [4/4] Checking orders table...`);
            const orders = await dbAdapter.query(
                `SELECT order_id, customer_phone, status, awb, created_at 
                 FROM orders 
                 WHERE order_id = ? OR order_id = ? OR customer_phone IN (?, ?, ?, ?)`,
                [ORDER_ID, `#${ORDER_ID}`, ...phoneVariations]
            );
            
            if (orders.length === 0) {
                console.log('   ⚠️  Order NOT in orders table!');
                console.log('   → Order may not have been shipped yet (only shipped orders sync to orders table).');
            } else {
                console.log(`   ✅ Found ${orders.length} order record(s):`);
                for (const o of orders) {
                    console.log(`      - Order: ${o.order_id}, Phone: ${o.customer_phone}, Status: ${o.status}, AWB: ${o.awb || 'N/A'}`);
                }
            }
        }
    }
    
    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY & RECOMMENDATIONS');
    console.log('='.repeat(70));
    
    if (shoppers.length === 0) {
        console.log('🔴 ROOT CAUSE: Order not imported from Shopify');
        console.log('');
        console.log('SOLUTION:');
        console.log('1. Run the backfill script to recover missing shoppers:');
        console.log('   node scripts/backfill_shopify_shoppers.js --hours=72 --apply');
        console.log('');
        console.log('2. If the order is older than 72 hours, specify a custom range:');
        console.log('   node scripts/backfill_shopify_shoppers.js --since=2026-09-01T00:00:00Z --until=2026-09-26T23:59:59Z --apply');
    } else {
        const shopper = shoppers[0];
        const cleanPhone = shopper.phone.replace(/\D/g, '');
        const phoneVariations = [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`];
        
        const messages = await dbAdapter.query(
            `SELECT COUNT(*) as count FROM messages WHERE customer_phone IN (?, ?, ?, ?)`,
            phoneVariations
        );
        
        if (messages[0]?.count === 0) {
            console.log('🟡 ROOT CAUSE: Customer has not messaged on WhatsApp');
            console.log('');
            console.log('The order exists in the system, but no WhatsApp conversation has occurred.');
            console.log('This is expected if the customer hasn\'t initiated contact.');
            console.log('');
            console.log('If you need to contact the customer:');
            console.log(`→ Phone: ${shopper.phone}`);
            console.log('→ Use the dashboard to send a proactive message.');
        } else {
            console.log('🟢 Messages exist but may not be visible due to:');
            console.log('   - Phone number format mismatch in database');
            console.log('   - Dashboard filtering issue');
            console.log('');
            console.log('Check the phone variations in the messages table.');
        }
    }
    
    console.log('\n' + '='.repeat(70));
    process.exit(0);
}

diagnose().catch(err => {
    console.error('Diagnosis failed:', err);
    process.exit(1);
});
