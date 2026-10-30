const zohoService = require('./zohoService');
const zohoCodService = require('./zohoCodService');
const {
    buildCreditNotePayload,
    buildCreditNoteFromInvoice,
    creditNoteReference,
    breakBundleLineItems,
    loadBundleMap,
    determineTaxType
} = require('./zohoTransform');
const { createItemResolver } = require('./zohoItemResolver');
const { taxFromInvoiceLine, extractSizeFromTitle } = require('./zohoTransform');
const { dbAdapter } = require('../database/db');

// One resolver per process. A catalog miss costs up to three Zoho searches, so
// rebuilding the cache for every invoice throws that work away — a bulk run
// resolves the same few hundred style/size names over and over.
let sharedResolver = null;
function getItemResolver() {
    if (!sharedResolver) sharedResolver = createItemResolver();
    return sharedResolver;
}

// Bundle map is a small static table; don't hit Postgres once per invoice.
let bundleMapCache = { value: null, at: 0 };
const BUNDLE_MAP_TTL_MS = 5 * 60 * 1000;
async function getBundleMap() {
    if (bundleMapCache.value && Date.now() - bundleMapCache.at < BUNDLE_MAP_TTL_MS) {
        return bundleMapCache.value;
    }
    const map = await loadBundleMap();
    bundleMapCache = { value: map, at: Date.now() };
    return map;
}

// Append " - SIZE" to a product title when the size is provided separately
// and not already present in the title. Zoho Books catalog uses the format
// "PRODUCT ( COLOR ) - SIZE" so the item resolver can match and deduct stock.
function withSizeInTitle(title, variant) {
    if (!title) title = '';
    if (!variant || variant === 'Same') return title;
    if (/\s-\s\S+\s*$/.test(title)) return title;
    return title + ' - ' + variant;
}

// ============================================================
// ZOHO RETURN / RTO HANDLER
// Creates credit notes in Zoho when returns or RTOs happen.
// ============================================================

/**
 * Shopify refund webhooks deliver the INTERNAL order id (7048440381684),
 * but the sync log + Zoho reference numbers use the display order number
 * (#46015). Resolve the display number from the sync log (matches both).
 */
async function resolveOrderNumber(orderId) {
    const key = String(orderId || '').replace(/^#/, '');
    if (!key) return key;
    try {
        const rows = await dbAdapter.query(
            `SELECT shopify_order_id FROM zoho_sync_log
             WHERE shopify_order_id = ? OR original_payload->>'id' = ?
             ORDER BY created_at DESC LIMIT 1`,
            [key, key]
        );
        if (rows.length > 0) return rows[0].shopify_order_id;
    } catch (e) { /* keep the incoming key */ }
    return key;
}

/**
 * Find the Zoho invoice for an order; auto-syncs the order from Shopify
 * first when it was never invoiced (reuses the COD self-heal helper).
 * Prefers a non-void invoice — some legacy orders have a duplicate from
 * the old native integration.
 */
async function findInvoiceForOrder(orderId) {
    const invoices = await zohoCodService.ensureInvoiceExists(orderId);
    if (!invoices || invoices.length === 0) return null;
    return invoices.find(i => i.status !== 'void' && i.status !== 'deleted') || invoices[0];
}

/**
 * Fetch the FULL invoice (with line items, discounts and applied taxes)
 * — the list API only returns totals, which is not enough to mirror the
 * original tax treatment and discount on a credit note.
 */
async function fetchFullInvoice(listInvoice) {
    try {
        const full = await zohoService.getInvoice(listInvoice.invoice_id);
        if (full) return full;
    } catch (e) {
        console.warn(`⚠️ Zoho: full invoice fetch failed for ${listInvoice.invoice_id}: ${e.message}`);
    }
    return listInvoice;
}

/**
 * Tax decision fallback for credit lines that don't match any invoice
 * line — derived from seller vs customer state, never hardcoded.
 */
function fallbackTaxDecisionFor(shopifyOrder) {
    const customerState = shopifyOrder?.shipping_address?.province || shopifyOrder?.billing_address?.province || '';
    return determineTaxType(process.env.ZOHO_SELLER_STATE || 'Haryana', customerState);
}

/**
 * Credit note payload that MIRRORS the invoice it reverses: same rate, same
 * discount proportion, same tax basis (CGST+SGST vs IGST, inclusive vs
 * exclusive) and item-linked lines so the stock returns. Falls back to the
 * state-derived payload when the invoice has no usable lines.
 */
async function buildMirroredCreditNotePayload({
    shopifyOrder, orderId, returnItems, returnType, fullInvoice, reference, extraNotes = '', customerId = null
}) {
    const fallbackTaxDecision = fallbackTaxDecisionFor(shopifyOrder);
    const payload = (fullInvoice?.line_items || []).length > 0
        ? await buildCreditNoteFromInvoice({
            shopifyOrder, returnItems, returnType,
            originalInvoice: fullInvoice,
            extraNotes,
            referenceNumber: reference,
            fallbackTaxDecision
        })
        : buildCreditNotePayload(shopifyOrder, returnItems, returnType, extraNotes, fallbackTaxDecision);

    // Books requires the credit note's customer to be EXACTLY the invoice's
    // customer (400 "You cannot change the customer..."). The invoice's own
    // customer_id is authoritative; the Shopify-resolved customer is only a
    // fallback for the rare case the invoice has none.
    payload.customer_id = fullInvoice?.customer_id || customerId || null;
    payload.invoice_id = fullInvoice?.invoice_id;
    return payload;
}

/**
 * Books rejects a credit note whose total would exceed the invoice total or
 * fall below zero ("credit notes balance isn't negative") — cap the lines at
 * the remaining creditable amount, proportionally, instead of failing. Runs
 * whether or not credits were already applied, and also catches negative line
 * totals from bad discount mirroring.
 */
function capCreditNoteToBalance(payload, fullInvoice, reference, returnType) {
    try {
        const invoiceTotal = parseFloat(fullInvoice?.total);
        const alreadyCredited = parseFloat(fullInvoice?.credits_applied) || 0;
        if (Number.isFinite(invoiceTotal) && invoiceTotal > 0) {
            const remaining = invoiceTotal - alreadyCredited;
            const inclusive = !!payload.is_inclusive_tax;

            const estTotal = (payload.line_items || []).reduce((sum, l) => {
                const net = (parseFloat(l.rate) || 0) * (parseFloat(l.quantity) || 1) - (parseFloat(l.discount) || 0);
                const pct = (parseFloat(l.cgst_rate) || 0) + (parseFloat(l.sgst_rate) || 0)
                    + (parseFloat(l.igst_rate) || 0);
                return sum + (inclusive ? net : net * (1 + pct / 100));
            }, 0);

            if (remaining <= 0.02) {
                console.log(`ℹ️ Zoho ${returnType}: invoice ${fullInvoice.invoice_id} already fully credited (₹${alreadyCredited.toFixed(2)} of ₹${invoiceTotal.toFixed(2)}) — skipping ${reference}`);
                return { fullyCredited: true };
            }
            if (estTotal < -0.02) {
                throw new Error(`Credit note ${reference} built a negative total (₹${estTotal.toFixed(2)}) — discount mirroring bug, aborting before Zoho rejects it`);
            }
            if (estTotal > remaining + 0.02) {
                const factor = remaining / estTotal;
                console.warn(`⚠️ Zoho ${returnType}: capping ${reference} from ₹${estTotal.toFixed(2)} to remaining creditable ₹${remaining.toFixed(2)}`);
                for (const l of payload.line_items || []) {
                    l.rate = Math.round((parseFloat(l.rate) || 0) * factor * 100) / 100;
                    l.discount = Math.round((parseFloat(l.discount) || 0) * factor * 100) / 100;
                }
            }
        }
    } catch (capErr) {
        // Negative-total abort is a real bug — surface it instead of
        // proceeding with a payload Zoho will reject anyway
        if (/negative total/.test(capErr.message)) throw capErr;
        console.warn(`⚠️ Zoho ${returnType}: balance-cap check failed (${capErr.message}) — attempting full amount`);
    }
    return { fullyCredited: false };
}

/**
 * Shared credit note flow for returns, RTOs and exchanges:
 *  1. Zoho-side duplicate check (reference convention)
 *  2. customer resolution
 *  3. original invoice lookup (auto-syncs when missing) + full fetch
 *  4. payload that mirrors the invoice (rate, discount share, tax basis)
 *  5. creation linked to the invoice via invoice_id query param
 * Never deletes the original invoice — reversal happens via credit note.
 */
async function prepareAndCreateCreditNote({ shopifyOrder, orderId, returnItems, returnType, reference, extraNotes = '' }) {
    // Zoho-side dedupe: one credit note per reference (req: no duplicates)
    try {
        const existing = await zohoService.searchCreditNotes({ reference_number: reference });
        if (existing.length > 0) {
            console.log(`✅ Zoho ${returnType}: credit note for reference ${reference} already exists in Zoho (${existing[0].creditnote_id})`);
            return {
                success: true,
                alreadyProcessed: true,
                creditNoteId: existing[0].creditnote_id,
                creditNoteTotal: parseFloat(existing[0].total) || 0,
                customerId: existing[0].customer_id || null
            };
        }
    } catch (dedupeErr) {
        console.warn(`⚠️ Zoho ${returnType}: credit note dedupe check failed (${dedupeErr.message}) — DB dedupe still applies`);
    }

    // Resolve customer in Zoho
    const customerName = `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim();
    let customerId = null;
    try {
        const zohoCustomer = await zohoService.getOrCreateCustomer(customerName, shopifyOrder.email || '', shopifyOrder.phone || '');
        customerId = zohoCustomer?.contact_id || null;
    } catch (custErr) {
        console.warn(`⚠️ Zoho customer lookup failed for ${returnType}: ${custErr.message}`);
    }

    // Find the original invoice (auto-syncs the order first if it was never
    // invoiced). Books links credit notes ONLY via the invoice_id query
    // parameter — see zohoService.createCreditNote.
    const originalInvoice = await findInvoiceForOrder(orderId);
    if (!originalInvoice) {
        throw new Error(`No Zoho invoice found for order #${orderId} even after on-demand sync — cannot create credit note`);
    }
    const fullInvoice = await fetchFullInvoice(originalInvoice);

    const creditNotePayload = await buildMirroredCreditNotePayload({
        shopifyOrder, orderId, returnItems, returnType, fullInvoice, reference, extraNotes,
        customerId: customerId || originalInvoice.customer_id
    });

    // For RTOs where ALL items are returned, include shipping and COD charges
    // in the credit note so the invoice balances to zero. Without this, those
    // charges remain as an outstanding balance on the invoice.
    if (returnType === 'rto' && fullInvoice?.line_items?.length > 0) {
        const isNonProductLine = (l) => {
            const name = (l.name || '').toLowerCase();
            const desc = (l.description || '').toLowerCase();
            return name.includes('shipping') || desc.includes('shipping')
                || name.includes('cod') || desc.includes('cod')
                || name.includes('cash on delivery') || desc.includes('cash on delivery');
        };

        const invoiceItemLines = fullInvoice.line_items.filter(l => !isNonProductLine(l));
        const nonProductLines = fullInvoice.line_items.filter(l => isNonProductLine(l));

        // Check if all invoice product items are being returned
        const totalInvoiceQty = invoiceItemLines.reduce((sum, l) => sum + parseFloat(l.quantity || 0), 0);
        const totalReturnQty = returnItems.reduce((sum, l) => sum + parseInt(l.quantity || 1), 0);

        if (totalReturnQty >= totalInvoiceQty && totalInvoiceQty > 0) {
            // All items returned — add shipping/COD lines to credit note
            for (const extraLine of nonProductLines) {
                const creditLine = {
                    name: extraLine.name,
                    description: `RTO ${extraLine.name} Reversal`,
                    quantity: parseFloat(extraLine.quantity || 1),
                    rate: parseFloat(extraLine.rate || 0),
                    discount: parseFloat(extraLine.discount || 0)
                };

                // Preserve tax treatment from original line
                if (extraLine.taxes) {
                    for (const t of extraLine.taxes) {
                        const tName = String(t.tax_name || '').toUpperCase();
                        const tRate = parseFloat(t.rate || 0);
                        if (tName.includes('IGST')) creditLine.igst_rate = tRate;
                        else if (tName.includes('CGST')) creditLine.cgst_rate = tRate;
                        else if (tName.includes('SGST')) creditLine.sgst_rate = tRate;
                    }
                } else if (extraLine.tax_percentage) {
                    creditLine.tax_percentage = parseFloat(extraLine.tax_percentage || 0);
                }

                creditNotePayload.line_items.push(creditLine);
                console.log(`📦 Zoho RTO: all items returned, added ${extraLine.name} (₹${creditLine.rate.toFixed(2)}) to credit note`);
            }
        }
    }

    const cap = capCreditNoteToBalance(creditNotePayload, fullInvoice, reference, returnType);
    if (cap.fullyCredited) {
        return { success: true, creditNoteId: null, fullyCredited: true, creditNoteTotal: 0, customerId };
    }

    const creditNote = await zohoService.createCreditNote(creditNotePayload);
    const creditNoteTotal = parseFloat(creditNote?.total) || 0;
    await ensureCreditNoteApplied({ creditNote, fullInvoice, reference, returnType });
    return {
        success: true,
        creditNoteId: creditNote?.creditnote_id || null,
        creditNoteTotal,
        customerId
    };
}

