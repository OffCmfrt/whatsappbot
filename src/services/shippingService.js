/**
 * Shipping orchestration service — bridges the Shopper Hub, the shipments
 * table and the carrier adapter framework (src/services/carriers/).
 *
 * Responsibilities:
 *   - Build an editable shipment draft from a store_shoppers row
 *   - Ship with hard idempotency (one active shipment per order)
 *   - Persist full request/response payloads for audit
 *   - Sync AWB/courier/status back onto the orders row (hub-wide visibility)
 *   - Pickup / label / cancel / track wrappers with status transitions
 */

const { dbAdapter } = require('../database/db');
const { caches } = require('../utils/cache');
const { extractItemSize, extractItemColour } = require('../utils/orderItems');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const axios = require('axios');
const { getConfiguredCarriers, getAdapter } = require('./carriers');

// Default package when admin doesn't override (apparel-friendly)
const DEFAULT_PACKAGE = { weightGrams: 500, lengthCm: 30, breadthCm: 40, heightCm: 2 };

// Terminal shipment states — they release the one-open-shipment-per-order slot
// (mirrors the idx_shipments_open_order partial unique index in db.js)
const TERMINAL_STATUSES = ['cancelled', 'failed', 'delivered', 'rto'];

function invalidateShoppersCache() {
    if (caches && caches.shoppers) {
        caches.shoppers.clear();
        console.log('🗑️ Cache invalidated: shoppers (shipping)');
    }
}

function parseItems(itemsJson) {
    try {
        const items = JSON.parse(itemsJson || '[]');
        if (!Array.isArray(items)) return [];
        return items.map(item => ({
            name: item.title || item.name || 'Product',
            sku: item.sku || item.variant_id ? String(item.sku || item.variant_id) : null,
            quantity: parseInt(item.quantity) || 1,
            price: Number(item.price) || 0,
            // Shopify keeps the size and colour in variant_title — resolve every shape
            // so carriers can print them on the label
            size: extractItemSize(item),
            colour: extractItemColour(item)
        }));
    } catch (e) {
        return [];
    }
}

function derivePaymentMode(paymentMethod) {
    const pm = (paymentMethod || '').toLowerCase();
    // Shopify-style values: 'COD', 'cash_on_delivery', 'Cash on Delivery (COD)', 'prepaid', 'razorpay'...
    return (pm.includes('cod') || pm.includes('cash')) ? 'COD' : 'Prepaid';
}

function validateContext(ctx) {
    const errors = [];
    if (!ctx.consignee.name) errors.push('Consignee name is required');
    if (!/^\d{10}$/.test((ctx.consignee.phone || '').replace(/\D/g, '').slice(-10))) errors.push('Valid 10-digit phone is required');
    if (!ctx.consignee.address || ctx.consignee.address.trim().length < 5) errors.push('Delivery address is required');
    if (!/^\d{6}$/.test((ctx.consignee.pincode || '').replace(/\D/g, ''))) errors.push('Valid 6-digit pincode is required');
    if (!(ctx.package.weightGrams > 0)) errors.push('Package weight must be greater than 0');
    if (ctx.payment.mode === 'COD' && !(ctx.payment.codAmount > 0)) errors.push('COD amount must be greater than 0 for COD orders');
    return errors;
}

// Load the shopper row (latest per order) + joined orders info
async function getShopperRow(shopperId) {
    const rows = await dbAdapter.query(`
        SELECT s.*, o.awb AS existing_awb, o.courier_name AS existing_courier, o.status AS order_status
        FROM store_shoppers s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.id = ?
        LIMIT 1
    `, [shopperId]);
    return rows[0] || null;
}

// Build the prefilled, editable shipment draft the admin reviews before shipping
async function buildShipmentContext(shopperId, overrides = {}) {
    const shopper = await getShopperRow(shopperId);
    if (!shopper) return { error: 'Shopper/order not found', status: 404 };

    const items = parseItems(shopper.items_json);
    const paymentMode = derivePaymentMode(shopper.payment_method);
    const orderTotal = Number(shopper.order_total) || 0;

    const ctx = {
        shopperId: shopper.id,
        orderId: shopper.order_id,
        consignee: {
            name: shopper.name || '',
            phone: shopper.phone || '',
            email: shopper.email || '',
            address: shopper.address || '',
            city: shopper.city || '',
            state: shopper.province || '',
            pincode: shopper.zip || '',
            country: shopper.country || 'India',
            ...(overrides.consignee || {})
        },
        payment: {
            mode: overrides.paymentMode || paymentMode,
            codAmount: paymentMode === 'COD' ? orderTotal : 0,
            declaredValue: orderTotal,
            ...(overrides.payment || {})
        },
        items,
        package: { ...DEFAULT_PACKAGE, ...(overrides.package || {}) },
        courierId: overrides.courierId || null,
        meta: {
            shopperStatus: shopper.status,
            paymentMethodRaw: shopper.payment_method,
            existingAwb: shopper.existing_awb || null,
            existingCourier: shopper.existing_courier || null
        }
    };

    // AWBs from closed local shipments (cancelled/failed/delivered/RTO).
    // Delhivery's tracking feed can report a stale live status for cancelled
    // waybills, so carriers use this list to refuse re-adopting them
    try {
        const closedRows = await dbAdapter.query(
            `SELECT awb FROM shipments WHERE order_id = ? AND awb IS NOT NULL AND status IN ('cancelled', 'failed', 'delivered', 'rto')`,
            [shopper.order_id]
        );
        ctx.meta.closedAwbs = [...new Set(closedRows.map(r => String(r.awb)).filter(Boolean))];
    } catch (e) {
        ctx.meta.closedAwbs = [];
    }

    ctx.validationErrors = validateContext(ctx);
    return { ctx, shopper };
}

