const zohoService = require('./zohoService');
const { buildZohoInvoicePayload } = require('./zohoTransform');
const { dbAdapter } = require('../database/db');

// ============================================================
// ZOHO SYNC ORCHESTRATOR
// Pipeline: Shopify webhook → transform → push to Zoho → log
// ============================================================

const MAX_RETRIES = 3;
const SELLER_STATE = () => process.env.ZOHO_SELLER_STATE || 'Haryana';

// In-process guard: prevents duplicate invoices when Shopify redelivers a
// webhook while the first processing is still running
const inFlightSyncs = new Set();

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

    // Concurrency guard: another webhook delivery for this order is in progress
    if (inFlightSyncs.has(orderId)) {
        console.log(`⏳ Zoho sync: order #${orderId} is already being processed, skipping duplicate`);
        return { success: true, skipped: 'in_progress' };
    }

    // Zoho-side dedupe: if an invoice with this reference already exists in
    // Zoho (log lost, manual sync ran twice, retry after partial failure),
    // never create a second one
    try {
        const existingInvoices = await zohoService.searchInvoice({ reference_number: orderId });
        if (existingInvoices.length > 0) {
            console.log(`✅ Zoho sync: invoice for order #${orderId} already exists in Zoho (${existingInvoices[0].invoice_id})`);
            await logSync(orderId, shopifyOrder, existingInvoices[0].invoice_id, 'synced');
            return { success: true, alreadySynced: true, zohoInvoiceId: existingInvoices[0].invoice_id };
        }
    } catch (dedupeErr) {
        console.warn(`⚠️ Zoho dedupe check failed for #${orderId}: ${dedupeErr.message}`);
    }

    inFlightSyncs.add(orderId);

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

        // Step 2.5: Resolve line items to real Zoho items (by SKU, then exact
        // name) so invoices link to items and Zoho auto-deducts stock when the
        // invoice is marked sent — this covers broken-bundle singles too.
        const itemCache = new Map();
        const resolveItem = async (key) => {
            if (!key) return null;
            if (itemCache.has(key)) return itemCache.get(key);
            let item = null;
            try {
                const bySku = await zohoService.searchItem({ sku: key });
                item = bySku[0] || null;
                if (!item) item = await zohoService.getItemByName(key);
            } catch (e) { /* leave unlinked */ }
            itemCache.set(key, item);
            return item;
        };
        for (const li of invoice.line_items) {
            const item = await resolveItem(li.item_id || li.name);
            li.resolved_item_id = item?.item_id || null;
        }

        // Step 3: Build the final Zoho invoice payload
        const invoicePayload = {
            customer_id: zohoCustomer?.contact_id,
            date: invoice.date,
            payment_terms: 0,
            line_items: invoice.line_items.map(li => {
                const line = {
                    name: li.name,
                    description: li.description,
                    quantity: li.quantity,
                    rate: li.rate,
                    discount: 0
                };
                if (li.resolved_item_id) line.item_id = li.resolved_item_id;
                // GST split computed by correctTax() — must reach Zoho or
                // the invoice is created with zero tax
                if ((li.cgst_rate || 0) > 0 || (li.sgst_rate || 0) > 0) {
                    line.cgst_rate = li.cgst_rate;
                    line.sgst_rate = li.sgst_rate;
                    line.tax_percentage = (li.cgst_rate || 0) + (li.sgst_rate || 0);
                } else if ((li.igst_rate || 0) > 0) {
                    line.igst_rate = li.igst_rate;
                    line.tax_percentage = li.igst_rate;
                }
                return line;
            }),
            notes: invoice.notes,
            reference_number: invoice.reference_number,
            is_inclusive_tax: false
        };

        // Add shipping address if available.
        // Zoho rejects empty-string fields (misleading "address < 100 chars"
        // error) and caps each field at 100 chars — drop empties, truncate rest.
        if (invoice.shipping_address) {
            const clean = {};
            for (const [k, v] of Object.entries(invoice.shipping_address)) {
                if (v !== null && v !== undefined && String(v).trim() !== '') clean[k] = String(v).slice(0, 100);
            }
            if (Object.keys(clean).length > 0) invoicePayload.address = clean;
        }

        // Step 4: Create invoice in Zoho Books
        let zohoInvoice;
        try {
            zohoInvoice = await zohoService.createInvoice(invoicePayload);
        } catch (invoiceErr) {
            // Purchase-only items cannot appear on invoices — retry once with
            // those lines unlinked (name suffixed so Zoho doesn't auto-match)
            if (/purchase information/i.test(invoiceErr.message)) {
                console.warn(`⚠️ Zoho sync #${orderId}: purchase-only item matched, retrying with unlinked lines`);
                invoicePayload.line_items = invoicePayload.line_items.map(l => l.item_id
                    ? { ...l, item_id: undefined, name: `${l.name} *` }
                    : l);
                try {
                    zohoInvoice = await zohoService.createInvoice(invoicePayload);
                } catch (retryErr) {
                    throw new Error(`Invoice creation failed: ${retryErr.message}`);
                }
            } else {
                throw new Error(`Invoice creation failed: ${invoiceErr.message}`);
            }
        }

        // Step 4.5: Mark sent — activates stock deduction and allows payments
        try {
            await zohoService.markInvoiceSent(zohoInvoice.invoice_id);
        } catch (sentErr) {
            console.warn(`⚠️ Zoho sync #${orderId}: mark-sent failed (${sentErr.message}) — invoice left as draft`);
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
    } finally {
        inFlightSyncs.delete(orderId);
    }
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
