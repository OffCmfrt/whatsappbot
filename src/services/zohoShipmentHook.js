const { dbAdapter } = require('../database/db');

// ============================================================
// ZOHO SHIPMENT HOOK
// Bridges the existing shipment status cron (Delhivery/Shiprocket
// polling) into the Zoho middleware:
//   - delivered + COD  → auto-record payment in Zoho (invoice = paid)
//   - rto              → auto-create credit note in Zoho
// Fire-and-forget: failures never break the shipment sync loop.
// ============================================================

async function onShipmentTerminal(shipment, newStatus, deliveredAt) {
    // Respect the global auto-sync toggle
    if (process.env.ZOHO_AUTO_SYNC === 'false') return;

    const orderId = String(shipment.order_id || '');
    if (!orderId) return;

    const carrierInfo = {
        carrier: shipment.carrier || shipment.courier_name || 'unknown',
        awb: shipment.awb || '',
        deliveryDate: deliveredAt || new Date().toISOString()
    };

    if (newStatus === 'delivered') {
        // Only COD orders need payment reconciliation
        if (!(await isCodOrder(orderId))) return;

        const zohoCodService = require('./zohoCodService');
        const result = await zohoCodService.handleCodDelivery(orderId, carrierInfo);
        if (result && result.success) {
            console.log(`💰 Zoho hook: COD payment auto-reconciled for order #${orderId}`);
        }
    } else if (newStatus === 'rto') {
        const zohoReturnService = require('./zohoReturnService');
        const result = await zohoReturnService.handleRTOByOrderId(orderId, carrierInfo);
        if (result && result.success) {
            console.log(`🔁 Zoho hook: RTO credit note created for order #${orderId}`);
        }
    }
}

/**
 * Determine if an order is Cash-on-Delivery.
 * Primary source: store_shoppers.payment_method ('COD' / 'Prepaid').
 * Fallback: Shopify gateway names stored in the zoho sync log payload.
 */
async function isCodOrder(orderId) {
    try {
        const rows = await dbAdapter.query(
            'SELECT payment_method FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );
        const pm = (rows[0]?.payment_method || '').toLowerCase();
        if (pm) return pm.includes('cod') || pm.includes('cash');
    } catch (e) {
        // column/table missing — fall through to sync log check
    }

    try {
        const rows = await dbAdapter.query(
            'SELECT original_payload FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );
        const payload = rows[0]?.original_payload;
        if (payload) {
            const o = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const gw = ((o.payment_gateway_names || []).join(' ') + ' ' + (o.gateway || '')).toLowerCase();
            if (gw.trim()) return gw.includes('cod') || gw.includes('cash');
        }
    } catch (e) {
        // ignore — treat as not COD
    }

    return false;
}

module.exports = { onShipmentTerminal, isCodOrder };
