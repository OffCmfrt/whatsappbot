/**
 * Zoho ↔ Shopify Price Reconciliation
 * -------------------------------------
 * Identifies and fixes price discrepancies between Shopify orders and their
 * corresponding Zoho invoices.
 *
 * Root causes of discrepancies:
 *   1. Orders synced before the accounting overhaul (commit 37c8a3b) had
 *      discount=0 on all lines — Zoho invoices show full price while
 *      Shopify shows the discounted amount.
 *   2. The native Zoho Inventory ↔ Shopify integration may have created
 *      duplicate invoices with different prices.
 *   3. Tax miscalculation on discounted amounts (pre-overhaul tax was
 *      computed on gross, not net).
 *
 * Phases:
 *   detect     Compare every synced invoice line-by-line against Shopify
 *   fix        Void + re-sync unpaid mismatched invoices (default: dry-run)
 *   duplicates Remove extra invoices from the native integration
 *
 * Usage:
 *   node scripts/reconcile_zoho_prices.js                          dry-run detect
 *   node scripts/reconcile_zoho_prices.js --apply                  apply fixes
 *   node scripts/reconcile_zoho_prices.js --phase=duplicates       find/remove duplicates
 *   node scripts/reconcile_zoho_prices.js --apply --phase=fix      void+re-sync mismatches
 *
 * Options:
 *   --limit=N          cap records processed (default 1000)
 *   --concurrency=N    parallel workers (default 4)
 *   --since=YYYY-MM-DD only process orders after this date
 *   --order=XXXXX      process a single order number (e.g. 46015)
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
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '1000', 10);
const CONCURRENCY = Math.max(1, parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || '4', 10));
const SINCE = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || '2026-03-25';
const SINGLE_ORDER = (args.find(a => a.startsWith('--order=')) || '').split('=')[1] || null;

const TOLERANCE = 1.00; // ₹1 tolerance for rounding
const summary = { detected: 0, fixed: 0, skipped_paid: 0, skipped_credit: 0, duplicates_removed: 0, ok: 0, errors: [] };

function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`); }

// ============================================================
// Shopify helpers
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

// ============================================================
// Phase: DETECT — compare Zoho invoice vs Shopify order
// ============================================================

/**
 * Build a normalised map of line items from a Shopify order for comparison.
 * Key = SKU (or name if no SKU), value = { price, qty, discount, gross, net }
 */
function shopifyLineMap(order) {
    const map = {};
    for (const li of (order.line_items || [])) {
        const key = (li.sku || li.title || '').trim().toUpperCase();
        if (!key) continue;
        const price = parseFloat(li.price || 0);
        const qty = parseInt(li.quantity || 1);
        const discount = round2(
            (li.discount_allocations || []).reduce((s, a) => s + (parseFloat(a.amount) || 0), 0)
        );
        if (!map[key]) map[key] = { price, qty, discount: 0, gross: 0 };
        map[key].qty += qty;
        map[key].discount = round2(map[key].discount + discount);
        map[key].gross = round2(map[key].gross + price * qty);
    }
    return map;
}

/**
 * Build the same normalised map from a Zoho invoice.
 */
function zohoLineMap(invoice) {
    const map = {};
    for (const li of (invoice.line_items || [])) {
        // Zoho item name often has the SKU embedded; use item_name or name
        const key = (li.sku || li.item_id || li.name || '').trim().toUpperCase();
        if (!key) continue;
        const rate = parseFloat(li.rate || 0);
        const qty = parseFloat(li.quantity || 1);
        const discount = round2(parseFloat(li.discount || 0));
        if (!map[key]) map[key] = { price: rate, qty: 0, discount: 0, gross: 0 };
        map[key].qty += qty;
        map[key].discount = round2(map[key].discount + discount);
        map[key].gross = round2(map[key].gross + rate * qty);
    }
    return map;
}

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

/**
 * Compare a Zoho invoice against its Shopify order.
 * Returns { match: bool, issues: string[], zohoTotal, shopifyTotal, delta }
 */
