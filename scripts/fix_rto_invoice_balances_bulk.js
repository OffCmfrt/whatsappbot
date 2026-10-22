/**
 * Fix RTO Invoice Balances — BULK MODE
 * --------------------------------------
 * Instead of scanning each credit note individually (2 API calls × 2656 = slow),
 * this fetches all overdue invoices in bulk and cross-references with RTO
 * credit notes to find unbalanced ones.
 *
 * Usage:
 *   node scripts/fix_rto_invoice_balances_bulk.js              # dry-run
 *   node scripts/fix_rto_invoice_balances_bulk.js --apply      # apply fixes
 *   node scripts/fix_rto_invoice_balances_bulk.js --limit=100  # limit records
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const zohoService = require('../src/services/zohoService');
const { dbAdapter } = require('../src/database/db');

const WINDOW_START = '2026-09-01';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '500', 10);

const summary = {
    totalOverdue: 0,
    withRtoCreditNote: 0,
    alreadyBalanced: 0,
    unbalanced: 0,
    appliedCredit: 0,
    createdCreditNote: 0,
    failed: 0,
    errors: []
};

function log(msg) {
    console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Fetch all RTO credit notes from Zoho in bulk (list API only — no detail fetch).
 */
async function fetchAllRtoCreditNotes() {
    log('Fetching all RTO credit notes from Zoho (list API)...');
    const allCreditNotes = [];
    let page = 1;

    while (true) {
        const result = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/creditnotes`, null, {
            page,
            per_page: 200,
            date_start: WINDOW_START
        });

        const notes = result.creditnotes || [];
        if (notes.length === 0) break;

        const rtoNotes = notes.filter(cn =>
            String(cn.reference_number || '').startsWith('RTO-')
        );
        allCreditNotes.push(...rtoNotes);

        if (notes.length < 200) break;
        page++;
        await sleep(500);
    }

    log(`Found ${allCreditNotes.length} RTO credit notes from ${WINDOW_START}`);
    return allCreditNotes;
}

/**
 * Fetch all overdue invoices in bulk. Zoho's invoice list API returns
 * balance info so we can filter locally without fetching each invoice.
 */
async function fetchOverdueInvoices() {
    log('Fetching overdue invoices from Zoho (bulk)...');
    const allInvoices = [];
    let page = 1;

    while (true) {
        const result = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/invoices`, null, {
            page,
            per_page: 200,
            status: 'overdue',
            date_start: WINDOW_START
        });

        const invoices = result.invoices || [];
        if (invoices.length === 0) break;

        allInvoices.push(...invoices);

        if (invoices.length < 200) break;
        page++;
        log(`  Fetched ${allInvoices.length} overdue invoices so far...`);
        await sleep(500);
    }

    log(`Found ${allInvoices.length} overdue invoices from ${WINDOW_START}`);
    return allInvoices;
}

/**
 * Build a map of order_number → RTO credit note info.
 * The credit note list API doesn't include invoice_id, so we match by
 * extracting the order number from the RTO reference (e.g. RTO-38103 → 38103)
 * and matching against the invoice's reference_number.
 */
function buildRtoCreditNoteMap(rtoCreditNotes) {
    const map = new Map();
    for (const cn of rtoCreditNotes) {
        // Extract order number from reference like "RTO-38103" or "RTO-OFF/26-27/38103"
        const ref = String(cn.reference_number || '');
        const orderNum = ref.replace(/^RTO-/, '').trim();
        if (orderNum) {
            map.set(orderNum, {
                creditnote_id: cn.creditnote_id,
                creditnote_number: cn.creditnote_number,
                reference_number: cn.reference_number,
                amount: parseFloat(cn.amount || cn.total || 0),
                customer_id: cn.customer_id || null
            });
        }
    }
    return map;
}

/**
 * Create additional credit notes for remaining non-product charges
 * (shipping, COD charges, etc.) that were missed in the original RTO credit note.
 */
