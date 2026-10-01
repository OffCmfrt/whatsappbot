/**
 * Fix Unpaid Invoices Backfill — 1 Sep 2026 → today
 * ------------------------------------------------------------
 * Finds Zoho invoices created since 1 Sep that are still unpaid
 * (status = "sent") and records the missing payment so they show as
 * "Paid" in Zoho Books.
 *
 *   • Prepaid orders (Shopify financial_status = paid/partially_paid)
 *     → payment_mode = "online"
 *   • COD orders (financial_status = pending, order fulfilled)
 *     → payment_mode = "cash"
 *
 * Usage:
 *   node scripts/fix_unpaid_invoices.js                          dry-run
 *   node scripts/fix_unpaid_invoices.js --apply                  apply
 *   node scripts/fix_unpaid_invoices.js --apply --concurrency=4  slower
 *   node scripts/fix_unpaid_invoices.js --apply --since=2026-09-01  custom date
 */
require('dotenv').config();
const axios = require('axios');

const zohoService = require('../src/services/zohoService');
const { buildCodPaymentPayload } = require('../src/services/zohoTransform');
const { dbAdapter } = require('../src/database/db');

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SINCE = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || '2026-09-01';
const CONCURRENCY = Math.max(1, parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || '4', 10));

const stats = { scanned: 0, already_paid: 0, no_shopify_order: 0, skipped_refunded: 0, skipped_zero_balance: 0, prepaid_fixed: 0, cod_fixed: 0, failed: 0, errors: [] };

