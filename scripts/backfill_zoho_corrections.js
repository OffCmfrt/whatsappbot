/**
 * Zoho Historical Corrections Backfill — 25 March 2026 → today
 * ------------------------------------------------------------
 * Identifies and (with --apply) fixes historical records affected by the
 * issues fixed in the middleware overhaul:
 *
 *   Phase rto-credit-notes    RTO orders (all carriers incl. Shiprocket)
 *                             without a Zoho credit note → create linked,
 *                             invoice-mirroring credit notes (no duplicates)
 *   Phase refund-credit-notes Shopify refunds without a credit note
 *   Phase haryana-gst         Same-state (Haryana) invoices that got IGST
 *                             → void + re-sync with correct CGST+SGST
 *   Phase cod-paid            Reconciled COD payments whose Shopify order
 *                             is still unpaid → mark Paid
 *   Phase missing-invoices    Dispatched orders without a Zoho invoice
 *   Phase mismatch-report     Invoice-vs-Shopify total comparison → CSV in tmp/
 *
 * Usage:
 *   node scripts/backfill_zoho_corrections.js                          dry-run, all phases
 *   node scripts/backfill_zoho_corrections.js --phase=cod-paid         dry-run one phase
 *   node scripts/backfill_zoho_corrections.js --apply --phase=rto-credit-notes
 *   node scripts/backfill_zoho_corrections.js --apply                  apply all phases
 *
 * Options:
 *   --limit=N        cap records processed per phase (default 500)
 *   --max-pages=N    Shopify order paging cap for refund scan (default 30)
 *
 * Every phase is idempotent — DB rows, Zoho-side reference checks and
 * existing-document searches are all consulted before any write.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const zohoService = require('../src/services/zohoService');
const zohoSyncService = require('../src/services/zohoSyncService');
const zohoReturnService = require('../src/services/zohoReturnService');
const shopifyService = require('../src/services/shopifyService');
const { creditNoteReference } = require('../src/services/zohoTransform');
const { dbAdapter } = require('../src/database/db');

const WINDOW_START = '2026-03-25';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PHASE = (args.find(a => a.startsWith('--phase=')) || '').split('=')[1] || 'all';
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '500', 10);
const MAX_PAGES = parseInt((args.find(a => a.startsWith('--max-pages=')) || '').split('=')[1] || '30', 10);

const summary = { phase: {}, errors: [] };
function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`); }
function tally(phase, key) {
    summary.phase[phase] = summary.phase[phase] || {};
    summary.phase[phase][key] = (summary.phase[phase][key] || 0) + 1;
}

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

async function fetchShopifyOrderByName(orderNumber) {
    const cfg = shopifyCfg();
    if (!cfg) return null;
    const name = String(orderNumber).replace(/^#/, '');
    try {
        const res = await axios.get(`${cfg.base}/orders.json`, {
            params: { name, status: 'any' }, headers: cfg.headers, timeout: 15000
        });
        return (res.data?.orders || [])[0] || null;
    } catch (e) {
        return null;
    }
}

async function fetchShopifyRefunds(internalOrderId) {
    const cfg = shopifyCfg();
    if (!cfg) return [];
    try {
        const res = await axios.get(`${cfg.base}/orders/${internalOrderId}/refunds.json`, {
            headers: cfg.headers, timeout: 15000
        });
        return res.data?.refunds || [];
    } catch (e) {
        return [];
    }
}

async function* pageShopifyOrders({ updatedSince }) {
    const cfg = shopifyCfg();
    if (!cfg) return;
    let url = `${cfg.base}/orders.json?status=any&limit=250&updated_at_min=${updatedSince}T00:00:00Z`;
    let pages = 0;
    while (url && pages < MAX_PAGES) {
        const res = await axios.get(url, { headers: cfg.headers, timeout: 30000 });
        const orders = res.data?.orders || [];
        if (orders.length > 0) yield orders;
        // Cursor pagination via Link header
        const link = res.headers.link || '';
        const next = (link.split(',').find(p => p.includes('rel="next"')) || '').match(/<([^>]+)>/);
        url = next ? next[1] : null;
        pages++;
        await new Promise(r => setTimeout(r, 300));
    }
}

// ============================================================
// Phase: RTO credit notes (all carriers incl. Shiprocket)
// ============================================================

async function phaseRtoCreditNotes(existingCnRefs) {
    const rows = await dbAdapter.query(
        `SELECT order_id, MAX(carrier) AS carrier, MAX(awb) AS awb
         FROM shipments
         WHERE status IN ('rto', 'rto_delivered') AND created_at >= ?
         GROUP BY order_id
         ORDER BY order_id
         LIMIT ?`,
        [WINDOW_START, LIMIT]
    );
    log(`rto-credit-notes: ${rows.length} RTO orders since ${WINDOW_START}`);

    for (const row of rows) {
        const orderNum = String(row.order_id).replace(/^#/, '');
        const reference = creditNoteReference(orderNum, 'rto');

        // Dedupe: DB row already synced/pending
        const dup = await dbAdapter.query(
            `SELECT id FROM zoho_returns WHERE shopify_order_id IN (?, ?) AND return_type = 'rto' AND status IN ('pending', 'synced')`,
            [orderNum, row.order_id]
        );
        if (dup.length > 0) { tally('rto-credit-notes', 'already_in_db'); continue; }
        // Dedupe: credit note already exists in Zoho with our reference
        if (existingCnRefs.has(reference)) { tally('rto-credit-notes', 'already_in_zoho'); continue; }

        tally('rto-credit-notes', 'eligible');
        log(`  RTO #${orderNum} (${row.carrier || 'unknown carrier'}${row.awb ? ' ' + row.awb : ''}) → credit note ${reference}`);
        if (!APPLY) continue;

        try {
            // Prefer the live Shopify order (self-heals orders that predate
            // the sync log); fall back to the stored sync-log payload.
            const order = await fetchShopifyOrderByName(orderNum);
            const result = order
                ? await zohoReturnService.handleRTO(order, { carrier: row.carrier, awb: row.awb })
                : await zohoReturnService.handleRTOByOrderId(orderNum, { carrier: row.carrier, awb: row.awb });
            if (result.success) tally('rto-credit-notes', 'created');
            else { tally('rto-credit-notes', 'failed'); summary.errors.push(`RTO #${orderNum}: ${result.error}`); }
        } catch (e) {
            tally('rto-credit-notes', 'failed');
            summary.errors.push(`RTO #${orderNum}: ${e.message}`);
        }
    }
}

// ============================================================
// Phase: Shopify refund credit notes
// ============================================================

async function phaseRefundCreditNotes() {
    let scanned = 0, refundOrders = 0;
    for await (const orders of pageShopifyOrders({ updatedSince: WINDOW_START })) {
        for (const order of orders) {
            scanned++;
            if (!['refunded', 'partially_refunded'].includes(order.financial_status)) continue;
            refundOrders++;
            if (refundOrders > LIMIT) return;

            const refunds = await fetchShopifyRefunds(order.id);
            for (const refund of refunds) {
                const refundId = String(refund.id);
                const dup = await dbAdapter.query(
                    `SELECT id FROM zoho_returns WHERE shopify_return_id = ? AND return_type = 'return' AND status IN ('pending', 'synced')`,
                    [refundId]
                );
                if (dup.length > 0) { tally('refund-credit-notes', 'already_in_db'); continue; }

                tally('refund-credit-notes', 'eligible');
                log(`  refund ${refundId} on ${order.name || order.id} → credit note`);
                if (!APPLY) continue;
                try {
                    const result = await zohoReturnService.handleShopifyRefund(order, refund);
                    if (result.success) tally('refund-credit-notes', 'created');
                    else { tally('refund-credit-notes', 'failed'); summary.errors.push(`${order.name}: ${result.error}`); }
                } catch (e) {
                    tally('refund-credit-notes', 'failed');
                    summary.errors.push(`${order.name}: ${e.message}`);
                }
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }
    log(`refund-credit-notes: scanned ${scanned} orders, ${refundOrders} had refunds`);
}

// ============================================================
// Phase: Haryana GST (CGST+SGST correction)
// ============================================================

async function phaseHaryanaGst() {
    // Page through Zoho invoices in the window
    const candidates = [];
    for (let page = 1; page <= 40; page++) {
        let invoices = [];
        try {
            invoices = await zohoService.searchInvoice({ page, per_page: 200 });
        } catch (e) {
            summary.errors.push(`haryana-gst: invoice list page ${page} failed: ${e.message}`);
            break;
        }
        if (!invoices.length) break;
        for (const inv of invoices) {
            if (inv.date && inv.date < WINDOW_START) continue;
            if (inv.status === 'void' || inv.status === 'deleted') continue;
            const addr = inv.shipping_address || {};
            const isHaryana = /haryana/i.test(addr.state || '') || /^hr$/i.test(addr.state_code || '');
            if (isHaryana) candidates.push(inv);
        }
        if (invoices.length < 200) break;
    }
    log(`haryana-gst: ${candidates.length} Haryana invoices since ${WINDOW_START}`);

    for (const inv of candidates.slice(0, LIMIT)) {
        let full;
        try { full = await zohoService.getInvoice(inv.invoice_id); }
        catch (e) { summary.errors.push(`haryana-gst: get ${inv.invoice_id}: ${e.message}`); continue; }

        const lines = full?.line_items || [];
        const hasIgst = lines.some(l => (l.taxes || []).some(t => /igst/i.test(t.tax_name || '')));
        if (!hasIgst) { tally('haryana-gst', 'already_correct'); continue; }

        tally('haryana-gst', 'misapplied_igst');
        const orderNum = (full.reference_number || '').replace(/^#/, '');
        log(`  invoice ${full.invoice_number} (order #${orderNum}) has IGST — needs CGST+SGST`);
        if (!APPLY) continue;

        // Only auto-fix unpaid invoices: void → delete → re-sync through the
        // corrected pipeline. Paid ones need manual accountant review.
        const balance = parseFloat(full.balance ?? full.total);
        const total = parseFloat(full.total);
        if (Math.abs(balance - total) > 0.01) {
            tally('haryana-gst', 'manual_paid');
            log(`    → has payments (balance ${balance}/${total}) — MANUAL FIX required`);
            continue;
        }
        try {
            const payload = await resolveOrderPayload(orderNum);
            if (!payload) throw new Error('no order payload found (sync log + Shopify)');
            await zohoService.voidInvoice(inv.invoice_id);
            await zohoService.deleteInvoice(inv.invoice_id);
            // Drop the old sync log row so the corrected pipeline re-runs
            await dbAdapter.run(`DELETE FROM zoho_sync_log WHERE shopify_order_id = ?`, [orderNum]);
            const result = await zohoSyncService.syncOrderToZoho(payload);
            if (result.success) tally('haryana-gst', 'fixed');
            else { tally('haryana-gst', 'failed'); summary.errors.push(`haryana-gst #${orderNum}: ${result.error}`); }
        } catch (e) {
            tally('haryana-gst', 'failed');
            summary.errors.push(`haryana-gst invoice ${inv.invoice_id}: ${e.message}`);
        }
    }
}

async function resolveOrderPayload(orderNum) {
    if (!orderNum) return null;
    try {
        const rows = await dbAdapter.query(
            'SELECT original_payload FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1',
            [orderNum]
        );
        if (rows.length > 0) {
            return typeof rows[0].original_payload === 'string'
                ? JSON.parse(rows[0].original_payload)
                : rows[0].original_payload;
        }
    } catch (e) { /* fall through to Shopify */ }
    return fetchShopifyOrderByName(orderNum);
}

