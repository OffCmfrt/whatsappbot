/**
 * Bulk void Zoho invoices for cancelled Shopify orders.
 * Uses list-scan approach: paginates ALL invoices (~60 calls at 200/page)
 * then cross-references cancelled orders in memory — avoids per-order API calls.
 * 
 * Usage:
 *   node bulk-void-cancelled.js [--dry-run]
 */

require('dotenv').config();
const zohoService = require('./src/services/zohoService');
const { dbAdapter, pool } = require('./src/database/db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    console.log(`\n🔍 Bulk void: Finding cancelled orders...${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

    // Get all cancelled order IDs from DB
    const cancelledOrders = await dbAdapter.query(`
        SELECT DISTINCT order_id
        FROM store_shoppers
        WHERE shopify_cancelled_at IS NOT NULL
    `);

    const cancelledSet = new Set(cancelledOrders.map(r => r.order_id.replace(/^#/, '')));
    console.log(`📋 Found ${cancelledSet.size} cancelled orders in DB\n`);

    if (cancelledSet.size === 0) {
        console.log('✅ No cancelled orders. Nothing to do.');
        await pool.end();
        return;
    }

    // Step 1: Paginate ALL invoices from Zoho and find matches (list-scan approach)
    console.log('🔍 Scanning all Zoho invoices (list-scan, ~200/page)...');
    const invoicesToVoid = [];
    const invoicesToSkip = [];
    let page = 1;
    let totalScanned = 0;
    let hasMore = true;

    while (hasMore) {
        let invoices;
        try {
            invoices = await zohoService.searchInvoice({ page, per_page: 200 });
            
            if (invoices.length === 0) {
                hasMore = false;
                break;
            }
            
            totalScanned += invoices.length;
            
            // Check each invoice against cancelled orders
            for (const inv of invoices) {
                const refNum = inv.reference_number;
                if (!refNum || !cancelledSet.has(refNum)) continue;
                
                if (inv.status === 'void' || inv.status === 'deleted') {
                    continue; // Already voided
                }
                
                if (inv.status === 'paid' || inv.status === 'partially_paid') {
                    invoicesToSkip.push({ orderId: refNum, invoiceId: inv.invoice_id, status: inv.status });
                    continue; // Skip paid
                }
                
                invoicesToVoid.push({ orderId: refNum, invoiceId: inv.invoice_id, invoiceNumber: inv.invoice_number, status: inv.status });
            }
            
            if (invoices.length < 200) {
                hasMore = false;
            } else {
                page++;
            }
            
            if (page % 10 === 0) {
                process.stdout.write(`  Scanned page ${page} (${totalScanned} invoices so far)...\n`);
            }
        } catch (err) {
            console.error(`  ⚠️  Error on page ${page}: ${err.message}`);
            if (err.message.includes('429') || err.message.includes('rate')) {
                console.log('  ⏳ Rate limited, waiting 30s...');
                await new Promise(r => setTimeout(r, 30000));
                continue; // Retry same page
            }
            hasMore = false;
        }
    }

    console.log(`\n📊 Scan complete: ${totalScanned} invoices scanned across ${page} pages`);
    console.log(`   Invoices to void: ${invoicesToVoid.length}`);
    console.log(`   Invoices to skip (paid): ${invoicesToSkip.length}`);
    console.log();

    if (invoicesToVoid.length === 0) {
        console.log('✅ No invoices need voiding.');
        await pool.end();
        return;
    }

    // Step 2: Void invoices
    if (DRY_RUN) {
        console.log('[DRY RUN] Would void these invoices:');
        invoicesToVoid.slice(0, 20).forEach(({ orderId, invoiceId, status }) => {
            console.log(`  Order #${orderId} → Invoice ${invoiceId} (${status})`);
        });
        if (invoicesToVoid.length > 20) {
            console.log(`  ... and ${invoicesToVoid.length - 20} more`);
        }
    } else {
        console.log(`⚡ Voiding ${invoicesToVoid.length} invoices...`);
        let voided = 0;
        let failed = 0;

        for (const { orderId, invoiceId } of invoicesToVoid) {
            try {
                await zohoService.voidInvoice(invoiceId);
                voided++;
                
                // Update sync_log
                await dbAdapter.run(`
                    UPDATE zoho_sync_log
                    SET status = 'cancelled',
                        error_message = 'Order cancelled — invoice voided (bulk)',
                        updated_at = NOW()
                    WHERE shopify_order_id = ?
                      AND status NOT IN ('cancelled')
                `, [orderId]).catch(() => {});
                
                // Insert cancel guard row if not exists
                const existing = await dbAdapter.query(
                    'SELECT id FROM zoho_sync_log WHERE shopify_order_id = ?',
                    [orderId]
                );
                if (existing.length === 0) {
                    await dbAdapter.run(`
                        INSERT INTO zoho_sync_log (shopify_order_id, status, error_message, created_at, updated_at)
                        VALUES (?, 'cancelled', 'Order cancelled — invoice voided (bulk)', NOW(), NOW())
                    `, [orderId]).catch(() => {});
                }
                
                if (voided % 50 === 0) {
                    process.stdout.write(`\r  Progress: ${voided}/${invoicesToVoid.length} voided (${failed} failed)`);
                }
            } catch (err) {
                failed++;
                console.error(`\n  ❌ Order #${orderId} invoice ${invoiceId}: ${err.message}`);
                
                if (err.message.includes('429') || err.message.includes('rate')) {
                    console.log('  ⏳ Rate limited, waiting 60s...');
                    await new Promise(r => setTimeout(r, 60000));
                }
            }
        }

        console.log(`\n\n✅ Voiding complete: ${voided} succeeded, ${failed} failed\n`);
    }

    // Summary
    console.log('='.repeat(60));
    console.log('📊 FINAL SUMMARY:');
    console.log(`   Total cancelled orders: ${cancelledSet.size}`);
    console.log(`   Total Zoho invoices scanned: ${totalScanned}`);
    console.log(`   Invoices ${DRY_RUN ? 'to void' : 'voided'}: ${invoicesToVoid.length}`);
    console.log(`   Invoices skipped (paid): ${invoicesToSkip.length}`);
    console.log('='.repeat(60));

    if (invoicesToSkip.length > 0) {
        console.log('\n⚠️  PAID INVOICES REQUIRING MANUAL REVIEW:');
        invoicesToSkip.slice(0, 30).forEach(({ orderId, invoiceId, status }) => {
            console.log(`   Order #${orderId} → Invoice ${invoiceId} (${status})`);
        });
        if (invoicesToSkip.length > 30) {
            console.log(`   ... and ${invoicesToSkip.length - 30} more`);
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
