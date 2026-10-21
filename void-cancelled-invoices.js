/**
 * Cleanup script: Void Zoho invoices for already-cancelled Shopify orders.
 * 
 * This script finds all orders that were cancelled in Shopify (shopify_cancelled_at
 * is set in store_shoppers) but still have live invoices in Zoho, and voids them.
 * 
 * Usage:
 *   node void-cancelled-invoices.js [--dry-run]
 * 
 * Options:
 *   --dry-run   Show what would be voided without actually voiding
 */

require('dotenv').config();
const zohoService = require('./src/services/zohoService');
const { dbAdapter, pool } = require('./src/database/db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    console.log(`\n🔍 Finding cancelled orders with live Zoho invoices...${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

    // Step 1: Find all orders marked as cancelled in store_shoppers
    const cancelledOrders = await dbAdapter.query(`
        SELECT DISTINCT order_id, shopify_cancelled_at
        FROM store_shoppers
        WHERE shopify_cancelled_at IS NOT NULL
        ORDER BY shopify_cancelled_at DESC
    `);

    console.log(`📋 Found ${cancelledOrders.length} cancelled orders in store_shoppers\n`);

    if (cancelledOrders.length === 0) {
        console.log('✅ No cancelled orders found. Nothing to do.');
        await pool.end();
        return;
    }

    let voidedCount = 0;
    let alreadyVoidedCount = 0;
    let notFoundCount = 0;
    let failedCount = 0;
    let skippedPaidCount = 0;
    const skippedPaidOrders = [];

    for (const order of cancelledOrders) {
        const orderId = order.order_id.replace(/^#/, '');
        process.stdout.write(`  Processing order #${orderId}... `);

        try {
            // Step 2: Search for invoices in Zoho by reference_number
            const invoices = await zohoService.searchInvoice({ reference_number: orderId });

            if (invoices.length === 0) {
                console.log('no invoice in Zoho');
                notFoundCount++;
                continue;
            }

            // Step 3: Void each non-void invoice (but skip paid invoices)
            for (const inv of invoices) {
                if (inv.status === 'void' || inv.status === 'deleted') {
                    console.log(`invoice ${inv.invoice_id} already ${inv.status}`);
                    alreadyVoidedCount++;
                    continue;
                }

                // Skip paid/partially paid invoices — these need manual review
                if (inv.status === 'paid' || inv.status === 'partially_paid') {
                    console.log(`⚠️  SKIPPING invoice ${inv.invoice_id} (status: ${inv.status}) — requires manual review`);
                    skippedPaidCount++;
                    skippedPaidOrders.push({ orderId, invoiceId: inv.invoice_id, status: inv.status });
                    continue;
                }

                if (DRY_RUN) {
                    console.log(`[DRY RUN] would void invoice ${inv.invoice_id} (status: ${inv.status})`);
                    voidedCount++;
                } else {
                    try {
                        await zohoService.voidInvoice(inv.invoice_id);
                        console.log(`✅ voided invoice ${inv.invoice_id} (was: ${inv.status})`);
                        voidedCount++;
                    } catch (voidErr) {
                        console.error(`❌ failed to void invoice ${inv.invoice_id}: ${voidErr.message}`);
                        failedCount++;
                    }
                }
            }

            // Step 4: Update sync_log to mark as cancelled (if not already)
            if (!DRY_RUN) {
                await dbAdapter.run(
                    `UPDATE zoho_sync_log
                     SET status = 'cancelled',
                         error_message = 'Order cancelled — invoice voided by cleanup script',
                         updated_at = NOW()
                     WHERE shopify_order_id = ?
                       AND status NOT IN ('cancelled')`,
                    [orderId]
                );

                // If no row was updated, insert a cancel guard row
                const check = await dbAdapter.query(
                    `SELECT id FROM zoho_sync_log
                     WHERE shopify_order_id = ? AND status = 'cancelled'`,
                    [orderId]
                );

                if (check.length === 0) {
                    await dbAdapter.run(
                        `INSERT INTO zoho_sync_log (shopify_order_id, status, error_message, created_at, updated_at)
                         VALUES (?, 'cancelled', 'Order cancelled — invoice voided by cleanup script', NOW(), NOW())`,
                        [orderId]
                    );
                }
            }
        } catch (err) {
            console.error(`❌ error processing order #${orderId}: ${err.message}`);
            failedCount++;
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Summary:');
    console.log(`   Total cancelled orders: ${cancelledOrders.length}`);
    console.log(`   Invoices voided: ${voidedCount}`);
    console.log(`   Already voided/deleted: ${alreadyVoidedCount}`);
    console.log(`   No invoice found: ${notFoundCount}`);
    console.log(`   Skipped (paid/partially paid): ${skippedPaidCount}`);
    console.log(`   Failed: ${failedCount}`);
    console.log('='.repeat(60));

    if (skippedPaidOrders.length > 0) {
        console.log('\n⚠️  PAID INVOICES REQUIRING MANUAL REVIEW:');
        skippedPaidOrders.forEach(({ orderId, invoiceId, status }) => {
            console.log(`   Order #${orderId} → Invoice ${invoiceId} (${status})`);
        });
        console.log('\nThese invoices have payments recorded and were NOT voided.');
        console.log('You may need to issue refunds or create credit notes manually.\n');
    }

    console.log();

    await pool.end();
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    pool.end().then(() => process.exit(1));
});