function log(msg) { console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`); }

// ── Shopify helpers ───────────────────────────────────────
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
            params: { name, status: 'any' },
            headers: cfg.headers,
            timeout: 15000
        });
        return (res.data?.orders || [])[0] || null;
    } catch (e) {
        return null;
    }
}

// ── Concurrency pool ──────────────────────────────────────
async function pool(items, fn) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
        while (idx < items.length) {
            const i = idx++;
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

// ── Main ──────────────────────────────────────────────────
async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Fix Unpaid Invoices — since ${SINCE}`);
    console.log(`${'='.repeat(60)}\n`);

    // Step 1: Fetch all unpaid invoices from Zoho since SINCE
    // Zoho statuses for unpaid: sent, overdue, partially_paid
    log('Fetching unpaid invoices from Zoho Books...');
    const unpaidInvoices = [];
    const STATUSES = ['sent', 'overdue', 'partially_paid'];
    const seen = new Set();

    for (const status of STATUSES) {
        let page = 1;
        const MAX_PAGES = 200;
        while (page <= MAX_PAGES) {
            const result = await zohoService.searchInvoice({
                status,
                created_date_start: SINCE,
                per_page: 200,
                page
            });
            const batch = result || [];
            for (const inv of batch) {
                // Client-side date filter: only invoices dated on or after SINCE
                const invDate = (inv.date || inv.created_time || '').substring(0, 10);
                if (invDate && invDate < SINCE) continue;
                if (!seen.has(inv.invoice_id)) {
                    seen.add(inv.invoice_id);
                    unpaidInvoices.push(inv);
                }
            }
            if (batch.length < 200) break;
            page++;
            await new Promise(r => setTimeout(r, 200));
        }
        log(`  status=${status}: ${unpaidInvoices.length} unique invoices so far`);
    }

    log(`Found ${unpaidInvoices.length} unpaid invoices since ${SINCE}\n`);
    stats.scanned = unpaidInvoices.length;

    // Step 2: Process each invoice
    await pool(unpaidInvoices, async (inv) => {
        const invoiceId = inv.invoice_id;
        const invoiceNumber = inv.invoice_number;
        const refNumber = inv.reference_number || '';
        const orderNum = String(refNumber).replace(/^#/, '');

        if (!orderNum) {
            log(`  SKIP ${invoiceNumber}: no reference_number (not a Shopify order)`);
            return;
        }

        // Check if invoice already has payments (idempotency)
        try {
            const existingPayments = await zohoService.getPayments(invoiceId, invoiceNumber);
            if (existingPayments.length > 0) {
                stats.already_paid++;
                return;
            }
        } catch (e) {
            // If we can't check payments, continue anyway
        }

        // Check balance — if 0 (e.g. fully credited), skip
        const balance = parseFloat(inv.balance || 0);
        const total = parseFloat(inv.total || inv.amount || 0);
        if (total <= 0) {
            stats.skipped_zero_balance++;
            return;
        }

        // Fetch the Shopify order
        const shopifyOrder = await fetchShopifyOrder(orderNum);
        if (!shopifyOrder) {
            stats.no_shopify_order++;
            log(`  SKIP ${invoiceNumber} (#${orderNum}): Shopify order not found`);
            return;
        }

        const financialStatus = (shopifyOrder.financial_status || '').toLowerCase();

        // Skip refunded/voided orders
        if (['refunded', 'voided'].includes(financialStatus)) {
            stats.skipped_refunded++;
            return;
        }

        // Determine payment mode
        let paymentMode;
        if (financialStatus === 'paid' || financialStatus === 'partially_paid') {
            paymentMode = 'online';
        } else if (financialStatus === 'pending') {
            // COD order — only record payment if the order has been fulfilled/delivered
            const hasFulfillment = (shopifyOrder.fulfillments || []).length > 0;
            if (!hasFulfillment) {
                log(`  SKIP ${invoiceNumber} (#${orderNum}): COD not yet fulfilled`);
                return;
            }
            paymentMode = 'cash';
        } else {
            log(`  SKIP ${invoiceNumber} (#${orderNum}): financial_status=${financialStatus}`);
            return;
        }

        // Use the smaller of balance and total (credit notes may have reduced balance)
        const payAmount = balance > 0 ? Math.min(balance, total) : total;
        if (payAmount <= 0) {
            stats.skipped_zero_balance++;
            return;
        }

        const paymentDate = shopifyOrder.created_at || inv.date || new Date().toISOString();
        const customerId = inv.customer_id || null;

        log(`  FIX ${invoiceNumber} (#${orderNum}): ${paymentMode} ₹${payAmount} (balance=${balance}, total=${total}, fin=${financialStatus})`);

        if (!APPLY) {
            if (paymentMode === 'online') stats.prepaid_fixed++;
            else stats.cod_fixed++;
            return;
        }

        try {
            const payload = buildCodPaymentPayload(invoiceId, payAmount, paymentDate, customerId);
            payload.payment_mode = paymentMode;
            payload.description = paymentMode === 'online'
                ? `Prepaid Payment — ${((shopifyOrder.payment_gateway_names || []).join('/') || 'online')} (backfill)`
                : `COD Payment (backfill)`;

            const payment = await zohoService.recordPayment(payload);
            log(`    ✅ payment ${payment?.payment_id || 'recorded'}`);

            if (paymentMode === 'online') stats.prepaid_fixed++;
            else stats.cod_fixed++;

            // Also mark Shopify order as paid for COD
            if (paymentMode === 'cash') {
                try {
                    const shopifyService = require('../src/services/shopifyService');
                    await shopifyService.markOrderPaidByOrderNumber(orderNum);
                } catch (e) {
                    // non-critical
                }
            }
        } catch (e) {
            stats.failed++;
            stats.errors.push(`${invoiceNumber} (#${orderNum}): ${e.message}`);
            log(`    ❌ failed: ${e.message}`);
        }

        // Small delay between API calls
        await new Promise(r => setTimeout(r, 150));
    });

    // ── Summary ───────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`Scanned:           ${stats.scanned}`);
    console.log(`Already paid:      ${stats.already_paid}`);
    console.log(`Zero balance:      ${stats.skipped_zero_balance}`);
    console.log(`No Shopify order:  ${stats.no_shopify_order}`);
    console.log(`Skipped refunded:  ${stats.skipped_refunded}`);
    console.log(`Prepaid fixed:     ${stats.prepaid_fixed}`);
    console.log(`COD fixed:         ${stats.cod_fixed}`);
    console.log(`Failed:            ${stats.failed}`);

    if (stats.errors.length) {
        console.log(`\n${stats.errors.length} error(s):`);
        stats.errors.slice(0, 50).forEach(e => console.log(`  - ${e}`));
    }

    if (!APPLY) {
        console.log('\nDry-run complete. Re-run with --apply to execute.');
    } else {
        console.log('\nDone.');
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
