const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Services
const zohoSyncService = require('../services/zohoSyncService');
const zohoReturnService = require('../services/zohoReturnService');
const zohoCodService = require('../services/zohoCodService');

// ============================================================
// SHOPIFY WEBHOOK VERIFICATION (HMAC-SHA256)
// ============================================================

function verifyShopifyWebhook(req, res, next) {
    const hmac = req.headers['x-shopify-hmac-sha256'];

    if (hmac) {
        // Shopify signs each notification webhook with that webhook's signing
        // secret (shown in Shopify admin when the webhook is created). Accept
        // any configured secret: ZOHO_SHOPIFY_WEBHOOK_SECRET (comma-separated
        // list for the Zoho webhooks) plus the app-wide secret as fallback.
        const candidates = [
            ...(process.env.ZOHO_SHOPIFY_WEBHOOK_SECRET || '').split(','),
            process.env.SHOPIFY_WEBHOOK_SECRET || ''
        ].map(s => s.trim()).filter(Boolean);

        if (candidates.length === 0) {
            console.warn('⚠️ Zoho webhook: no webhook secret configured, skipping HMAC verification');
        } else {
            const valid = candidates.some(secret => {
                const hash = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
                return hash === hmac;
            });
            if (!valid) {
                console.error('❌ Zoho webhook: HMAC verification failed');
                return res.status(401).json({ error: 'HMAC verification failed' });
            }
        }
    }

    // Parse the body for downstream handlers
    try {
        req.body = JSON.parse(req.body.toString());
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }

    next();
}

// ============================================================
// SHOPIFY ORDER CREATED — sync to Zoho
// ============================================================

router.post('/orders/create', verifyShopifyWebhook, async (req, res) => {
    // Respond immediately to Shopify (webhook must respond within 5s)
    res.status(200).json({ received: true });

    try {
        const order = req.body;
        console.log(`📦 Zoho webhook: order created #${order.order_number || order.id}`);
        await zohoSyncService.syncOrderToZoho(order);
    } catch (err) {
        console.error('❌ Zoho webhook order/create error:', err.message);
    }
});

// ============================================================
// SHOPIFY ORDER UPDATED — re-sync if needed
// ============================================================

router.post('/orders/updated', verifyShopifyWebhook, async (req, res) => {
    res.status(200).json({ received: true });

    try {
        const order = req.body;
        // Only re-sync if the order has meaningful changes
        // (financial_status, fulfillment_status, etc.)
        console.log(`📦 Zoho webhook: order updated #${order.order_number || order.id}`);
        // For now, we skip re-sync to avoid duplicate invoices.
        // The initial orders/create handles the primary sync.
    } catch (err) {
        console.error('❌ Zoho webhook order/updated error:', err.message);
    }
});

// ============================================================
// SHOPIFY REFUND CREATED — create credit note in Zoho
// ============================================================

router.post('/refunds/create', verifyShopifyWebhook, async (req, res) => {
    res.status(200).json({ received: true });

    try {
        const refund = req.body;
        const orderId = refund.order_id?.toString() || '';
        console.log(`🔄 Zoho webhook: refund created for order #${orderId}`);

        // We need the original order data — fetch from the sync log or Shopify
        const syncLog = await require('../database/db').dbAdapter.query(
            'SELECT original_payload FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1',
            [orderId]
        );

        let shopifyOrder = null;
        if (syncLog.length > 0) {
            shopifyOrder = typeof syncLog[0].original_payload === 'string'
                ? JSON.parse(syncLog[0].original_payload)
                : syncLog[0].original_payload;
        }

        if (!shopifyOrder) {
            // Minimal order object from refund data
            shopifyOrder = {
                order_number: orderId,
                id: orderId,
                line_items: (refund.line_items || []).map(li => ({
                    title: li.title || li.name || '',
                    sku: li.sku || '',
                    quantity: li.quantity || 1,
                    price: li.price || '0'
                }))
            };
        }

        await zohoReturnService.handleShopifyRefund(shopifyOrder, refund);
    } catch (err) {
        console.error('❌ Zoho webhook refunds/create error:', err.message);
    }
});