// Open (non-terminal) shipment for an order, if any — blocks a new shipment.
// Delivered/RTO shipments are terminal too, so replacement re-ships are allowed.
async function getActiveShipment(orderId) {
    const rows = await dbAdapter.query(
        `SELECT * FROM shipments WHERE order_id = ? AND status NOT IN ('cancelled', 'failed', 'delivered', 'rto') ORDER BY id DESC LIMIT 1`,
        [orderId]
    );
    return rows[0] || null;
}

// Serviceability/rate check for a carrier against a draft context
async function checkServiceability({ shopperId, carrier, packageOverrides, consigneeOverrides }) {
    const adapter = getAdapter(carrier);
    if (!adapter) return { error: `Carrier '${carrier}' is not configured`, status: 400 };

    const draft = await buildShipmentContext(shopperId, {
        package: packageOverrides,
        consignee: consigneeOverrides
    });
    if (draft.error) return draft;

    const result = await adapter.checkServiceability(draft.ctx);
    if (!result.success) return { error: result.error, status: 502, raw: result.raw };
    return { data: result.data };
}

// Create the shipment: idempotency guard → carrier call → audit row → orders sync.
// Re-ship: pass reshipOfShipmentId (+ optional reshipReason) to link the new
// shipment to the one it replaces — persisted for audit and used to word the
// customer WhatsApp notification as a replacement shipment.
async function ship({ shopperId, carrier, courierId, packageOverrides, consigneeOverrides, notifyCustomer, shippedBy, reshipOfShipmentId, reshipReason, batchId }) {
    const adapter = getAdapter(carrier);
    if (!adapter) return { error: `Carrier '${carrier}' is not configured`, status: 400 };

    const draft = await buildShipmentContext(shopperId, {
        package: packageOverrides,
        consignee: consigneeOverrides,
        courierId
    });
    if (draft.error) return draft;
    const { ctx, shopper } = draft;

    if (ctx.validationErrors.length > 0) {
        return { error: `Invalid shipment data: ${ctx.validationErrors.join('; ')}`, status: 400 };
    }

    // Re-ship lineage: the referenced shipment must exist, belong to this order
    // and already be terminal (cancelled/failed/delivered/rto)
    let reshipOf = null;
    if (reshipOfShipmentId) {
        reshipOf = await getShipmentById(reshipOfShipmentId);
        if (!reshipOf || reshipOf.order_id !== ctx.orderId) {
            return { error: 'Re-ship source shipment not found for this order', status: 400 };
        }
        if (!TERMINAL_STATUSES.includes(reshipOf.status)) {
            return { error: `Cancel the existing shipment first (AWB: ${reshipOf.awb || 'pending'} is still ${reshipOf.status})`, status: 409, shipment: reshipOf };
        }
    }

    // Idempotency: one open shipment per order (also enforced by DB partial unique index)
    const existing = await getActiveShipment(ctx.orderId);
    if (existing) {
        return {
            error: `Order ${ctx.orderId} already has an active shipment (AWB: ${existing.awb || 'pending'} via ${existing.carrier})`,
            status: 409,
            shipment: existing
        };
    }

    const result = await adapter.createShipment(ctx);

    if (!result.success) {
        // Persist the failure for audit (status 'failed' keeps the order re-shippable)
        try {
            await dbAdapter.insert('shipments', {
                order_id: ctx.orderId,
                shopper_id: String(shopperId),
                carrier,
                status: 'failed',
                payment_mode: ctx.payment.mode,
                cod_amount: ctx.payment.codAmount,
                weight_grams: ctx.package.weightGrams,
                length_cm: ctx.package.lengthCm,
                breadth_cm: ctx.package.breadthCm,
                height_cm: ctx.package.heightCm,
                request_payload: JSON.stringify(ctx),
                response_payload: result.raw ? JSON.stringify(result.raw) : null,
                error_message: result.error,
                shipped_by: shippedBy || 'admin',
                reship_of_shipment_id: reshipOf ? reshipOf.id : null,
                reship_reason: reshipReason || null,
                batch_id: batchId || null
            });
        } catch (auditError) {
            console.error('⚠️ Failed to persist failed-shipment audit row:', auditError.message);
        }
        return { error: result.error, status: 502, raw: result.raw };
    }

    const data = result.data;
    let shipmentRow;
    try {
        shipmentRow = await dbAdapter.insert('shipments', {
            order_id: ctx.orderId,
            shopper_id: String(shopperId),
            carrier,
            carrier_shipment_id: data.carrierShipmentId || null,
            carrier_order_id: data.carrierOrderId || null,
            awb: data.awb,
            courier_name: data.courierName,
            status: 'awb_assigned',
            payment_mode: ctx.payment.mode,
            cod_amount: ctx.payment.codAmount,
            weight_grams: ctx.package.weightGrams,
            length_cm: ctx.package.lengthCm,
            breadth_cm: ctx.package.breadthCm,
            height_cm: ctx.package.heightCm,
            freight_charge: data.freightCharge,
            tracking_url: data.trackingUrl || null,
            request_payload: JSON.stringify(data.requestPayload || ctx),
            response_payload: result.raw ? JSON.stringify(result.raw) : null,
            shipped_by: shippedBy || 'admin',
            reship_of_shipment_id: reshipOf ? reshipOf.id : null,
            reship_reason: reshipReason || null,
            batch_id: batchId || null
        });
    } catch (dbError) {
        // Unique-index race: another request shipped this order between our check and insert
        if (dbError.code === '23505') {
            return { error: `Order ${ctx.orderId} was just shipped by another request`, status: 409 };
        }
        console.error('❌ Shipment created at carrier but DB insert failed:', dbError.message);
        return {
            error: `Shipment created at ${adapter.name} (AWB: ${data.awb}) but failed to save locally: ${dbError.message}`,
            status: 500,
            data
        };
    }
    
    // Sync AWB onto the orders row so it shows across the hub instantly
    await syncOrderRow(ctx, data, shopper);
    invalidateShoppersCache();
    
    // Auto-generate label and persist URL so batch label downloads work
    if (data.awb) {
        (async () => {
            try {
                const lblResult = await generateLabel(shipmentRow.id);
                if (lblResult.data?.labelUrl) {
                    await dbAdapter.update('shipments', {
                        label_url: lblResult.data.labelUrl,
                        updated_at: new Date().toISOString()
                    }, { id: shipmentRow.id });
                }
            } catch (lblErr) {
                console.warn(`⚠️ Auto-label generation failed for shipment ${shipmentRow.id}: ${lblErr.message}`);
            }
        })();
    }

    // Direct carriers have no Shopify channel, so Shopify never learns the
    // order shipped — post the fulfillment + tracking there ourselves.
    // Delhivery needs it too when the consignment was created via the API
    // (adopted waybills were already fulfilled through the panel channel)
    if (carrier === 'ekart' || (carrier === 'delhivery' && data.reusedSyncedOrder === false)) {
        require('./shopifyService').syncFulfillment(ctx.orderId, {
            awb: data.awb,
            courierName: data.courierName,
            trackingUrl: data.trackingUrl
        })
            .then(res => {
                if (res.success) console.log(`🛍️ ${res.action}`);
                else if (res.warning) console.warn(`⚠️ Shopify fulfillment sync skipped for ${ctx.orderId}: ${res.warning}`);
            })
            .catch(err => console.warn(`⚠️ Shopify fulfillment sync failed (non-blocking): ${err.message}`));
    }

    // Optional best-effort WhatsApp notification (never blocks the response)
    if (notifyCustomer) {
        notifyCustomerShipped(shopper, data, { isReship: Boolean(reshipOf), reason: reshipReason }).catch(err =>
            console.warn('⚠️ Shipping WhatsApp notification failed (non-blocking):', err.message)
        );
    }

    return { data: { ...data, shipment: shipmentRow, reship: reshipOf ? { ofShipmentId: reshipOf.id, previousAwb: reshipOf.awb, reason: reshipReason || null } : null } };
}