function compareInvoice(syncRow, zohoInvoice, shopifyOrder) {
    const issues = [];
    const zohoLines = zohoLineMap(zohoInvoice);
    const shopLines = shopifyLineMap(shopifyOrder);

    // 1) Line-by-line price check
    for (const [key, zLine] of Object.entries(zohoLines)) {
        const sLine = shopLines[key];
        if (!sLine) {
            // Zoho has a line Shopify doesn't — might be a name mismatch, skip
            continue;
        }
        if (Math.abs(zLine.price - sLine.price) > 0.01) {
            issues.push(`price_mismatch:${key}:zoho=${zLine.price}:shopify=${sLine.price}`);
        }
        if (Math.abs(zLine.discount - sLine.discount) > TOLERANCE) {
            issues.push(`discount_mismatch:${key}:zoho=${zLine.discount}:shopify=${sLine.discount}`);
        }
    }

    // 2) Total check — compare Zoho invoice total vs Shopify's expected total
    //    Shopify expected = total_price (includes shipping, tax, discounts)
    //    Zoho total = subtotal - discounts + tax (no shipping in middleware)
    //    We compare the SUBTOTAL (items after discount) since Zoho doesn't have shipping
    const zohoSubtotal = parseFloat(zohoInvoice.subtotal || 0);
    const zohoDiscount = round2(
        (zohoInvoice.line_items || []).reduce((s, l) => s + (parseFloat(l.discount || 0)), 0)
    );
    const zohoNet = round2(zohoSubtotal - zohoDiscount);

    const shopifyItemsNet = Object.values(shopLines).reduce((s, l) => s + l.gross - l.discount, 0);

    if (Math.abs(zohoNet - shopifyItemsNet) > TOLERANCE) {
        issues.push(`net_total_mismatch:zoho=${zohoNet}:shopify=${round2(shopifyItemsNet)}`);
    }

    // 3) Check if discount was applied in Shopify but missing in Zoho
    const shopifyTotalDiscount = parseFloat(shopifyOrder.total_discounts || 0);
    const zohoTotalDiscount = round2(
        (zohoInvoice.line_items || []).reduce((s, l) => s + (parseFloat(l.discount || 0)), 0)
    );
    if (shopifyTotalDiscount > TOLERANCE && zohoTotalDiscount < TOLERANCE) {
        issues.push(`discount_missing:shopify_total=${shopifyTotalDiscount}:zoho_total=${zohoTotalDiscount}`);
    } else if (Math.abs(shopifyTotalDiscount - zohoTotalDiscount) > TOLERANCE && shopifyTotalDiscount > TOLERANCE) {
        issues.push(`discount_drift:shopify=${shopifyTotalDiscount}:zoho=${zohoTotalDiscount}`);
    }

    return {
        match: issues.length === 0,
        issues,
        zohoNet,
        shopifyNet: round2(shopifyItemsNet),
        zohoTotal: parseFloat(zohoInvoice.total || 0),
        shopifyTotal: parseFloat(shopifyOrder.total_price || 0),
        delta: round2(parseFloat(zohoInvoice.total || 0) - parseFloat(shopifyOrder.total_price || 0))
    };
}

async function phaseDetect() {
    let query = `SELECT shopify_order_id, zoho_invoice_id, created_at
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
    log(`detect: ${rows.length} synced invoices to check`);

    const csvPath = path.join(__dirname, `../tmp/zoho_price_reconciliation_${new Date().toISOString().slice(0, 10)}.csv`);
    const csvLines = ['order,zoho_invoice_id,issue,zoho_net,shopify_net,zoho_total,shopify_total,delta'];

    await pool(rows, async (row) => {
        const orderNum = String(row.shopify_order_id).replace(/^#/, '');

        // Fetch Zoho invoice (full, with line items)
        let zohoInv;
        try {
            zohoInv = await zohoService.getInvoice(row.zoho_invoice_id);
        } catch (e) {
            summary.errors.push(`${orderNum}: getInvoice failed: ${e.message}`);
            return;
        }
        if (!zohoInv) {
            summary.errors.push(`${orderNum}: invoice ${row.zoho_invoice_id} not found in Zoho`);
            return;
        }

        // Fetch live Shopify order
        const shopifyOrder = await fetchShopifyOrder(orderNum);
        if (!shopifyOrder) {
            summary.errors.push(`${orderNum}: not found in Shopify`);
            return;
        }

        const result = compareInvoice(row, zohoInv, shopifyOrder);

        if (result.match) {
            summary.ok++;
            return;
        }

        summary.detected++;
        const issueStr = result.issues.join('; ');
        log(`  ❌ #${orderNum}: ${issueStr} (delta: ₹${result.delta})`);

        csvLines.push([
            orderNum, row.zoho_invoice_id, issueStr,
            result.zohoNet, result.shopifyNet,
            result.zohoTotal, result.shopifyTotal, result.delta
        ].join(','));

        // If --apply, attempt fix for unpaid invoices
        if (APPLY && PHASE === 'detect') {
            await attemptFix(orderNum, row, zohoInv, shopifyOrder);
        }
    });

    // Write CSV report
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, csvLines.join('\n'));
    log(`detect: report written to ${csvPath}`);
}