/**
 * Make sure the credit note is actually APPLIED to the invoice it reverses.
 *
 * Books does not always apply a credit note created against an invoice — it
 * can leave it as unused customer credit, so the invoice keeps showing the
 * returned amount as due even though the return is booked. The invoice is
 * re-read after creation (Books has by then applied it if it was going to) and
 * only the difference is applied. Failure is non-fatal: the credit note itself
 * is valid and merely sits as customer credit.
 */
async function ensureCreditNoteApplied({ creditNote, fullInvoice, reference, returnType }) {
    const creditNoteId = creditNote?.creditnote_id;
    const invoiceId = fullInvoice?.invoice_id;
    const amount = Math.round((parseFloat(creditNote?.total) || 0) * 100) / 100;
    if (!creditNoteId || !invoiceId || !(amount > 0)) return false;

    const before = Math.round((parseFloat(fullInvoice?.credits_applied) || 0) * 100) / 100;
    let after = before;
    try {
        const fresh = await zohoService.getInvoice(invoiceId);
        after = Math.round((parseFloat(fresh?.credits_applied) || 0) * 100) / 100;
    } catch (e) {
        // State unknown — an over-application is rejected by Books rather than
        // double-crediting the invoice, so attempting it is still safe.
    }

    const pending = Math.round(Math.max(0, amount - Math.max(0, after - before)) * 100) / 100;
    if (pending <= 0.01) return true;

    try {
        await zohoService.applyCreditNote(creditNoteId, invoiceId, pending);
        console.log(`✅ Zoho ${returnType}: credit note ${reference} applied to invoice ${fullInvoice.invoice_number || invoiceId} (₹${pending.toFixed(2)})`);
        return true;
    } catch (e) {
        console.warn(`⚠️ Zoho ${returnType}: credit note ${reference} could not be applied to invoice ${fullInvoice.invoice_number || invoiceId} (${e.message}) — it remains as customer credit`);
        return false;
    }
}

// Charge lines (shipping, COD) are never part of an exchange swap: they stay
// on the original invoice and are never billed a second time.
const isChargeLine = (l) => /shipping|cod|cash on delivery/i.test(`${l?.name || ''} ${l?.description || ''}`);

// A rendered line carries its GST split as flat rates (that is what Books
// accepts on a POST/PUT). The credit-note builder reads the split from the
// `taxes[]` array Zoho returns, so rebuild that shape for lines we built.
function taxesArrayFromRates(line) {
    const taxes = [];
    if (parseFloat(line.igst_rate)) taxes.push({ tax_name: 'IGST', rate: parseFloat(line.igst_rate) });
    if (parseFloat(line.cgst_rate)) taxes.push({ tax_name: 'CGST', rate: parseFloat(line.cgst_rate) });
    if (parseFloat(line.sgst_rate)) taxes.push({ tax_name: 'SGST', rate: parseFloat(line.sgst_rate) });
    return taxes;
}

/** The invoice's dominant product tax split (used by lines built without one). */
function dominantInvoiceTax(invoiceLines) {
    let best = null;
    for (const line of invoiceLines || []) {
        if (isChargeLine(line)) continue;
        const tax = taxFromInvoiceLine(line);
        if (!tax.tax_percentage) continue;
        const gross = (parseFloat(line.rate) || 0) * (parseFloat(line.quantity) || 1);
        if (!best || gross > best.gross) best = { ...tax, gross };
    }
    return best;
}

/**
 * Lines for the standalone replacement invoice: the exchanged items in the
 * shape the ORIGINAL invoice bills, priced from the exchange record
 * (`replacementPrice`, prorated across bundle components). A record without a
 * price falls back to what the customer paid for the item it replaces, so a
 * same-product swap never moves money.
 */
async function buildReplacementInvoiceLines({ invoiceLines = [], originalItems = [], exchangedItems = [] }) {
    if (!exchangedItems?.length) return [];
    const lines = await buildSwapLines({
        invoiceLines,
        fromItems: originalItems,
        toItems: exchangedItems,
        useRecordedPrice: true,
        newDocument: true,
        rateFor: (exItem, inheritedRate, origLine) => {
            const explicit = parseFloat(exItem.price) || 0;
            if (explicit > 0) return explicit;
            // No price on the exchange record: bill what the customer ACTUALLY
            // paid for the item being replaced, net of its line discount. The
            // replacement line carries no discount of its own, so inheriting
            // the gross rate would leave a balance on a like-for-like swap.
            const net = Math.round(Math.max(0, inheritedRate - (parseFloat(origLine?.discount) || 0)) * 100) / 100;
            if (net > 0) {
                console.warn(`⚠️ Zoho exchange: no replacement price for "${exItem.name}" — billing the amount paid (₹${net})`);
            }
            return net;
        }
    });

    // A replacement that matched no invoice line (renamed style, extra piece)
    // inherits no GST split. Give it the invoice's dominant one, otherwise the
    // new document is billed untaxed while the credit note reverses tax.
    const tax = dominantInvoiceTax(invoiceLines);
    if (tax) {
        for (const line of lines) {
            if (line.cgst_rate || line.sgst_rate || line.igst_rate || line.tax_percentage) continue;
            if (tax.cgst_rate) line.cgst_rate = tax.cgst_rate;
            if (tax.sgst_rate) line.sgst_rate = tax.sgst_rate;
            if (tax.igst_rate) line.igst_rate = tax.igst_rate;
            if (tax.tax_percentage) line.tax_percentage = tax.tax_percentage;
        }
    }
    return lines;
}

/**
 * Exchange replacement invoice — the NEW items the customer received, billed
 * on their own document (EXCH-INV-<order>) at the exchange record's price.
 * The returned items are reversed by the EXCH-<order> credit note on the
 * original invoice, so the two documents settle the exchange between them.
 *
 * One document per order: an existing one (including the ₹0 stock-only
 * artifact the old flow left behind) is re-lined in place instead of a second
 * invoice being created.
 */
