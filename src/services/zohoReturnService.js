const zohoService = require('./zohoService');
const { buildCreditNotePayload } = require('./zohoTransform');
const { dbAdapter } = require('../database/db');

// ============================================================
// ZOHO RETURN / RTO HANDLER
// Creates credit notes in Zoho when returns or RTOs happen.
// ============================================================

/**
 * Handle a Shopify refund event (customer return).
 * Called from the Shopify webhook when refunds/create fires.
 */
async function handleShopifyRefund(shopifyOrder, refundData) {
    const orderId = shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString();

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

    const returnItems = (refundData?.line_items || refundData?.refund_line_items || []).map(item => ({
        title: item.title || '',
        sku: item.sku || '',
        quantity: item.quantity || item.restock_quantity || 1,
        price: parseFloat(item.price || 0)
    }));

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
        // Build credit note payload
        const creditNotePayload = buildCreditNotePayload(shopifyOrder, returnItems, 'return');

        // Resolve customer in Zoho
        const customerName = creditNotePayload.customer_name;
        const email = shopifyOrder.email || '';
        let zohoCustomer = null;
        try {
            zohoCustomer = await zohoService.getOrCreateCustomer(customerName, email, shopifyOrder.phone || '');
            creditNotePayload.customer_id = zohoCustomer?.contact_id;
        } catch (custErr) {
            console.warn(`⚠️ Zoho customer lookup failed for return: ${custErr.message}`);
        }

        // Find the original invoice in Zoho (to link the credit note)
        let originalInvoiceId = null;
        try {
            const invoices = await zohoService.searchInvoice({
                reference_number: orderId
            });
            if (invoices.length > 0) {
                originalInvoiceId = invoices[0].invoice_id;
                creditNotePayload.reference_number = originalInvoiceId;
            }
        } catch (searchErr) {
            console.warn(`⚠️ Could not find original invoice for credit note: ${searchErr.message}`);
        }

        // Create credit note in Zoho
        const creditNote = await zohoService.createCreditNote(creditNotePayload);

        // Update return log
        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
            ['synced', creditNote?.creditnote_id || null, logResult.lastInsertRowid]
        );

        console.log(`✅ Zoho return: order #${orderId} → credit note ${creditNote?.creditnote_id || 'created'}`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            creditNoteId: creditNote?.creditnote_id
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
    const orderId = shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString();

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
        const creditNotePayload = buildCreditNotePayload(shopifyOrder, returnItems, 'rto');

        // Resolve customer
        const customerName = creditNotePayload.customer_name;
        let zohoCustomer = null;
        try {
            zohoCustomer = await zohoService.getOrCreateCustomer(customerName, shopifyOrder.email || '', shopifyOrder.phone || '');
            creditNotePayload.customer_id = zohoCustomer?.contact_id;
        } catch (custErr) {
            console.warn(`⚠️ Zoho customer lookup failed for RTO: ${custErr.message}`);
        }

        // Create credit note
        const creditNote = await zohoService.createCreditNote(creditNotePayload);

        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
            ['synced', creditNote?.creditnote_id || null, logResult.lastInsertRowid]
        );

        console.log(`✅ Zoho RTO: order #${orderId} → credit note ${creditNote?.creditnote_id || 'created'}`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            creditNoteId: creditNote?.creditnote_id
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
 * Handle an exchange (customer returns product A, gets product B).
 * Creates credit note for original product, notes the exchanged product.
 */
async function handleExchange(shopifyOrder, originalItems, exchangedItems) {
    const orderId = shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString();

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
        // Credit note for the original returned items
        const creditNotePayload = buildCreditNotePayload(shopifyOrder, originalItems, 'exchange');

        const customerName = creditNotePayload.customer_name;
        let zohoCustomer = null;
        try {
            zohoCustomer = await zohoService.getOrCreateCustomer(customerName, shopifyOrder.email || '', shopifyOrder.phone || '');
            creditNotePayload.customer_id = zohoCustomer?.contact_id;
        } catch (custErr) {
            console.warn(`⚠️ Zoho customer lookup failed for exchange: ${custErr.message}`);
        }

        const creditNote = await zohoService.createCreditNote(creditNotePayload);

        await dbAdapter.run(
            `UPDATE zoho_returns SET status = ?, zoho_credit_note_id = ?, updated_at = NOW() WHERE id = ?`,
            ['synced', creditNote?.creditnote_id || null, logResult.lastInsertRowid]
        );

        console.log(`✅ Zoho exchange: order #${orderId} → credit note ${creditNote?.creditnote_id || 'created'} (original items credited)`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            creditNoteId: creditNote?.creditnote_id,
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
async function getReturnLog({ page = 1, limit = 50, status, returnType } = {}) {
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

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
        dbAdapter.query(
            `SELECT * FROM zoho_returns ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, limit, offset]
        ),
        dbAdapter.query(`SELECT COUNT(*) as total FROM zoho_returns ${whereClause}`, params)
    ]);

    return {
        data: rows,
        total: countResult[0]?.total || 0,
        page,
        limit,
        totalPages: Math.ceil((countResult[0]?.total || 0) / limit)
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
