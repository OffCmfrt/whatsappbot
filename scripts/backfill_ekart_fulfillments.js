/**
 * One-shot backfill: Ekart orders shipped before the fulfillment sync existed
 * were never marked fulfilled in Shopify (Ekart has no Shopify channel).
 * This posts the fulfillment + AWB for every Ekart shipment found locally.
 *
 * Usage:
 *   node scripts/backfill_ekart_fulfillments.js           # dry run (report only)
 *   node scripts/backfill_ekart_fulfillments.js --apply   # actually sync to Shopify
 */
require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');
const shopifyService = require('../src/services/shopifyService');

const APPLY = process.argv.includes('--apply');

async function main() {
    await initializeDatabase();

    // One row per order: the latest non-failed Ekart shipment wins
    const rows = await dbAdapter.query(`
        SELECT DISTINCT ON (s.order_id)
               s.order_id, s.awb, s.courier_name, s.tracking_url, s.status, s.created_at
        FROM shipments s
        WHERE s.carrier = 'ekart'
          AND s.awb IS NOT NULL
          AND s.status NOT IN ('failed', 'cancelled')
        ORDER BY s.order_id, s.id DESC
    `);

    console.log(`\n📦 Ekart shipments to consider: ${rows.length}${APPLY ? '' : ' (DRY RUN — pass --apply to sync)'}\n`);
    if (rows.length === 0) process.exit(0);

    let synced = 0, skipped = 0, failed = 0;
    for (const r of rows) {
        const label = `${String(r.order_id).padEnd(12)} AWB ${String(r.awb).padEnd(16)} (${r.status})`;
        if (!APPLY) {
            console.log(`  • ${label} — would sync`);
            continue;
        }
        const res = await shopifyService.syncFulfillment(r.order_id, {
            awb: r.awb,
            courierName: r.courier_name,
            trackingUrl: r.tracking_url,
            notifyCustomer: false // historical orders — don't re-email customers
        });
        if (res.success) {
            console.log(`  ✅ ${label} — ${res.action}`);
            synced++;
        } else {
            console.log(`  ⚠️ ${label} — ${res.warning}`);
            if (/not found in Shopify|already tracks/i.test(res.warning || '')) skipped++;
            else failed++;
        }
    }

    if (APPLY) console.log(`\nDone: ${synced} synced, ${skipped} skipped, ${failed} failed`);
    else console.log(`\nDry run complete — re-run with --apply to sync these to Shopify`);
    process.exit(0);
}

main().catch(err => { console.error('💥', err); process.exit(1); });
