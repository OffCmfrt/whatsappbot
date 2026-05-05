/**
 * Migration Script: Fix Payment Methods for Existing Orders
 * 
 * This script queries Shopify to get the actual payment gateway for orders
 * that are currently marked as "Prepaid" and updates them correctly.
 */

require('dotenv').config();
const { dbAdapter } = require('./src/database/db');
const shopifyService = require('./src/services/shopifyService');

async function fixPaymentMethods() {
    console.log('🚀 Starting payment method migration...\n');

    try {
        // Get all orders marked as "Prepaid"
        const prepaidOrders = await dbAdapter.query(`
            SELECT id, order_id, phone 
            FROM store_shoppers 
            WHERE payment_method = 'Prepaid'
            ORDER BY created_at DESC
        `);

        console.log(`📊 Found ${prepaidOrders.length} orders marked as "Prepaid"\n`);

        if (prepaidOrders.length === 0) {
            console.log('✅ No orders to fix. Exiting...');
            process.exit(0);
        }

        let updated = 0;
        let failed = 0;
        let skipped = 0;

        // Process in batches to avoid overwhelming Shopify API
        const batchSize = 10;
        for (let i = 0; i < prepaidOrders.length; i += batchSize) {
            const batch = prepaidOrders.slice(i, i + batchSize);
            
            console.log(`\n📦 Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} orders)...`);

            const updatePromises = batch.map(async (shopper) => {
                try {
                    // Query Shopify for the order details
                    const shopifyOrder = await shopifyService.getOrderById(shopper.order_id);

                    if (!shopifyOrder) {
                        console.log(`  ⚠️ Order ${shopper.order_id}: Not found in Shopify, skipping`);
                        skipped++;
                        return;
                    }

                    // Extract payment gateway information
                    const gateway = shopifyOrder.gateway || 
                                   (shopifyOrder.payment_gateway_names && shopifyOrder.payment_gateway_names[0]) || 
                                   'Unknown';

                    // Determine correct payment method
                    let correctPaymentMethod = 'Prepaid';
                    if (gateway && typeof gateway === 'string') {
                        const gatewayLower = gateway.toLowerCase();
                        if (gatewayLower.includes('cod') || 
                            gatewayLower.includes('cash on delivery') || 
                            gatewayLower.includes('cash_on_delivery') ||
                            gatewayLower === 'manual') {
                            correctPaymentMethod = 'COD';
                        }
                    }

                    // Only update if different
                    if (correctPaymentMethod !== 'Prepaid') {
                        await dbAdapter.query(`
                            UPDATE store_shoppers 
                            SET payment_method = ?, updated_at = datetime('now')
                            WHERE id = ?
                        `, [correctPaymentMethod, shopper.id]);

                        console.log(`  ✅ Order ${shopper.order_id}: "Prepaid" → "${correctPaymentMethod}" (gateway: ${gateway})`);
                        updated++;
                    } else {
                        console.log(`  ✓ Order ${shopper.order_id}: Confirmed as Prepaid (gateway: ${gateway})`);
                        skipped++;
                    }

                } catch (error) {
                    console.error(`  ❌ Order ${shopper.order_id}: Error - ${error.message}`);
                    failed++;
                }
            });

            // Wait for batch to complete
            await Promise.all(updatePromises);

            // Add delay between batches to avoid rate limiting
            if (i + batchSize < prepaidOrders.length) {
                console.log('  ⏳ Waiting 2 seconds before next batch...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('📊 Migration Summary:');
        console.log('='.repeat(60));
        console.log(`Total processed: ${prepaidOrders.length}`);
        console.log(`✅ Updated to COD: ${updated}`);
        console.log(`✓ Confirmed Prepaid: ${skipped}`);
        console.log(`❌ Failed: ${failed}`);
        console.log('='.repeat(60));

    } catch (error) {
        console.error('❌ Migration failed:', error);
        console.error(error.stack);
    } finally {
        process.exit(0);
    }
}

// Run migration
fixPaymentMethods();
