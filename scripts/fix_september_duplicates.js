/**
 * Fix September 2026 Duplicate Zoho Invoices (BULK v3 — FINAL)
 * --------------------------------------------------------------
 * Optimized flow:
 *   1. Fetch September invoices, group by reference_number
 *   2. Identify native duplicates via zoho_sync_log
 *   3. Delete payments on paid duplicates (concurrent)
 *   4. Void all (concurrent)
 *   5. Bulk-delete in batches of 200
 *
 * Usage:
 *   node scripts/fix_september_duplicates.js              # dry-run
 *   node scripts/fix_september_duplicates.js --apply       # execute
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const zohoService = require('../src/services/zohoService');
const { dbAdapter } = require('../src/database/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CONCURRENCY = Math.max(1, parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || '3', 10));
const PACE_MS = 200;
const BATCH_SIZE = 200;

const DATE_START = '2026-09-01';
const DATE_END = '2026-09-30';

const summary = {
    scanned: 0, duplicateGroups: 0, invoicesToRemove: 0,
    paymentsDeleted: 0, voided: 0, removed: 0, failed: 0, errors: []
};

const startTime = Date.now();
function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`); }
function elapsed() { return ((Date.now() - startTime) / 1000).toFixed(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pool(items, fn, concurrency = CONCURRENCY) {
    let idx = 0;
    const results = [];
    const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

// ── Step 1: Fetch all September invoices ──────────────────────────
async function fetchSeptemberInvoices() {
    log(`Fetching all invoices from ${DATE_START} to ${DATE_END}...`);
    try { await zohoService.getAccessToken(true); } catch (e) { /* use cached */ }

    const allInvoices = [];
    let page = 1;
    while (true) {
        let invoices = [];
        let retries = 0;
        while (retries < 3) {
            try {
                invoices = await zohoService.searchInvoice({ page, per_page: 200, date_start: DATE_START });
                break;
            } catch (e) {
                retries++;
                if (retries >= 3) { log(`  Error page ${page} after ${retries} retries: ${e.message}`); }
                else { log(`  Page ${page} retry ${retries}/3: ${e.message}`); await sleep(5000 * retries); }
            }
        }
        if (!invoices.length) { if (page === 1) log('  ⚠️ 0 invoices returned'); break; }

        for (const inv of invoices) {
            if (inv.status === 'void' || inv.status === 'deleted') continue;
            const invDate = (inv.date || inv.created_at || '').slice(0, 10);
            if (invDate && (invDate < DATE_START || invDate > DATE_END)) continue;
            summary.scanned++;
            allInvoices.push(inv);
        }
        if (invoices.length < 200) break;
        page++;
        if (page % 5 === 0) log(`  ... page ${page} (${allInvoices.length} September invoices)`);
        await sleep(PACE_MS);
    }
    log(`  ${allInvoices.length} September invoices scanned (${elapsed()}s)`);
    return allInvoices;
}