// ============================================================
// Phase: FIX — void + re-sync mismatched unpaid invoices
// ============================================================

async function attemptFix(orderNum, syncRow, zohoInv, shopifyOrder) {
    // Skip cancelled orders
    if (shopifyOrder.cancelled_at && !(shopifyOrder.fulfillments || []).length) {
        log(`  ⏭️ #${orderNum}: cancelled before dispatch — skipping`);
        return;
    }

    const balance = parseFloat(zohoInv.balance ?? zohoInv.total);
    const total = parseFloat(zohoInv.total);
    const isPaid = Math.abs(balance - total) > 0.01;

    // Check for credit notes linked to this invoice
    let hasCreditNotes = false;
    try {
        const cnRef = require('../src/services/zohoTransform').creditNoteReference(orderNum, 'return');
        const cnRto = require('../src/services/zohoTransform').creditNoteReference(orderNum, 'rto');
        const cnExch = require('../src/services/zohoTransform').creditNoteReference(orderNum, 'exchange');
        const [cn1, cn2, cn3] = await Promise.all([
            zohoService.searchCreditNotes({ reference_number: cnRef }),
            zohoService.searchCreditNotes({ reference_number: cnRto }),
            zohoService.searchCreditNotes({ reference_number: cnExch })
        ]);
        hasCreditNotes = cn1.length > 0 || cn2.length > 0 || cn3.length > 0;
    } catch (e) { /* assume none */ }

    if (hasCreditNotes) {
        summary.skipped_credit++;
        log(`  ⏭️ #${orderNum}: has credit notes — MANUAL FIX required`);
        return;
    }

    if (isPaid) {
        summary.skipped_paid++;
        log(`  ⏭️ #${orderNum}: has payments (balance ${balance}/${total}) — MANUAL FIX required`);
        return;
    }

    log(`  🔧 #${orderNum}: unpaid, no credit notes → void + re-sync`);

    try {
        // Delete any payments (shouldn't exist if unpaid, but defensive)
        const payments = await zohoService.getPayments(null, zohoInv.invoice_number);
        for (const p of payments) {
            try { await zohoService.deletePayment(p.payment_id); } catch (e) { /* ignore */ }
        }

        // Void + delete old invoice
        await zohoService.voidInvoice(zohoInv.invoice_id);
        await zohoService.deleteInvoice(zohoInv.invoice_id);

        // Remove old sync log so the pipeline re-runs cleanly
        await dbAdapter.run(`DELETE FROM zoho_sync_log WHERE shopify_order_id = ?`, [orderNum]);

        // Re-sync through the corrected pipeline
        const result = await zohoSyncService.syncOrderToZoho(shopifyOrder);
        if (result.success) {
            summary.fixed++;
            log(`  ✅ #${orderNum}: re-synced → invoice ${result.zohoInvoiceId || 'created'}`);
        } else {
            summary.errors.push(`${orderNum}: re-sync failed: ${result.error}`);
            log(`  ❌ #${orderNum}: re-sync failed: ${result.error}`);
        }
    } catch (e) {
        summary.errors.push(`${orderNum}: fix failed: ${e.message}`);
        log(`  ❌ #${orderNum}: fix failed: ${e.message}`);
    }
}

