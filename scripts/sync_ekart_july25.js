/**
 * One-off: Force-sync Ekart shipments from July 25 that are stuck at
 * pre-shipment statuses but have actually been shipped at Ekart's end.
 *
 * Usage:  node scripts/sync_ekart_july25.js
 */

require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');
const ekartAdapter = require('../src/services/carriers/ekartAdapter');
const { mapCarrierStatus, resolveTransition } = require('../src/services/shipmentSyncService');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('🔧 Initializing database...');
    await initializeDatabase();

    // Find Ekart shipments from July 25 range still in non-terminal statuses
    const { rows } = await dbAdapter.query(`
        SELECT s.id, s.order_id, s.awb, s.status, s.created_at,
               o.status AS order_status
        FROM shipments s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.carrier = 'ekart'
          AND s.created_at >= '2026-07-25'
          AND s.created_at < '2026-08-02'
          AND s.status IN ('created', 'awb_assigned', 'pickup_scheduled', 'shipped')
        ORDER BY s.created_at ASC
    `);

    if (!rows || rows.length === 0) {
        console.log('✅ No stuck Ekart shipments found for July 25 range.');
        process.exit(0);
    }

    console.log(`\n📋 Found ${rows.length} Ekart shipment(s) to sync:\n`);
    console.log('─'.repeat(100));
    console.log(
        '#'.padEnd(5),
        'Order ID'.padEnd(24),
        'AWB'.padEnd(18),
        'DB Status'.padEnd(18),
        'Order Status'.padEnd(18),
        'Created'
    );
    console.log('─'.repeat(100));
    for (const r of rows) {
        console.log(
            String(r.id).padEnd(5),
            String(r.order_id).padEnd(24),
            String(r.awb || 'NO-AWB').padEnd(18),
            String(r.status).padEnd(18),
            String(r.order_status || '—').padEnd(18),
            String(r.created_at).substring(0, 10)
        );
    }
    console.log('─'.repeat(100));

    let updated = 0, skipped = 0, errors = 0;

    for (const shipment of rows) {
        if (!shipment.awb) {
            console.log(`\n⏭️  #${shipment.id} (${shipment.order_id}) — No AWB assigned, skipping`);
            skipped++;
            continue;
        }

        console.log(`\n🔍 Tracking AWB ${shipment.awb} (order ${shipment.order_id}, current: ${shipment.status})...`);

        try {
            const result = await ekartAdapter.track(shipment.awb);

            if (!result.success) {
                console.log(`   ❌ Track failed: ${result.error}`);
                errors++;
                await sleep(300);
                continue;
            }

            const carrierStatus = result.data.currentStatus;
            const expectedDelivery = result.data.expectedDelivery;
            const mapped = mapCarrierStatus(carrierStatus);

            console.log(`   📡 Carrier says: "${carrierStatus}" → mapped: "${mapped || 'no-change'}"`);

            // Show latest tracking event
            if (result.data.timeline && result.data.timeline.length > 0) {
                const latest = result.data.timeline[0];
                console.log(`   📍 Latest scan: ${latest.date ? latest.date.substring(0, 16) : '?'} — ${latest.activity} (${latest.location})`);
            }

            const newStatus = resolveTransition(shipment.status, mapped);

            if (!newStatus) {
                console.log(`   ✅ Already in sync (no transition needed)`);
                skipped++;
                await sleep(300);
                continue;
            }

            console.log(`   🔄 Transition: ${shipment.status} → ${newStatus}`);

            // Update shipment row
            await dbAdapter.update('shipments', {
                status: newStatus,
                updated_at: new Date().toISOString()
            }, { id: shipment.id });

            // Mirror onto orders row for hub-wide visibility
            if (newStatus === 'delivered') {
                await dbAdapter.query(
                    `UPDATE orders SET status = 'delivered', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                    [shipment.order_id, shipment.awb]
                );
            } else if (newStatus === 'rto') {
                await dbAdapter.query(
                    `UPDATE orders SET status = 'rto', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                    [shipment.order_id, shipment.awb]
                );
            } else if (newStatus === 'cancelled') {
                await dbAdapter.query(
                    `UPDATE orders SET awb = NULL, courier_name = NULL, tracking_url = NULL, status = 'cancelled_shipment', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                    [shipment.order_id, shipment.awb]
                );
            } else if (expectedDelivery) {
                await dbAdapter.query(
                    `UPDATE orders SET expected_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                    [String(expectedDelivery).substring(0, 100), shipment.order_id, shipment.awb]
                );
            }

            // Also update the order status to 'shipped' if it was still 'confirmed'
            if (['in_transit', 'shipped', 'pickup_scheduled'].includes(newStatus)) {
                const orderCheck = await dbAdapter.query(
                    `SELECT status FROM orders WHERE order_id = ?`,
                    [shipment.order_id]
                );
                const currentOrderStatus = orderCheck.rows?.[0]?.status;
                if (currentOrderStatus === 'confirmed') {
                    await dbAdapter.query(
                        `UPDATE orders SET status = 'shipped', updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`,
                        [shipment.order_id]
                    );
                    console.log(`   📦 Order row also updated: confirmed → shipped`);
                }
            }

            console.log(`   ✅ Updated successfully`);
            updated++;
        } catch (error) {
            console.error(`   ❌ Error: ${error.message}`);
            errors++;
        }

        await sleep(400); // rate limit between Ekart API calls
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`📊 Sync complete: ${updated} updated, ${skipped} skipped, ${errors} errors`);
    console.log('═'.repeat(60));

    process.exit(0);
}

main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
});