// Upsert the orders row with the fresh AWB/courier/tracking
async function syncOrderRow(ctx, data, shopper) {
    try {
        const updated = await dbAdapter.query(`
            UPDATE orders
            SET awb = ?, courier_name = ?, status = 'shipped', tracking_url = ?, updated_at = CURRENT_TIMESTAMP
            WHERE order_id = ?
            RETURNING id
        `, [data.awb, data.courierName, data.trackingUrl || null, ctx.orderId]);

        if (!updated || updated.length === 0) {
            await dbAdapter.insert('orders', {
                order_id: ctx.orderId,
                awb: data.awb,
                courier_name: data.courierName,
                status: 'shipped',
                tracking_url: data.trackingUrl || null,
                total: ctx.payment.declaredValue,
                payment_method: ctx.payment.mode,
                product_name: ctx.items.map(i => i.name).join(', ').substring(0, 500) || null,
                order_date: new Date().toISOString()
            });
        }
    } catch (error) {
        // Non-fatal: the shipments row is the source of truth
        console.error('⚠️ Failed to sync orders row after shipping:', error.message);
    }
}

async function notifyCustomerShipped(shopper, data, { isReship = false, reason = null } = {}) {
    const whatsappService = require('./whatsappService');
    const trackingLine = data.trackingUrl ? `\n\n📍 Track your order: ${data.trackingUrl}` : '';
    const message = isReship
        ? `🔄 Update on your order, ${shopper.name || 'there'}!\n\n` +
          `We've re-shipped your OFFCOMFRT order *${shopper.order_id}*${reason ? ` (${reason.toLowerCase()})` : ''} — a fresh shipment is on its way via *${data.courierName}*.\n\n` +
          `📦 New Tracking Number (AWB): *${data.awb}*${trackingLine}\n\n` +
          `Sorry for the wait — thank you for your patience! 🖤`
        : `🎉 Great news, ${shopper.name || 'there'}!\n\n` +
          `Your OFFCOMFRT order *${shopper.order_id}* has been shipped via *${data.courierName}*.\n\n` +
          `📦 Tracking Number (AWB): *${data.awb}*${trackingLine}\n\n` +
          `Thank you for shopping with us! 🖤`;
    await whatsappService.sendMessage(shopper.phone, message, 'shipping_confirmation');
}

// ==========================================
// Post-ship operations (by shipments.id)
// ==========================================

async function getShipmentById(shipmentId) {
    const rows = await dbAdapter.select('shipments', { id: parseInt(shipmentId) }, { limit: 1 });
    return rows[0] || null;
}