async function createExchangeReplacementInvoice({
    orderId, exchangedItems, originalItems = [], originalInvoice = null,
    invoiceLines = [], existingInvoiceId = null
}) {
    if (!exchangedItems?.length) return null;
    const ref = `EXCH-INV-${String(orderId).replace(/^#/, '')}`;
    const zohoLines = await buildReplacementInvoiceLines({ invoiceLines, originalItems, exchangedItems });
    if (zohoLines.length === 0) return null;

    // Dedupe — one replacement invoice per order. A VOID document is not a
    // usable invoice (Books refuses to re-line it and no payment can settle
    // it), so it never counts as "already booked".
    const usable = (inv) => inv && inv.status !== 'void' && inv.status !== 'deleted';
    let invoiceId = existingInvoiceId || null;
    if (invoiceId) {
        // Callers may pass an id from a list scan; only trust it when the
        // document can still be written to.
        try {
            if (!usable(await zohoService.getInvoice(invoiceId))) invoiceId = null;
        } catch (e) { invoiceId = null; }
    }
    if (!invoiceId) {
        try {
            const existing = await zohoService.searchInvoice({ reference_number: ref });
            invoiceId = existing.find(usable)?.invoice_id || null;
            if (existing.length && !invoiceId) {
                console.warn(`⚠️ Zoho exchange: order #${orderId} has a void ${ref} — creating a usable one instead`);
            }
        } catch (e) { /* create a fresh document */ }
    }

    let invoice;
    if (invoiceId) {
        invoice = await zohoService.updateInvoice(
            invoiceId,
            { line_items: zohoLines, is_inclusive_tax: true },
            `Exchange: replacement items billed (order #${orderId})`
        );
    } else {
        const payload = {
            customer_id: originalInvoice?.customer_id || undefined,
            date: new Date().toISOString().split('T')[0],
            payment_terms: 0,
            line_items: zohoLines,
            notes: `Exchange replacement for Shopify Order #${orderId}`,
            reference_number: ref,
            is_inclusive_tax: true,
            // Same GST basis as the invoice the credit note reverses
            gst_treatment: originalInvoice?.gst_treatment || 'consumer'
        };
        if (originalInvoice?.place_of_supply) payload.place_of_supply = originalInvoice.place_of_supply;
        if (originalInvoice?.shipping_address) payload.shipping_address = originalInvoice.shipping_address;
        invoice = await zohoService.createInvoice(payload);
    }

    // Mark sent so the stock deduction actually happens
    try {
        await zohoService.markInvoiceSent(invoice.invoice_id);
    } catch (sentErr) {
        console.warn(`⚠️ Zoho exchange: replacement invoice mark-sent failed (${sentErr.message})`);
    }
    return invoice;
}

/**
 * Move the customer's money onto the replacement invoice.
 *
 * The payment is recorded against the ORIGINAL invoice, which the exchange
 * credit note just reduced — left alone the invoice ends up overpaid while the
 * replacement shows as unpaid. Only payments applied to this invoice ALONE are
 * moved: deleting a payment that also settles other invoices would unbalance
 * documents this flow knows nothing about, so those are reported instead.
 *
 * Split rule: the original invoice keeps what it is still owed after the
 * credit note, the replacement invoice receives up to its own total, and any
 * remainder (a cheaper replacement) is reported as an unused/refundable amount.
 */
async function moveExchangePayments({ originalInvoice, replacementInvoice, creditNoteTotal = 0 }) {
    const result = { moved: 0, stayed: 0, leftover: 0, warnings: [] };
    const invoiceId = originalInvoice?.invoice_id;
    if (!invoiceId || !replacementInvoice?.invoice_id) {
        result.warnings.push('missing invoice document — payments not moved');
        return result;
    }

    let payments = [];
    try {
        payments = await zohoService.getPayments(invoiceId, originalInvoice.invoice_number);
    } catch (e) {
        result.warnings.push(`payment lookup failed: ${e.message}`);
        return result;
    }
    if (!payments.length) return result;

    const invoiceNumber = String(originalInvoice.invoice_number || '');
    const appliesOnlyHere = (p) => {
        const applied = Array.isArray(p.invoices) ? p.invoices : [];
        if (applied.length > 1) return false;
        if (applied.length === 1 && applied[0]?.invoice_id && String(applied[0].invoice_id) !== String(invoiceId)) return false;
        const numbers = String(p.invoice_numbers || '');
        if (numbers.includes(',')) return false;
        if (numbers && invoiceNumber && !numbers.includes(invoiceNumber)) return false;
        return true;
    };
    const movable = payments.filter(appliesOnlyHere);
    if (movable.length < payments.length) {
        result.warnings.push(`${payments.length - movable.length} payment(s) also settle other invoices — left untouched`);
    }
    const round = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
    const paid = round(movable.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0));
    if (paid <= 0.01) return result;

    const oldTarget = Math.min(paid, Math.max(0, round((parseFloat(originalInvoice.total) || 0) - round(creditNoteTotal))));
    // The replacement is settled by its outstanding BALANCE, not its total: a
    // document that already took money must not be paid twice.
    const replacementDue = round(
        parseFloat(replacementInvoice.balance) >= 0 ? replacementInvoice.balance : replacementInvoice.total
    );
    const newTarget = Math.min(round(paid - oldTarget), Math.max(0, replacementDue));

    const sample = movable[0];
    const recordOn = (targetInvoiceId, amount, description) => zohoService.recordPayment({
        customer_id: sample.customer_id || originalInvoice.customer_id,
        amount,
        date: sample.date || new Date().toISOString().split('T')[0],
        payment_mode: sample.payment_mode || 'cash',
        invoices: [{ invoice_id: targetInvoiceId, amount_applied: amount }],
        description
    });

    const deleted = [];
    for (const p of movable) {
        try {
            await zohoService.deletePayment(p.payment_id);
            deleted.push(p);
        } catch (e) {
            // Never leave money unrecorded: put back what was already removed.
            const removed = round(deleted.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
            const back = Math.min(removed, oldTarget);
            if (back > 0) {
                await recordOn(invoiceId, back, 'Exchange: payment restored after a failed transfer').catch(() => {});
            }
            result.warnings.push(`payment ${p.payment_id} could not be moved: ${e.message}`);
            return result;
        }
    }

    if (oldTarget > 0) {
        try {
            await recordOn(invoiceId, oldTarget, 'Exchange: payment re-recorded after the exchange credit note');
            result.stayed = oldTarget;
        } catch (e) {
            result.warnings.push(`₹${oldTarget} not recorded back on the original invoice: ${e.message}`);
        }
    }
    if (newTarget > 0) {
        try {
            await recordOn(replacementInvoice.invoice_id, newTarget, 'Exchange: payment transferred from the original invoice');
            result.moved = newTarget;
        } catch (e) {
            result.warnings.push(`₹${newTarget} not recorded on the replacement invoice: ${e.message}`);
        }
    }
    result.leftover = Math.max(0, round(paid - result.moved - result.stayed));
    if (result.leftover > 0) {
        result.warnings.push(`₹${result.leftover} of recorded payment is now unused (refund/advance) — settle manually`);
    }
    return result;
}

/**
 * Was this order actually paid? The Zoho documents cannot answer that once a
 * cleanup flow has deleted the payment, so ask the source that recorded the
 * order: the Shopify payload in the sync log.
 */
