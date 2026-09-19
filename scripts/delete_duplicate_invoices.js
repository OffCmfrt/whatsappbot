/**
 * Delete all duplicate Zoho invoices created by the native Zoho ↔ Shopify
 * integration. Uses the sync log DB to identify which invoice to keep
 * (the middleware's) and voids+deletes the rest.
 *
 * Pacing: simple 650ms delay between API calls (~90 req/min, under Zoho's
 * 100 req/min limit). No token-bucket — avoids thundering-herd stalls.
 *
 * Usage:
 *   node scripts/delete_duplicate_invoices.js            dry-run
 *   node scripts/delete_duplicate_invoices.js --apply    execute
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const zohoService = require('../src/services/zohoService');
const { dbAdapter } = require('../src/database/db');

const APPLY = process.argv.includes('--apply');
const PACE_MS = 650; // ~90 req/min
const startTime = Date.now();
let removed = 0, errors = 0, scanned = 0;

function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY]'} ${msg}`); }
function elapsed() { return ((Date.now() - startTime) / 1000).toFixed(0); }
async function pace() { return new Promise(r => setTimeout(r, PACE_MS)); }

async function main() {
    console.log(`\n🗑️  Zoho Duplicate Invoice Cleanup`);
    console.log(`   mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} | pace: ${PACE_MS}ms\n`);

    // Step 1: Scan all active Zoho invoices, group by reference_number
    log('Step 1: Scanning Zoho invoices...');
    const seenRefs = {};
    for (let page = 1; page <= 100; page++) {
        let invoices = [];
        try { invoices = await zohoService.searchInvoice({ page, per_page: 200 }); } catch (e) { break; }
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
    // Batch in chunks of 500 to avoid query param size limits
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

    // Step 3: Process each duplicate group
    log(`Step 3: Processing ${dups.length} duplicate groups...`);
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

        for (const dup of removeInvs) {
            try {
                // Always delete payments first (unconditional — status field
                // from list API is unreliable for detecting paid invoices)
                await pace();
                const pmts = await zohoService.getPayments(null, dup.invoice_number);
                for (const p of pmts) {
                    await pace();
                    try { await zohoService.deletePayment(p.payment_id); } catch (_) {}
                }

                // Void (skip if already void or draft)
                if (dup.status !== 'void' && dup.status !== 'draft') {
                    await pace();
                    await zohoService.voidInvoice(dup.invoice_id);
                }
                // Delete
                await pace();
                await zohoService.deleteInvoice(dup.invoice_id);
                removed++;
                csvLines.push(`${orderNum},removed,${keepInv.invoice_number},${dup.invoice_number},`);

                if (removed % 10 === 0) {
                    log(`  ✅ ${removed} removed so far (${elapsed()}s) — last: #${orderNum} ${dup.invoice_number}`);
                }
            } catch (e) {
                errors++;
                csvLines.push(`${orderNum},error,${keepInv.invoice_number},${dup.invoice_number},"${e.message}"`);
                if (errors <= 30) log(`  ⚠️ #${orderNum} ${dup.invoice_number}: ${e.message}`);
            }
        }
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
