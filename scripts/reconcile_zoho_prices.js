/**
 * Zoho ↔ Shopify Price Reconciliation (FAST)
 * --------------------------------------------
 * Uses the original_payload stored in zoho_sync_log instead of fetching
 * each order from Shopify — eliminates thousands of API calls.
 *
 * Only fetches from Shopify when the payload is missing (rare).
 * Zoho invoices are fetched in pages (list API) for speed.
 *
 * Phases:
 *   detect     Compare every synced invoice total against Shopify payload
 *   fix        Void + re-sync unpaid mismatched invoices
 *   duplicates Remove extra invoices from the native integration
 *
 * Usage:
 *   node scripts/reconcile_zoho_prices.js                          dry-run detect
 *   node scripts/reconcile_zoho_prices.js --apply                  detect + auto-fix
 *   node scripts/reconcile_zoho_prices.js --apply --phase=fix      fix only
 *   node scripts/reconcile_zoho_prices.js --apply --phase=duplicates
 *
 * Options:
 *   --limit=N          cap records processed (default 5000)
 *   --concurrency=N    parallel workers (default 8)
 *   --since=YYYY-MM-DD only process orders after this date
 *   --order=XXXXX      process a single order number
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const zohoService = require('../src/services/zohoService');
const zohoSyncService = require('../src/services/zohoSyncService');
const { dbAdapter } = require('../src/database/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PHASE = (args.find(a => a.startsWith('--phase=')) || '').split('=')[1] || 'detect';
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '5000', 10);
const CONCURRENCY = Math.max(1, parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || '8', 10));
const SINCE = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || '2026-03-25';
const SINGLE_ORDER = (args.find(a => a.startsWith('--order=')) || '').split('=')[1] || null;

const TOLERANCE = 1.00;
const summary = { detected: 0, fixed: 0, skipped_paid: 0, skipped_credit: 0, duplicates_removed: 0, ok: 0, errors: [] };
const startTime = Date.now();

function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`); }
function elapsed() { return ((Date.now() - startTime) / 1000).toFixed(1); }

// ============================================================
// Shopify helpers (only used when payload missing from sync log)
// ============================================================

function shopifyCfg() {
    const shop = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP_URL;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!shop || !token) return null;
    return {
        base: `https://${shop.replace('.myshopify.com', '')}.myshopify.com/admin/api/2024-01`,
        headers: { 'X-Shopify-Access-Token': token }
    };
}

async function fetchShopifyOrder(orderNumber) {
    const cfg = shopifyCfg();
    if (!cfg) return null;
    const name = String(orderNumber).replace(/^#/, '');
    try {
        const res = await axios.get(`${cfg.base}/orders.json`, {
            params: { name, status: 'any' }, headers: cfg.headers, timeout: 15000
        });
        return (res.data?.orders || [])[0] || null;
    } catch (e) { return null; }
}

// ============================================================
// Worker pool
// ============================================================

async function pool(items, fn) {
    let idx = 0;
    const results = [];
    const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

// ============================================================
// Fast comparison using totals only (no line-by-line needed
// for the initial scan — line-by-line is only needed for fix)
// ============================================================

/**
 * Compute the expected net from a Shopify order payload.
 * net = items_gross - total_discounts + shipping
 */
function shopifyNet(payload) {
    const itemsGross = round2((payload.line_items || [])
        .reduce((s, li) => s + (parseFloat(li.price) || 0) * (parseInt(li.quantity) || 1), 0));
    const discounts = round2(parseFloat(payload.total_discounts || 0));
    const shipping = round2((payload.shipping_lines || [])
        .reduce((s, sl) => s + (parseFloat(sl.price) || 0), 0));
    return round2(itemsGross - discounts + shipping);
}

/**
 * Compute the Zoho invoice net from its line items.
 */
function zohoNet(invoice) {
    return round2((invoice.line_items || []).reduce((s, l) => {
        return s + (parseFloat(l.rate || 0) * parseFloat(l.quantity || 1)) - (parseFloat(l.discount || 0));
    }, 0));
}