async function listShipments({ orderId, status, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM shipments WHERE 1=1';
    const params = [];
    if (orderId) { sql += ' AND order_id = ?'; params.push(orderId); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Math.min(parseInt(limit) || 50, 200), Math.max(0, parseInt(offset) || 0));
    return await dbAdapter.query(sql, params);
}

// Shared loader: shipment row + its (configured) adapter
async function loadShipmentAndAdapter(shipmentId) {
    const shipment = await getShipmentById(shipmentId);
    if (!shipment) return { error: 'Shipment not found', status: 404 };
    const adapter = getAdapter(shipment.carrier);
    if (!adapter) return { error: `Carrier '${shipment.carrier}' is no longer configured`, status: 400 };
    return { shipment, adapter };
}

async function schedulePickup(shipmentId, pickupDate) {
    const loaded = await loadShipmentAndAdapter(shipmentId);
    if (loaded.error) return loaded;
    const { shipment, adapter } = loaded;

    const result = await adapter.schedulePickup(shipment, pickupDate);
    if (!result.success) return { error: result.error, status: 502, raw: result.raw };

    await dbAdapter.update('shipments', {
        status: 'pickup_scheduled',
        pickup_date: result.data.pickupDate || pickupDate,
        pickup_token: result.data.pickupToken || null,
        updated_at: new Date().toISOString()
    }, { id: shipment.id });

    return { data: result.data };
}

async function generateLabel(shipmentId) {
    const loaded = await loadShipmentAndAdapter(shipmentId);
    if (loaded.error) return loaded;
    const { shipment, adapter } = loaded;

    // Reuse a previously generated label
    if (shipment.label_url) return { data: { labelUrl: shipment.label_url, cached: true } };

    const result = await adapter.generateLabel(shipment);
    if (!result.success) return { error: result.error, status: 502, raw: result.raw };

    await dbAdapter.update('shipments', {
        label_url: result.data.labelUrl,
        updated_at: new Date().toISOString()
    }, { id: shipment.id });

    return { data: result.data };
}

async function generateDocument(shipmentId, type) {
    const loaded = await loadShipmentAndAdapter(shipmentId);
    if (loaded.error) return loaded;
    const { shipment, adapter } = loaded;

    if (type === 'manifest') {
        if (!adapter.capabilities.supportsManifest) return { error: `${adapter.name} does not support manifests`, status: 400 };
        if (shipment.manifest_url) return { data: { manifestUrl: shipment.manifest_url, cached: true } };
        const result = await adapter.generateManifest(shipment);
        if (!result.success) return { error: result.error, status: 502, raw: result.raw };
        await dbAdapter.update('shipments', { manifest_url: result.data.manifestUrl, updated_at: new Date().toISOString() }, { id: shipment.id });
        return { data: result.data };
    }

    if (type === 'invoice') {
        if (!adapter.capabilities.supportsInvoice) return { error: `${adapter.name} does not support invoices`, status: 400 };
        if (shipment.invoice_url) return { data: { invoiceUrl: shipment.invoice_url, cached: true } };
        const result = await adapter.generateInvoice(shipment);
        if (!result.success) return { error: result.error, status: 502, raw: result.raw };
        await dbAdapter.update('shipments', { invoice_url: result.data.invoiceUrl, updated_at: new Date().toISOString() }, { id: shipment.id });
        return { data: result.data };
    }

    return { error: `Unknown document type: ${type}`, status: 400 };
}

// Cancel at the carrier, then mark cancelled locally.
// force = the carrier refused (package already delivered/RTO/lost/closed) but the
// admin still needs the order shippable again — the local row is closed with the
// carrier's reason recorded, and the caller gets it back as a warning.
async function cancelShipment(shipmentId, { force = false } = {}) {
    const loaded = await loadShipmentAndAdapter(shipmentId);
    if (loaded.error) return loaded;
    const { shipment, adapter } = loaded;

    if (['cancelled', 'delivered'].includes(shipment.status)) {
        return { error: `Shipment is already ${shipment.status}`, status: 400 };
    }

    const result = await adapter.cancelShipment(shipment);
    let warning = result.data?.warning || null;

    if (!result.success) {
        console.error(
            `❌ Carrier cancellation failed for shipment #${shipment.id} (${shipment.carrier}, AWB ${shipment.awb || 'n/a'}):`,
            result.error,
            '| carrier response:', JSON.stringify(result.raw || {}).substring(0, 1000)
        );

        // Keep the reason on the row so the hub shows why it is still open
        try {
            await dbAdapter.update('shipments', {
                error_message: `Cancel ${force ? 'refused by carrier (forced locally)' : 'failed'}: ${result.error}`.substring(0, 1000),
                response_payload: result.raw ? JSON.stringify(result.raw) : null,
                updated_at: new Date().toISOString()
            }, { id: shipment.id });
        } catch (auditError) {
            console.error('⚠️ Failed to persist cancellation error on shipment row:', auditError.message);
        }

        if (!force) {
            return { error: result.error, status: 502, raw: result.raw, carrierRejected: true };
        }
        console.warn(`⚠️ Force-closing shipment #${shipment.id} locally after carrier rejection (AWB ${shipment.awb || 'n/a'} may still be live at ${shipment.carrier})`);
        warning = `${adapter.name} did not cancel AWB ${shipment.awb || 'n/a'} (${result.error}). Marked cancelled locally only — verify with the carrier.`;
    } else {
        console.log(`📦 Carrier cancellation OK for shipment #${shipment.id} (${shipment.carrier}, AWB ${shipment.awb || 'n/a'})`, JSON.stringify(result.raw || {}).substring(0, 300));
    }

    await dbAdapter.update('shipments', {
        status: 'cancelled',
        updated_at: new Date().toISOString()
    }, { id: shipment.id });

    // Clear AWB from the orders row so the hub shows the order as shippable again
    try {
        await dbAdapter.query(`
            UPDATE orders
            SET awb = NULL, courier_name = NULL, tracking_url = NULL, status = 'cancelled_shipment', updated_at = CURRENT_TIMESTAMP
            WHERE order_id = ? AND awb = ?
        `, [shipment.order_id, shipment.awb]);
    } catch (error) {
        console.error('⚠️ Failed to clear orders row after cancellation:', error.message);
    }
    invalidateShoppersCache();

    return { data: { cancelled: true, forced: force && !result.success, warning, shipment: { ...shipment, status: 'cancelled' } } };
}

// Cancel the active shipment (if any) for an order at its carrier.
// Used when the hub cancels an order outright (Shopper Hub status → cancelled).
async function cancelActiveShipmentForOrder(orderId) {
    if (!orderId) return { hadShipment: false };
    const active = await getActiveShipment(orderId);
    if (!active) return { hadShipment: false };

    const result = await cancelShipment(active.id);
    if (result.error) {
        return { hadShipment: true, cancelled: false, awb: active.awb, carrier: active.carrier, error: result.error };
    }
    return { hadShipment: true, cancelled: true, awb: active.awb, carrier: active.carrier };
}

async function trackShipment(shipmentId) {
    const loaded = await loadShipmentAndAdapter(shipmentId);
    if (loaded.error) return loaded;
    const { shipment, adapter } = loaded;

    if (!shipment.awb) return { error: 'Shipment has no AWB yet', status: 400 };

    const result = await adapter.track(shipment.awb);
    if (!result.success) return { error: result.error, status: 502, raw: result.raw };

    // Opportunistic status sync from live tracking (same smart mapping +
    // forward-only transitions as the automatic background sync)
    const { mapCarrierStatus, resolveTransition } = require('./shipmentSyncService');
    const mapped = mapCarrierStatus(result.data.currentStatus);
    const newStatus = resolveTransition(shipment.status, mapped);
    if (newStatus) {
        await dbAdapter.update('shipments', { status: newStatus, updated_at: new Date().toISOString() }, { id: shipment.id });
    }

    return { data: { ...result.data, awb: shipment.awb, courierName: shipment.courier_name, carrier: shipment.carrier } };
}

// ─── Shipment Batches ────────────────────────────────────────────────
// Group bulk-ship runs into a single batch record for manifest/label download
// and operator audit trail.

async function createBatch({ shippedBy, carrier, totalOrders, packageDefaults }) {
    // Generate a human-friendly batch number: BATCH-0001, BATCH-0002, ...
    const countRows = await dbAdapter.query('SELECT COUNT(*)::int AS c FROM shipment_batches');
    const nextNum = (countRows[0]?.c || 0) + 1;
    const batchNumber = `BATCH-${String(nextNum).padStart(4, '0')}`;

    const rows = await dbAdapter.query(`
        INSERT INTO shipment_batches (batch_number, shipped_by, carrier, total_orders, package_defaults, status)
        VALUES (?, ?, ?, ?, ?, 'processing')
        RETURNING id, batch_number, created_at
    `, [batchNumber, shippedBy || 'admin', carrier, totalOrders || 0, JSON.stringify(packageDefaults || {})]);

    return rows[0];
}

async function updateBatch(batchId, { successfulCount, failedCount, status, customName }) {
    const setClauses = ['updated_at = CURRENT_TIMESTAMP'];
    const params = [];

    if (successfulCount !== undefined) {
        params.push(successfulCount);
        setClauses.push(`successful_count = ?`);
    }
    if (failedCount !== undefined) {
        params.push(failedCount);
        setClauses.push(`failed_count = ?`);
    }
    if (status) {
        params.push(status);
        setClauses.push(`status = ?`);
        if (status !== 'processing') {
            setClauses.push(`completed_at = CURRENT_TIMESTAMP`);
        }
    }
    if (customName !== undefined) {
        params.push(customName || null);
        setClauses.push(`custom_name = ?`);
    }

    params.push(batchId);
    await dbAdapter.query(`UPDATE shipment_batches SET ${setClauses.join(', ')} WHERE id = ?`, params);
}

async function getBatch(batchId) {
    const batches = await dbAdapter.query('SELECT * FROM shipment_batches WHERE id = ? LIMIT 1', [batchId]);
    if (!batches[0]) return null;

    const shipments = await dbAdapter.query(`
        SELECT s.*,
               COALESCE(ss.name, '') AS customer_name,
               COALESCE(ss.phone, '') AS customer_phone,
               COALESCE(ss.address, '') AS customer_address,
               COALESCE(ss.city, '') AS customer_city,
               COALESCE(ss.province, '') AS customer_state,
               COALESCE(ss.zip, '') AS customer_pincode,
               COALESCE(ss.order_total, 0) AS order_total,
               COALESCE(ss.items_json, '[]') AS items_json
        FROM shipments s
        LEFT JOIN store_shoppers ss ON ss.id = s.shopper_id
        WHERE s.batch_id = ?
        ORDER BY s.id ASC
    `, [batchId]);

    return { ...batches[0], shipments };
}

async function listBatches({ limit = 25, offset = 0 } = {}) {
    const safeLimit = Math.min(parseInt(limit) || 25, 100);
    const safeOffset = Math.max(0, parseInt(offset) || 0);

    const [rows, countRows, statsRows] = await Promise.all([
        dbAdapter.query(`
            SELECT * FROM shipment_batches
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, [safeLimit, safeOffset]),
        dbAdapter.query('SELECT COUNT(*)::int AS total FROM shipment_batches'),
        dbAdapter.query(`
            SELECT COUNT(*)::int AS total_batches,
                   COALESCE(SUM(total_orders), 0)::int AS total_orders_shipped,
                   COALESCE(SUM(successful_count), 0)::int AS total_successful,
                   COALESCE(SUM(failed_count), 0)::int AS total_failed
            FROM shipment_batches
        `)
    ]);

    return {
        batches: rows,
        total: countRows[0]?.total || 0,
        stats: statsRows[0] || {}
    };
}

async function generateBatchManifest(batchId) {
    const batch = await dbAdapter.query('SELECT * FROM shipment_batches WHERE id = ? LIMIT 1', [batchId]);
    if (!batch[0]) return { error: 'Batch not found', status: 404 };

    const shipments = await dbAdapter.query(`
        SELECT s.order_id, s.awb, s.courier_name, s.status, s.freight_charge,
               s.payment_mode, s.cod_amount, s.weight_grams,
               COALESCE(ss.name, '') AS customer_name,
               COALESCE(ss.phone, '') AS customer_phone,
               COALESCE(ss.address, '') AS customer_address,
               COALESCE(ss.city, '') AS customer_city,
               COALESCE(ss.province, '') AS customer_state,
               COALESCE(ss.zip, '') AS customer_pincode,
               COALESCE(ss.order_total, 0) AS order_total,
               COALESCE(ss.items_json, '[]') AS items_json
        FROM shipments s
        LEFT JOIN store_shoppers ss ON ss.id = s.shopper_id
        WHERE s.batch_id = ? AND s.status NOT IN ('failed')
        ORDER BY s.id ASC
    `, [batchId]);

    // ── Barcode helper (Code-128 via bwip-js) ──────────────────────
    async function renderBarcode(text) {
        if (!text) return null;
        try {
            return await bwipjs.toBuffer({
                bcid: 'code128', text: String(text),
                scale: 2, height: 12, includetext: true,
                textxalign: 'center', textsize: 9
            });
        } catch (_) { return null; }
    }

    // ── Build PDF (clean white, print-friendly) ─────────────────────
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));

    const PW = 595.28 - 80;
    const batchData = batch[0];
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    // ── Header ──────────────────────────────────────────────────────
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#000')
       .text('SHIPPING MANIFEST', 40, 40, { width: PW, align: 'center' });
    doc.moveTo(40, 62).lineTo(40 + PW, 62).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#333')
       .text(`Batch: ${batchData.batch_number}     |     Date: ${dateStr}     |     Shipments: ${shipments.length}     |     Carrier: ${batchData.carrier || 'Multi-Carrier'}`,
             40, 68, { width: PW, align: 'center' });
    doc.moveTo(40, 84).lineTo(40 + PW, 84).strokeColor('#ccc').lineWidth(0.5).stroke();

    // ── Column layout ───────────────────────────────────────────────
    const COL = {
        sr:    { x: 40,      w: 25  },
        awb:   { x: 65,      w: 100 },
        order: { x: 165,     w: 75  },
        cust:  { x: 240,     w: 115 },
        dest:  { x: 355,     w: 105 },
        pay:   { x: 460,     w: 45  },
        amt:   { x: 505,     w: 50.28 }
    };
    const ROW_H    = 52;
    const HDR_H    = 18;
    const PAGE_BOT = 842 - 50;
    let y = 92;

    // ── Table header (reusable) ─────────────────────────────────────
    function drawTableHeader() {
        doc.rect(40, y, PW, HDR_H).fillColor('#f0f0f0').stroke();
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#333');
        const cols = [
            ['#', COL.sr.x, COL.sr.w], ['AWB', COL.awb.x, COL.awb.w],
            ['ORDER', COL.order.x, COL.order.w], ['CUSTOMER', COL.cust.x, COL.cust.w],
            ['DESTINATION', COL.dest.x, COL.dest.w], ['PAY', COL.pay.x, COL.pay.w],
            ['AMOUNT', COL.amt.x, COL.amt.w]
        ];
        for (const [label, x, w] of cols) doc.text(label, x + 3, y + 4, { width: w - 6 });
        y += HDR_H;
    }
    drawTableHeader();

    // ── Shipment rows ───────────────────────────────────────────────
    let totalCod = 0, totalFreight = 0;
    for (let i = 0; i < shipments.length; i++) {
        const s = shipments[i];
        if (y + ROW_H > PAGE_BOT) { doc.addPage(); y = 40; drawTableHeader(); }

        // Alternating row background
        if (i % 2 === 1) doc.rect(40, y, PW, ROW_H).fillColor('#fafafa');
        doc.rect(40, y, PW, ROW_H).strokeColor('#ddd').lineWidth(0.3).stroke();

        const textY = y + 5;

        // # (serial)
        doc.fontSize(7).font('Helvetica').fillColor('#666')
           .text(String(i + 1), COL.sr.x + 3, textY, { width: COL.sr.w - 6 });

        // AWB + barcode
        if (s.awb) {
            const bcBuf = await renderBarcode(s.awb);
            if (bcBuf) {
                try { doc.image(bcBuf, { fit: [COL.awb.w - 6, 28], x: COL.awb.x + 3, y: textY }); }
                catch (_) { doc.fontSize(7).fillColor('#000').text(s.awb, COL.awb.x + 3, textY, { width: COL.awb.w - 6 }); }
            } else {
                doc.fontSize(7).fillColor('#000').text(s.awb, COL.awb.x + 3, textY, { width: COL.awb.w - 6 });
            }
        }

        // Order ID
        doc.fontSize(7).fillColor('#222')
           .text(String(s.order_id || ''), COL.order.x + 3, textY, { width: COL.order.w - 6 });

        // Customer name + phone
        doc.fontSize(7).fillColor('#333')
           .text(`${s.customer_name || '-'}\n${s.customer_phone || ''}`, COL.cust.x + 3, textY, { width: COL.cust.w - 6, lineBreak: false, height: ROW_H - 10 });

        // Destination
        const destParts = [s.customer_city, s.customer_state, s.customer_pincode].filter(Boolean);
        doc.fontSize(7).fillColor('#333')
           .text(destParts.join(', ') || '-', COL.dest.x + 3, textY, { width: COL.dest.w - 6, lineBreak: false, height: ROW_H - 10 });

        // Payment mode
        const payLabel = (s.payment_mode || '').toUpperCase();
        doc.fontSize(7).fillColor(payLabel === 'COD' ? '#c0392b' : '#27ae60')
           .text(payLabel || '-', COL.pay.x + 3, textY, { width: COL.pay.w - 6 });

        // Amount
        const amt = s.payment_mode === 'COD' ? (s.cod_amount || 0) : (s.order_total || 0);
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#000')
           .text(`Rs.${amt}`, COL.amt.x + 3, textY, { width: COL.amt.w - 6 });

        // Product line at bottom of row
        let productLine = '';
        try {
            const items = JSON.parse(s.items_json || '[]');
            productLine = items.map(it => {
                const sz = extractItemSize(it) || '';
                const title = it.title || it.name || 'Product';
                const qty = it.quantity || 1;
                return sz ? `${title}(${sz})x${qty}` : `${title}x${qty}`;
            }).join(' | ');
        } catch (_) {}
        if (productLine) {
            doc.fontSize(5.5).font('Helvetica').fillColor('#888')
               .text(productLine, COL.cust.x + 3, y + ROW_H - 12, { width: PW - (COL.cust.x - 40) - 6, lineBreak: false });
        }

        totalCod += (s.payment_mode === 'COD') ? (s.cod_amount || 0) : 0;
        totalFreight += (s.freight_charge || 0);
        y += ROW_H;
    }

    // ── Footer summary ──────────────────────────────────────────────
    y += 8;
    doc.moveTo(40, y).lineTo(40 + PW, y).strokeColor('#999').lineWidth(0.5).stroke();
    y += 6;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#000')
       .text(`Total: ${shipments.length} shipments   |   COD Collectible: Rs.${totalCod}   |   Freight: Rs.${totalFreight}`,
             40, y, { width: PW, align: 'center' });

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let pg = range.start; pg < range.start + range.count; pg++) {
        doc.switchToPage(pg);
        doc.fontSize(7).font('Helvetica').fillColor('#999')
           .text(`Page ${pg + 1} of ${range.count}`, 40, 842 - 28, { width: PW, align: 'center' });
    }

    doc.end();
    const pdfBuffer = await new Promise(resolve => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    return {
        data: {
            batchNumber: batchData.batch_number,
            pdfBuffer,
            shipmentCount: shipments.length
        }
    };
}

async function getBatchLabels(batchId) {
    // Fetch ALL shipments (including those without stored label_url)
    const shipments = await dbAdapter.query(`
        SELECT s.id, s.order_id, s.awb, s.label_url, s.courier_name, s.manifest_url,
               COALESCE(ss.items_json, '[]') AS items_json
        FROM shipments s
        LEFT JOIN store_shoppers ss ON ss.id = s.shopper_id
        WHERE s.batch_id = ? AND s.status NOT IN ('failed', 'cancelled')
        ORDER BY s.id ASC
    `, [batchId]);

    // Generate labels on-the-fly for shipments without stored label_url
    // Each carrier call gets a 15s timeout so a slow API never blocks the whole batch
    for (const s of shipments) {
        if (!s.label_url && s.awb) {
            try {
                const result = await Promise.race([
                    generateLabel(s.id),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('Label generation timeout')), 15000))
                ]);
                if (result.data?.labelUrl) {
                    s.label_url = result.data.labelUrl;
                    // Persist so subsequent requests are instant
                    await dbAdapter.update('shipments', {
                        label_url: result.data.labelUrl,
                        updated_at: new Date().toISOString()
                    }, { id: s.id });
                } else if (result.data?.labelBuffer) {
                    // Carrier returned a raw PDF buffer (e.g. Ekart without Cloudinary)
                    s._labelBuffer = result.data.labelBuffer;
                }
            } catch (err) {
                console.warn(`Label generation failed for shipment ${s.id}: ${err.message}`);
            }
        }
    }

    // Enrich each label with parsed SKU / product info
    const labels = shipments.filter(s => s.label_url || s._labelBuffer).map(s => {
        let skus = [];
        let productSummary = '';
        try {
            const items = JSON.parse(s.items_json || '[]');
            skus = items.map(item => {
                const size = extractItemSize(item) || '';
                const title = item.title || item.name || 'Product';
                const sku = item.sku || item.variant_sku || '';
                return { title, size, sku };
            });
            productSummary = skus.map(s => {
                const parts = [s.title];
                if (s.size) parts.push(s.size);
                return parts.join(' ');
            }).join('; ');
        } catch (_) {}

        // Primary SKU for grouping: use first item's SKU or derive from title+size
        const primarySku = skus.length > 0
            ? (skus[0].sku || `${skus[0].title}${skus[0].size ? '-' + skus[0].size : ''}`)
            : 'unknown';

        return {
            id: s.id,
            order_id: s.order_id,
            awb: s.awb,
            label_url: s.label_url,
            label_buffer: s._labelBuffer || null,
            courier_name: s.courier_name,
            manifest_url: s.manifest_url,
            skus,
            product_summary: productSummary,
            primary_sku: primarySku
        };
    });

    return { data: { labels } };
}

// Build a ZIP file containing all labels for a batch, sorted/grouped by the
// chosen strategy.  Always returns a ZIP — shipments without carrier labels
// get a generated info-sheet PDF so the download never fails.
async function buildBatchLabelsZip(batchId, { sortBy = 'sku', format = 'flat' } = {}) {
    const { ZipArchive } = require('archiver');
    const { PassThrough } = require('stream');

    // Fetch batch
    const batchRows = await dbAdapter.query('SELECT * FROM shipment_batches WHERE id = ? LIMIT 1', [batchId]);
    if (!batchRows[0]) return { error: 'Batch not found', status: 404 };
    const batch = batchRows[0];

    // Get labels (now generates on-the-fly for missing ones)
    const { data: { labels } } = await getBatchLabels(batchId);

    // If still empty (all carrier API calls failed), fetch raw shipment data
    // so we can at least produce info-sheet PDFs
    let allLabels = labels || [];
    if (allLabels.length === 0) {
        const rawShipments = await dbAdapter.query(`
            SELECT s.id, s.order_id, s.awb, s.courier_name, s.status,
                   COALESCE(ss.items_json, '[]') AS items_json
            FROM shipments s
            LEFT JOIN store_shoppers ss ON ss.id = s.shopper_id
            WHERE s.batch_id = ? AND s.status NOT IN ('failed', 'cancelled')
            ORDER BY s.id ASC
        `, [batchId]);

        allLabels = rawShipments.map(s => {
            let productSummary = '', primarySku = 'unknown';
            try {
                const items = JSON.parse(s.items_json || '[]');
                productSummary = items.map(it => {
                    const sz = extractItemSize(it) || '';
                    const t = it.title || it.name || 'Product';
                    return sz ? `${t} (${sz})` : t;
                }).join('; ');
                const firstSku = items[0]?.sku || items[0]?.variant_sku || '';
                primarySku = firstSku || items[0]?.title || 'unknown';
            } catch (_) {}
            return {
                id: s.id, order_id: s.order_id, awb: s.awb,
                label_url: null, courier_name: s.courier_name,
                product_summary: productSummary, primary_sku: primarySku
            };
        });
    }

    if (allLabels.length === 0) return { error: 'No shipments found in this batch', status: 404 };

    // Sort
    const sorted = [...allLabels];
    switch (sortBy) {
        case 'sku': sorted.sort((a, b) => (a.primary_sku || '').localeCompare(b.primary_sku || '')); break;
        case 'awb': sorted.sort((a, b) => (a.awb || '').localeCompare(b.awb || '')); break;
        case 'order_id': sorted.sort((a, b) => (a.order_id || '').localeCompare(b.order_id || '')); break;
        case 'product': sorted.sort((a, b) => (a.product_summary || '').localeCompare(b.product_summary || '')); break;
    }

    // Helper: generate a simple info-sheet PDF for shipments without carrier labels
    function buildInfoSheetPdf(label) {
        const doc = new PDFDocument({ size: [283.46, 425.20], margin: 14 }); // ~100x150mm label
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#000')
           .text(label.awb || 'NO AWB', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(8).font('Helvetica').fillColor('#333')
           .text(`Order: ${label.order_id || '-'}`);
        doc.text(`Courier: ${label.courier_name || '-'}`);
        if (label.product_summary) {
            doc.moveDown(0.3);
            doc.fontSize(7).text(`Items: ${label.product_summary}`);
        }
        doc.moveDown(0.5);
        doc.fontSize(7).fillColor('#999')
           .text('(Carrier label could not be retrieved — please print from carrier panel)');
        doc.end();
        return new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
    }

    // Create ZIP buffer
    const zipBuffer = await new Promise(async (resolve, reject) => {
        const output = new PassThrough();
        const chunks = [];
        const archive = new ZipArchive({ zlib: { level: 6 } });
        archive.pipe(output);
        output.on('data', chunk => chunks.push(chunk));
        output.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);

        let labelCount = 0, missingCount = 0;

        for (const label of sorted) {
            const safeOrder = (label.order_id || 'order').replace(/[^a-zA-Z0-9_-]/g, '_');
            const safeAwb = (label.awb || 'noawb').replace(/[^a-zA-Z0-9_-]/g, '_');
            const fileName = `${safeOrder}_${safeAwb}.pdf`;
            const folder = format === 'by_sku'
                ? `${(label.primary_sku || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60)}/`
                : '';

            if (label.label_buffer) {
                // Real carrier PDF buffer (e.g. Ekart without Cloudinary)
                archive.append(label.label_buffer, { name: `${folder}${fileName}` });
                labelCount++;
            } else if (label.label_url) {
                // Fetch label from carrier URL (Delhivery, Shiprocket)
                archive.append(fetchLabelBuffer(label.label_url), { name: `${folder}${fileName}` });
                labelCount++;
            } else {
                // Generate info-sheet PDF as last resort
                const infoPdf = await buildInfoSheetPdf(label);
                archive.append(infoPdf, { name: `${folder}${fileName}` });
                missingCount++;
            }
        }

        // Label index CSV
        const indexLines = ['Order ID,AWB,Courier,SKU,Products,Label Status'];
        for (const label of sorted) {
            indexLines.push([
                label.order_id, label.awb || '', label.courier_name || '',
                label.primary_sku || '', `"${(label.product_summary || '').replace(/"/g, '""')}"`,
                label.label_url ? 'OK' : 'MISSING'
            ].join(','));
        }
        archive.append(indexLines.join('\n'), { name: '_label_index.csv' });

        // Summary note
        archive.append(
            `Labels downloaded: ${labelCount}\nMissing (info-sheets): ${missingCount}\nTotal: ${sorted.length}`,
            { name: '_download_summary.txt' }
        );

        archive.finalize();
    });

    const safeBatchNum = (batch.batch_number || `batch_${batchId}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
        zipBuffer,
        fileName: `${safeBatchNum}_labels_${sortBy}.zip`,
        labelCount: allLabels.length,
        batchNumber: batch.batch_number
    };
}

// Helper: fetch a label PDF from its URL and return as an async-readable stream
function fetchLabelBuffer(labelUrl) {
    const { PassThrough } = require('stream');
    const pt = new PassThrough();

    if (!labelUrl) {
        pt.end(Buffer.alloc(0));
        return pt;
    }

    axios.get(labelUrl, { responseType: 'stream', timeout: 30000 })
        .then(res => {
            res.data.pipe(pt);
            res.data.on('error', (err) => {
                console.warn(`Label stream error for ${labelUrl}: ${err.message}`);
                pt.end();
            });
            res.data.on('end', () => {
                // Ensure the stream closes cleanly when data is fully received
                if (!pt.writableEnded) pt.end();
            });
        })
        .catch((err) => {
            // If the fetch fails, write an empty placeholder so the ZIP still completes
            console.warn(`Label fetch failed for ${labelUrl}: ${err.message}`);
            pt.end();
        });

    return pt;
}

module.exports = {
    getConfiguredCarriers,
    buildShipmentContext,
    checkServiceability,
    ship,
    listShipments,
    getShipmentById,
    schedulePickup,
    generateLabel,
    generateDocument,
    cancelShipment,
    cancelActiveShipmentForOrder,
    trackShipment,
    createBatch,
    updateBatch,
    getBatch,
    listBatches,
    generateBatchManifest,
    getBatchLabels,
    buildBatchLabelsZip
};
