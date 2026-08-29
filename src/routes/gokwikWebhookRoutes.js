const express = require('express');
const router = express.Router();
const gokwikService = require('../services/gokwikService');
const abandonedCartService = require('../services/abandonedCartService');
const { dbAdapter } = require('../database/db');

/**
 * GoKwik Webhook Routes
 *
 * OffComfrt uses GoKwik as the checkout partner. GoKwik creates the order in
 * Shopify, so /webhooks/shopify/orders/create still fires as a fallback —
 * these routes are the primary, faster ingestion path plus the events Shopify
 * never sends (order confirmed/cancelled by GoKwik, COD→Prepaid conversion,
 * RTO risk). Dedup is handled downstream: handleOrderCreated updates instead
 * of inserting on an existing order_id, and shopper_confirmations(phone,
 * order_id) guarantees the WhatsApp confirmation goes out exactly once.
 *
 * NOTE: These webhooks only keep existing data in sync — they never change
 * the order `source` field.
 *
 * Register in GoKwik Dashboard (any of these URLs hit the same dispatcher):
 *   • POST /webhooks/gokwik/events          (generic — recommended)
 *   • POST /webhooks/gokwik/order-created
 *   • POST /webhooks/gokwik/abandoned-cart
 *   • POST /webhooks/gokwik/order-status
 *
 * server.js mounts express.raw() on /webhooks/gokwik so HMAC verification
 * runs on the untouched body (same as the Shopify webhook mount).
 */

// ── Signature verification middleware ─────────────────────────────────────────
// Same security posture as the Shiprocket routes: if no secret is configured or
// GoKwik sends no signature header, log a warning and accept — never drop
// orders while the webhook contract is unconfirmed. A present-but-wrong
// signature is rejected.
const verifyGokwikWebhook = (req, res, next) => {
    const rawBody = req.body;

    const finishParse = () => {
        if (Buffer.isBuffer(req.body)) {
            try {
                req.body = JSON.parse(req.body.toString('utf8'));
            } catch (e) {
                console.error('[GoKwik Webhook] ⚠️ Failed to parse body as JSON:', e.message);
                req.body = {};
            }
        }
        next();
    };

    const result = gokwikService.verifyWebhookSignature(rawBody, req.headers);

    if (result.verified) {
        return finishParse();
    }

    if (result.reason === 'no_secret_configured') {
        console.warn('[GoKwik Webhook] ⚠️ No GOKWIK_WEBHOOK_SECRET/GOKWIK_APP_SECRET set — skipping signature check (INSECURE)');
        return finishParse();
    }

    if (result.reason === 'no_signature_header') {
        // TODO: Reject once GoKwik's signature header name is confirmed from real traffic
        console.warn('[GoKwik Webhook] ⚠️ No signature header present — accepting until GoKwik contract is confirmed. Headers:', Object.keys(req.headers).join(', '));
        return finishParse();
    }

    // signature_mismatch — header was sent but doesn't match
    console.warn('[GoKwik Webhook] ❌ Signature mismatch — rejecting request');
    return res.status(401).send('Invalid signature');
};

// ── Event dispatcher ──────────────────────────────────────────────────────────

function getOrderId(payload) {
    // Same preference order as gokwikService.normalizeOrder so status events
    // land on the same store_shoppers row the order webhook created.
    return payload.shopify_order_name || payload.order_name ||
        payload.merchant_order_id || payload.moid ||
        (payload.order_id != null ? payload.order_id.toString() : null);
}

async function findShopperByOrderId(orderId) {
    if (!orderId) return null;
    const rows = await dbAdapter.query('SELECT id, status, payment_method, order_id FROM store_shoppers WHERE order_id = ?', [orderId]);
    return (rows && rows.length > 0) ? rows[0] : null;
}