// ============================================================
// Phase: DETECT — fast scan using sync log payloads + Zoho list API
// ============================================================

async function phaseDetect() {
    // 1) Load sync log rows with original_payload (one DB query, no Shopify API)
    let query = `SELECT shopify_order_id, zoho_invoice_id, original_payload, created_at
         FROM zoho_sync_log
         WHERE status = 'synced' AND zoho_invoice_id IS NOT NULL`;
    const params = [];

    if (SINGLE_ORDER) {
        query += ` AND shopify_order_id = ?`;
        params.push(SINGLE_ORDER);
    } else {
        query += ` AND created_at >= ?`;
        params.push(SINCE);
    }
    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(LIMIT);

    const rows = await dbAdapter.query(query, params);
    log(`detect: ${rows.length} synced invoices to check (${elapsed()}s)`);

    // 2) Fetch all Zoho invoices in pages (list API — fast, just totals)
    const zohoCache = {};
    log('detect: fetching Zoho invoices...');
    for (let page = 1; page <= 50; page++) {
        let invoices = [];
        try {
            invoices = await zohoService.searchInvoice({ page, per_page: 200 });
        } catch (e) { break; }
        if (!invoices.length) break;
        for (const inv of invoices) {
            if (inv.invoice_id) zohoCache[inv.invoice_id] = inv;
        }
        if (invoices.length < 200) break;
        if (page % 5 === 0) log(`  ... page ${page} (${Object.keys(zohoCache).length} invoices cached)`);
    }
    log(`detect: ${Object.keys(zohoCache).length} Zoho invoices cached (${elapsed()}s)`);

    // 3) Compare — use stored payload, only fetch from Shopify if missing
    const csvPath = path.join(__dirname, `../tmp/zoho_price_reconciliation_${new Date().toISOString().slice(0, 10)}.csv`);
    const csvLines = ['order,zoho_invoice_id,zoho_net,shopify_net,delta,zoho_total,shopify_total,status'];
    const mismatched = []; // collect for fix phase

    let shopifyFetches = 0;

    await pool(rows, async (row) => {
        const orderNum = String(row.shopify_order_id).replace(/^#/, '');

        // Get Zoho invoice from cache
        const zohoListInv = zohoCache[row.zoho_invoice_id];
        if (!zohoListInv) {
            // Not in cache — fetch individually
            try {
                const full = await zohoService.getInvoice(row.zoho_invoice_id);
                if (full) zohoCache[row.zoho_invoice_id] = full;
            } catch (e) {
                summary.errors.push(`${orderNum}: Zoho invoice not found`);
                return;
            }
        }

        const zohoInv = zohoCache[row.zoho_invoice_id];
        if (!zohoInv) { summary.errors.push(`${orderNum}: invoice missing`); return; }

        // Get Shopify order from stored payload (FAST — no API call)
        let shopifyOrder = null;
        if (row.original_payload) {
            shopifyOrder = typeof row.original_payload === 'string'
                ? JSON.parse(row.original_payload) : row.original_payload;
        }

        // Fallback: fetch from Shopify (rare — only if payload missing)
        if (!shopifyOrder || !shopifyOrder.line_items) {
            shopifyOrder = await fetchShopifyOrder(orderNum);
            shopifyFetches++;
            if (!shopifyOrder) {
                summary.errors.push(`${orderNum}: not in sync log payload or Shopify`);
                return;
            }
        }

        // Compare totals
        const sNet = shopifyNet(shopifyOrder);
        const zNet = zohoNet(zohoInv);
        const delta = round2(sNet - zNet);

        if (Math.abs(delta) <= TOLERANCE) {
            summary.ok++;
            return;
        }

        summary.detected++;
        const zohoTotal = parseFloat(zohoInv.total || 0);
        const shopifyTotal = parseFloat(shopifyOrder.total_price || 0);

        log(`  ❌ #${orderNum}: zoho=₹${zNet} shopify=₹${sNet} Δ=₹${Math.abs(delta).toFixed(2)} [${elapsed()}s]`);

        csvLines.push([
            orderNum, row.zoho_invoice_id, zNet, sNet, Math.abs(delta),
            zohoTotal, shopifyTotal,
            Math.abs(delta) > 100 ? 'large_mismatch' : 'small_mismatch'
        ].join(','));

        mismatched.push({ orderNum, row, delta, zohoInv, shopifyOrder });
    });

    // Write CSV
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, csvLines.join('\n'));

    log(`\ndetect: ${summary.detected} mismatches found, ${summary.ok} OK (${elapsed()}s)`);
    if (shopifyFetches > 0) log(`  (fetched ${shopifyFetches} orders from Shopify — rest used stored payload)`);
    log(`  report: ${csvPath}`);
    if (summary.errors.length) log(`  ${summary.errors.length} errors`);

    // Auto-fix if --apply and phase=detect
    if (APPLY && mismatched.length > 0 && PHASE === 'detect') {
        log(`\nfix: attempting to fix ${mismatched.length} mismatched invoices...`);
        await fixMismatched(mismatched);
    }

    return mismatched;
}