async function createNonProductCreditNotes(invoice, remainingBalance) {
    const fullInvoice = await zohoService.getInvoice(invoice.invoice_id);

    const isNonProductLine = (l) => {
        const name = (l.name || '').toLowerCase();
        const desc = (l.description || '').toLowerCase();
        return name.includes('shipping') || desc.includes('shipping')
            || name.includes('cod') || desc.includes('cod')
            || name.includes('cash on delivery') || desc.includes('cash on delivery');
    };

    const nonProductLines = (fullInvoice.line_items || []).filter(isNonProductLine);

    if (nonProductLines.length === 0) {
        throw new Error('No shipping/COD lines found in invoice');
    }

    const customerId = fullInvoice.customer_id;

    const creditLines = nonProductLines.map(l => ({
        name: l.name,
        description: `RTO ${l.name} Reversal`,
        quantity: parseFloat(l.quantity || 1),
        rate: parseFloat(l.rate || 0),
        discount: parseFloat(l.discount || 0),
        ...(l.taxes || []).reduce((acc, t) => {
            const tName = String(t.tax_name || '').toUpperCase();
            const tRate = parseFloat(t.rate || 0);
            if (tName.includes('IGST')) acc.igst_rate = tRate;
            else if (tName.includes('CGST')) acc.cgst_rate = tRate;
            else if (tName.includes('SGST')) acc.sgst_rate = tRate;
            return acc;
        }, {})
    }));

    const creditNotePayload = {
        customer_id: customerId,
        date: new Date().toISOString().split('T')[0],
        line_items: creditLines,
        notes: `RTO Non-Product Charge Reversal for Invoice ${invoice.invoice_number}`,
        reference_number: `RTO-MISC-${invoice.reference_number || invoice.invoice_number}`,
        is_inclusive_tax: fullInvoice.is_inclusive_tax || false
    };

    const params = { invoice_id: invoice.invoice_id };
    const url = `${zohoService.BOOKS_BASE()}/creditnotes`;
    const result = await zohoService.zohoRequest('post', url, creditNotePayload, params);

    return result.creditnote;
}

/**
 * Check if the RTO credit note has unapplied balance.
 */
async function checkCreditNoteBalance(creditNoteId) {
    const cn = await zohoService.getCreditNote(creditNoteId);
    const balance = parseFloat(cn.balance_amount || cn.balance || 0);
    return { hasUnapplied: balance > 0.01, balance };
}

/**
 * Apply credit note balance to an invoice.
 */
async function applyCreditToInvoice(creditNoteId, invoiceId, amount) {
    const url = `${zohoService.BOOKS_BASE()}/creditnotes/${creditNoteId}/refund`;
    await zohoService.zohoRequest('post', url, {
        invoice_id: invoiceId,
        amount: amount
    });
}

