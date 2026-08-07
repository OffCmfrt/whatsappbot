/**
 * Backfill delivered_at for orders/shipments already marked delivered.
 *
 * Before this column existed, the return/exchange eligibility check measured
 * the 2-day window from the ORDER DATE instead of the delivery date — wrongly
 * rejecting fresh deliveries (e.g. order 41662 delivered today). The status
 * sync stamps updated_at at the exact moment it marks a row delivered, so for
 * historical rows updated_at is the best available proxy for the delivery time.
 *
 * Usage:
 *   node scripts/backfill_delivered_at.js            # dry run (report only)
 *   node scripts/backfill_delivered_at.js --apply    # write to the DB
 */

require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');

const APPLY = process.argv.includes('--apply');

async function main() {
    // Ensures the delivered_at columns exist before we touch them
    await initializeDatabase();

    const orders = await dbAdapter.query(`
        SELECT order_id, status, created_at, updated_at, delivered_at
        FROM orders
        WHERE LOWER(status) LIKE '%delivered%' AND delivered_at IS NULL
        ORDER BY updated_at DESC
    `);
    const shipments = await dbAdapter.query(`
        SELECT id, order_id, awb, updated_at, delivered_at
        FROM shipments
        WHERE status = 'delivered' AND delivered_at IS NULL
        ORDER BY updated_at DESC
    `);

    console.log(`${APPLY ? '🔧 APPLY' : '👀 DRY RUN'} — backfilling delivered_at from updated_at`);
    console.log(`   orders missing delivered_at    : ${orders.length}`);
    console.log(`   shipments missing delivered_at : ${shipments.length}`);
    console.log('');

    for (const o of orders) {
        const flag = o.order_id === '41660' || o.order_id === '41662' ? ' ⬅️  affected customer order' : '';
        console.log(`   order ${o.order_id}: delivered_at → ${o.updated_at}${flag}`);
        if (APPLY) {
            await dbAdapter.query(
                `UPDATE orders SET delivered_at = updated_at WHERE order_id = ? AND delivered_at IS NULL`,
                [o.order_id]
            );
        }
    }

    if (APPLY && shipments.length > 0) {
        await dbAdapter.query(`
            UPDATE shipments SET delivered_at = updated_at
            WHERE status = 'delivered' AND delivered_at IS NULL
        `);
    }

    console.log('');
    if (APPLY) {
        console.log(`✅ Backfilled ${orders.length} orders and ${shipments.length} shipments`);
    } else {
        console.log('Dry run complete — re-run with --apply to write the changes');
    }
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('❌ Backfill failed:', err.message);
        process.exit(1);
    });
