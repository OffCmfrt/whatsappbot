const express = require('express');
const router = express.Router();
const shopifyService = require('../services/shopifyService');
const abandonedCartService = require('../services/abandonedCartService');

/**
 * Shiprocket Checkout Webhook Routes
 *
 * OffComfrt uses Shiprocket Checkout (SR Checkout / Fastrr) as the checkout page.
 * Shopify's native checkout webhooks are therefore never triggered.
 * These routes receive events directly from Shiprocket Checkout.
 *
 * Configure in Shiprocket Dashboard → Solutions → Checkout → Webhooks:
 *   • Abandon Cart   → POST /webhooks/shiprocket/abandoned-cart
 *   • Order Placed   → POST /webhooks/shiprocket/order-created  (optional redundancy)
 *
 * NOTE: The existing Shopify `orders/create` webhook (in shopifyWebhookRoutes.js)
 * still handles cart recovery — Shiprocket creates an order in Shopify on payment
 * success, which fires that webhook. This route is an additional fallback.
 */

// ── Optional: Lightweight signature check ──────────────────────────────────────
// Shiprocket may send X-Shiprocket-Hmac-Sha256 if configured in their dashboard.
// If SHIPROCKET_WEBHOOK_SECRET is not set, we skip verification (safe for now).
const verifyShiprocketSignature = (req, res, next) => {
    const secret = process.env.SHIPROCKET_CHECKOUT_WEBHOOK_SECRET;
    if (!secret) {
        // No secret configured — pass through (log a warning in production)
        console.log('[Shiprocket Webhook] ⚠️  No SHIPROCKET_CHECKOUT_WEBHOOK_SECRET set — skipping signature check');
        return next();
    }

    const hmacHeader =
        req.headers['x-shiprocket-hmac-sha256'] ||
        req.headers['x-signature'] ||
        req.headers['x-webhook-signature'];

    if (!hmacHeader) {
        console.warn('[Shiprocket Webhook] ⚠️  HMAC header missing — rejecting request');
        return res.status(401).send('Missing signature header');
    }

    const crypto = require('crypto');
    const rawBody = JSON.stringify(req.body); // body is already parsed JSON here
    const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

    if (digest !== hmacHeader) {
        console.warn('[Shiprocket Webhook] ⚠️  Signature mismatch — rejecting request');
        return res.status(401).send('Invalid signature');
    }

    next();
};

// ── POST /webhooks/shiprocket/abandoned-cart ──────────────────────────────────
// Fired by Shiprocket Checkout when a customer abandons the checkout.
router.post('/abandoned-cart', verifyShiprocketSignature, async (req, res) => {
    try {
        const payload = req.body;
        console.log('[Shiprocket Webhook] 🛒 Abandoned cart received. Keys:', Object.keys(payload));

        // Extract using Shiprocket-specific field mapping
        const data = shopifyService.extractShiprocketCheckoutData(payload);

        if (!data) {
            console.warn('[Shiprocket Webhook] ⚠️  Could not extract checkout data — payload may be empty or malformed');
            // Always return 200 to Shiprocket so it doesn't retry indefinitely
            return res.status(200).send('OK');
        }

        if (!data.customer_phone) {
            console.log('[Shiprocket Webhook] ⚠️  No phone number in payload — skipping (customer may not have entered phone yet)');
            return res.status(200).send('OK');
        }

        // Reuse the exact same service method as Shopify — it's platform-agnostic
        await abandonedCartService.processAbandonedCheckout(data);

        console.log(`[Shiprocket Webhook] ✅ Abandoned cart processed for ${data.customer_phone}`);
        res.status(200).send('OK');
    } catch (error) {
        console.error('[Shiprocket Webhook] ❌ Error processing abandoned cart:', error);
        // Return 200 anyway to prevent Shiprocket from retrying on our server errors
        res.status(200).send('OK');
    }
});

// ── POST /webhooks/shiprocket/order-created ───────────────────────────────────
// Optional: Fired by Shiprocket Checkout when a customer completes payment.
// This marks the abandoned cart as recovered in case the Shopify orders/create
// webhook hasn't fired yet or if the Shiprocket order isn't linked to Shopify.
router.post('/order-created', verifyShiprocketSignature, async (req, res) => {
    try {
        const payload = req.body;
        console.log('[Shiprocket Webhook] 📦 Order created received. Keys:', Object.keys(payload));

        // Normalize to the shape handleOrderCreated() understands (it reads phone
        // from several fallback fields, so just pass through with field aliasing)
        const normalizedPayload = {
            // ID fields
            checkout_id: payload.checkout_id || payload.id,
            cart_token:  payload.cart_token || payload.checkout_id,
            order_number: payload.order_id || payload.channel_order_id || payload.order_number,
            name: payload.order_id || payload.channel_order_id || payload.order_number,

            // Phone (handleOrderCreated does its own robust extraction)
            phone: payload.phone || payload.mobile || payload.contact_number,

            // Customer object
            customer: {
                phone:      payload.customer?.phone || payload.customer?.mobile || payload.customer?.customer_phone,
                first_name: payload.customer?.first_name || payload.billing_address?.first_name || '',
                last_name:  payload.customer?.last_name  || payload.billing_address?.last_name  || ''
            },

            // Billing address
            billing_address: {
                phone: payload.billing_address?.phone || payload.billing_address?.billing_phone || payload.billing_address?.mobile,
                name:  payload.billing_address?.name  || `${payload.billing_address?.first_name || ''} ${payload.billing_address?.last_name || ''}`.trim()
            },

            // Shipping address
            shipping_address: {
                phone: payload.shipping_address?.phone || payload.shipping_address?.mobile,
                name:  payload.shipping_address?.name
            }
        };

        await abandonedCartService.handleOrderCreated(normalizedPayload);

        console.log(`[Shiprocket Webhook] ✅ Order created processed`);
        res.status(200).send('OK');
    } catch (error) {
        console.error('[Shiprocket Webhook] ❌ Error processing order created:', error);
        res.status(200).send('OK');
    }
});

module.exports = router;
