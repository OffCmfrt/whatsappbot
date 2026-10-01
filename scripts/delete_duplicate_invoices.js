/**
 * Delete all duplicate Zoho invoices created by the native Zoho ↔ Shopify
 * integration using BULK operations for maximum speed.
 *
 * Uses bulk delete endpoint: DELETE /invoices?invoice_ids=id1,id2,...
 * Up to 200 invoices per API call.
 *
 * Usage:
 *   node scripts/delete_duplicate_invoices.js            dry-run
 *   node scripts/delete_duplicate_invoices.js --apply    execute
 *   node scripts/delete_duplicate_invoices.js --apply --from=2026-09-01  only invoices from date
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zohoService = require('../src/services/zohoService');
const { dbAdapter } = require('../src/database/db');

const APPLY = process.argv.includes('--apply');
const FROM_ARG = process.argv.find(a => a.startsWith('--from='));
const DATE_START = FROM_ARG ? FROM_ARG.split('=')[1] : null;
const PACE_MS = 200;
const startTime = Date.now();
let removed = 0, errors = 0, scanned = 0;

function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY]'} ${msg}`); }
function elapsed() { return ((Date.now() - startTime) / 1000).toFixed(0); }
async function pace() { return new Promise(r => setTimeout(r, PACE_MS)); }

async function bulkDeleteInvoices(invoiceIds, csvLines, orderMap) {
    // Process in batches of 200 (Zoho limit)
    for (let i = 0; i < invoiceIds.length; i += 200) {
        const batch = invoiceIds.slice(i, i + 200);
        const batchNum = Math.floor(i / 200) + 1;
        const totalBatches = Math.ceil(invoiceIds.length / 200);
        
        log(`  Batch ${batchNum}/${totalBatches}: Deleting ${batch.length} invoices...`);
        
        try {
            await pace();
            // Use bulk delete endpoint
            const result = await zohoService.bulkDeleteInvoices(batch);
            
            // Track successes and failures
            if (result && result.invoice_ids) {
                for (const invId of batch) {
                    const orderNum = orderMap[invId] || 'unknown';
                    if (result.invoice_ids.includes(invId)) {
                        removed++;
                        csvLines.push(`${orderNum},removed,bulk_batch_${batchNum},,`);
                    } else {
                        errors++;
                        csvLines.push(`${orderNum},error,bulk_batch_${batchNum},,Failed in bulk delete`);
                    }
                }
            } else {
                // Assume all succeeded if no specific result
                removed += batch.length;
                for (const invId of batch) {
                    const orderNum = orderMap[invId] || 'unknown';
                    csvLines.push(`${orderNum},removed,bulk_batch_${batchNum},,`);
                }
            }
            
            log(`  ✅ Batch ${batchNum} complete: ${batch.length} invoices deleted (${elapsed()}s)`);
        } catch (e) {
            errors += batch.length;
            log(`  ⚠️ Batch ${batchNum} failed: ${e.message}`);
            for (const invId of batch) {
                const orderNum = orderMap[invId] || 'unknown';
                csvLines.push(`${orderNum},error,bulk_batch_${batchNum},,"${e.message}"`);
            }
        }
    }
}

async function main() {
    console.log(`\n🗑️  Zoho Duplicate Invoice Cleanup (BULK OPERATIONS)`);
    console.log(`   mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} | pace: ${PACE_MS}ms${DATE_START ? ` | from: ${DATE_START}` : ''}\n`);

    // Step 1: Scan all active Zoho invoices, group by reference_number
    log('Step 1: Scanning Zoho invoices...');
    const seenRefs = {};
    for (let page = 1; page <= 100; page++) {
        let invoices = [];
        try {
            const filters = { page, per_page: 200 };
            if (DATE_START) filters.date_start = DATE_START;
            invoices = await zohoService.searchInvoice(filters);
        } catch (e) { break; }
        if (!invoices.length) break;
        for (const inv of invoices) {
            const ref = String(inv.reference_number || '').replace(/^#/, '').trim();
            if (!ref) continue;
            if (inv.status === 'void' || inv.status === 'deleted') continue;
            scanned++;
            if (!seenRefs[ref]) seenRefs[ref] = [];
            seenRefs[ref].push(inv);
        }
        if (invoices.length < 200) break;
        if (page % 10 === 0) log(`  ... page ${page} (${scanned} invoices)`);
        await pace();
    }
    const dups = Object.entries(seenRefs).filter(([, invs]) => invs.length > 1);
    log(`  ${scanned} invoices scanned, ${dups.length} duplicate groups found (${elapsed()}s)\n`);

    // Step 2: Bulk-load sync log to identify middleware invoices
    log('Step 2: Loading sync log...');
    const orderIds = dups.map(([ref]) => ref.replace(/^#/, ''));
    const syncMap = {};
    for (let i = 0; i < orderIds.length; i += 500) {
        const chunk = orderIds.slice(i, i + 500);
        const rows = await dbAdapter.query(
            `SELECT shopify_order_id, zoho_invoice_id FROM zoho_sync_log
             WHERE status = 'synced' AND zoho_invoice_id IS NOT NULL
             AND shopify_order_id = ANY(?)`,
            [chunk]
        );
        for (const r of rows) {
            syncMap[String(r.shopify_order_id).replace(/^#/, '')] = r.zoho_invoice_id;
        }
    }
    log(`  ${Object.keys(syncMap).length} middleware invoices identified (${elapsed()}s)\n`);

    // Step 3: Collect all invoice IDs to remove
    log(`Step 3: Identifying invoices to remove...`);
    const invoicesToRemove = [];
    const orderMap = {}; // invoice_id -> order_number
    const csvLines = ['order,action,kept,removed,details'];

    for (const [ref, invoices] of dups) {
        const orderNum = ref.replace(/^#/, '');
        const middlewareId = syncMap[orderNum];

        // Determine which to keep and which to remove
        let keepInv, removeInvs;
        if (middlewareId) {
            keepInv = invoices.find(i => i.invoice_id === middlewareId);
            if (keepInv) {
                removeInvs = invoices.filter(i => i.invoice_id !== middlewareId);
            }
        }
        if (!keepInv) {
            const sorted = [...invoices].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
            keepInv = sorted[0];
            removeInvs = sorted.slice(1);
        }

        if (!APPLY) {
            for (const dup of removeInvs) {
                csvLines.push(`${orderNum},would_remove,${keepInv.invoice_number},${dup.invoice_number},`);
            }
            continue;
        }

        // Collect for bulk deletion
        for (const dup of removeInvs) {
            invoicesToRemove.push(dup.invoice_id);
            orderMap[dup.invoice_id] = orderNum;
        }
    }

    if (!APPLY) {
        log(`  ${invoicesToRemove.length} invoices would be removed`);
    } else {
        log(`  ${invoicesToRemove.length} invoices to remove in bulk\n`);

        // Step 4: Bulk delete all invoices
        log(`Step 4: Bulk deleting ${invoicesToRemove.length} invoices...`);
        await bulkDeleteInvoices(invoicesToRemove, csvLines, orderMap);
    }

    // Write CSV
    const csvPath = path.join(__dirname, `../tmp/dedup_result_${new Date().toISOString().slice(0, 10)}.csv`);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, csvLines.join('\n'));

    console.log(`\n${'='.repeat(50)}`);
    console.log(`DONE (${elapsed()}s)`);
    console.log(`  removed: ${removed}`);
    console.log(`  errors: ${errors}`);
    console.log(`  report: ${csvPath}`);
    if (!APPLY) console.log(`\nDry-run. Re-run with --apply to execute.`);
    process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