async function orderPaidFromSyncLog(orderId) {
    const key = String(orderId || '').replace(/^#/, '');
    if (!key) return false;
    try {
        const rows = await dbAdapter.query(
            `SELECT original_payload->>'financial_status' AS financial_status
             FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1`,
            [key]
        );
        const status = String(rows[0]?.financial_status || '').toLowerCase();
        return status === 'paid' || status === 'partially_paid';
    } catch (e) {
        return false;
    }
}

/**
 * Settle the replacement invoice.
 *
 * The customer's money follows the goods: when the order was paid, what they
 * paid is what funds the product they now hold, and the credit note released
 * exactly that amount on the original invoice. Moving recorded payments already
 * covers the usual case — this covers the ones where nothing is left to move
 * (an old cleanup flow deleted the payment, or it never reached this invoice),
 * which is what leaves a paid exchange showing as overdue.
 *
 * Unpaid (COD) orders are deliberately left alone: their money is still to be
 * collected, so the warning says so instead of inventing a receipt.
 */
async function settleReplacementInvoice({ replacementInvoiceId, creditNoteTotal = 0, orderPaid = false, orderId = '', paymentMode = 'cash' }) {
    const out = { settled: 0, balance: 0, warnings: [] };
    if (!replacementInvoiceId) return out;

    const round = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
    let invoice;
    try {
        invoice = await zohoService.getInvoice(replacementInvoiceId);
    } catch (e) {
        out.warnings.push(`replacement invoice re-read failed: ${e.message}`);
        return out;
    }

    out.balance = round(invoice?.balance);
    if (out.balance <= 0.02) return out; // already settled

    if (!orderPaid) {
        out.warnings.push(`replacement invoice ${invoice.invoice_number || replacementInvoiceId} carries ₹${out.balance} — the order is not marked paid, so COD/collection settles it`);
        return out;
    }

    const credit = round(creditNoteTotal);
    const amount = credit > 0 ? Math.min(out.balance, credit) : out.balance;
    if (!(amount > 0)) return out;

    try {
        await zohoService.recordPayment({
            customer_id: invoice.customer_id,
            amount,
            date: new Date().toISOString().split('T')[0],
            payment_mode: paymentMode,
            invoices: [{ invoice_id: replacementInvoiceId, amount_applied: amount }],
            description: `Exchange: settles the replacement invoice (order #${String(orderId).replace(/^#/, '')})`
        });
        out.settled = amount;
        console.log(`✅ Zoho exchange: replacement invoice ${invoice.invoice_number || replacementInvoiceId} settled with ₹${amount} (the customer already paid for the replacement)`);
    } catch (e) {
        out.warnings.push(`₹${amount} could not be recorded on the replacement invoice: ${e.message}`);
    }
    return out;
}

/**
 * Handle a Shopify refund event (customer return).
 * Called from the Shopify webhook when refunds/create fires.
 */
async function handleShopifyRefund(shopifyOrder, refundData) {
    // Refund webhooks carry Shopify's INTERNAL order id — resolve the
    // display number used in the sync log and Zoho reference numbers.
    const rawOrderId = shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString();
    const orderId = await resolveOrderNumber(rawOrderId);
    if (orderId !== rawOrderId && shopifyOrder) shopifyOrder.order_number = orderId;

    if (!orderId) {
        return { success: false, error: 'No order identifier' };
    }

    const refundId = refundData?.id?.toString() || '';

    // Idempotency: same Shopify refund delivered twice → one credit note only
    if (refundId) {
        const dup = await dbAdapter.query(
            `SELECT id FROM zoho_returns WHERE shopify_return_id = ? AND return_type = 'return' AND status IN ('pending', 'synced')`,
            [refundId]
        );
        if (dup.length > 0) {
            console.log(`✅ Zoho return: refund ${refundId} already processed, skipping duplicate`);
            return { success: true, alreadyProcessed: true, logId: dup[0].id };
        }
    }

    // refunds/create delivers refund_line_items where the product details
    // live on the nested line_item object
    const returnItems = (refundData?.refund_line_items || refundData?.line_items || []).map(entry => {
        const item = entry.line_item || entry;
        return {
            title: item.title || entry.title || '',
            sku: item.sku || entry.sku || '',
            quantity: entry.quantity || item.quantity || entry.restock_quantity || 1,
            price: parseFloat(item.price || entry.price || 0)
        };
    });

    if (returnItems.length === 0) {
        console.log(`ℹ️ Zoho return: order #${orderId} refund has no line items, skipping`);
        return { success: false, error: 'No return items' };
    }

    // Log the return
    const logResult = await dbAdapter.run(
        `INSERT INTO zoho_returns (shopify_order_id, shopify_return_id, return_type, original_items, corrected_items, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, refundId, 'return', JSON.stringify(returnItems), JSON.stringify(returnItems), 'pending']
    );

    try {
        // Credit note mirroring the original invoice — same tax basis,
        // discount reversed proportionally, item-linked for stock return.
        const reference = creditNoteReference(orderId, 'return', refundId);
        const result = await prepareAndCreateCreditNote({
            shopifyOrder,
            orderId,
            returnItems,
            returnType: 'return',
            reference
        });

        if (result.alreadyProcessed) {
            await dbAdapter.run(
                `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
                ['synced', result.creditNoteId || null, logResult.lastInsertRowid]
            );
            return { success: true, alreadyProcessed: true, logId: logResult.lastInsertRowid, creditNoteId: result.creditNoteId };
        }

        // Update return log
        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
            ['synced', result.creditNoteId || null, logResult.lastInsertRowid]
        );

        console.log(`✅ Zoho return: order #${orderId} → credit note ${result.creditNoteId || 'created'}`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            creditNoteId: result.creditNoteId
        };

    } catch (err) {
        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?`,
            ['failed', err.message, logResult.lastInsertRowid]
        );

        console.error(`❌ Zoho return failed for order #${orderId}: ${err.message}`);
        return { success: false, error: err.message, logId: logResult.lastInsertRowid };
    }
}

/**
 * Handle an RTO event (package returned to sender by carrier).
 * Called from carrier webhooks (Delhivery/Shiprocket) when status = RTO.
 */
async function handleRTO(shopifyOrder, carrierInfo = {}) {
    const rawOrderId = shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString();
    const orderId = await resolveOrderNumber(rawOrderId);
    if (orderId !== rawOrderId && shopifyOrder) shopifyOrder.order_number = orderId;

    if (!orderId) {
        return { success: false, error: 'No order identifier' };
    }

    // Idempotency: one active RTO credit note per order
    const dup = await dbAdapter.query(
        `SELECT id FROM zoho_returns WHERE shopify_order_id = ? AND return_type = 'rto' AND status IN ('pending', 'synced')`,
        [orderId]
    );
    if (dup.length > 0) {
        console.log(`✅ Zoho RTO: order #${orderId} already has an RTO credit note, skipping duplicate`);
        return { success: true, alreadyProcessed: true, logId: dup[0].id };
    }

    // Get original order items for the credit note
    const returnItems = (shopifyOrder.line_items || []).map(item => ({
        title: item.title || '',
        sku: item.sku || '',
        quantity: item.quantity || 1,
        price: parseFloat(item.price || 0)
    }));

    if (returnItems.length === 0) {
        return { success: false, error: 'No items to return for RTO' };
    }

    // Log the RTO
    const logResult = await dbAdapter.run(
        `INSERT INTO zoho_returns (shopify_order_id, shopify_return_id, return_type, original_items, corrected_items, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            orderId,
            carrierInfo.awb || carrierInfo.tracking_id || '',
            'rto',
            JSON.stringify(returnItems),
            JSON.stringify(returnItems),
            'pending'
        ]
    );

    try {
        const reference = creditNoteReference(orderId, 'rto');
        const result = await prepareAndCreateCreditNote({
            shopifyOrder,
            orderId,
            returnItems,
            returnType: 'rto',
            reference
        });

        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
            ['synced', result.creditNoteId || null, logResult.lastInsertRowid]
        );

        console.log(`✅ Zoho RTO: order #${orderId} → credit note ${result.creditNoteId || 'created'}`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            creditNoteId: result.creditNoteId
        };

    } catch (err) {
        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?`,
            ['failed', err.message, logResult.lastInsertRowid]
        );

        console.error(`❌ Zoho RTO failed for order #${orderId}: ${err.message}`);
        return { success: false, error: err.message, logId: logResult.lastInsertRowid };
    }
}

/**
 * Pass a non-exchanged invoice line through untouched — same name, quantity,
 * rate, discount and GST split (shipping, COD, items outside the exchange).
 */
function preserveInvoiceLine(line) {
    const preserved = {
        name: line.name,
        description: line.description || line.name,
        quantity: parseFloat(line.quantity || 1),
        rate: parseFloat(line.rate || 0),
        discount: parseFloat(line.discount || 0),
        is_inclusive_tax: true
    };
    if (line.item_id) preserved.item_id = line.item_id;
    // Preserve tax treatment from the original line
    const tax = taxFromInvoiceLine(line);
    if (tax.cgst_rate) preserved.cgst_rate = tax.cgst_rate;
    if (tax.sgst_rate) preserved.sgst_rate = tax.sgst_rate;
    if (tax.igst_rate) preserved.igst_rate = tax.igst_rate;
    if (tax.tax_percentage) preserved.tax_percentage = tax.tax_percentage;
    return preserved;
}

/**
 * Turn one exchange item into the form the INVOICE uses. Bundle mappings are
 * keyed without a size ("HENLEY - 001 ( TRIPLE )") and the invoice usually
 * bills the components, so look the bundle up size-free and hand the size over
 * as the variant — the components come back as "... ( B ) - L".
 * Items that are not bundles come back as themselves.
 */
async function expandItem(item, bundleMap) {
    const title = String(item?.title || '');
    const size = item?.variant || extractSizeFromTitle(title);
    let base = title;
    if (size) {
        const sizeRe = String(size).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        base = base
            .replace(new RegExp(`\\s*-\\s*${sizeRe}\\s*$`, 'i'), '')
            .replace(new RegExp(`\\(\\s*${sizeRe}\\s*\\)\\s*$`, 'i'), '')
            .trim();
    }
    const raw = [{
        title: base,
        sku: item?.sku || '',
        quantity: parseInt(item?.quantity || 1) || 1,
        price: parseFloat(item?.price || 0) || 0,
        variant: size
    }];
    const { lineItems } = breakBundleLineItems(raw, bundleMap);
    return lineItems.map(li => {
        // breakBundleLineItems strips a size-suffixed title back to the base
        // name — re-attach it so it equals the invoice line name.
        const name = withSizeInTitle(li.name, li.variant || '');
        return {
            title: name,
            name,
            sku: li.sku || '',
            variant: li.variant || '',
            quantity: li.quantity,
            // For a bundle this is the prorated per-component price, the same
            // math the original invoice used; for a plain item it is the price
            // paid.
            price: parseFloat(li.rate) || 0,
            isBundleComponent: !!li.is_bundle_component
        };
    });
}

const tightName = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

// An older backfill appended the replacement as an extra ₹0 line ("Exchange
// replacement - S") instead of re-lining the original. It is never a real
// billed line: it must not decide the invoice's shape nor satisfy a match.
const isObsoleteLine = (l) => !(parseFloat(l.rate) > 0)
    && /^exchange replacement/i.test(String(l.description || ''));

/**
 * Pair every item the invoice bills with the item that takes its place, in the
 * shape the invoice itself uses: when the invoice bills a bundle as one line
 * ("WAFFLE-001 (BUNDLE) - S") both sides stay whole, when it bills the
 * components both sides are expanded so each keeps its own colourway and
 * price. Without this a component invoice would be rewritten as a single line
 * (total changes) or a bundle line would be rewritten as several.
 *
 * Directional on purpose: forwards (original → replacement) to bill what the
 * customer received, backwards (replacement → original) to undo a correction
 * made by the old in-place flow.
 */