// ── Step 2: Group by reference_number ─────────────────────────────
function findDuplicateGroups(invoices) {
    const seenRefs = {};
    for (const inv of invoices) {
        const ref = String(inv.reference_number || '').replace(/^#/, '').trim();
        if (!ref) continue;
        if (!seenRefs[ref]) seenRefs[ref] = [];
        seenRefs[ref].push(inv);
    }
    const dups = Object.entries(seenRefs).filter(([, v]) => v.length > 1);
    summary.duplicateGroups = dups.length;
    log(`  ${dups.length} duplicate groups found`);
    return dups;
}

// ── Step 3: Load sync log ─────────────────────────────────────────
async function loadSyncMap(dupGroups) {
    log('Loading sync log...');
    const orderIds = dupGroups.map(([ref]) => ref.replace(/^#/, ''));
    const syncMap = {};
    for (let i = 0; i < orderIds.length; i += 500) {
        const chunk = orderIds.slice(i, i + 500);
        try {
            const rows = await dbAdapter.query(
                `SELECT shopify_order_id, zoho_invoice_id FROM zoho_sync_log
                 WHERE status = 'synced' AND zoho_invoice_id IS NOT NULL AND shopify_order_id = ANY(?)`,
                [chunk]
            );
            for (const r of rows) syncMap[String(r.shopify_order_id).replace(/^#/, '')] = r.zoho_invoice_id;
        } catch (e) { /* skip */ }
    }
    log(`  ${Object.keys(syncMap).length} middleware invoices identified`);
    return syncMap;
}

// ── Step 4: Identify removals ─────────────────────────────────────
function identifyRemovals(dupGroups, syncMap) {
    const toRemove = [];
    const csvLines = ['order,action,kept,removed,reason,status'];

    for (const [ref, invoices] of dupGroups) {
        const orderNum = ref.replace(/^#/, '');
        const midId = syncMap[orderNum];
        let keepInv, removeInvs;

        if (midId) {
            keepInv = invoices.find(i => i.invoice_id === midId);
            if (keepInv) removeInvs = invoices.filter(i => i.invoice_id !== midId);
        }
        if (!keepInv) {
            const sorted = [...invoices].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
            keepInv = sorted[0];
            removeInvs = sorted.slice(1);
        }

        for (const dup of removeInvs) {
            toRemove.push({
                invoice_id: dup.invoice_id,
                invoice_number: dup.invoice_number,
                order_num: orderNum,
                status: dup.status,
                balance: parseFloat((dup.balance ?? dup.total) || 0),
                total: parseFloat(dup.total || 0),
                keep_number: keepInv.invoice_number,
                reason: midId ? 'native_dup' : 'older_dup'
            });
            csvLines.push([orderNum, APPLY ? 'removing' : 'would_remove',
                keepInv.invoice_number, dup.invoice_number,
                midId ? 'native_dup' : 'older_dup', dup.status].join(','));
        }
    }

    summary.invoicesToRemove = toRemove.length;
    log(`  ${toRemove.length} duplicates to remove`);
    return { toRemove, csvLines };
}

// ── Step 5a: Bulk-fetch payments, match to paid duplicates, delete ─
async function deletePaymentsOnPaid(toRemove) {
    const paidInvoices = toRemove.filter(i => i.status === 'paid');
    if (paidInvoices.length === 0) { log('No paid duplicates — skipping payment deletion.'); return; }

    const targetIds = new Set(paidInvoices.map(i => i.invoice_id));
    const targetNumbers = new Set(paidInvoices.map(i => i.invoice_number));
    log(`\nBulk-fetching all customer payments to find those on ${paidInvoices.length} paid duplicates...`);

    // Fetch ALL payments in bulk (paginated list API)
    const matchingPayments = [];
    let page = 1;
    while (true) {
        let payments = [];
        let retries = 0;
        while (retries < 3) {
            try {
                const url = `${zohoService.BOOKS_BASE()}/customerpayments`;
                const result = await zohoService.zohoRequest('get', url, null, { page, per_page: 200 });
                payments = result.customerpayments || result.payments || [];
                break;
            } catch (e) {
                retries++;
                if (retries >= 3) { log(`  Error payments page ${page}: ${e.message}`); }
                else { await sleep(5000 * retries); }
            }
        }
        if (!payments.length) break;

        for (const pmt of payments) {
            // Match by invoice_numbers field (string like "OFF/26-27/50143")
            const invNumbers = String(pmt.invoice_numbers || '');
            const matches = invNumbers.split(',').some(n => targetNumbers.has(n.trim()));
            if (matches) {
                matchingPayments.push(pmt.payment_id);
            }
        }

        if (page % 50 === 0) log(`  ... page ${page} (${matchingPayments.length} matching payments found)`);
        if (payments.length < 200) break;
        page++;
        await sleep(PACE_MS);
    }

    log(`  Found ${matchingPayments.length} payments on paid duplicates across ${page} pages`);
    if (matchingPayments.length === 0) return;

    // Delete payments concurrently
    log(`Deleting ${matchingPayments.length} payments (concurrent=${CONCURRENCY})...`);
    let deleted = 0;

    await pool(matchingPayments, async (paymentId) => {
        try {
            await zohoService.deletePayment(paymentId);
            deleted++;
            if (deleted % 200 === 0) log(`  ... ${deleted}/${matchingPayments.length} deleted (${elapsed()}s)`);
        } catch (e) { /* skip */ }
        await sleep(50);
    });

    summary.paymentsDeleted = deleted;
    log(`  ${deleted} payments deleted (${elapsed()}s)`);
}

// ── Step 5b: Void all (concurrent) ────────────────────────────────
async function voidAll(toRemove) {
    log(`\nVoiding ${toRemove.length} invoices (concurrent=${CONCURRENCY})...`);
    let voided = 0, skipped = 0;

    await pool(toRemove, async (item) => {
        if (item.status === 'void') { skipped++; return; }
        try {
            await zohoService.voidInvoice(item.invoice_id);
            item.status = 'void';
            voided++;
            if (voided % 100 === 0) log(`  ... ${voided} voided (${elapsed()}s)`);
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('already void')) { item.status = 'void'; voided++; }
            else if (msg.includes('credit note')) {
                // Can't void — has credit notes. Skip void, try delete directly.
                log(`  ⚠️ ${item.invoice_number} has credit notes — skipping void`);
                summary.errors.push(`${item.invoice_number}: has credit notes, cannot void`);
            } else {
                log(`  ⚠️ Void failed for ${item.invoice_number}: ${msg.slice(0, 80)}`);
            }
        }
        await sleep(100);
    });

    summary.voided = voided;
    log(`  ${voided} voided, ${skipped} already void (${elapsed()}s)`);
}

// ── Step 5c: Bulk-delete in batches of 200 ────────────────────────
async function bulkDeleteAll(toRemove, csvLines) {
    const batches = [];
for (let i = 0; i < toRemove.length; i += BATCH_SIZE) batches.push(toRemove.slice(i, i + BATCH_SIZE));
    log(`\nBulk-deleting ${toRemove.length} invoices in ${batches.length} batches...`);

    for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const ids = batch.map(i => i.invoice_id);
        try {
            await sleep(PACE_MS);
            const result = await zohoService.bulkDeleteInvoices(ids);
            const ok = (result && result.invoice_ids) ? result.invoice_ids : ids;
            for (const item of batch) {
                if (ok.includes(item.invoice_id)) {
                    summary.removed++;
                    csvLines.push([item.order_num, 'removed', item.keep_number, item.invoice_number, item.reason, `batch_${bi + 1}`].join(','));
                } else {
                    summary.failed++;
                    csvLines.push([item.order_num, 'error', item.keep_number, item.invoice_number, item.reason, 'bulk_failed'].join(','));
                }
            }
            log(`  ✅ Batch ${bi + 1}/${batches.length} (${elapsed()}s)`);
        } catch (e) {
            summary.failed += batch.length;
            log(`  ⚠️ Batch ${bi + 1} failed: ${e.message}`);
            for (const item of batch) {
                summary.errors.push(`${item.invoice_number}: ${e.message}`);
                csvLines.push([item.order_num, 'error', item.keep_number, item.invoice_number, item.reason, e.message].join(','));
            }
        }
    }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
    console.log('\n🗑️  Fix September 2026 Duplicate Zoho Invoices (BULK v3)');
    console.log(`   mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} | workers: ${CONCURRENCY} | batch: ${BATCH_SIZE}`);
    console.log(`   date range: ${DATE_START} to ${DATE_END}\n`);

    const allInvoices = await fetchSeptemberInvoices();
    if (!allInvoices.length) { log('No invoices found.'); return; }

    const dupGroups = findDuplicateGroups(allInvoices);
    if (!dupGroups.length) { log('No duplicates!'); return; }

    const syncMap = await loadSyncMap(dupGroups);
    const { toRemove, csvLines } = identifyRemovals(dupGroups, syncMap);
    if (!toRemove.length) { log('Nothing to remove.'); return; }

    // Show sample
    const paid = toRemove.filter(i => i.status === 'paid').length;
    log(`\nBreakdown: ${paid} paid, ${toRemove.length - paid} non-paid`);
    log('Sample:');
    for (const item of toRemove.slice(0, 10)) {
        log(`  #${item.order_num}: keep ${item.keep_number}, remove ${item.invoice_number} [${item.status}]`);
    }
    if (toRemove.length > 10) log(`  ... and ${toRemove.length - 10} more`);

    if (!APPLY) {
        const csvPath = path.join(__dirname, `../tmp/fix_september_duplicates_${new Date().toISOString().slice(0, 10)}.csv`);
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        fs.writeFileSync(csvPath, csvLines.join('\n'));
        console.log(`\nDRY-RUN COMPLETE (${elapsed()}s) — ${toRemove.length} to remove. Re-run with --apply.`);
        return;
    }

    // APPLY: payments → void → bulk delete
    await deletePaymentsOnPaid(toRemove);
    await voidAll(toRemove);
    await bulkDeleteAll(toRemove, csvLines);

    // Write report
    const csvPath = path.join(__dirname, `../tmp/fix_september_duplicates_${new Date().toISOString().slice(0, 10)}.csv`);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, csvLines.join('\n'));

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Scanned:          ${summary.scanned}`);
    console.log(`Duplicate groups: ${summary.duplicateGroups}`);
    console.log(`To remove:        ${summary.invoicesToRemove}`);
    console.log(`Payments deleted: ${summary.paymentsDeleted}`);
    console.log(`Voided:           ${summary.voided}`);
    console.log(`Bulk-deleted:     ${summary.removed}`);
    console.log(`Failed:           ${summary.failed}`);
    console.log(`Time:             ${elapsed()}s`);
    console.log(`Report:           ${csvPath}`);
    if (summary.errors.length) {
        console.log(`\nErrors (${summary.errors.length}):`);
        summary.errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
    }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