// ============================================================
// Phase: COD paid status in Shopify
// ============================================================

async function phaseCodPaid() {
    const rows = await dbAdapter.query(
        `SELECT shopify_order_id FROM zoho_cod_payments
         WHERE payment_status = 'reconciled' AND reconciled_at >= ?
         LIMIT ?`,
        [WINDOW_START, LIMIT]
    );
    log(`cod-paid: ${rows.length} reconciled COD payments since ${WINDOW_START}`);

    for (const row of rows) {
        const orderNum = String(row.shopify_order_id).replace(/^#/, '');
        const order = await fetchShopifyOrderByName(orderNum);
        if (!order) { tally('cod-paid', 'order_not_found'); continue; }
        if (order.financial_status === 'paid') { tally('cod-paid', 'already_paid'); continue; }
        if (['refunded', 'partially_refunded', 'voided'].includes(order.financial_status)) {
            tally('cod-paid', 'skipped_status');
            continue;
        }

        tally('cod-paid', 'eligible');
        log(`  #${order.name || orderNum} financial_status=${order.financial_status} → mark Paid`);
        if (!APPLY) continue;
        try {
            const result = await shopifyService.markOrderPaidByOrderNumber(orderNum);
            if (result.success) tally('cod-paid', 'marked_paid');
            else { tally('cod-paid', 'failed'); summary.errors.push(`COD #${orderNum}: ${result.error || result.skipped}`); }
        } catch (e) {
            tally('cod-paid', 'failed');
            summary.errors.push(`COD #${orderNum}: ${e.message}`);
        }
    }
}

// ============================================================
// Phase: Missing invoices for dispatched orders
// ============================================================

async function phaseMissingInvoices() {
    const rows = await dbAdapter.query(
        `SELECT order_id FROM shipments
         WHERE created_at >= ? AND status NOT IN ('cancelled', 'failed')
         GROUP BY order_id ORDER BY order_id LIMIT ?`,
        [WINDOW_START, LIMIT]
    );
    log(`missing-invoices: ${rows.length} dispatched orders since ${WINDOW_START}`);

    for (const row of rows) {
        const orderNum = String(row.order_id).replace(/^#/, '');

        // Already synced (or cancelled-before-dispatch) in the sync log
        const logged = await dbAdapter.query(
            `SELECT status FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1`,
            [orderNum]
        );
        if (logged.length > 0 && ['synced', 'cancelled'].includes(logged[0].status)) {
            tally('missing-invoices', 'already_handled');
            continue;
        }
        // Zoho-side check (covers lost log rows)
        const existing = await zohoService.searchInvoice({ reference_number: orderNum });
        if (existing.length > 0) { tally('missing-invoices', 'already_in_zoho'); continue; }

        const order = await fetchShopifyOrderByName(orderNum);
        if (!order) { tally('missing-invoices', 'order_not_found'); continue; }
        if (order.cancelled_at && !order.fulfillments?.length) {
            tally('missing-invoices', 'cancelled_before_dispatch');
            continue;
        }

        tally('missing-invoices', 'eligible');
        log(`  #${order.name || orderNum} has no Zoho invoice → sync`);
        if (!APPLY) continue;
        try {
            const result = await zohoSyncService.syncOrderToZoho(order);
            if (result.success) tally('missing-invoices', 'synced');
            else { tally('missing-invoices', 'failed'); summary.errors.push(`invoice #${orderNum}: ${result.error}`); }
        } catch (e) {
            tally('missing-invoices', 'failed');
            summary.errors.push(`invoice #${orderNum}: ${e.message}`);
        }
    }
}

// ============================================================
// Phase: Invoice vs Shopify mismatch report (read-only)
// ============================================================

async function phaseMismatchReport() {
    const rows = await dbAdapter.query(
        `SELECT shopify_order_id, zoho_invoice_id, original_payload FROM zoho_sync_log
         WHERE status = 'synced' AND zoho_invoice_id IS NOT NULL AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
        [WINDOW_START, LIMIT]
    );
    log(`mismatch-report: ${rows.length} synced orders to compare`);

    const csvPath = path.join(__dirname, `../tmp/zoho_mismatch_report_${new Date().toISOString().slice(0, 10)}.csv`);
    const lines = ['order,invoice_number,zoho_subtotal,zoho_tax,zoho_total,shopify_items_total,shopify_total,delta_total,notes'];

    for (const row of rows) {
        let inv;
        try { inv = await zohoService.getInvoice(row.zoho_invoice_id); }
        catch (e) { lines.push(`${row.shopify_order_id},,,,,,,,get_invoice failed: ${e.message}`); continue; }

        const payload = typeof row.original_payload === 'string'
            ? JSON.parse(row.original_payload) : row.original_payload;
        const shopifyItemsTotal = (payload?.line_items || [])
            .reduce((s, li) => s + (parseFloat(li.price) || 0) * (li.quantity || 1), 0);
        const zohoSubtotal = parseFloat(inv.subtotal || 0);
        const zohoTax = parseFloat(inv.tax_total || 0);
        const zohoTotal = parseFloat(inv.total || 0);
        const shopifyTotal = parseFloat(payload?.total_price || 0);
        const delta = Math.round((zohoTotal - shopifyTotal) * 100) / 100;

        const notes = [];
        if (Math.abs(delta) > 1) notes.push('total_mismatch');
        if (Math.abs(zohoSubtotal - shopifyItemsTotal) > 1) notes.push('subtotal_vs_items');
        if (notes.length) tally('mismatch-report', 'mismatches');
        else tally('mismatch-report', 'ok');

        lines.push([
            row.shopify_order_id, inv.invoice_number, zohoSubtotal, zohoTax, zohoTotal,
            Math.round(shopifyItemsTotal * 100) / 100, shopifyTotal, delta, notes.join('|')
        ].join(','));
    }

    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, lines.join('\n'));
    log(`mismatch-report: written to ${csvPath}`);
}

// ============================================================
// Main
// ============================================================

async function main() {
    console.log(`\n🔧 Zoho historical corrections — window ${WINDOW_START} → today`);
    console.log(`   mode: ${APPLY ? 'APPLY (writes to Zoho/Shopify/DB)' : 'DRY-RUN (report only)'} | phase: ${PHASE} | limit: ${LIMIT}\n`);

    // One shared Zoho credit-note reference scan for RTO dedupe
    const existingCnRefs = new Set();
    if (PHASE === 'all' || PHASE === 'rto-credit-notes') {
        try {
            const all = await zohoService.searchCreditNotes({ page_limit: 10 });
            for (const cn of all) if (cn.reference_number) existingCnRefs.add(String(cn.reference_number).trim());
            log(`loaded ${existingCnRefs.size} existing credit note references from Zoho`);
        } catch (e) {
            log(`credit note pre-scan failed (${e.message}) — relying on per-order dedupe`);
        }
    }

    const phases = {
        'rto-credit-notes': () => phaseRtoCreditNotes(existingCnRefs),
        'refund-credit-notes': phaseRefundCreditNotes,
        'haryana-gst': phaseHaryanaGst,
        'cod-paid': phaseCodPaid,
        'missing-invoices': phaseMissingInvoices,
        'mismatch-report': phaseMismatchReport
    };

    for (const [name, fn] of Object.entries(phases)) {
        if (PHASE !== 'all' && PHASE !== name) continue;
        console.log(`\n--- phase: ${name} ---`);
        try {
            await fn();
        } catch (e) {
            summary.errors.push(`phase ${name}: ${e.message}`);
            console.error(`❌ phase ${name} crashed: ${e.message}`);
        }
    }

    console.log('\n================ SUMMARY ================');
    for (const [phase, counts] of Object.entries(summary.phase)) {
        console.log(`${phase}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    if (summary.errors.length) {
        console.log(`\n${summary.errors.length} error(s):`);
        summary.errors.slice(0, 50).forEach(e => console.log(`  - ${e}`));
    }
    if (!APPLY) console.log('\nDry-run complete. Re-run with --apply (and optionally --phase=...) to execute.');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