async function pairExchangeItems({ fromItems, toItems, invoiceLines }) {
    const bundleMap = await getBundleMap();
    const billedNames = new Set((invoiceLines || [])
        .filter(l => !isObsoleteLine(l))
        .map(l => tightName(l.name)));
    const originals = [];
    const replacements = [];
    const count = Math.max((fromItems || []).length, (toItems || []).length);

    for (let i = 0; i < count; i++) {
        const fromItem = (fromItems || [])[i];
        const toItem = (toItems || [])[i];
        const origPlain = await expandItem(fromItem, {});          // no expansion
        const origExpanded = await expandItem(fromItem, bundleMap);
        const replPlain = await expandItem(toItem, {});
        const replExpanded = await expandItem(toItem, bundleMap);

        // Does the invoice bill this item whole, or as its components?
        const billedWhole = origPlain.some(o => billedNames.has(tightName(o.title)));
        const useWhole = billedWhole || origExpanded.length === 1;
        originals.push(...(useWhole ? origPlain : origExpanded));
        replacements.push(...(useWhole ? replPlain : replExpanded));
    }

    return { originals, replacements };
}

/**
 * Swap the invoice lines that were returned/exchanged for their replacement.
 * Each replacement inherits the rate, discount and GST split of the line it
 * replaces, so the invoice total — and the payments already recorded against
 * it — stay balanced. Bundles are expanded into size-wise singles like
 * everywhere else.
 *
 * Directional: `fromItems` are what the invoice currently bills, `toItems`
 * what takes their place. The same call therefore reverses a correction.
 *
 * `newDocument` renders the swap for a STANDALONE document (the replacement
 * invoice): charge lines are not carried over, the line discount is dropped,
 * and `rateFor` may override the price of each replacement.
 */
async function buildSwapLines({
    invoiceLines, fromItems, toItems, useRecordedPrice = false, newDocument = false, rateFor = null
}) {
    const resolver = getItemResolver();
    const { originals, replacements: brokenExchanged } = await pairExchangeItems({ fromItems, toItems, invoiceLines });

    let lines = (invoiceLines || []).map(l => ({ ...l, _matched: false }));
    // Whitespace is dropped entirely: the catalog and the dashboard disagree on
    // spacing around parens ("( ACID WASH)" vs "( ACID WASH )") while meaning
    // the same variant.
    const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
    const isProductLine = (l) => !isChargeLine(l);

    // An older backfill appended the replacement as an extra ₹0 line
    // ("Exchange replacement - S") instead of re-lining the original. That line
    // is superseded below, and keeping it would book the replacement twice.
    if (lines.some(l => isProductLine(l) && !isObsoleteLine(l))) {
        const before = lines.length;
        lines = lines.filter(l => !isObsoleteLine(l));
        if (lines.length !== before) {
            console.log(`🔁 Zoho exchange: dropping ${before - lines.length} zero-value replacement line(s) superseded by the correction`);
        }
    }

    // Find the invoice line a returned/exchanged item came from
    const findOrigLine = (item) => {
        const keys = [item.sku, item.title].filter(Boolean);
        for (const key of keys) {
            const hit = lines.find(l =>
                !l._matched && (
                    norm(l.sku || '') === norm(key) ||
                    norm(l.name || '') === norm(key) ||
                    (key.length > 3 && (norm(l.name || '').includes(norm(key)) || norm(key).includes(norm(l.name || ''))))
                )
            );
            if (hit) return hit;
        }
        return null;
    };

    for (const orig of originals) {
        const line = findOrigLine(orig);
        if (line) {
            line._matched = true;
            line._origItem = orig;
        }
    }

    // Catalog renames make SKU/title matching drift — fall back to positional
    // matching against the invoice's product lines so the swap still happens.
    if (!lines.some(l => l._matched)) {
        const productLines = lines.filter(isProductLine);
        const wanted = Math.max(originals.length, 1);
        for (let i = 0; i < Math.min(wanted, productLines.length); i++) {
            productLines[i]._matched = true;
            productLines[i]._origItem = originals[i] || null;
        }
    }

    const buildLine = async (exItem, origLine) => {
        // The pairing already produced invoice-shaped names (size included) —
        // keep them so the Zoho catalog item stays size-specific.
        const lineName = withSizeInTitle(exItem.name, exItem.variant);
        let rate = parseFloat(origLine?.rate || 0);
        if (!(rate > 0) && useRecordedPrice) {
            // Backfill case: an invoice recreated by the old flow carries the
            // replacement at ₹0 — fall back to the price on the exchange record.
            rate = parseFloat(origLine?._origItem?.price || 0) || 0;
        }
        // A standalone replacement invoice bills the price on the exchange
        // record; an in-place re-line keeps the amount already paid.
        if (rateFor) rate = rateFor(exItem, rate, origLine);
        const line = {
            name: lineName,
            description: `Exchange replacement — ${lineName}`,
            quantity: exItem.quantity,
            rate,
            discount: newDocument ? 0 : parseFloat(origLine?.discount || 0),
            is_inclusive_tax: true
        };
        if (origLine) {
            const tax = taxFromInvoiceLine(origLine);
            if (tax.cgst_rate) line.cgst_rate = tax.cgst_rate;
            if (tax.sgst_rate) line.sgst_rate = tax.sgst_rate;
            if (tax.igst_rate) line.igst_rate = tax.igst_rate;
            if (tax.tax_percentage) line.tax_percentage = tax.tax_percentage;
        }
        // Resolve by NAME first — the exchange SKU can still be the ORIGINAL
        // item's SKU, which would link the line to the wrong stock item.
        let item = await resolver.resolve(lineName);
        if (!item?.item_id && exItem.sku) item = await resolver.resolve(exItem.sku);
        if (item?.item_id) line.item_id = item.item_id;
        else console.warn(`⚠️ Zoho exchange: no catalog item for "${lineName}" — line created without item_id (no stock movement)`);
        return line;
    };

    // Pair every replaced line with its own replacement: same product/colourway,
    // different size ("HENLEY - 001 ( B ) - L" ↔ "HENLEY - 001 ( B ) - M").
    // A bundle expands into several components, so line order alone would put
    // the wrong colourway on the wrong stock item.
    const baseKey = (name) => String(name || '').toUpperCase().replace(/\s+/g, ' ')
        .replace(/\s*-\s*[A-Z0-9]{1,3}$/, '').trim();
    const taken = new Array(brokenExchanged.length).fill(false);
    const takeReplacement = (lineName) => {
        const key = baseKey(lineName);
        let idx = brokenExchanged.findIndex((ex, i) =>
            !taken[i] && baseKey(withSizeInTitle(ex.name, ex.variant)) === key);
        // No name match (renamed style, unexpected component) — keep the old
        // positional behaviour rather than dropping the replacement.
        if (idx < 0) idx = taken.indexOf(false);
        if (idx < 0) return null;
        taken[idx] = true;
        return brokenExchanged[idx];
    };

    const corrected = [];
    for (const line of lines) {
        if (!line._matched) {
            // A standalone replacement invoice carries only the swapped items.
            if (!newDocument) corrected.push(preserveInvoiceLine(line));
            continue;
        }
        const exItem = takeReplacement(line.name);
        if (!exItem) continue; // fewer replacement items than original lines
        corrected.push(await buildLine(exItem, line));
    }
    // More replacement items than matched originals (a swap that turned into
    // two pieces) — append the remainder rather than dropping them.
    for (let i = 0; i < brokenExchanged.length; i++) {
        if (!taken[i]) corrected.push(await buildLine(brokenExchanged[i], null));
    }
    return corrected;
}

// NOTE: an exchange is never booked by re-billing the original invoice.
// The returned product is reversed with a credit note on that invoice and the
// product the customer received is billed on its own replacement invoice
// (createExchangeReplacementInvoice) — see handleExchange.

const money = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const lineFingerprint = (l) => `${l.name} x${money(l.quantity)} @${money(l.rate).toFixed(2)}`;

/**
 * Plan the exchange documents for an order — read-only.
 *
 * Target state (what applyExchangePlan writes):
 *   original invoice  bills what the customer ORDERED, with the returned
 *                     items reversed by the EXCH-<order> credit note
 *   EXCH-INV-<order>  bills what the customer RECEIVED, priced from the
 *                     exchange record
 *
 * Orders booked by the OLD flow need repairs: that flow deleted the credit
 * note and re-lined the invoice in place, and its fallback left a ₹0
 * "stock only" EXCH-INV document behind. The plan therefore also carries the
 * lines needed to revert such an invoice, and re-lines an existing EXCH-INV
 * instead of creating a second document.
 *
 * The plan is serialisable and carries every payload apply needs, so a bulk
 * run can review every order first and then execute the writes without
 * re-reading anything from Zoho.
 *
 * `invoice`, `creditNoteId` and `replacementInvoiceId` may be passed in by a
 * bulk caller that already resolved them from paged list scans — that removes
 * up to three calls per order. Pass `null` for "known absent"; leave them
 * undefined to let this function look them up.
 */
