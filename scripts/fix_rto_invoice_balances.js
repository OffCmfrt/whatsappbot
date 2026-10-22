/**
 * Fix RTO Invoice Balances — September 1, 2026 onwards (BULK OPTIMIZED)
 * ---------------------------------------------------------------------
 * RTO credit notes were created for product amounts only, missing shipping
 * and COD charges. This leaves invoices with non-zero balances even after
 * the RTO credit note is applied.
 *
 * OPTIMIZED: Fetches all RTO credit notes in bulk first, then only checks
 * the specific invoices that have RTO credit notes, instead of scanning
 * all 6000+ overdue invoices.
 *
 * Usage:
 *   node scripts/fix_rto_invoice_balances.js              # dry-run
 *   node scripts/fix_rto_invoice_balances.js --apply      # apply fixes
 *   node scripts/fix_rto_invoice_balances.js --limit=50   # limit records
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
    total: 0,
    alreadyBalanced: 0,
    noCreditNote: 0,
    appliedCredit: 0,
    createdCreditNote: 0,
    failed: 0,
    errors: []
};

function log(msg) {
    console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${msg}`);
}

/**
 * Fetch all RTO credit notes from Zoho in bulk.
 * RTO credit notes have reference numbers like "RTO-XXXXX".
 */
async function fetchAllRtoCreditNotes() {
    log('Fetching all RTO credit notes from Zoho...');

    const allCreditNotes = [];
    let page = 1;

    // Fetch all credit notes and filter for RTO references
    while (true) {
        const result = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/creditnotes`, null, {
            page,
            per_page: 200,
            date_start: WINDOW_START
        });

        const notes = result.creditnotes || [];
        if (notes.length === 0) break;

        // Filter for RTO credit notes
        const rtoNotes = notes.filter(cn =>
            String(cn.reference_number || '').startsWith('RTO-')
        );
        allCreditNotes.push(...rtoNotes);

        if (notes.length < 200) break;
        page++;
    }

    log(`Found ${allCreditNotes.length} RTO credit notes from ${WINDOW_START}`);
    return allCreditNotes;
}

/**
 * For each RTO credit note, check if the linked invoice has a balance.
 * Returns only the invoices that need fixing.
 */
async function findUnbalancedInvoices(rtoCreditNotes) {
    log(`Checking ${rtoCreditNotes.length} RTO credit notes for unbalanced invoices...`);

    const unbalanced = [];
    const BATCH = 5;
    const DELAY_MS = 1200; // ~3 req/sec to stay under Zoho rate limits

    // Process sequentially in small batches to avoid rate limits
    for (let i = 0; i < rtoCreditNotes.length; i += BATCH) {
        const batch = rtoCreditNotes.slice(i, i + BATCH);

        for (const cn of batch) {
            try {
                const cnFull = await zohoService.getCreditNote(cn.creditnote_id);
                const invoices = cnFull.invoices || [];
                if (invoices.length === 0) continue;

                const invoiceId = invoices[0].invoice_id;
                const amountApplied = parseFloat(invoices[0].amount_applied || 0);
                const invoice = await zohoService.getInvoice(invoiceId);
                const balance = parseFloat(invoice.balance || 0);

                if (balance > 0.01) {
                    unbalanced.push({
                        invoice_id: invoiceId,
                        invoice_number: invoice.invoice_number,
                        reference_number: invoice.reference_number,
                        total: parseFloat(invoice.total || 0),
                        balance,
                        credits_applied: parseFloat(invoice.credits_applied || 0),
                        rto_credit_note_id: cn.creditnote_id,
                        rto_credit_note_number: cn.creditnote_number,
                        rto_credit_amount: amountApplied,
                        customer_name: invoice.customer_name
                    });
                }
            } catch (e) {
                // skip individual failures
            }
        }

        // Progress logging
        const done = Math.min(i + BATCH, rtoCreditNotes.length);
        if (done % 100 === 0 || done === rtoCreditNotes.length) {
            log(`  Checked ${done}/${rtoCreditNotes.length} credit notes... (${unbalanced.length} unbalanced so far)`);
        }

        // Delay between batches
        if (i + BATCH < rtoCreditNotes.length) {
            await new Promise(r => setTimeout(r, DELAY_MS));
        }
    }

    log(`Found ${unbalanced.length} unbalanced RTO invoices`);
    return unbalanced.slice(0, LIMIT);
}

/**
 * Check if the RTO credit note has unapplied balance that can be applied
 * to the invoice.
 */
async function checkCreditNoteBalance(creditNoteId) {
    try {
        const cn = await zohoService.getCreditNote(creditNoteId);
        const total = parseFloat(cn.total || 0);
        const balance = parseFloat(cn.balance || 0);

        return {
            total,
            balance,
            hasUnapplied: balance > 0.01
        };
    } catch (e) {
        return { total: 0, balance: 0, hasUnapplied: false };
    }
}

/**
 * Apply unapplied credit from a credit note to an invoice.
 */
async function applyCreditToInvoice(creditNoteId, invoiceId, amount) {
    const url = `${zohoService.BOOKS_BASE()}/creditnotes/${creditNoteId}/invoices`;
    const payload = {
        invoice_id: invoiceId,
        amount_applied: amount
    };

    const result = await zohoService.zohoRequest('post', url, payload);
    return result;
}

/**
 * Create additional credit notes for remaining non-product charges
 * (shipping, COD charges, etc.) that were missed in the original RTO credit note.
 */
async function createNonProductCreditNotes(invoice, remainingBalance) {
    // Fetch the full invoice to get all non-product line details
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

    // Get the customer_id from the invoice
    const customerId = fullInvoice.customer_id;

    // Build credit note lines for all non-product charges
    const creditLines = nonProductLines.map(l => ({
        name: l.name,
        description: `RTO ${l.name} Reversal`,
        quantity: parseFloat(l.quantity || 1),
        rate: parseFloat(l.rate || 0),
        discount: parseFloat(l.discount || 0),
        // Preserve tax treatment from original line
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

    // Create credit note linked to the invoice
    const params = { invoice_id: invoice.invoice_id };

    const url = `${zohoService.BOOKS_BASE()}/creditnotes`;
    const result = await zohoService.zohoRequest('post', url, creditNotePayload, params);

    return result.creditnote;
}

/**
 * Main fix loop.
 */
async function fixRtoInvoiceBalances() {
    // Step 1: Fetch all RTO credit notes in bulk
    const rtoCreditNotes = await fetchAllRtoCreditNotes();

    if (rtoCreditNotes.length === 0) {
        log('No RTO credit notes found. Nothing to fix.');
        return;
    }

    // Step 2: Find unbalanced invoices
    const invoices = await findUnbalancedInvoices(rtoCreditNotes);
    summary.total = invoices.length;

    if (invoices.length === 0) {
        log('All RTO invoices are already balanced. Nothing to fix.');
        return;
    }

    log(`\nProcessing ${invoices.length} unbalanced RTO invoices...`);

    // Step 3: Fix each unbalanced invoice
    for (const inv of invoices) {
        const orderNum = inv.reference_number || inv.invoice_number;
        log(`\n  Invoice ${inv.invoice_number} (${orderNum}): balance=₹${inv.balance.toFixed(2)}, credit_applied=₹${inv.credits_applied.toFixed(2)}`);

        try {
            // Check if the RTO credit note has unapplied balance
            const cnBalance = await checkCreditNoteBalance(inv.rto_credit_note_id);

            if (cnBalance.hasUnapplied) {
                // Apply the remaining credit to the invoice
                const amountToApply = Math.min(cnBalance.balance, inv.balance);
                log(`    → Credit note has ₹${cnBalance.balance.toFixed(2)} unapplied, applying ₹${amountToApply.toFixed(2)}`);

                if (APPLY) {
                    await applyCreditToInvoice(inv.rto_credit_note_id, inv.invoice_id, amountToApply);
                    log(`    ✅ Applied ₹${amountToApply.toFixed(2)} to invoice`);
                    summary.appliedCredit++;
                } else {
                    log(`    [DRY-RUN] Would apply ₹${amountToApply.toFixed(2)}`);
                    summary.appliedCredit++;
                }
            } else {
                // Credit note is fully applied, need to create additional credit for non-product charges
                const missingAmount = inv.balance;
                log(`    → Credit note fully applied, creating additional credit note for ₹${missingAmount.toFixed(2)} (shipping/COD)`);

                if (APPLY) {
                    const newCn = await createNonProductCreditNotes(inv, missingAmount);
                    log(`    ✅ Created credit note ${newCn.creditnote_number} for ₹${missingAmount.toFixed(2)}`);
                    summary.createdCreditNote++;
                } else {
                    log(`    [DRY-RUN] Would create credit note for ₹${missingAmount.toFixed(2)}`);
                    summary.createdCreditNote++;
                }
            }
        } catch (e) {
            log(`    ❌ Failed: ${e.message}`);
            summary.failed++;
            summary.errors.push(`${inv.invoice_number}: ${e.message}`);
        }
    }

    // Print summary
    log('\n' + '='.repeat(60));
    log('SUMMARY');
    log('='.repeat(60));
    log(`Total RTO invoices with balance: ${summary.total}`);
    log(`Already balanced:                ${summary.alreadyBalanced}`);
    log(`No credit note found:            ${summary.noCreditNote}`);
    log(`Applied unapplied credit:        ${summary.appliedCredit}`);
    log(`Created additional credit note:  ${summary.createdCreditNote}`);
    log(`Failed:                          ${summary.failed}`);

    if (summary.errors.length > 0) {
        log('\nErrors:');
        for (const err of summary.errors) {
            log(`  - ${err}`);
        }
    }

    // Write report to tmp/
    const reportPath = path.join(__dirname, '..', 'tmp', `rto_balance_fix_${new Date().toISOString().split('T')[0]}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    log(`\nReport written to ${reportPath}`);
}

// Run
fixRtoInvoiceBalances().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
