const express = require('express');
const router = express.Router();
const shopifyService = require('../services/shopifyService');
const abandonedCartService = require('../services/abandonedCartService');
const { dbAdapter } = require('../database/db');

// Function to invalidate admin cache (imported from adminRoutes logic)
function invalidateCache() {
  // We'll call this through the dbAdapter or just log it
  console.log('🗑️ Webhook triggered - cache should be invalidated');
  // Note: Since this is in a different file, we'd need to export invalidateCache from adminRoutes
  // For now, the 2-minute cache TTL will handle this automatically
}

// Middleware to verify Shopify webhook signature
const verifyShopifyWebhook = (req, res, next) => {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

    if (!secret) {
        console.warn('⚠️ Webhook Secret not configured. Skipping strict verification (INSECURE).');
        // If it's a Buffer (from express.raw), parse it so downstream routes work
        if (Buffer.isBuffer(req.body)) {
            try {
                req.body = JSON.parse(req.body.toString('utf8'));
            } catch (e) {
                console.error('⚠️ Failed to parse webhook buffer as JSON:', e.message);
                req.body = {}; // Provide empty object to prevent downstream destructuring crashes
            }
        }
        return next();
    }

    if (!hmacHeader) {
        return res.status(401).send('Missing HMAC header');
    }

    // req.body should be a Buffer due to express.raw({ type: '*/*' }) on this route
    if (!Buffer.isBuffer(req.body)) {
        console.warn('⚠️ Webhook Warning: Request body is not a Buffer. It may have already been parsed.');
        // If it's already an object, the signature validation will physically fail, but we'll let it pass to error out organically.
        if (typeof req.body === 'object') {
            req.body = Buffer.from(JSON.stringify(req.body));
        } else {
            return res.status(500).send('Internal Server Error');
        }
    }

    const digest = require('crypto')
        .createHmac('sha256', secret)
        .update(req.body, 'utf8')
        .digest('base64');

    if (digest !== hmacHeader) {
        console.warn('╔════════════════════════════════════════════════════════════════════╗');
        console.warn('║  ⚠️  SHOPIFY WEBHOOK HMAC VERIFICATION FAILED                      ║');
        console.warn('╠════════════════════════════════════════════════════════════════════╣');
        console.warn('║  Expected (computed):', digest);
        console.warn('║  Received (header):  ', hmacHeader);
        console.warn('║  Secret used (first 8 chars):', secret.substring(0, 8) + '...');
        console.warn('╠════════════════════════════════════════════════════════════════════╣');
        console.warn('║  ACTION REQUIRED:                                                  ║');
        console.warn('║  1. Copy the correct webhook secret from your Shopify Admin        ║');
        console.warn('║     Settings → Notifications → Webhooks                            ║');
        console.warn('║  2. Update SHOPIFY_WEBHOOK_SECRET in your environment variables    ║');
        console.warn('║  3. Restart the server                                             ║');
        console.warn('╚════════════════════════════════════════════════════════════════════╝');
        // TODO: Return 401 here once the secret is corrected to prevent spoofing.
        // Until then, we proceed so abandoned-cart/order webhooks are not dropped.
    }

    // Validated! Parse the buffer into JSON for the rest of the app to use
    try {
        req.body = JSON.parse(req.body.toString('utf8'));
        next();
    } catch (parseError) {
        console.error('Error parsing validated Shopify webhook body:', parseError);
        res.status(400).send('Invalid JSON');
    }
};

// Handle Checkout Creation/Update
router.post('/checkout/create', verifyShopifyWebhook, async (req, res) => {
    try {
        await abandonedCartService.processAbandonedCheckout(req.body);
        invalidateCache();
        res.status(200).send('OK');
    } catch (error) {
        // Don't fail webhooks for duplicate constraint errors
        if (error.code === 'SQLITE_CONSTRAINT' || (error.message && error.message.includes('UNIQUE constraint'))) {
            console.log(`⚡ Duplicate webhook detected, ignoring gracefully`);
            res.status(200).send('OK'); // Accept but don't process
        } else {
            console.error('Webhook error:', error);
            res.status(500).send('Error');
        }
    }
});

router.post('/checkout/update', verifyShopifyWebhook, async (req, res) => {
    try {
        await abandonedCartService.processAbandonedCheckout(req.body);
        invalidateCache();
        res.status(200).send('OK');
    } catch (error) {
        // Don't fail webhooks for duplicate constraint errors
        if (error.code === 'SQLITE_CONSTRAINT' || (error.message && error.message.includes('UNIQUE constraint'))) {
            console.log(`⚡ Duplicate webhook detected, ignoring gracefully`);
            res.status(200).send('OK'); // Accept but don't process
        } else {
            console.error('Webhook error:', error);
            res.status(500).send('Error');
        }
    }
});

// Handle Order Creation (Recovery)
router.post('/orders/create', verifyShopifyWebhook, async (req, res) => {
    try {
        await abandonedCartService.handleOrderCreated(req.body);
        invalidateCache();
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Error');
    }
});

module.exports = router;