async function planExchangeInvoice({
    orderId, originalItems, exchangedItems,
    invoice = null, creditNoteId, replacementInvoiceId, orderPaid,
    requireMatch = false, withPayments = false
}) {
    const ref = String(orderId || '').replace(/^#/, '').trim();
    const out = { orderId: ref, status: 'skipped', invoiceId: null, invoiceNumber: '', before: [], after: [], notes: [] };
    if (!ref) return { ...out, status: 'invalid_order' };
    if (!exchangedItems?.length) return { ...out, status: 'no_exchanged_items' };

    // 1. Locate the original invoice. The EXCH-INV document carries its own
    //    reference, so searching the bare order number never returns it.
    if (!invoice) {
        try {
            const found = await zohoService.searchInvoice({ reference_number: ref });
            invoice = found.find(i => i.status !== 'void' && i.status !== 'deleted') || null;
        } catch (e) {
            return { ...out, status: 'invoice_lookup_failed', notes: [e.message] };
        }
    }
    if (!invoice) return { ...out, status: 'no_invoice' };
    out.invoiceId = invoice.invoice_id;
    out.invoiceNumber = invoice.invoice_number || '';
    if (invoice.status === 'void' || invoice.status === 'deleted') {
        return { ...out, status: 'invoice_void' };
    }

    // 2. Read the current lines — the only per-order detail call.
    let full = invoice;
    if (!Array.isArray(invoice.line_items) || invoice.line_items.length === 0) {
        try {
            full = await zohoService.getInvoice(invoice.invoice_id);
        } catch (e) {
            return { ...out, status: 'invoice_fetch_failed', notes: [e.message] };
        }
    }
    if (!full?.line_items?.length) return { ...out, status: 'no_invoice_lines' };

    const keyOf = (v) => String(v || '').toUpperCase().replace(/\s+/g, '');
    const lineMatches = (l, item) => {
        const name = keyOf(l.name);
        return [item?.sku, item?.title].filter(Boolean).map(keyOf).some(k =>
            name === k || (k.length > 3 && (name.includes(k) || k.includes(name)))
        );
    };
    // ₹0 lines the old backfill appended are not real invoice lines.
    const productLines = full.line_items.filter(l => !isChargeLine(l) && !isObsoleteLine(l));
    const billsAll = (items) => (items || []).length > 0
        && items.every(it => productLines.some(l => lineMatches(l, it)));

    // 3. Safety gate for bulk runs: only touch an order whose returned items
    //    can be tied to a real invoice line by name/SKU. Anything ambiguous is
    //    reported instead of written.
    const billsReplacement = billsAll(exchangedItems) && !billsAll(originalItems);
    if (requireMatch) {
        const { originals: matchedItems } = await pairExchangeItems({
            fromItems: originalItems, toItems: exchangedItems, invoiceLines: full.line_items
        });
        const unmatched = matchedItems.filter(it => !productLines.some(l => lineMatches(l, it)));
        const allZero = productLines.length > 0 && productLines.every(l => !(parseFloat(l.rate) > 0));
        if (unmatched.length && !allZero && !billsReplacement) {
            return {
                ...out,
                status: 'needs_review',
                before: full.line_items.map(lineFingerprint),
                notes: [
                    ...out.notes,
                    `no invoice line for returned item(s): ${unmatched.map(u => u.title || u.sku || '?').join(', ')}`
                ]
            };
        }
    }

    // 4. Existing exchange documents for this order.
    if (creditNoteId === undefined) {
        creditNoteId = null;
        try {
            const cns = await zohoService.searchCreditNotes({ reference_number: `EXCH-${ref}` });
            creditNoteId = cns[0]?.creditnote_id || null;
        } catch (e) {
            out.notes.push(`credit note lookup failed: ${e.message}`);
        }
    }

    let replacementRow = null;
    if (replacementInvoiceId === undefined) {
        replacementInvoiceId = null;
        try {
            const reps = await zohoService.searchInvoice({ reference_number: `EXCH-INV-${ref}` });
            // A VOID document cannot be re-lined or paid, so it never counts as
            // "the replacement invoice already exists" — a usable one is made.
            replacementRow = reps.find(i => i.status !== 'void' && i.status !== 'deleted') || null;
            replacementInvoiceId = replacementRow?.invoice_id || null;
            if (!replacementRow && reps.length) {
                out.notes.push(`${reps.length} void EXCH-INV document(s) — a usable one will be created`);
            }
        } catch (e) {
            out.notes.push(`EXCH-INV lookup failed: ${e.message}`);
        }
    }

    // 5. An invoice re-lined by the old flow bills the replacement — restore
    //    the original items first, or the credit note would reverse the wrong
    //    product (and stock).
    const revertLineItems = billsReplacement
        ? await buildSwapLines({
            invoiceLines: full.line_items,
            fromItems: exchangedItems,
            toItems: originalItems,
            useRecordedPrice: true
        })
        : null;
    const baseLines = revertLineItems || full.line_items;

    // 6. Credit note for the returned items, mirroring the invoice lines they
    //    came from (rate, discount share, GST split, item linkage).
    let creditNotePayload = null;
    let creditNoteTotal = 0;
    if (!creditNoteId) {
        const creditReference = creditNoteReference(ref, 'exchange');
        const baseInvoice = {
            ...full,
            line_items: revertLineItems
                ? revertLineItems.map(l => ({ ...l, taxes: taxesArrayFromRates(l) }))
                : full.line_items,
            // Reverting the re-line removes the credits applied against it.
            credits_applied: billsReplacement ? 0 : full.credits_applied
        };
        creditNotePayload = await buildMirroredCreditNotePayload({
            shopifyOrder: { order_number: ref, id: ref },
            orderId: ref,
            returnItems: originalItems,
            returnType: 'exchange',
            fullInvoice: baseInvoice,
            reference: creditReference
        });
        const cap = capCreditNoteToBalance(creditNotePayload, baseInvoice, creditReference, 'exchange');
        if (cap.fullyCredited) creditNotePayload = null;
        creditNoteTotal = money((creditNotePayload?.line_items || []).reduce(
            (s, l) => s + money(l.rate) * (parseFloat(l.quantity) || 1) - money(l.discount), 0));
    }

    // 7. The replacement product on its own invoice, priced from the exchange
    //    record (the old flow billed it at ₹0).
    const replacementInvoiceLines = await buildReplacementInvoiceLines({
        invoiceLines: baseLines, originalItems, exchangedItems
    });
    const replacementTotal = money(replacementInvoiceLines.reduce(
        (s, l) => s + money(l.rate) * (parseFloat(l.quantity) || 1), 0));
    const replacementNeedsLines = replacementInvoiceLines.length > 0
        && (replacementRow ? !(parseFloat(replacementRow.total) > 0) : !replacementInvoiceId);

    out.before = full.line_items.map(lineFingerprint);
    out.after = replacementInvoiceLines.map(lineFingerprint);
    out.creditNoteId = creditNoteId;
    out.creditNotePayload = creditNotePayload;
    out.creditNoteTotal = creditNoteTotal;
    out.replacementInvoiceId = replacementInvoiceId;
    out.replacementInvoiceLines = replacementInvoiceLines;
    out.replacementNeedsLines = replacementNeedsLines;
    out.replacementTotal = replacementTotal;
    out.revertLineItems = revertLineItems;
    out.customerId = full.customer_id || null;
    out.gstTreatment = full.gst_treatment || 'consumer';
    out.placeOfSupply = full.place_of_supply || null;
    // Credits already on the invoice once the revert is written — the apply
    // pass uses it to tell an applied credit note from an unapplied one.
    out.creditsApplied = money(billsReplacement ? 0 : full.credits_applied);
    out.totalBefore = money(full.total);
    out.totalAfter = replacementTotal;
    out.withPayments = !!withPayments;

    // 8. Money: a paid order must end with the replacement invoice settled, and
    //    a COD one must not be paid before the cash arrives.
    out.orderPaid = orderPaid !== undefined
        ? !!orderPaid
        : (await orderPaidFromSyncLog(ref))
            || /paid|partially_paid/.test(String(full.status || '').toLowerCase())
            || !!(full.payments && full.payments.length);
    out.replacementBalance = replacementRow ? money(replacementRow.balance) : null;
    out.replacementNeedsSettlement = !!(withPayments && out.orderPaid && replacementInvoiceId
        && (replacementNeedsLines || (out.replacementBalance || 0) > 0.02));

    out.changed = !!(revertLineItems || creditNotePayload || replacementNeedsLines || out.replacementNeedsSettlement);
    return { ...out, status: out.changed ? 'would_fix' : 'already_correct' };
}

/**
 * Execute a plan produced by planExchangeInvoice: revert an old in-place
 * re-line, book the credit note for the returned items, then write the
 * replacement invoice. Payments move only when the plan asked for it. Safe to
 * call twice — a second pass finds the documents already in place.
 */
async function applyExchangePlan(plan) {
    const out = { ...plan, notes: [...(plan.notes || [])] };
    const ref = String(out.orderId || '').replace(/^#/, '');
    if (!out.invoiceId) return { ...out, status: 'invalid_plan' };

    // 1. Undo an old in-place re-line: the invoice must bill what the customer
    //    ordered before the credit note can reverse the returned item.
    if (Array.isArray(out.revertLineItems) && out.revertLineItems.length > 0) {
        try {
            await zohoService.updateInvoice(
                out.invoiceId,
                { line_items: out.revertLineItems, is_inclusive_tax: true },
                `Exchange: restore the originally invoiced items (order #${ref})`
            );
        } catch (e) {
            return { ...out, status: 'revert_failed', notes: [...out.notes, e.message] };
        }
    }

    // 2. Credit note on the ORIGINAL invoice for the returned item(s).
    if (out.creditNotePayload?.line_items?.length && !out.creditNoteId) {
        try {
            const cn = await zohoService.createCreditNote(out.creditNotePayload);
            out.creditNoteId = cn?.creditnote_id || null;
            out.creditNoteTotal = money(cn?.total ?? out.creditNoteTotal);
            out.notes.push(`credit note ${out.creditNoteId} booked`);
            // Books can leave the new note as unused customer credit; apply it
            // so the original invoice actually drops by the returned amount.
            if (out.creditNoteId) {
                await ensureCreditNoteApplied({
                    creditNote: { creditnote_id: out.creditNoteId, total: out.creditNoteTotal },
                    fullInvoice: {
                        invoice_id: out.invoiceId,
                        invoice_number: out.invoiceNumber,
                        credits_applied: out.creditsApplied || 0
                    },
                    reference: creditNoteReference(ref, 'exchange'),
                    returnType: 'exchange'
                });
            }
        } catch (e) {
            return { ...out, status: 'credit_note_failed', notes: [...out.notes, e.message] };
        }
    }

    // 3. The replacement product on its own invoice.
    if (out.replacementNeedsLines && out.replacementInvoiceLines?.length) {
        try {
            if (out.replacementInvoiceId) {
                await zohoService.updateInvoice(
                    out.replacementInvoiceId,
                    { line_items: out.replacementInvoiceLines, is_inclusive_tax: true },
                    `Exchange: replacement items billed (order #${ref})`
                );
            } else {
                const payload = {
                    customer_id: out.customerId || undefined,
                    date: new Date().toISOString().split('T')[0],
                    payment_terms: 0,
                    line_items: out.replacementInvoiceLines,
                    notes: `Exchange replacement for Shopify Order #${ref}`,
                    reference_number: `EXCH-INV-${ref}`,
                    is_inclusive_tax: true,
                    gst_treatment: out.gstTreatment || 'consumer'
                };
                if (out.placeOfSupply) payload.place_of_supply = out.placeOfSupply;
                const created = await zohoService.createInvoice(payload);
                out.replacementInvoiceId = created?.invoice_id || null;
            }
            if (out.replacementInvoiceId) {
                try {
                    await zohoService.markInvoiceSent(out.replacementInvoiceId);
                } catch (e) {
                    out.notes.push(`mark-sent failed: ${e.message}`);
                }
            }
        } catch (e) {
            return { ...out, status: 'replacement_invoice_failed', notes: [...out.notes, e.message] };
        }
    }

    // 4. Payments are only re-allocated on request: a bulk run over historical
    //    orders leaves the money where it already sits.
    if (out.withPayments && out.replacementInvoiceId) {
        try {
            const moved = await moveExchangePayments({
                originalInvoice: {
                    invoice_id: out.invoiceId,
                    invoice_number: out.invoiceNumber,
                    total: out.totalBefore,
                    customer_id: out.customerId
                },
                replacementInvoice: { invoice_id: out.replacementInvoiceId, total: out.replacementTotal },
                creditNoteTotal: out.creditNoteTotal || 0
            });
            out.paymentMove = moved;
            out.notes.push(...moved.warnings);
        } catch (e) {
            out.notes.push(`payment move failed: ${e.message}`);
        }

        // Whatever the move could not cover (the payment was destroyed by an
        // old cleanup, or never landed on this document) is settled here when
        // the order was paid — the replacement must not stay overdue.
        const settled = await settleReplacementInvoice({
            replacementInvoiceId: out.replacementInvoiceId,
            creditNoteTotal: out.creditNoteTotal || 0,
            orderPaid: out.orderPaid !== undefined ? out.orderPaid : await orderPaidFromSyncLog(ref),
            orderId: ref
        });
        out.paymentSettle = settled;
        out.notes.push(...settled.warnings);
    }

    return { ...out, status: out.notes.length ? 'fixed_with_warnings' : 'fixed' };
}

/** Plan + optionally apply in one call, for a single order. */
async function backfillExchangeInvoice(opts) {
    const plan = await planExchangeInvoice(opts);
    if (!opts.apply || plan.status !== 'would_fix') return plan;
    return applyExchangePlan(plan);
}

/**
 * Handle an exchange (customer returns product A, gets product B).
 *
 * Books is kept as two documents, like a real exchange:
 *   1. a CREDIT NOTE on the original invoice for the product coming back
 *      (item-linked → the old variant returns to stock)
 *   2. a NEW INVOICE for the product going out (EXCH-INV-<order>), priced from
 *      the exchange record → the replacement variant leaves stock
 *   3. the customer's payment is moved onto the new invoice, so neither
 *      document is left over- or under-paid
 */
async function handleExchange(shopifyOrder, originalItems, exchangedItems) {
    const rawOrderId = shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString();
    const orderId = await resolveOrderNumber(rawOrderId);
    if (orderId !== rawOrderId && shopifyOrder) shopifyOrder.order_number = orderId;

    if (!orderId) {
        return { success: false, error: 'No order identifier' };
    }

    // Idempotency: one active exchange record per order
    const dupEx = await dbAdapter.query(
        `SELECT id FROM zoho_returns WHERE shopify_order_id = ? AND return_type = 'exchange' AND status IN ('pending', 'synced')`,
        [orderId]
    );
    if (dupEx.length > 0) {
        console.log(`✅ Zoho exchange: order #${orderId} already processed, skipping duplicate`);
        return { success: true, alreadyProcessed: true, logId: dupEx[0].id };
    }

    // Log the exchange with both original and exchanged items
    const logResult = await dbAdapter.run(
        `INSERT INTO zoho_returns (shopify_order_id, return_type, original_items, corrected_items, status)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, 'exchange', JSON.stringify(originalItems), JSON.stringify(exchangedItems), 'pending']
    );

    try {
        const summarise = (items) => (items || [])
            .map(i => `${i.quantity || 1}x ${i.title || i.sku || 'item'}${i.variant ? ' (' + i.variant + ')' : ''}`)
            .join(', ');
        const exchangedSummary = summarise(exchangedItems);

        // 1. Reverse the returned items on the ORIGINAL invoice. It keeps its
        //    lines, number, date and payments — the credit note is what
        //    reverses the old product (and returns its stock).
        const reference = creditNoteReference(orderId, 'exchange');
        const result = await prepareAndCreateCreditNote({
            shopifyOrder,
            orderId,
            returnItems: originalItems,
            returnType: 'exchange',
            reference,
            extraNotes: exchangedSummary ? `Exchanged for: ${exchangedSummary}` : ''
        });

        // 2. Bill what the customer actually received on its own invoice, at
        //    the price on the exchange record.
        const originalInvoice = await findInvoiceForOrder(orderId);
        const fullInvoice = originalInvoice ? await fetchFullInvoice(originalInvoice) : null;
        let replacementInvoice = null;
        if (fullInvoice?.line_items?.length) {
            try {
                replacementInvoice = await createExchangeReplacementInvoice({
                    orderId,
                    exchangedItems,
                    originalItems,
                    originalInvoice: fullInvoice,
                    invoiceLines: fullInvoice.line_items
                });
            } catch (invErr) {
                console.error(`❌ Zoho exchange: replacement invoice failed for order #${orderId}: ${invErr.message}`);
            }
        }

        // 3. The money follows the order, not one document: the part that pays
        //    for the replacement moves onto the replacement invoice.
        let paymentMove = null;
        let paymentSettle = null;
        if (replacementInvoice?.invoice_id && fullInvoice) {
            try {
                paymentMove = await moveExchangePayments({
                    originalInvoice: fullInvoice,
                    replacementInvoice,
                    creditNoteTotal: result.creditNoteTotal || 0
                });
                for (const warning of paymentMove.warnings) {
                    console.warn(`⚠️ Zoho exchange: order #${orderId} — ${warning}`);
                }
            } catch (pmErr) {
                console.warn(`⚠️ Zoho exchange: payment move failed for #${orderId}: ${pmErr.message}`);
            }

            // 3b. Settle what the move could not cover. Without this the
            // replacement invoice stays OVERDUE on an exchange the customer
            // already paid for (their payment was often removed by an older
            // cleanup flow that deleted it together with a duplicate invoice).
            try {
                const financial = String(shopifyOrder?.financial_status || '').toLowerCase();
                paymentSettle = await settleReplacementInvoice({
                    replacementInvoiceId: replacementInvoice.invoice_id,
                    creditNoteTotal: result.creditNoteTotal || 0,
                    orderPaid: financial === 'paid' || financial === 'partially_paid'
                        || await orderPaidFromSyncLog(orderId),
                    orderId,
                    // Mirror the sync path: a gateway order is not a cash receipt.
                    paymentMode: (shopifyOrder?.payment_gateway_names || []).length ? 'online' : 'cash'
                });
                for (const warning of paymentSettle.warnings) {
                    console.warn(`⚠️ Zoho exchange: order #${orderId} — ${warning}`);
                }
            } catch (stErr) {
                console.warn(`⚠️ Zoho exchange: settle failed for #${orderId}: ${stErr.message}`);
            }
        }

        // 4. Document the exchange on both documents.
        const replacementInvoiceId = replacementInvoice?.invoice_id || null;
        const noteText = `EXCHANGE — ${new Date().toISOString().split('T')[0]}\n`
            + `Original: ${summarise(originalItems)}\n`
            + `Exchanged for: ${exchangedSummary}\n`
            + 'Processed via returns server.';
        for (const docId of [fullInvoice?.invoice_id, replacementInvoiceId]) {
            if (!docId) continue;
            try {
                await zohoService.addInvoiceComment(docId, noteText);
                console.log(`📝 Zoho exchange: note added to invoice ${docId}`);
            } catch (noteErr) {
                console.warn(`⚠️ Zoho exchange: failed to add note to invoice ${docId}: ${noteErr.message}`);
            }
        }

        // 5. Persist what Zoho now holds for this exchange. An exchange with no
        //    replacement invoice is only half booked — record it as a failure so
        //    retryReturn (or the bulk backfill) picks the order up again.
        const partialFailure = (exchangedItems || []).length > 0 && !replacementInvoiceId;
        const savedStatus = partialFailure ? 'failed' : 'synced';
        const savedError = partialFailure ? `replacement invoice not created for order #${orderId}` : null;
        if (partialFailure) {
            console.error(`❌ Zoho exchange: order #${orderId} has no replacement invoice — flagged for retry`);
        }
        try {
            await dbAdapter.run(
                `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, zoho_exchange_invoice_id = ?, error_message = ?, updated_at = NOW() WHERE id = ?`,
                [savedStatus, result.creditNoteId || null, replacementInvoiceId, savedError, logResult.lastInsertRowid]
            );
        } catch (colErr) {
            // Column added post-rollout — fall back without it
            await dbAdapter.run(
                `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, error_message = ?, updated_at = NOW() WHERE id = ?`,
                [savedStatus, result.creditNoteId || null, savedError, logResult.lastInsertRowid]
            );
        }

        console.log(`✅ Zoho exchange: order #${orderId} → credit note ${result.creditNoteId || 'created'} + replacement invoice ${replacementInvoiceId || 'not created'}`);
        return {
            success: true,
            partialFailure,
            logId: logResult.lastInsertRowid,
            creditNoteId: result.creditNoteId,
            replacementInvoiceId,
            paymentMove,
            paymentSettle,
            originalItems,
            exchangedItems
        };

    } catch (err) {
        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?`,
            ['failed', err.message, logResult.lastInsertRowid]
        );

        console.error(`❌ Zoho exchange failed for order #${orderId}: ${err.message}`);
        return { success: false, error: err.message, logId: logResult.lastInsertRowid };
    }
}