// ============================================================
// Phase: FIX — void + re-sync mismatched unpaid invoices
// ============================================================

async function fixMismatched(mismatched) {
    await pool(mismatched, async ({ orderNum, row, delta, zohoInv, shopifyOrder }) => {
        // Skip cancelled orders
        if (shopifyOrder.cancelled_at && !(shopifyOrder.fulfillments || []).length) {
            log(`  ⏭️ #${orderNum}: cancelled — skip`);
            return;
        }

        const balance = parseFloat(zohoInv.balance ?? zohoInv.total);
        const total = parseFloat(zohoInv.total);
        const isPaid = Math.abs(balance - total) > 0.01;

        if (isPaid) {
            summary.skipped_paid++;
            return;
        }

        // Check for credit notes (quick DB check, not API)
        try {
            const { creditNoteReference } = require('../src/services/zohoTransform');
            const refs = ['return', 'rto', 'exchange'].map(t => creditNoteReference(orderNum, t));
            for (const ref of refs) {
                const cn = await zohoService.searchCreditNotes({ reference_number: ref });
                if (cn.length > 0) {
                    summary.skipped_credit++;
                    return;
                }
            }
        } catch (e) { /* proceed */ }

        log(`  🔧 #${orderNum}: voiding + re-syncing (Δ=₹${Math.abs(delta).toFixed(2)}) [${elapsed()}s]`);

        try {
            // Void + delete old invoice
            await zohoService.voidInvoice(zohoInv.invoice_id);
            await zohoService.deleteInvoice(zohoInv.invoice_id);

            // Remove old sync log
            await dbAdapter.run(`DELETE FROM zoho_sync_log WHERE shopify_order_id = ?`, [orderNum]);

            // Re-sync through corrected pipeline
            const result = await zohoSyncService.syncOrderToZoho(shopifyOrder);
            if (result.success) {
                summary.fixed++;
            } else {
                summary.errors.push(`${orderNum}: re-sync failed: ${result.error}`);
            }
        } catch (e) {
            summary.errors.push(`${orderNum}: fix failed: ${e.message}`);
        }
    });

    log(`fix: ${summary.fixed} fixed, ${summary.skipped_paid} skipped (paid), ${summary.skipped_credit} skipped (credit notes) [${elapsed()}s]`);
}

async function phaseFix() {
    const mismatched = await phaseDetect();
    if (mismatched && mismatched.length > 0) {
        log(`\nfix: processing ${mismatched.length} mismatches...`);
        await fixMismatched(mismatched);
    }
}

// ============================================================
// Phase: DUPLICATES — find and remove extra invoices
// ============================================================