// ============================================================
// MAIN
// ============================================================
async function fixRtoInvoiceBalancesBulk() {
    // Step 1: Fetch RTO credit notes (list API — fast)
    const rtoCreditNotes = await fetchAllRtoCreditNotes();
    const rtoMap = buildRtoCreditNoteMap(rtoCreditNotes);
    log(`Built RTO credit note map: ${rtoMap.size} invoices linked`);

    // Step 2: Fetch overdue invoices (list API — fast, includes balance)
    const overdueInvoices = await fetchOverdueInvoices();
    summary.totalOverdue = overdueInvoices.length;

    // Step 3: Cross-reference — find overdue invoices that have an RTO credit note
    // Match by order number: invoice reference_number may be "#38103", "OFF/26-27/38103", etc.
    // RTO credit note reference is "RTO-38103". Extract numeric order number from both.
    const unbalanced = [];
    for (const inv of overdueInvoices) {
        const balance = parseFloat(inv.balance || 0);
        if (balance <= 0.01) continue;

        // Extract order number from invoice reference (strip #, slashes, prefixes)
        const invRef = String(inv.reference_number || inv.invoice_number || '');
        const invOrderNum = invRef.replace(/^#/, '').replace(/.*\//, '').trim();

        const rtoCn = rtoMap.get(invOrderNum);
        if (!rtoCn) continue; // overdue but no RTO credit note — not our problem

        summary.withRtoCreditNote++;
        unbalanced.push({
            invoice_id: inv.invoice_id,
            invoice_number: inv.invoice_number,
            reference_number: inv.reference_number,
            total: parseFloat(inv.total || 0),
            balance,
            credits_applied: parseFloat(inv.credits_applied || 0),
            rto_credit_note_id: rtoCn.creditnote_id,
            rto_credit_note_number: rtoCn.creditnote_number,
            rto_credit_amount: rtoCn.amount,
            customer_name: inv.customer_name,
            customer_id: rtoCn.customer_id
        });
    }

    summary.unbalanced = unbalanced.length;
    log(`\n${unbalanced.length} overdue invoices have RTO credit notes but still have balance`);

    if (unbalanced.length === 0) {
        log('All RTO invoices are already balanced. Nothing to fix.');
        return;
    }

    // Step 4: Fix each unbalanced invoice — OPTIMIZED: 1 API call per invoice
    // No getInvoice detail fetch, no checkCreditNoteBalance.
    // Compute credit note from list data: balance is tax-inclusive at 5% IGST,
    // so rate = balance/1.05, igst_rate = 5, is_inclusive_tax = true.
    log(`\nProcessing ${Math.min(unbalanced.length, LIMIT)} unbalanced RTO invoices (1 API call each)...`);
    const toProcess = unbalanced.slice(0, LIMIT);
    let totalCreditValue = 0;

    for (let i = 0; i < toProcess.length; i++) {
        const inv = toProcess[i];
        const orderNum = inv.reference_number || inv.invoice_number;

        try {
            if (APPLY) {
                // Compute pre-tax amount: balance / 1.05 (tax-inclusive at 5% IGST)
                const preTaxRate = Math.round((inv.balance / 1.05) * 100) / 100;

                const creditNotePayload = {
                    customer_id: inv.customer_id,
                    customer_name: inv.customer_name,
                    date: new Date().toISOString().split('T')[0],
                    line_items: [{
                        name: 'RTO Shipping/COD Charge Reversal',
                        description: `Reversal of unreversed shipping/COD charges for RTO order`,
                        quantity: 1,
                        rate: preTaxRate,
                        igst_rate: 5
                    }],
                    notes: `RTO balance reversal — Shopify Order ${orderNum}`,
                    reference_number: `RTO-MISC-${inv.reference_number || inv.invoice_number}`,
                    is_inclusive_tax: true
                };

                const params = { invoice_id: inv.invoice_id };
                const url = `${zohoService.BOOKS_BASE()}/creditnotes`;
                const result = await zohoService.zohoRequest('post', url, creditNotePayload, params);
                const cnNum = result?.creditnote?.creditnote_number || 'created';

                log(`  [${i + 1}/${toProcess.length}] ✅ ${inv.invoice_number} (${orderNum}): ₹${inv.balance.toFixed(2)} → ${cnNum}`);
                summary.createdCreditNote++;
                totalCreditValue += inv.balance;
            } else {
                log(`  [${i + 1}/${toProcess.length}] [DRY-RUN] ${inv.invoice_number} (${orderNum}): would create credit note for ₹${inv.balance.toFixed(2)}`);
                summary.createdCreditNote++;
                totalCreditValue += inv.balance;
            }

            // Rate limit safety: 600ms between calls (~100/min, well under Zoho limits)
            if (i < toProcess.length - 1) {
                await sleep(600);
            }
        } catch (e) {
            log(`  [${i + 1}/${toProcess.length}] ❌ ${inv.invoice_number} (${orderNum}): ${e.message}`);
            summary.failed++;
            summary.errors.push(`${inv.invoice_number}: ${e.message}`);

            // If rate limited, back off longer
            if (e.message?.includes('too many requests') || e.message?.includes('400')) {
                log('    → Rate limited, waiting 30s...');
                await sleep(30000);
            }
        }
    }

    // Summary
    log('\n' + '='.repeat(60));
    log('SUMMARY');
    log('='.repeat(60));
    log(`Total overdue invoices scanned:    ${summary.totalOverdue}`);
    log(`With RTO credit note:              ${summary.withRtoCreditNote}`);
    log(`Already balanced:                  ${summary.alreadyBalanced}`);
    log(`Unbalanced (needs fix):            ${summary.unbalanced}`);
    log(`Applied unapplied credit:          ${summary.appliedCredit}`);
    log(`Created additional credit note:    ${summary.createdCreditNote}`);
    log(`Total credit value:                ₹${totalCreditValue.toFixed(2)}`);
    log(`Failed:                            ${summary.failed}`);
    log(`API calls:                         ~${toProcess.length} (1 per invoice, vs 2-3 before)`);

    if (summary.errors.length > 0) {
        log('\nErrors:');
        for (const err of summary.errors) {
            log(`  - ${err}`);
        }
    }

    const reportPath = path.join(__dirname, '..', 'tmp', `rto_balance_fix_bulk_${new Date().toISOString().split('T')[0]}.json`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    log(`\nReport written to ${reportPath}`);
}

fixRtoInvoiceBalancesBulk().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