/**
 * Handle a return notification from the external returns server.
 * Called when a return request is approved/completed on the returns portal.
 * Creates a credit note in Zoho mirroring the original invoice.
 */
async function handleReturnsServerReturn(orderId, returnItems) {
    const rawOrderId = String(orderId || '').replace(/^#/, '');
    const resolvedOrderId = await resolveOrderNumber(rawOrderId);

    if (!resolvedOrderId) {
        return { success: false, error: 'No order identifier' };
    }

    // Idempotency: one credit note per order for returns-server returns
    const dup = await dbAdapter.query(
        `SELECT id FROM zoho_returns WHERE shopify_order_id = ? AND return_type = 'return_portal' AND status IN ('pending', 'synced')`,
        [resolvedOrderId]
    );
    if (dup.length > 0) {
        console.log(`✅ Zoho return (portal): order #${resolvedOrderId} already processed, skipping duplicate`);
        return { success: true, alreadyProcessed: true, logId: dup[0].id };
    }

    // Parse items if they come as JSON string
    let items = returnItems;
    if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (e) { items = []; }
    }

    const parsedItems = (items || []).map(i => ({
        title: i.title || i.name || '',
        sku: i.sku || '',
        quantity: parseInt(i.quantity || 1),
        price: parseFloat(i.paidPrice || i.price || 0)
    }));

    if (parsedItems.length === 0) {
        return { success: false, error: 'No return items provided' };
    }

    // Look up the original Shopify order from the sync log
    const syncLog = await dbAdapter.query(
        'SELECT original_payload FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1',
        [resolvedOrderId]
    );

    let shopifyOrder = null;
    if (syncLog.length > 0) {
        shopifyOrder = typeof syncLog[0].original_payload === 'string'
            ? JSON.parse(syncLog[0].original_payload)
            : syncLog[0].original_payload;
    }
    if (!shopifyOrder) {
        shopifyOrder = { order_number: resolvedOrderId, id: resolvedOrderId, line_items: parsedItems };
    }

    // Log the return
    const logResult = await dbAdapter.run(
        `INSERT INTO zoho_returns (shopify_order_id, shopify_return_id, return_type, original_items, corrected_items, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [resolvedOrderId, 'portal-return', 'return_portal', JSON.stringify(parsedItems), JSON.stringify(parsedItems), 'pending']
    );

    try {
        const reference = creditNoteReference(resolvedOrderId, 'return_portal');
        const result = await prepareAndCreateCreditNote({
            shopifyOrder,
            orderId: resolvedOrderId,
            returnItems: parsedItems,
            returnType: 'return',
            reference,
            extraNotes: 'Return processed via returns portal'
        });

        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
            ['synced', result.creditNoteId || null, logResult.lastInsertRowid]
        );

        console.log(`✅ Zoho return (portal): order #${resolvedOrderId} → credit note ${result.creditNoteId || 'created'}`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            creditNoteId: result.creditNoteId
        };

    } catch (err) {
        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?`,
            ['failed', err.message, logResult.lastInsertRowid]
        );

        console.error(`❌ Zoho return (portal) failed for order #${resolvedOrderId}: ${err.message}`);
        return { success: false, error: err.message, logId: logResult.lastInsertRowid };
    }
}

