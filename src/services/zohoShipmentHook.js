const { dbAdapter } = require('../database/db');
const axios = require('axios');

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
 * Uses a multi-tier fallback chain so Delhivery dashboard orders
 * (where store_shoppers.payment_method may be missing) are still
 * correctly identified:
 *   1. store_shoppers.payment_method
 *   2. shipments.payment_mode
 *   3. zoho_sync_log original payload (payment_gateway_names)
 *   4. Shopify financial_status (live API lookup)
 */
async function isCodOrder(orderId) {
    // Tier 1: store_shoppers.payment_method
    try {
        const rows = await dbAdapter.query(
            'SELECT payment_method FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );
        const pm = (rows[0]?.payment_method || '').toLowerCase();
        if (pm) return pm.includes('cod') || pm.includes('cash');
    } catch (e) {
        // column/table missing — fall through
    }

    // Tier 2: shipments.payment_mode (populated when the Hub ships an
    // order, including Delhivery dashboard orders shipped via the Hub)
    try {
        const rows = await dbAdapter.query(
            'SELECT payment_mode FROM shipments WHERE order_id = ? AND awb IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );
        const pm = (rows[0]?.payment_mode || '').toLowerCase();
        if (pm) return pm.includes('cod') || pm.includes('cash');
    } catch (e) {
        // column/table missing — fall through
    }

    // Tier 3: zoho_sync_log original payload (payment_gateway_names)
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
        // ignore — fall through to Shopify check
    }

    // Tier 4: Shopify financial_status — last-resort live lookup for
    // orders where local data is incomplete (e.g. Delhivery dashboard
    // orders where payment_method was never captured locally)
    try {
        const shop = process.env.SHOPIFY_STORE;
        const token = process.env.SHOPIFY_ACCESS_TOKEN;
        if (shop && token) {
            const name = String(orderId).replace(/^#/, '');
            const url = `https://${shop}/admin/api/2024-01/orders.json?name=${encodeURIComponent(name)}&status=any&fields=id,order_number,financial_status,payment_gateway_names`;
            const res = await axios.get(url, {
                headers: { 'X-Shopify-Access-Token': token },
                timeout: 10000
            });
            const order = (res.data?.orders || [])[0];
            if (order) {
                const fs = (order.financial_status || '').toLowerCase();
                if (fs === 'pending' || fs === 'partially_paid') return true; // COD shows as 'pending' in Shopify
                const gw = ((order.payment_gateway_names || []).join(' ')).toLowerCase();
                if (gw.includes('cod') || gw.includes('cash')) return true;
            }
        }
    } catch (e) {
        // Shopify unreachableable — treat as not COD
    }

    return false;
}

module.exports = { onShipmentTerminal, isCodOrder };
