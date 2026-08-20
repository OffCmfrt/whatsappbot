const zohoService = require('./zohoService');
const { buildZohoInvoicePayload } = require('./zohoTransform');
const { dbAdapter } = require('../database/db');

// ============================================================
// ZOHO SYNC ORCHESTRATOR
// Pipeline: Shopify webhook → transform → push to Zoho → log
// ============================================================

const MAX_RETRIES = 3;
const SELLER_STATE = () => process.env.ZOHO_SELLER_STATE || 'Haryana';

/**
 * Main entry point — called from the Shopify webhook handler
 * when an order is created or updated.
 */
async function syncOrderToZoho(shopifyOrder) {
    const orderId = shopifyOrder.order_number?.toString() || shopifyOrder.id?.toString();

    if (!orderId) {
        console.warn('⚠️ Zoho sync: order has no order_number or id, skipping');
        return { success: false, error: 'No order identifier' };
    }

    // Check if auto-sync is enabled
    if (process.env.ZOHO_AUTO_SYNC === 'false') {
        console.log(`⏸️ Zoho auto-sync disabled, logging order #${orderId} as pending`);
        await logSync(orderId, shopifyOrder, null, 'pending', 'Auto-sync disabled');
        return { success: false, error: 'Auto-sync disabled' };
    }

    // Check if already synced (idempotency)
    const existing = await dbAdapter.query(
        'SELECT id, status FROM zoho_sync_log WHERE shopify_order_id = ? AND status = ?',
        [orderId, 'synced']
    );
    if (existing.length > 0) {
        console.log(`✅ Zoho sync: order #${orderId} already synced (id=${existing[0].id})`);
        return { success: true, alreadySynced: true, logId: existing[0].id };
    }

    // Log as pending
    const logResult = await logSync(orderId, shopifyOrder, null, 'pending');
    const logId = logResult.lastInsertRowid;

    try {
        // Step 1: Build the transformed invoice payload
        const { invoice, customer, transformations } = await buildZohoInvoicePayload(
            shopifyOrder,
            SELLER_STATE()
        );

        // Step 2: Resolve or create the customer in Zoho
        let zohoCustomer;
        try {
            zohoCustomer = await zohoService.getOrCreateCustomer(
                customer.name,
                customer.email,
                customer.phone
            );
        } catch (custErr) {
            console.warn(`⚠️ Zoho customer create failed for #${orderId}: ${custErr.message}`);
            // Continue with a placeholder — invoice can still be created
            zohoCustomer = null;
        }

        // Step 3: Build the final Zoho invoice payload
        const invoicePayload = {
            customer_id: zohoCustomer?.contact_id,
            date: invoice.date,
            payment_terms: 0,
            line_items: invoice.line_items.map(li => ({
                name: li.name,
                description: li.description,
                quantity: li.quantity,
                rate: li.rate,
                discount: 0
            })),
            notes: invoice.notes,
            is_inclusive_tax: false
        };

        // Add shipping address if available
        if (invoice.shipping_address) {
            invoicePayload.address = invoice.shipping_address;
        }

        // Step 4: Create invoice in Zoho Books
        let zohoInvoice;
        try {
            zohoInvoice = await zohoService.createInvoice(invoicePayload);
        } catch (invoiceErr) {
            throw new Error(`Invoice creation failed: ${invoiceErr.message}`);
        }

        // Step 5: Log tax corrections to the tax_corrections table
        if (transformations.tax_corrections && transformations.tax_corrections.length > 0) {
            await dbAdapter.run(
                `INSERT INTO zoho_tax_corrections (shopify_order_id, original_tax, corrected_tax, correction_type)
                 VALUES (?, ?, ?, ?)`,
                [
                    orderId,
                    JSON.stringify(transformations.tax_corrections.map(c => ({ sku: c.sku, rate: c.original_rate }))),
                    JSON.stringify(transformations.tax_corrections.map(c => ({ sku: c.sku, rate: c.corrected_rate, type: c.tax_type }))),
                    transformations.tax_decision.reason
                ]
            );
        }

        // Step 6: Update sync log as successful
        await dbAdapter.run(
            `UPDATE zoho_sync_log SET status = ?, zoho_invoice_id = ?, transformation = ?, updated_at = NOW()
             WHERE id = ?`,
            [
                'synced',
                zohoInvoice?.invoice_id || null,
                JSON.stringify(transformations),
                logId
            ]
        );

        // Step 7: Deduct individual component stock for broken bundles
        if (transformations.bundle_breaks && transformations.bundle_breaks.length > 0) {
            try {
                await applyBundleStockAdjustments(orderId, transformations.bundle_breaks);
            } catch (stockErr) {
                // Non-fatal: invoice is already synced, stock can be retried manually
                console.warn(`⚠️ Zoho stock adjustment failed for #${orderId}: ${stockErr.message}`);
            }
        }

        console.log(`✅ Zoho sync: order #${orderId} → invoice ${zohoInvoice?.invoice_id || 'created'}`);
        return {
            success: true,
            logId,
            zohoInvoiceId: zohoInvoice?.invoice_id,
            transformations
        };

    } catch (err) {
        // Update sync log as failed
        await dbAdapter.run(
            `UPDATE zoho_sync_log SET status = ?, error_message = ?, retry_count = retry_count + 1, updated_at = NOW()
             WHERE id = ?`,
            ['failed', err.message, logId]
        );

        console.error(`❌ Zoho sync failed for order #${orderId}: ${err.message}`);
        return { success: false, error: err.message, logId };
    }
}

/**
 * Deduct individual component stock in Zoho Inventory when a bundle sells.
 * Stock is maintained as singles (Heneley), so selling 1 Triple bundle
 * must remove 3 singles via an inventory adjustment.
 */
