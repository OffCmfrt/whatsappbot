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
const { taxFromInvoiceLine } = require('./zohoTransform');
const { dbAdapter } = require('../database/db');

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
            return { success: true, alreadyProcessed: true, creditNoteId: existing[0].creditnote_id, customerId: existing[0].customer_id || null };
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

    // Build the credit note mirroring the original invoice — same tax
    // basis (CGST+SGST vs IGST, inclusive/exclusive), same rate and the
    // original discount reversed in proportion; item-linked lines so
    // stock returns to inventory. Falls back to the state-derived payload
    // when the invoice has no usable lines.
    const fallbackTaxDecision = fallbackTaxDecisionFor(shopifyOrder);
    const creditNotePayload = (fullInvoice?.line_items || []).length > 0
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
    creditNotePayload.customer_id = fullInvoice?.customer_id || originalInvoice.customer_id || customerId;
    creditNotePayload.invoice_id = originalInvoice.invoice_id;

    // Books rejects a credit note whose total would exceed the invoice total
    // ("credit notes balance isn't negative") — i.e. part of this invoice was
    // already credited earlier. Cap the lines at the remaining creditable
    // amount, proportionally, instead of failing. `credits_applied` on the
    // invoice is the authoritative sum of already-applied credit notes.
    try {
        const invoiceTotal = parseFloat(fullInvoice?.total);
        const alreadyCredited = parseFloat(fullInvoice?.credits_applied) || 0;
        if (Number.isFinite(invoiceTotal) && invoiceTotal > 0 && alreadyCredited > 0) {
            const remaining = invoiceTotal - alreadyCredited;

            const estTotal = (creditNotePayload.line_items || []).reduce((sum, l) => {
                const net = (parseFloat(l.rate) || 0) * (parseFloat(l.quantity) || 1) - (parseFloat(l.discount) || 0);
                const pct = (parseFloat(l.cgst_rate) || 0) + (parseFloat(l.sgst_rate) || 0)
                    + (parseFloat(l.igst_rate) || 0);
                return sum + net * (1 + pct / 100);
            }, 0);

            if (remaining <= 0.02) {
                console.log(`ℹ️ Zoho ${returnType}: invoice ${originalInvoice.invoice_id} already fully credited (₹${alreadyCredited.toFixed(2)} of ₹${invoiceTotal.toFixed(2)}) — skipping ${reference}`);
                return { success: true, creditNoteId: null, fullyCredited: true, customerId };
            }
            if (estTotal > remaining + 0.02) {
                const factor = remaining / estTotal;
                console.warn(`⚠️ Zoho ${returnType}: capping ${reference} from ₹${estTotal.toFixed(2)} to remaining creditable ₹${remaining.toFixed(2)}`);
                for (const l of creditNotePayload.line_items || []) {
                    l.rate = Math.round((parseFloat(l.rate) || 0) * factor * 100) / 100;
                    l.discount = Math.round((parseFloat(l.discount) || 0) * factor * 100) / 100;
                }
            }
        }
    } catch (capErr) {
        console.warn(`⚠️ Zoho ${returnType}: balance-cap check failed (${capErr.message}) — attempting full amount`);
    }

    const creditNote = await zohoService.createCreditNote(creditNotePayload);
    return { success: true, creditNoteId: creditNote?.creditnote_id || null, customerId };
}

/**
 * Exchange replacement: zero-value invoice for the NEW items the customer
 * received. item_id linkage makes Books deduct the new size from stock
 * (old size returns via the exchange credit note). Bundles are expanded
 * into size-wise singles like everywhere else.
 */
