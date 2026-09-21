/**
 * Fix backfilled shopper timestamps that are 5.5 hours AHEAD of actual UTC.
 *
 * The earlier correction added +5:30 to rows that already needed the opposite
 * shift. This subtracts INTERVAL '5 hours 30 minutes' from every backfilled row.
 *
 * Usage:
 *   node tmp/fix_backfill_timestamps.js            # dry run — shows affected rows
 *   node tmp/fix_backfill_timestamps.js --apply     # apply the correction
 */

require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');

const APPLY = process.argv.includes('--apply');

async function main() {
    await initializeDatabase();

    // Show current state of backfilled rows before fixing
    const before = await dbAdapter.query(
        `SELECT id, order_id, created_at, updated_at
         FROM store_shoppers
         WHERE id LIKE 'shop_backfill_%'
         ORDER BY created_at DESC`
    );

    console.log(`Found ${before.length} backfilled rows`);
    if (before.length === 0) {
        console.log('Nothing to fix.');
        return;
    }

    console.log('\n--- BEFORE (sample) ---');
    for (const row of before.slice(0, 5)) {
        console.log(`  ${row.order_id} | created_at: ${row.created_at} | updated_at: ${row.updated_at}`);
    }
    if (before.length > 5) console.log(`  ... and ${before.length - 5} more`);

    if (!APPLY) {
        console.log('\nDry run — add --apply to subtract 5h30m from all backfilled rows.');
        return;
    }

    await dbAdapter.query(
        `UPDATE store_shoppers
         SET created_at = created_at - INTERVAL '5 hours 30 minutes',
             updated_at = updated_at - INTERVAL '5 hours 30 minutes',
             shopify_cancelled_at = shopify_cancelled_at - INTERVAL '5 hours 30 minutes'
         WHERE id LIKE 'shop_backfill_%'`
    );

    // Verify
    const after = await dbAdapter.query(
        `SELECT id, order_id, created_at, updated_at
         FROM store_shoppers
         WHERE id LIKE 'shop_backfill_%'
         ORDER BY created_at DESC`
    );

    console.log('\n--- AFTER (sample) ---');
    for (const row of after.slice(0, 5)) {
        console.log(`  ${row.order_id} | created_at: ${row.created_at} | updated_at: ${row.updated_at}`);
    }
    if (after.length > 5) console.log(`  ... and ${after.length - 5} more`);

    console.log(`\nFixed ${after.length} row(s). All timestamps shifted back by 5h 30m.`);
}

main().catch(err => {
    console.error(`Fix failed: ${err.message}`);
    process.exitCode = 1;
});