async function handleGokwikEvent(payload) {
    const eventRaw = payload.event || payload.event_type || payload.type || payload.event_name || '';
    const event = eventRaw.toString().toLowerCase();
    console.log(`[GoKwik Webhook] 📨 Event "${eventRaw || 'unknown'}". Payload keys:`, Object.keys(payload).join(', '));

    // Some GoKwik payloads nest the actual entity under data/order/checkout
    const data = payload.data || payload.order || payload.checkout || payload;

    // 1. Order created / placed / paid → full ingestion (same path as Shopify)
    if (/order[_\s-]?(create|placed|paid|success|complete)|payment[_\s-]?(success|captured)/.test(event) || (!event && (data.line_items || data.items || data.products))) {
        const normalized = gokwikService.normalizeOrder(data);
        if (!normalized.name) {
            console.warn('[GoKwik Webhook] ⚠️ Order event without an order identifier — skipping. Keys:', Object.keys(data).join(', '));
            return { handled: 'order_created', skipped: true };
        }
        await abandonedCartService.handleOrderCreated(normalized);
        // Backfill gokwik_order_id for cross-referencing (column added by migration)
        if (normalized.gokwik_order_id) {
            try {
                await dbAdapter.query(
                    'UPDATE store_shoppers SET gokwik_order_id = ? WHERE order_id = ? AND (gokwik_order_id IS NULL OR gokwik_order_id = \'\')',
                    [normalized.gokwik_order_id, normalized.name]
                );
            } catch (e) {
                // Column may not exist until migrate_gokwik.js has run — non-critical
                console.warn('[GoKwik Webhook] ℹ️ Could not backfill gokwik_order_id:', e.message);
            }
        }
        return { handled: 'order_created' };
    }

    // 2. Abandoned cart / checkout
    if (/abandon|cart[_\s-]?(drop|left)|checkout[_\s-]?(abandon|drop)/.test(event)) {
        const normalized = gokwikService.normalizeAbandonedCart(data);
        await abandonedCartService.processAbandonedCheckout(normalized);
        return { handled: 'abandoned_cart' };
    }

    const orderId = getOrderId(data);

    // 3. Order confirmed (GoKwik confirmation flows, e.g. IVR/WhatsApp COD confirmation)
    if (/confirm/.test(event)) {
        const shopper = await findShopperByOrderId(orderId);
        if (!shopper) {
            console.warn(`[GoKwik Webhook] ⚠️ Confirm event for unknown order ${orderId}`);
            return { handled: 'order_confirmed', skipped: true };
        }
        // Never override a manual/WhatsApp confirmation or a cancellation
        if (['confirmed', 'cancelled'].includes(shopper.status)) {
            console.log(`[GoKwik Webhook] ℹ️ Order ${orderId} already ${shopper.status} — leaving as-is`);
            return { handled: 'order_confirmed', skipped: true };
        }
        await dbAdapter.update('store_shoppers',
            { status: 'confirmed', confirmed_by: 'gokwik', updated_at: new Date().toISOString() },
            { order_id: orderId });
        console.log(`[GoKwik Webhook] ✅ Order ${orderId} marked confirmed (gokwik)`);
        return { handled: 'order_confirmed' };
    }

    // 4. Order cancelled → cancel any active shipment too
    if (/cancel|reject/.test(event)) {
        const shopper = await findShopperByOrderId(orderId);
        if (!shopper) {
            console.warn(`[GoKwik Webhook] ⚠️ Cancel event for unknown order ${orderId}`);
            return { handled: 'order_cancelled', skipped: true };
        }
        await dbAdapter.update('store_shoppers',
            { status: 'cancelled', cancel_reason: 'AUTO — GoKwik', confirmed_by: 'gokwik', updated_at: new Date().toISOString() },
            { order_id: orderId });
        try {
            const shippingService = require('../services/shippingService');
            const result = await shippingService.cancelActiveShipmentForOrder(orderId);
            if (result.hadShipment) {
                console.log(`[GoKwik Webhook] 🚚 Shipment for ${orderId}: ${result.cancelled ? 'cancelled' : 'cancel FAILED: ' + result.error} (AWB: ${result.awb || 'n/a'})`);
            }
        } catch (e) {
            console.error(`[GoKwik Webhook] ❌ Shipment cancel error for ${orderId}:`, e.message);
        }
        console.log(`[GoKwik Webhook] ✅ Order ${orderId} marked cancelled`);
        return { handled: 'order_cancelled' };
    }

    // 5. Payment update / COD-to-prepaid conversion
    if (/prepaid|payment[_\s-]?(update|convert)|cod[_\s-]?to[_\s-]?prepaid/.test(event)) {
        const shopper = await findShopperByOrderId(orderId);
        if (!shopper) {
            console.warn(`[GoKwik Webhook] ⚠️ Payment event for unknown order ${orderId}`);
            return { handled: 'payment_update', skipped: true };
        }
        await dbAdapter.update('store_shoppers',
            { payment_method: 'Prepaid', updated_at: new Date().toISOString() },
            { order_id: orderId });
        console.log(`[GoKwik Webhook] 💳 Order ${orderId}: ${shopper.payment_method || 'COD'} → Prepaid`);
        return { handled: 'payment_update' };
    }

    // 6. RTO risk score
    if (/rto|risk/.test(event)) {
        const riskRaw = (data.rto_risk || data.risk || data.risk_level || data.risk_flag || data.score_band || '').toString().toLowerCase();
        const risk = ['high', 'medium', 'low'].find(r => riskRaw.includes(r));
        if (!orderId || !risk) {
            console.warn(`[GoKwik Webhook] ⚠️ RTO event missing order/risk (order: ${orderId}, risk: "${riskRaw}")`);
            return { handled: 'rto_risk', skipped: true };
        }
        try {
            await dbAdapter.update('store_shoppers',
                { rto_risk: risk, updated_at: new Date().toISOString() },
                { order_id: orderId });
            console.log(`[GoKwik Webhook] ⚠️ Order ${orderId} RTO risk: ${risk.toUpperCase()}`);
        } catch (e) {
            console.warn('[GoKwik Webhook] ℹ️ Could not save rto_risk (run migrate_gokwik.js?):', e.message);
        }
        return { handled: 'rto_risk' };
    }

    console.log(`[GoKwik Webhook] ❓ Unrecognized event "${eventRaw}" — logged for calibration, no action taken`);
    return { handled: 'none' };
}

// Shared route handler — always 200 (webhook retry etiquette, same as Shiprocket)
// defaultEvent: fallback event hint when the payload itself carries no event
// field (depends on which URL was registered in the GoKwik dashboard).
const dispatch = (defaultEvent = null) => async (req, res) => {
    try {
        const payload = req.body || {};
        if (defaultEvent && !payload.event && !payload.event_type && !payload.type && !payload.event_name) {
            payload.event = defaultEvent;
        }
        const result = await handleGokwikEvent(payload);
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        console.error('[GoKwik Webhook] ❌ Processing error:', error);
        res.status(200).send('OK');
    }
};

// Generic dispatcher (recommended registration URL)
router.post('/events', verifyGokwikWebhook, dispatch());

// Aliases — covers whichever URL style the GoKwik dashboard expects
router.post('/order-created', verifyGokwikWebhook, dispatch('order_created'));
router.post('/abandoned-cart', verifyGokwikWebhook, dispatch('cart_abandoned'));
router.post('/order-status', verifyGokwikWebhook, dispatch());

module.exports = router;