async function createExchangeReplacementInvoice({ shopifyOrder, orderId, exchangedItems, customerId }) {
    if (!exchangedItems || exchangedItems.length === 0) return null;
    const ref = `EXCH-INV-${String(orderId).replace(/^#/, '')}`;

    // Dedupe — one replacement invoice per order
    try {
        const existing = await zohoService.searchInvoice({ reference_number: ref });
        if (existing.length > 0) return existing[0].invoice_id;
    } catch (e) { /* continue */ }

    const bundleMap = await loadBundleMap();
    const rawItems = exchangedItems.map(i => ({
        title: i.title || '',
        sku: i.sku || '',
        quantity: parseInt(i.quantity || 1) || 1,
        price: 0,
        variant: i.variant || ''
    }));
    const { lineItems } = breakBundleLineItems(rawItems, bundleMap);

    const resolver = createItemResolver();
    const zohoLines = [];
    for (const li of lineItems) {
        const line = {
            name: li.name,
            description: 'Exchange replacement item',
            quantity: li.quantity,
            rate: 0,
            discount: 0
        };
        const item = await resolver.resolve(li.sku || li.name);
        if (item?.item_id) line.item_id = item.item_id;
        zohoLines.push(line);
    }

    const payload = {
        customer_id: customerId || undefined,
        date: new Date().toISOString().split('T')[0],
        payment_terms: 0,
        line_items: zohoLines,
        notes: `Exchange replacement for Shopify Order #${orderId}`,
        reference_number: ref,
        is_inclusive_tax: true,
        gst_treatment: 'consumer'
    };

    const invoice = await zohoService.createInvoice(payload);
    // Mark sent so the stock deduction actually happens
    try {
        await zohoService.markInvoiceSent(invoice.invoice_id);
    } catch (sentErr) {
        console.warn(`⚠️ Zoho exchange: replacement invoice mark-sent failed (${sentErr.message})`);
    }
    return invoice?.invoice_id || null;
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
 * Correct the original Zoho invoice after an exchange so it shows the
 * NEW items the customer actually received (e.g. Henley S instead of M).
 *
 * Flow: delete credit note → delete payments → delete original invoice →
 * create new invoice with exchanged items → re-record payments.
 *
 * Stock effect: old invoice deletion returns original stock, new invoice
 * deduction removes exchanged items — net effect is correct.
 */
async function correctOriginalInvoiceForExchange({ shopifyOrder, orderId, originalItems, exchangedItems, creditNoteId, customerId }) {
    if (!exchangedItems?.length) return { success: false, reason: 'no_exchanged_items' };

    // 1. Find the original invoice
    const originalInvoice = await findInvoiceForOrder(orderId);
    if (!originalInvoice) return { success: false, reason: 'no_original_invoice' };

    const fullInvoice = await fetchFullInvoice(originalInvoice);
    if (!fullInvoice?.line_items?.length) return { success: false, reason: 'no_invoice_lines' };

    const invoiceId = fullInvoice.invoice_id;

    // 2. Delete the exchange credit note first (it's linked to the invoice;
    //    Zoho may block invoice deletion while a credit note references it)
    if (creditNoteId) {
        try {
            await zohoService.deleteCreditNote(creditNoteId);
            console.log(`🗑️ Zoho exchange correction: deleted credit note ${creditNoteId}`);
        } catch (e) {
            console.warn(`⚠️ Zoho exchange correction: credit note delete failed (${e.message}) — continuing`);
        }
    }

    // 3. Fetch and delete payments on the original invoice
    //    (Zoho blocks invoice deletion when payments exist)
    let deletedPayments = [];
    try {
        const payments = await zohoService.getPayments(invoiceId, fullInvoice.invoice_number);
        for (const p of payments) {
            try {
                await zohoService.deletePayment(p.payment_id);
                deletedPayments.push({
                    amount: parseFloat(p.amount || 0),
                    date: p.date,
                    payment_mode: p.payment_mode,
                    customer_id: p.customer_id || customerId
                });
            } catch (e) {
                console.warn(`⚠️ Zoho exchange correction: payment delete failed (${e.message})`);
            }
        }
    } catch (e) {
        console.warn(`⚠️ Zoho exchange correction: payment fetch failed (${e.message})`);
    }

    // 4. Delete the original invoice
    try {
        await zohoService.deleteInvoice(invoiceId);
        console.log(`🗑️ Zoho exchange correction: deleted invoice ${invoiceId}`);
    } catch (e) {
        console.error(`❌ Zoho exchange correction: invoice delete failed (${e.message})`);
        return { success: false, reason: 'delete_failed', error: e.message };
    }

    // 5. Build new line items with exchanged products
    const bundleMap = await loadBundleMap();
    const resolver = createItemResolver();

    // Map original invoice lines → track which are exchanged
    const invoiceLines = (fullInvoice.line_items || []).map(l => ({ ...l, _matched: false }));

    const findOrigLine = (item) => {
        const keys = [item.sku, item.title].filter(Boolean);
        for (const key of keys) {
            const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
            const hit = invoiceLines.find(l =>
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

    // Mark matched lines
    for (const orig of originalItems) {
        const line = findOrigLine(orig);
        if (line) line._matched = true;
    }

    // Build new lines: exchanged items replace the matched original lines
    const newLines = [];
    const rawExchanged = exchangedItems.map(i => ({
        title: i.title || '',
        sku: i.sku || '',
        quantity: parseInt(i.quantity || 1) || 1,
        price: 0,
        variant: i.variant || ''
    }));
    const { lineItems: brokenExchanged } = breakBundleLineItems(rawExchanged, bundleMap);

    for (const exItem of brokenExchanged) {
        const desc = exItem.variant
            ? `${exItem.name} (${exItem.variant})`
            : (exItem.name || 'Item');
        const line = {
            name: exItem.name,
            description: desc,
            quantity: exItem.quantity,
            rate: 0,
            discount: 0,
            is_inclusive_tax: true
        };
        const item = await resolver.resolve(exItem.sku || exItem.name);
        if (item?.item_id) line.item_id = item.item_id;
        newLines.push(line);
    }

    // Preserve non-exchanged lines (shipping, other items not exchanged)
    for (const line of invoiceLines) {
        if (line._matched) continue;
        const preserved = {
            name: line.name,
            description: line.description || line.name,
            quantity: parseFloat(line.quantity || 1),
            rate: parseFloat(line.rate || 0),
            discount: parseFloat(line.discount || 0),
            is_inclusive_tax: true
        };
        if (line.item_id) preserved.item_id = line.item_id;
        // Preserve tax treatment from original line
        const tax = taxFromInvoiceLine(line);
        if (tax.cgst_rate) preserved.cgst_rate = tax.cgst_rate;
        if (tax.sgst_rate) preserved.sgst_rate = tax.sgst_rate;
        if (tax.igst_rate) preserved.igst_rate = tax.igst_rate;
        if (tax.tax_percentage) preserved.tax_percentage = tax.tax_percentage;
        newLines.push(preserved);
    }

    // 6. Create the new invoice with exchanged items
    const newPayload = {
        customer_id: fullInvoice.customer_id || customerId || undefined,
        date: fullInvoice.date || new Date().toISOString().split('T')[0],
        payment_terms: 0,
        line_items: newLines,
        notes: fullInvoice.notes || `Shopify Order #${orderId}`,
        reference_number: fullInvoice.reference_number,
        is_inclusive_tax: true,
        gst_treatment: fullInvoice.gst_treatment || 'consumer'
    };
    if (fullInvoice.shipping_address) newPayload.shipping_address = fullInvoice.shipping_address;
    if (fullInvoice.place_of_supply) newPayload.place_of_supply = fullInvoice.place_of_supply;

    let newInvoice;
    try {
        newInvoice = await zohoService.createInvoice(newPayload);
    } catch (e) {
        console.error(`❌ Zoho exchange correction: new invoice creation failed (${e.message})`);
        return { success: false, reason: 'create_failed', error: e.message };
    }

    // Mark sent so stock deduction happens
    try {
        await zohoService.markInvoiceSent(newInvoice.invoice_id);
    } catch (e) {
        console.warn(`⚠️ Zoho exchange correction: mark-sent failed (${e.message})`);
    }

    console.log(`✅ Zoho exchange correction: order #${orderId} → new invoice ${newInvoice.invoice_id} (was ${invoiceId})`);

    // 7. Re-record payments on the new invoice
    for (const p of deletedPayments) {
        try {
            await zohoService.recordPayment({
                customer_id: p.customer_id,
                amount: p.amount,
                date: p.date,
                payment_mode: p.payment_mode || 'cash',
                invoices: [{ invoice_id: newInvoice.invoice_id, amount_applied: p.amount }],
                description: 'Payment re-recorded after exchange correction'
            });
        } catch (e) {
            console.warn(`⚠️ Zoho exchange correction: payment re-record failed (${e.message})`);
        }
    }

    return { success: true, newInvoiceId: newInvoice.invoice_id };
}

/**
 * Handle an exchange (customer returns product A, gets product B).
 * Creates credit note for original product, then corrects the original
 * invoice to show the new items so Zoho always reflects what the
 * customer actually has.
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
        // Credit note for the ORIGINAL items (item-linked → old size stock
        // returns). The exchangedSummary is stamped in the notes for audit.
        const exchangedSummary = (exchangedItems || [])
            .map(i => `${i.quantity || 1}x ${i.title || i.sku || 'item'}${i.variant ? ' (' + i.variant + ')' : ''}`)
            .join(', ');

        const reference = creditNoteReference(orderId, 'exchange');
        const result = await prepareAndCreateCreditNote({
            shopifyOrder,
            orderId,
            returnItems: originalItems,
            returnType: 'exchange',
            reference,
            extraNotes: exchangedSummary ? `Exchanged for: ${exchangedSummary}` : ''
        });

        // Correct the original invoice to show the NEW items the customer
        // actually received (e.g. Henley S instead of Henley M). This
        // deletes the old invoice and creates a new one with exchanged
        // items, so Zoho always reflects reality. Payments are re-recorded.
        let replacementInvoiceId = null;
        let correctedInvoiceId = null;
        try {
            const correction = await correctOriginalInvoiceForExchange({
                shopifyOrder,
                orderId,
                originalItems,
                exchangedItems,
                creditNoteId: result.creditNoteId,
                customerId: result.customerId
            });
            if (correction.success) {
                correctedInvoiceId = correction.newInvoiceId;
            }
        } catch (corrErr) {
            console.warn(`⚠️ Zoho exchange: invoice correction failed for #${orderId}: ${corrErr.message} — falling back to replacement invoice`);
        }

        // Fallback: if correction failed, create a separate zero-value
        // replacement invoice (old behaviour — stock deduction only)
        if (!correctedInvoiceId) {
            try {
                replacementInvoiceId = await createExchangeReplacementInvoice({
                    shopifyOrder,
                    orderId,
                    exchangedItems,
                    customerId: result.customerId
                });
            } catch (invErr) {
                console.error(`❌ Zoho exchange: replacement invoice failed for order #${orderId}: ${invErr.message}`);
            }
        }

        // ── Create a note/comment on the Zoho invoice documenting the exchange ──
        const targetInvoiceId = correctedInvoiceId || replacementInvoiceId;
        if (targetInvoiceId) {
            const origSummary = (originalItems || [])
                .map(i => `${i.quantity || 1}x ${i.title || i.sku || 'item'}${i.variant ? ' (' + i.variant + ')' : ''}`)
                .join(', ');
            const exchSummary = (exchangedItems || [])
                .map(i => `${i.quantity || 1}x ${i.title || i.sku || 'item'}${i.variant ? ' (' + i.variant + ')' : ''}`)
                .join(', ');
            const noteText = `EXCHANGE — ${new Date().toISOString().split('T')[0]}\nOriginal: ${origSummary}\nExchanged for: ${exchSummary}\nProcessed via returns server.`;
            try {
                await zohoService.addInvoiceComment(targetInvoiceId, noteText);
                console.log(`📝 Zoho exchange: note added to invoice ${targetInvoiceId}`);
            } catch (noteErr) {
                console.warn(`⚠️ Zoho exchange: failed to add note to invoice ${targetInvoiceId}: ${noteErr.message}`);
            }
        }

        try {
            await dbAdapter.run(
                `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, zoho_exchange_invoice_id = ?, updated_at = NOW() WHERE id = ?`,
                ['synced', result.creditNoteId || null, correctedInvoiceId || replacementInvoiceId, logResult.lastInsertRowid]
            );
        } catch (colErr) {
            // Column added post-rollout — fall back without it
            await dbAdapter.run(
                `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
                ['synced', result.creditNoteId || null, logResult.lastInsertRowid]
            );
        }

        console.log(`✅ Zoho exchange: order #${orderId} → credit note ${result.creditNoteId || 'created'}${correctedInvoiceId ? ` + corrected invoice ${correctedInvoiceId}` : replacementInvoiceId ? ` + replacement invoice ${replacementInvoiceId}` : ''}`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            creditNoteId: result.creditNoteId,
            replacementInvoiceId: correctedInvoiceId || replacementInvoiceId,
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

    // Mark as pending for retry
    await dbAdapter.run(
        `UPDATE zoho_returns SET status = ?, error_message = NULL, updated_at = NOW() WHERE id = ?`,
        ['pending', returnId]
    );

    if (row.return_type === 'rto') {
        return handleRTO({ order_number: row.shopify_order_id, line_items: originalItems }, { awb: row.shopify_return_id });
    } else if (row.return_type === 'exchange') {
        return handleExchange({ order_number: row.shopify_order_id }, originalItems, correctedItems);
    } else {
        return handleShopifyRefund({ order_number: row.shopify_order_id }, { id: row.shopify_return_id, line_items: originalItems });
    }
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
    retryReturn,
    getReturnStats,
    getReturnLog
};