async function phaseDuplicates() {
    const seenRefs = {};
    log('duplicates: scanning Zoho invoices...');

    for (let page = 1; page <= 50; page++) {
        let invoices = [];
        try {
            invoices = await zohoService.searchInvoice({ page, per_page: 200 });
        } catch (e) { break; }
        if (!invoices.length) break;

        for (const inv of invoices) {
            const ref = String(inv.reference_number || '').replace(/^#/, '').trim();
            if (!ref) continue;
            if (inv.status === 'void' || inv.status === 'deleted') continue;
            if (!seenRefs[ref]) seenRefs[ref] = [];
            seenRefs[ref].push(inv);
        }
        if (invoices.length < 200) break;
        if (page % 5 === 0) log(`  ... page ${page}`);
    }

    const dupInvoices = Object.entries(seenRefs).filter(([, invs]) => invs.length > 1);
    log(`duplicates: ${dupInvoices.length} reference numbers with multiple invoices (${elapsed()}s)`);

    await pool(dupInvoices, async ([ref, invoices]) => {
        const orderNum = ref.replace(/^#/, '');

        // Sort: keep the one with discounts (our middleware), remove the rest
        const fullInvoices = [];
        for (const inv of invoices) {
            try {
                const full = await zohoService.getInvoice(inv.invoice_id);
                if (full) fullInvoices.push(full);
            } catch (e) { /* skip */ }
        }
        if (fullInvoices.length < 2) return;

        fullInvoices.sort((a, b) => {
            const aD = (a.line_items || []).some(l => parseFloat(l.discount || 0) > 0);
            const bD = (b.line_items || []).some(l => parseFloat(l.discount || 0) > 0);
            if (aD && !bD) return -1;
            if (!aD && bD) return 1;
            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });

        const keep = fullInvoices[0];
        const remove = fullInvoices.slice(1);

        log(`  #${orderNum}: keeping ${keep.invoice_number}, removing ${remove.length} dup(s)`);
        if (!APPLY) return;

        for (const dup of remove) {
            const payments = await zohoService.getPayments(null, dup.invoice_number);
            if (payments.length > 0) {
                log(`    ⚠️ ${dup.invoice_number} has payments — skip`);
                continue;
            }
            try {
                await zohoService.voidInvoice(dup.invoice_id);
                await zohoService.deleteInvoice(dup.invoice_id);
                summary.duplicates_removed++;
            } catch (e) {
                summary.errors.push(`dup ${dup.invoice_number}: ${e.message}`);
            }
        }
    });

    log(`duplicates: ${summary.duplicates_removed} removed (${elapsed()}s)`);
}

// ============================================================
// Main
// ============================================================

async function main() {
    console.log(`\n🔍 Zoho ↔ Shopify Price Reconciliation (FAST)`);
    console.log(`   mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} | phase: ${PHASE} | limit: ${LIMIT} | since: ${SINCE} | concurrency: ${CONCURRENCY}`);
    if (SINGLE_ORDER) console.log(`   single order: #${SINGLE_ORDER}`);
    console.log();

    const phases = {
        detect: phaseDetect,
        fix: phaseFix,
        duplicates: phaseDuplicates
    };

    const fn = phases[PHASE];
    if (!fn) {
        console.error(`Unknown phase: ${PHASE}. Available: ${Object.keys(phases).join(', ')}`);
        process.exit(1);
    }

    try {
        await fn();
    } catch (e) {
        summary.errors.push(`phase ${PHASE}: ${e.message}`);
        console.error(`❌ phase ${PHASE} crashed: ${e.message}`);
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`SUMMARY (${elapsed()}s total)`);
    console.log(`  ok: ${summary.ok}`);
    console.log(`  detected mismatches: ${summary.detected}`);
    if (APPLY) {
        console.log(`  fixed: ${summary.fixed}`);
        console.log(`  skipped (paid): ${summary.skipped_paid}`);
        console.log(`  skipped (credit notes): ${summary.skipped_credit}`);
        console.log(`  duplicates removed: ${summary.duplicates_removed}`);
    }
    if (summary.errors.length) {
        console.log(`  ${summary.errors.length} error(s):`);
        summary.errors.slice(0, 30).forEach(e => console.log(`    - ${e}`));
    }
    if (!APPLY) console.log('\nDry-run complete. Re-run with --apply to execute fixes.');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
