/**
 * Re-ship all confirmed shoppers since July 25 via Ekart.
 * - If already shipped manually → Ekart rejects "already exists" → we mark as synced
 * - If not shipped → creates new shipment → we get AWB
 * - If validation error → we log it for manual fix
 */
require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');
const { ship } = require('../src/services/shippingService');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    await initializeDatabase();

    const shippedExpr = `(o.awb IS NOT NULL OR o.status = 'shipped')`;

    // Get all confirmed shoppers since July 25 with no AWB
    const confirmedShoppers = await dbAdapter.query(`
        SELECT s.id, s.phone, s.order_id, s.status, s.created_at, s.name, s.address,
               s.city, s.province, s.zip, s.country, s.items_json, s.payment_method,
               s.order_total, s.email,
               o.awb, o.status AS order_status, o.courier_name
        FROM store_shoppers s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.status = 'confirmed'
          AND NOT COALESCE(${shippedExpr}, false)
          AND s.created_at >= '2026-07-25'
        ORDER BY s.created_at ASC
    `) || [];

    console.log(`\n Found ${confirmedShoppers.length} confirmed shoppers to sync\n`);

    if (confirmedShoppers.length === 0) {
        console.log('✅ Nothing to sync');
        process.exit(0);
    }

    let shipped = 0;
    let alreadyExists = 0;
    let failed = 0;
    let errors = [];

    for (const shopper of confirmedShoppers) {
        const orderId = shopper.order_id;
        console.log(`\n🔄 Order ${orderId} (shopper: ${shopper.id})...`);

        try {
            const result = await ship({
                shopperId: shopper.id,
                carrier: 'ekart',
                notifyCustomer: false,
                shippedBy: 'sync_script'
            });

            if (result.error) {
                const errMsg = result.error.toLowerCase();

                // Check if Ekart says "already exists" or similar
                if (errMsg.includes('already') || errMsg.includes('exists') || errMsg.includes('duplicate')) {
                    console.log(`  ⚠️ Already exists in Ekart: ${result.error.substring(0, 100)}`);
                    alreadyExists++;
                } else {
                    console.log(`  ❌ Failed: ${result.error.substring(0, 150)}`);
                    failed++;
                    errors.push({ orderId, error: result.error.substring(0, 200) });
                }
            } else {
                const awb = result.data?.awb || 'unknown';
                console.log(`  ✅ Shipped! AWB: ${awb}`);
                shipped++;
            }
        } catch (err) {
            console.log(`  ❌ Exception: ${err.message.substring(0, 150)}`);
            failed++;
            errors.push({ orderId, error: err.message.substring(0, 200) });
        }

        // Rate limiting
        await sleep(1000);
    }

    console.log(`\n\n📊 Sync Summary:`);
    console.log(`  ✅ Newly shipped: ${shipped}`);
    console.log(`  ⚠️ Already in Ekart: ${alreadyExists}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log(`  📦 Total processed: ${confirmedShoppers.length}`);

    if (errors.length > 0) {
        console.log(`\n❌ Failed orders:`);
        for (const e of errors.slice(0, 20)) {
            console.log(`  Order ${e.orderId}: ${e.error}`);
        }
        if (errors.length > 20) {
            console.log(`  ... and ${errors.length - 20} more`);
        }
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