/**
 * RTO by order ID — looks up the original Shopify payload from the sync log.
 * Used by the shipment status cron (no carrier webhook needed).
 */
async function handleRTOByOrderId(orderId, carrierInfo = {}) {
    if (!orderId) return { success: false, error: 'No order identifier' };

    const rows = await dbAdapter.query(
        'SELECT original_payload FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1',
        [orderId]
    );
    if (rows.length === 0) {
        console.warn(`⚠️ Zoho RTO: no sync log entry for order #${orderId} — skipping`);
        return { success: false, error: 'Order not found in sync log' };
    }

    const shopifyOrder = typeof rows[0].original_payload === 'string'
        ? JSON.parse(rows[0].original_payload)
        : rows[0].original_payload;

    return handleRTO(shopifyOrder, carrierInfo);
}

/**
 * Retry a failed return/RTO.
 */
async function retryReturn(returnId) {
    const rows = await dbAdapter.query('SELECT * FROM zoho_returns WHERE id = ? AND status = ?', [returnId, 'failed']);
    if (rows.length === 0) return { success: false, error: 'Return not found or not in failed state' };

    const row = rows[0];
    const originalItems = typeof row.original_items === 'string' ? JSON.parse(row.original_items) : row.original_items;
    const correctedItems = typeof row.corrected_items === 'string' ? JSON.parse(row.corrected_items) : row.corrected_items;

    // Mark as retrying for the duration: the retried call logs its OWN new row,
    // so leaving this one in 'pending' made its duplicate guard skip the retry.
    await dbAdapter.run(
        `UPDATE zoho_returns SET status = ?, error_message = NULL, updated_at = NOW() WHERE id = ?`,
        ['retrying', returnId]
    );

    let result;
    if (row.return_type === 'rto') {
        result = await handleRTO({ order_number: row.shopify_order_id, line_items: originalItems }, { awb: row.shopify_return_id });
    } else if (row.return_type === 'exchange') {
        result = await handleExchange({ order_number: row.shopify_order_id }, originalItems, correctedItems);
    } else {
        result = await handleShopifyRefund({ order_number: row.shopify_order_id }, { id: row.shopify_return_id, line_items: originalItems });
    }

    // Resolve this row's state from the outcome: a successful retry is no longer
    // a failure (the fresh row carries the document ids).
    await dbAdapter.run(
        `UPDATE zoho_returns SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?`,
        [result?.success ? 'synced' : 'failed', result?.success ? null : (result?.error || 'retry failed'), returnId]
    );
    return result;
}

/**
 * Get return stats for the dashboard.
 */
async function getReturnStats() {
    const today = new Date().toISOString().split('T')[0];

    const [returnsToday, rtosToday, exchangesToday, creditNotesCreated, failedReturns] = await Promise.all([
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_returns WHERE return_type = ? AND created_at >= ?`, ['return', today]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_returns WHERE return_type = ? AND created_at >= ?`, ['rto', today]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_returns WHERE return_type = ? AND created_at >= ?`, ['exchange', today]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_returns WHERE status = ? AND zoho_credit_note_id IS NOT NULL`, ['synced']),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_returns WHERE status = ?`, ['failed'])
    ]);

    return {
        today: {
            returns: returnsToday[0]?.count || 0,
            rtos: rtosToday[0]?.count || 0,
            exchanges: exchangesToday[0]?.count || 0
        },
        creditNotesCreated: creditNotesCreated[0]?.count || 0,
        failedReturns: failedReturns[0]?.count || 0
    };
}

/**
 * Get returns log with pagination.
 */
async function getReturnLog({ page = 1, limit = 50, status, returnType, search } = {}) {
    let where = [];
    let params = [];
    let paramIdx = 1;

    if (status) {
        where.push(`status = $${paramIdx++}`);
        params.push(status);
    }
    if (returnType) {
        where.push(`return_type = $${paramIdx++}`);
        params.push(returnType);
    }
    if (search) {
        where.push(`(shopify_order_id ILIKE $${paramIdx} OR zoho_credit_note_id ILIKE $${paramIdx})`);
        params.push(`%${search.trim()}%`);
        paramIdx++;
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
        dbAdapter.query(
            `SELECT * FROM zoho_returns ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, limit, offset]
        ),
        dbAdapter.query(`SELECT COUNT(*) as total FROM zoho_returns ${whereClause}`, params)
    ]);

    const total = parseInt(countResult[0]?.total || 0, 10);
    return {
        data: rows,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
    };
}

module.exports = {
    handleShopifyRefund,
    handleRTO,
    handleRTOByOrderId,
    handleExchange,
    planExchangeInvoice,
    applyExchangePlan,
    backfillExchangeInvoice,
    handleReturnsServerReturn,
    prepareAndCreateCreditNote,
    creditNoteReference,
    retryReturn,
    getReturnStats,
    getReturnLog
};
