/**
 * Bulk void Zoho invoices for cancelled Shopify orders.
 * Processes invoices in parallel batches for speed.
 * 
 * Usage:
 *   node bulk-void-cancelled.js [--dry-run]
 */

require('dotenv').config();
const zohoService = require('./src/services/zohoService');
const { dbAdapter, pool } = require('./src/database/db');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 10; // Process 10 invoices at a time

async function main() {
    console.log(`\n🔍 Bulk void: Finding cancelled orders...${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

    // Get all cancelled orders
    const cancelledOrders = await dbAdapter.query(`
        SELECT DISTINCT order_id
        FROM store_shoppers
        WHERE shopify_cancelled_at IS NOT NULL
    `);

    console.log(`📋 Found ${cancelledOrders.length} cancelled orders\n`);

    if (cancelledOrders.length === 0) {
        console.log('✅ No cancelled orders. Nothing to do.');
        await pool.end();
        return;
    }

    // Step 1: Collect all invoices that need voiding (skip paid ones)
    console.log('🔍 Collecting invoices to void...');
    const invoicesToVoid = [];
    const invoicesToSkip = [];
    let searched = 0;

    for (const order of cancelledOrders) {
        const orderId = order.order_id.replace(/^#/, '');
        searched++;
        
        if (searched % 100 === 0) {
            process.stdout.write(`  Searched ${searched}/${cancelledOrders.length} orders...\n`);
        }

        try {
            const invoices = await zohoService.searchInvoice({ reference_number: orderId });
            
            for (const inv of invoices) {
                if (inv.status === 'void' || inv.status === 'deleted') {
                    continue; // Already voided
                }
                
                if (inv.status === 'paid' || inv.status === 'partially_paid') {
                    invoicesToSkip.push({ orderId, invoiceId: inv.invoice_id, status: inv.status });
                    continue; // Skip paid invoices
                }
                
                invoicesToVoid.push({ orderId, invoiceId: inv.invoice_id, status: inv.status });
            }
        } catch (err) {
            console.error(`  ⚠️  Error searching order #${orderId}: ${err.message}`);
        }
    }

    console.log(`\n📊 Collection complete:`);
    console.log(`   Invoices to void: ${invoicesToVoid.length}`);
    console.log(`   Invoices to skip (paid): ${invoicesToSkip.length}`);
    console.log();

    if (invoicesToVoid.length === 0) {
        console.log('✅ No invoices need voiding.');
        await pool.end();
        return;
    }

    // Step 2: Void invoices in batches
    if (DRY_RUN) {
        console.log('[DRY RUN] Would void these invoices:');
        invoicesToVoid.slice(0, 20).forEach(({ orderId, invoiceId, status }) => {
            console.log(`  Order #${orderId} → Invoice ${invoiceId} (${status})`);
        });
        if (invoicesToVoid.length > 20) {
            console.log(`  ... and ${invoicesToVoid.length - 20} more`);
        }
    } else {
        console.log(`⚡ Voiding ${invoicesToVoid.length} invoices in batches of ${BATCH_SIZE}...`);
        let voided = 0;
        let failed = 0;

        for (let i = 0; i < invoicesToVoid.length; i += BATCH_SIZE) {
            const batch = invoicesToVoid.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(({ orderId, invoiceId }) => 
                    zohoService.voidInvoice(invoiceId).catch(err => {
                        throw new Error(`Order #${orderId} invoice ${invoiceId}: ${err.message}`);
                    })
                )
            );

            results.forEach((result, idx) => {
                if (result.status === 'fulfilled') {
                    voided++;
                } else {
                    failed++;
                    console.error(`  ❌ ${result.reason.message}`);
                }
            });

            const progress = Math.min(i + BATCH_SIZE, invoicesToVoid.length);
            process.stdout.write(`\r  Progress: ${progress}/${invoicesToVoid.length} voided (${voided} success, ${failed} failed)`);
        }

        console.log(`\n\n✅ Voiding complete: ${voided} succeeded, ${failed} failed\n`);
    }

    // Step 3: Update sync_log for all voided orders
    if (!DRY_RUN) {
        console.log('📝 Updating sync_log...');
        const orderIds = [...new Set(invoicesToVoid.map(inv => inv.orderId))];
        
        for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
            const batch = orderIds.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(orderId => 
                dbAdapter.run(`
                    UPDATE zoho_sync_log
                    SET status = 'cancelled',
                        error_message = 'Order cancelled — invoice voided (bulk)',
                        updated_at = NOW()
                    WHERE shopify_order_id = ?
                      AND status NOT IN ('cancelled')
                `, [orderId]).catch(() => {})
            ));
            
            // Insert cancel guard rows for orders not in sync_log
            await Promise.all(batch.map(orderId =>
                dbAdapter.run(`
                    INSERT INTO zoho_sync_log (shopify_order_id, status, error_message, created_at, updated_at)
                    SELECT ?, 'cancelled', 'Order cancelled — invoice voided (bulk)', NOW(), NOW()
                    WHERE NOT EXISTS (
                        SELECT 1 FROM zoho_sync_log WHERE shopify_order_id = ?
                    )
                `, [orderId, orderId]).catch(() => {})
            ));
            
            process.stdout.write(`\r  Updated ${Math.min(i + BATCH_SIZE, orderIds.length)}/${orderIds.length} sync_log entries`);
        }
        console.log('\n');
    }

    // Summary
    console.log('='.repeat(60));
    console.log('📊 FINAL SUMMARY:');
    console.log(`   Total cancelled orders: ${cancelledOrders.length}`);
    console.log(`   Invoices ${DRY_RUN ? 'to void' : 'voided'}: ${invoicesToVoid.length}`);
    console.log(`   Invoices skipped (paid): ${invoicesToSkip.length}`);
    console.log('='.repeat(60));

    if (invoicesToSkip.length > 0) {
        console.log('\n⚠️  PAID INVOICES REQUIRING MANUAL REVIEW:');
        invoicesToSkip.slice(0, 30).forEach(({ orderId, invoiceId, status }) => {
            console.log(`   Order #${orderId} → Invoice ${invoiceId} (${status})`);
        });
        if (invoicesToSkip.length > 30) {
            console.log(`   ... and ${invoicesToSkip.length - 30} more (see full list in logs)`);
        }
        console.log();
    }

    await pool.end();
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    pool.end().then(() => process.exit(1));
});