async function applyBundleStockAdjustments(orderId, bundleBreaks) {
    // Aggregate component deductions across all broken bundles in the order
    const deductions = {};
    for (const brk of bundleBreaks) {
        for (const exp of (brk.expanded || [])) {
            if (exp.sku && exp.qty) deductions[exp.sku] = (deductions[exp.sku] || 0) + exp.qty;
        }
    }

    const skus = Object.keys(deductions);
    if (skus.length === 0) return;

    // Resolve Zoho Inventory item IDs by SKU, then by name
    const adjustmentItems = [];
    for (const sku of skus) {
        let items = await zohoService.searchItem({ sku });
        let item = items[0] || null;
        if (!item) item = await zohoService.getItemByName(sku);

        if (!item || !item.item_id) {
            console.warn(`⚠️ Zoho stock: no Zoho item found for SKU "${sku}" — skipping deduction`);
            continue;
        }
        adjustmentItems.push({
            item_id: item.item_id,
            quantity: deductions[sku],
            adjustment_type: 'decrease'
        });
    }

    if (adjustmentItems.length === 0) return;

    const adjustment = await zohoService.adjustInventory({
        adjustment_date: new Date().toISOString().split('T')[0],
        adjustment_type: 'quantity',
        items: adjustmentItems,
        notes: `Auto-deduction: bundle sale (Shopify order #${orderId})`
    });

    console.log(`📉 Zoho stock: deducted ${adjustmentItems.map(i => i.quantity + '× ' + i.item_id).join(', ')} for order #${orderId} (adjustment ${adjustment?.inventory_adjustment_id || 'created'})`);
}

/**
 * Retry failed syncs (called from cron or manually).
 */
async function retryFailedSyncs() {
    const failed = await dbAdapter.query(
        `SELECT * FROM zoho_sync_log
         WHERE status = ? AND retry_count < ?
         ORDER BY created_at ASC
         LIMIT 50`,
        ['failed', MAX_RETRIES]
    );

    let retried = 0;
    let succeeded = 0;

    for (const row of failed) {
        retried++;
        try {
            // Re-fetch the original payload
            const originalPayload = typeof row.original_payload === 'string'
                ? JSON.parse(row.original_payload)
                : row.original_payload;

            if (!originalPayload) {
                await dbAdapter.run(
                    `UPDATE zoho_sync_log SET status = ?, error_message = ? WHERE id = ?`,
                    ['failed', 'No original payload available for retry', row.id]
                );
                continue;
            }

            // Mark as retry
            await dbAdapter.run(
                `UPDATE zoho_sync_log SET status = ?, updated_at = NOW() WHERE id = ?`,
                ['retry', row.id]
            );

            const result = await syncOrderToZoho(originalPayload);
            if (result.success) succeeded++;
        } catch (err) {
            console.error(`❌ Zoho retry failed for sync log ${row.id}: ${err.message}`);
        }
    }

    console.log(`🔄 Zoho retry: ${retried} attempted, ${succeeded} succeeded`);
    return { retried, succeeded };
}

/**
 * Log a sync attempt to the database.
 */
async function logSync(orderId, shopifyOrder, zohoInvoiceId, status, error = null) {
    return await dbAdapter.run(
        `INSERT INTO zoho_sync_log (shopify_order_id, zoho_invoice_id, status, original_payload, error_message)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, zohoInvoiceId, status, JSON.stringify(shopifyOrder), error]
    );
}

/**
 * Get sync stats for the dashboard.
 */
async function getSyncStats() {
    const today = new Date().toISOString().split('T')[0];

    const [totalToday, syncedToday, failedToday, pendingRetry, totalSynced, totalFailed] = await Promise.all([
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_sync_log WHERE created_at >= ?`, [today]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_sync_log WHERE status = ? AND created_at >= ?`, ['synced', today]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_sync_log WHERE status = ? AND created_at >= ?`, ['failed', today]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_sync_log WHERE status = ? AND retry_count < ?`, ['failed', MAX_RETRIES]),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_sync_log WHERE status = ?`, ['synced']),
        dbAdapter.query(`SELECT COUNT(*) as count FROM zoho_sync_log WHERE status = ?`, ['failed'])
    ]);

    return {
        today: {
            total: totalToday[0]?.count || 0,
            synced: syncedToday[0]?.count || 0,
            failed: failedToday[0]?.count || 0,
            pendingRetry: pendingRetry[0]?.count || 0
        },
        allTime: {
            synced: totalSynced[0]?.count || 0,
            failed: totalFailed[0]?.count || 0
        }
    };
}

/**
 * Get sync log with pagination and filters.
 */
async function getSyncLog({ page = 1, limit = 50, status, search, dateFrom, dateTo } = {}) {
    let where = [];
    let params = [];
    let paramIdx = 1;

    if (status) {
        where.push(`status = $${paramIdx++}`);
        params.push(status);
    }
    if (search) {
        where.push(`(shopify_order_id ILIKE $${paramIdx} OR zoho_invoice_id ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
    }
    if (dateFrom) {
        where.push(`created_at >= $${paramIdx++}`);
        params.push(dateFrom);
    }
    if (dateTo) {
        where.push(`created_at <= $${paramIdx++}`);
        params.push(dateTo + 'T23:59:59Z');
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
        dbAdapter.query(
            `SELECT * FROM zoho_sync_log ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, limit, offset]
        ),
        dbAdapter.query(
            `SELECT COUNT(*) as total FROM zoho_sync_log ${whereClause}`,
            params
        )
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
    syncOrderToZoho,
    retryFailedSyncs,
    getSyncStats,
    getSyncLog
};