async function phaseFix() {
    // Re-run detect in apply mode — it handles the fix inline
    await phaseDetect();
}

// ============================================================
// Phase: DUPLICATES — find and remove extra invoices from native integration
// ============================================================

async function phaseDuplicates() {
    // Find orders with multiple invoices in Zoho (same reference_number)
    const rows = await dbAdapter.query(
        `SELECT shopify_order_id, COUNT(*) as cnt
         FROM zoho_sync_log
         WHERE status = 'synced' AND zoho_invoice_id IS NOT NULL
         GROUP BY shopify_order_id HAVING COUNT(*) > 1
         LIMIT ?`,
        [LIMIT]
    );
    log(`duplicates: ${rows.length} orders with multiple sync log entries`);

    // Also scan Zoho directly for invoices with duplicate reference numbers
    const seenRefs = {};
    let dupInvoices = [];
    for (let page = 1; page <= 30; page++) {
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
    }

    dupInvoices = Object.entries(seenRefs).filter(([, invs]) => invs.length > 1);
    log(`duplicates: ${dupInvoices.length} reference numbers with multiple invoices in Zoho`);

    await pool(dupInvoices, async ([ref, invoices]) => {
        const orderNum = ref.replace(/^#/, '');

        // Fetch full details to decide which to keep
        const fullInvoices = [];
        for (const inv of invoices) {
            try {
                const full = await zohoService.getInvoice(inv.invoice_id);
                if (full) fullInvoices.push(full);
            } catch (e) { /* skip */ }
        }

        if (fullInvoices.length < 2) return;

        // Strategy: keep the invoice that has line items with discounts
        // (i.e. the one from our middleware, not the native integration)
        // If both have discounts or neither does, keep the most recent one.
        fullInvoices.sort((a, b) => {
            const aDiscount = (a.line_items || []).some(l => parseFloat(l.discount || 0) > 0);
            const bDiscount = (b.line_items || []).some(l => parseFloat(l.discount || 0) > 0);
            if (aDiscount && !bDiscount) return -1; // a is better
            if (!aDiscount && bDiscount) return 1;  // b is better
            // Both same — keep the one created by our middleware (has our reference format)
            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });

        const keep = fullInvoices[0];
        const remove = fullInvoices.slice(1);

        log(`  #${orderNum}: keeping ${keep.invoice_number}, removing ${remove.length} duplicate(s)`);

        if (!APPLY) return;

        for (const dup of remove) {
            // Check for payments on the duplicate
            const payments = await zohoService.getPayments(null, dup.invoice_number);
            if (payments.length > 0) {
                // Transfer payment to the kept invoice before deleting
                log(`    ⚠️ duplicate ${dup.invoice_number} has ${payments.length} payment(s) — skipping (manual review)`);
                continue;
            }

            try {
                await zohoService.voidInvoice(dup.invoice_id);
                await zohoService.deleteInvoice(dup.invoice_id);
                summary.duplicates_removed++;
                log(`    ✅ removed duplicate ${dup.invoice_number}`);
            } catch (e) {
                summary.errors.push(`dup ${dup.invoice_number}: ${e.message}`);
                log(`    ❌ failed to remove ${dup.invoice_number}: ${e.message}`);
            }
        }
    });
}

// ============================================================
// Main
// ============================================================

async function main() {
    console.log(`\n🔍 Zoho ↔ Shopify Price Reconciliation`);
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

    console.log('\n================ SUMMARY ================');
    console.log(`ok: ${summary.ok}`);
    console.log(`detected mismatches: ${summary.detected}`);
    if (APPLY) {
        console.log(`fixed: ${summary.fixed}`);
        console.log(`skipped (has payments): ${summary.skipped_paid}`);
        console.log(`skipped (has credit notes): ${summary.skipped_credit}`);
        console.log(`duplicates removed: ${summary.duplicates_removed}`);
    }
    if (summary.errors.length) {
        console.log(`\n${summary.errors.length} error(s):`);
        summary.errors.slice(0, 50).forEach(e => console.log(`  - ${e}`));
    }
    if (!APPLY) console.log('\nDry-run complete. Re-run with --apply to execute fixes.');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
