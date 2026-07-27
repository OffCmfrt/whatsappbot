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
const { getConfiguredCarriers, getAdapter } = require('./carriers');

// Default package when admin doesn't override (apparel-friendly)
const DEFAULT_PACKAGE = { weightGrams: 500, lengthCm: 30, breadthCm: 40, heightCm: 2 };

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
            size: item.size || item.variant_size || item.product_size || null
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

    ctx.validationErrors = validateContext(ctx);
    return { ctx, shopper };
}

// Active (non-cancelled, non-failed) shipment for an order, if any
async function getActiveShipment(orderId) {
    const rows = await dbAdapter.query(
        `SELECT * FROM shipments WHERE order_id = ? AND status NOT IN ('cancelled', 'failed') ORDER BY id DESC LIMIT 1`,
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

// Create the shipment: idempotency guard → carrier call → audit row → orders sync
async function ship({ shopperId, carrier, courierId, packageOverrides, consigneeOverrides, notifyCustomer, shippedBy }) {
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

    // Idempotency: one active shipment per order (also enforced by DB partial unique index)
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
                shipped_by: shippedBy || 'admin'
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
            shipped_by: shippedBy || 'admin'
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

    // Optional best-effort WhatsApp notification (never blocks the response)
    if (notifyCustomer) {
        notifyCustomerShipped(shopper, data).catch(err =>
            console.warn('⚠️ Shipping WhatsApp notification failed (non-blocking):', err.message)
        );
    }

    return { data: { ...data, shipment: shipmentRow } };
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

async function notifyCustomerShipped(shopper, data) {
    const whatsappService = require('./whatsappService');
    const trackingLine = data.trackingUrl ? `\n\n📍 Track your order: ${data.trackingUrl}` : '';
    const message = `🎉 Great news, ${shopper.name || 'there'}!\n\n` +
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

async function cancelShipment(shipmentId) {
    const loaded = await loadShipmentAndAdapter(shipmentId);
    if (loaded.error) return loaded;
    const { shipment, adapter } = loaded;

    if (['cancelled', 'delivered'].includes(shipment.status)) {
        return { error: `Shipment is already ${shipment.status}`, status: 400 };
    }

    const result = await adapter.cancelShipment(shipment);
    if (!result.success) {
        console.error(`❌ Carrier cancellation failed for shipment #${shipment.id} (${shipment.carrier}, AWB ${shipment.awb || 'n/a'}):`, result.error);
        return { error: result.error, status: 502, raw: result.raw };
    }
    console.log(`📦 Carrier cancellation OK for shipment #${shipment.id} (${shipment.carrier}, AWB ${shipment.awb || 'n/a'})`, JSON.stringify(result.raw || {}).substring(0, 300));

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

    return { data: { cancelled: true, warning: result.data?.warning || null, shipment: { ...shipment, status: 'cancelled' } } };
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
    trackShipment
};
