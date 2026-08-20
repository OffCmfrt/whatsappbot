const zohoService = require('./zohoService');
const { buildCodPaymentPayload } = require('./zohoTransform');
const { dbAdapter } = require('../database/db');

// ============================================================
// ZOHO COD PAYMENT RECONCILER
// Auto-marks invoices as paid when COD is collected by carrier.
// ============================================================

/**
 * Handle a COD delivery confirmation from a carrier webhook.
 * Called when Delhivery/Shiprocket confirms delivery + COD collection.
 */
async function handleCodDelivery(orderId, { amount, carrier, awb, deliveryDate, force = false } = {}) {
    if (!orderId) {
        return { success: false, error: 'No order identifier' };
    }

    // Check if already reconciled (idempotency)
    const existing = await dbAdapter.query(
        'SELECT id, payment_status FROM zoho_cod_payments WHERE shopify_order_id = ? AND payment_status = ?',
        [orderId, 'reconciled']
    );
    if (existing.length > 0) {
        console.log(`✅ Zoho COD: order #${orderId} already reconciled`);
        return { success: true, alreadyReconciled: true };
    }

    // Concurrency guard: a recent pending row means another process is
    // already reconciling this order (cron + webhook overlap)
    if (!force) {
        const recentPending = await dbAdapter.query(
            `SELECT id FROM zoho_cod_payments WHERE shopify_order_id = ? AND payment_status = 'pending' AND created_at > NOW() - INTERVAL '10 minutes'`,
            [orderId]
        );
        if (recentPending.length > 0) {
            console.log(`⏳ Zoho COD: order #${orderId} reconciliation already in progress, skipping`);
            return { success: true, inProgress: true };
        }
    }

    // Log the COD payment
    const logResult = await dbAdapter.run(
        `INSERT INTO zoho_cod_payments (shopify_order_id, amount, carrier, awb, payment_status)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, amount, carrier || 'unknown', awb || '', 'pending']
    );

    try {
        // Step 1: Find the Zoho invoice for this order
        const invoices = await zohoService.searchInvoice({
            reference_number: orderId
        });

        if (invoices.length === 0) {
            throw new Error(`No Zoho invoice found for order #${orderId}. Sync the order first.`);
        }

        const zohoInvoice = invoices[0];
        const invoiceId = zohoInvoice.invoice_id;
        // 'total' is the invoice grand total; 'amount' in the list API is
        // the remaining balance, which can be 0 → never record a ₹0 payment
        const invoiceAmount = parseFloat(zohoInvoice.total || zohoInvoice.amount || amount || 0);
        if (invoiceAmount <= 0) {
            throw new Error(`Invoice ${invoiceId} has no payable amount (total=${invoiceAmount}) — nothing to reconcile`);
        }

        // Step 2: Check if payment already recorded in Zoho
        const existingPayments = await zohoService.getPayments(invoiceId, zohoInvoice.invoice_number);
        if (existingPayments.length > 0) {
            console.log(`ℹ️ Zoho COD: invoice ${invoiceId} already has payments, skipping`);
            await dbAdapter.run(
                `UPDATE zoho_cod_payments SET payment_status = ?, zoho_invoice_id = ?, zoho_payment_id = ?, reconciled_at = NOW() WHERE id = ?`,
                ['reconciled', invoiceId, existingPayments[0].payment_id, logResult.lastInsertRowid]
            );
            return { success: true, alreadyPaid: true };
        }

        // Step 3: Record payment in Zoho (customer_id required by Books)
        const paymentPayload = buildCodPaymentPayload(invoiceId, invoiceAmount, deliveryDate, zohoInvoice.customer_id);
        const payment = await zohoService.recordPayment(paymentPayload);

        // Step 4: Update COD log
        await dbAdapter.run(
            `UPDATE zoho_cod_payments SET payment_status = ?, zoho_invoice_id = ?, zoho_payment_id = ?, reconciled_at = NOW() WHERE id = ?`,
            ['reconciled', invoiceId, payment?.payment_id || null, logResult.lastInsertRowid]
        );

        console.log(`✅ Zoho COD: order #${orderId} → payment ${payment?.payment_id || 'recorded'} (₹${invoiceAmount})`);
        return {
            success: true,
            logId: logResult.lastInsertRowid,
            paymentId: payment?.payment_id,
            amount: invoiceAmount
        };

    } catch (err) {
        await dbAdapter.run(
            `UPDATE zoho_cod_payments SET payment_status = ? WHERE id = ?`,
            ['failed', logResult.lastInsertRowid]
        );

        console.error(`❌ Zoho COD reconciliation failed for order #${orderId}: ${err.message}`);
        return { success: false, error: err.message, logId: logResult.lastInsertRowid };
    }
}

/**
 * Manually reconcile a pending COD payment.
 */
async function manualReconcile(codPaymentId) {
    const rows = await dbAdapter.query(
        'SELECT * FROM zoho_cod_payments WHERE id = ? AND payment_status != ?',
        [codPaymentId, 'reconciled']
    );

    if (rows.length === 0) {
        return { success: false, error: 'COD payment not found or already reconciled' };
    }

    const row = rows[0];
    return handleCodDelivery(row.shopify_order_id, {
        amount: parseFloat(row.amount || 0),
        carrier: row.carrier,
        awb: row.awb,
        force: true
    });
}

/**
 * Get COD payment stats for the dashboard.
 */
async function getCodStats() {
    const today = new Date().toISOString().split('T')[0];

    const [pending, reconciledToday, failed, totalReconciled, totalAmount] = await Promise.all([
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_cod_payments WHERE payment_status = ?`, ['pending']),
        dbAdapter.query(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM zoho_cod_payments WHERE payment_status = ? AND reconciled_at >= ?`, ['reconciled', today]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_cod_payments WHERE payment_status = ?`, ['failed']),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_cod_payments WHERE payment_status = ?`, ['reconciled']),
        dbAdapter.query(`SELECT COALESCE(SUM(amount), 0) as total FROM zoho_cod_payments WHERE payment_status = ?`, ['reconciled'])
    ]);

    return {
        pending: pending[0]?.count || 0,
        reconciledToday: {
            count: reconciledToday[0]?.count || 0,
            amount: parseFloat(reconciledToday[0]?.total || 0)
        },
        failed: failed[0]?.count || 0,
        allTime: {
            reconciled: totalReconciled[0]?.count || 0,
            totalAmount: parseFloat(totalAmount[0]?.total || 0)
        }
    };
}

/**
 * Get COD payment log with pagination.
 */
async function getCodLog({ page = 1, limit = 50, status, search } = {}) {
    let where = [];
    let params = [];
    let paramIdx = 1;

    if (status) {
        where.push(`payment_status = $${paramIdx++}`);
        params.push(status);
    }
    if (search) {
        where.push(`(shopify_order_id ILIKE $${paramIdx} OR awb ILIKE $${paramIdx} OR carrier ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
        dbAdapter.query(
            `SELECT * FROM zoho_cod_payments ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, limit, offset]
        ),
        dbAdapter.query(`SELECT COUNT(*) as total FROM zoho_cod_payments ${whereClause}`, params)
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
    handleCodDelivery,
    manualReconcile,
    getCodStats,
    getCodLog
};