// ============================================================
// CARRIER DELIVERY WEBHOOK — COD reconciliation + RTO
// Called by existing carrier webhook handlers or Delhivery/Shiprocket
// ============================================================

router.post('/carrier/delivery', async (req, res) => {
    res.status(200).json({ received: true });

    try {
        const { order_id, status, carrier, awb, amount, delivery_date } = req.body;

        if (!order_id) {
            console.warn('⚠️ Zoho carrier webhook: missing order_id');
            return;
        }

        console.log(`🚚 Zoho carrier webhook: order #${order_id} status=${status}`);

        if (status === 'delivered') {
            // COD reconciliation
            await zohoCodService.handleCodDelivery(order_id, {
                amount: parseFloat(amount || 0),
                carrier: carrier || 'unknown',
                awb: awb || '',
                deliveryDate: delivery_date || new Date().toISOString().split('T')[0]
            });
        } else if (status === 'rto' || status === 'rto_delivered') {
            // RTO — need original order data
            const syncLog = await require('../database/db').dbAdapter.query(
                'SELECT original_payload FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1',
                [order_id]
            );

            let shopifyOrder = null;
            if (syncLog.length > 0) {
                shopifyOrder = typeof syncLog[0].original_payload === 'string'
                    ? JSON.parse(syncLog[0].original_payload)
                    : syncLog[0].original_payload;
            }

            if (shopifyOrder) {
                await zohoReturnService.handleRTO(shopifyOrder, { carrier, awb });
            } else {
                console.warn(`⚠️ Zoho RTO: no original order data for #${order_id}`);
            }
        }
    } catch (err) {
        console.error('❌ Zoho carrier webhook error:', err.message);
    }
});

// ============================================================
// EXCHANGE INTAKE — actual exchanged products (Delhivery portal / returns server)
// Body: { order_id, original_items: [{title,sku,quantity,price}], exchanged_items: [...] }
// Ensures Zoho reflects the REAL returned/exchanged product, not the original.
// ============================================================

router.post('/exchange', async (req, res) => {
    res.status(200).json({ received: true });

    try {
        const { order_id, original_items, exchanged_items } = req.body || {};
        if (!order_id) {
            console.warn('⚠️ Zoho exchange webhook: missing order_id');
            return;
        }
        console.log(`🔁 Zoho webhook: exchange for order #${order_id}`);

        // Prefer the original Shopify payload from the sync log
        const syncLog = await require('../database/db').dbAdapter.query(
            'SELECT original_payload FROM zoho_sync_log WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1',
            [order_id]
        );

        let shopifyOrder = null;
        if (syncLog.length > 0) {
            shopifyOrder = typeof syncLog[0].original_payload === 'string'
                ? JSON.parse(syncLog[0].original_payload)
                : syncLog[0].original_payload;
        }
        if (!shopifyOrder) {
            shopifyOrder = { order_number: order_id, id: order_id, line_items: original_items || [] };
        }

        await zohoReturnService.handleExchange(
            shopifyOrder,
            original_items || [],
            exchanged_items || []
        );
    } catch (err) {
        console.error('❌ Zoho exchange webhook error:', err.message);
    }
});

// ============================================================
// MANUAL SYNC — trigger sync for a specific order (dashboard)
// ============================================================

router.post('/manual-sync', async (req, res) => {
    try {
        const { order_id } = req.body;
        if (!order_id) {
            return res.status(400).json({ error: 'order_id is required' });
        }

        // Fetch the order from Shopify
        const shopifyService = require('../services/shopifyService');
        const order = await shopifyService.getOrderById(order_id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found in Shopify' });
        }

        const result = await zohoSyncService.syncOrderToZoho(order);
        res.json(result);
    } catch (err) {
        console.error('❌ Zoho manual sync error:', err.message);
        res.status(500).json({ error: 'Manual sync failed', detail: err.message });
    }
});

module.exports = router;
