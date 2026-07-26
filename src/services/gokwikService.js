const crypto = require('crypto');

/**
 * GoKwik Service
 *
 * OffComfrt uses GoKwik as the checkout partner. GoKwik creates the order in
 * Shopify (so the Shopify orders/create webhook still fires as fallback), and
 * additionally pushes its own webhooks: order placed, abandoned checkout,
 * order confirmed/cancelled, COD-to-prepaid conversion and RTO risk events.
 *
 * NOTE: GoKwik's merchant webhook contract varies per account and their docs
 * are not public. Signature verification and field mapping are therefore built
 * tolerantly (multiple header/field aliases) with TODO markers to tighten once
 * real payloads have been observed in the logs.
 */
class GoKwikService {

    get appId() { return process.env.GOKWIK_APP_ID; }
    get appSecret() { return process.env.GOKWIK_APP_SECRET; }
    // Webhook secret defaults to the app secret unless a dedicated one is provided
    get webhookSecret() { return process.env.GOKWIK_WEBHOOK_SECRET || process.env.GOKWIK_APP_SECRET; }
    get baseUrl() { return process.env.GOKWIK_BASE_URL || 'https://api.gokwik.co'; }
    // Account-specific order-update endpoint (e.g. /v1/orders/update). Outbound
    // sync only fires when this is explicitly configured — GoKwik's merchant API
    // docs aren't public, so we never guess endpoints.
    get orderUpdatePath() { return process.env.GOKWIK_ORDER_UPDATE_PATH; }

    isConfigured() {
        return !!(this.appId && this.appSecret);
    }

    // ── Webhook signature verification ────────────────────────────────────────
    // HMAC-SHA256 of the raw body with the webhook secret. GoKwik's exact header
    // name is unconfirmed, so we check the common aliases. Compared in both hex
    // and base64 encodings.
    // Returns { verified, reason } — caller decides the security posture.
    verifyWebhookSignature(rawBodyBuffer, headers) {
        const secret = this.webhookSecret;
        if (!secret) {
            return { verified: false, reason: 'no_secret_configured' };
        }

        // TODO: Lock this down to the exact header once the first real GoKwik webhook arrives
        const headerAliases = ['x-gokwik-signature', 'x-gk-signature', 'x-hmac-sha256', 'x-signature'];
        let received = null;
        for (const name of headerAliases) {
            if (headers[name]) { received = headers[name].toString().trim(); break; }
        }

        if (!received) {
            return { verified: false, reason: 'no_signature_header' };
        }

        const body = Buffer.isBuffer(rawBodyBuffer) ? rawBodyBuffer : Buffer.from(JSON.stringify(rawBodyBuffer));
        const hmac = crypto.createHmac('sha256', secret).update(body);
        const digestHex = hmac.digest('hex');
        const digestB64 = Buffer.from(digestHex, 'hex').toString('base64');

        // Some providers prefix like "sha256=<sig>"
        const cleaned = received.replace(/^sha256=/i, '');

        if (this._safeCompare(cleaned, digestHex) || this._safeCompare(cleaned, digestB64)) {
            return { verified: true, reason: 'ok' };
        }
        return { verified: false, reason: 'signature_mismatch' };
    }

    _safeCompare(a, b) {
        try {
            const bufA = Buffer.from(a);
            const bufB = Buffer.from(b);
            if (bufA.length !== bufB.length) return false;
            return crypto.timingSafeEqual(bufA, bufB);
        } catch (e) {
            return false;
        }
    }

    // ── Payload normalization ─────────────────────────────────────────────────

    // Detect COD across the field spellings GoKwik is known to use.
    // Includes partial-COD (customer pays part upfront, rest on delivery).
    _isCodPayment(payload) {
        if (payload.is_cod === true || payload.is_cod === 'true' || payload.is_cod === 1) return true;
        const method = (payload.payment_method || payload.payment_mode || payload.payment_type || '').toString().toLowerCase();
        return method.includes('cod') || method.includes('cash on delivery') || method.includes('cash_on_delivery') || method.includes('partial');
    }

    _pickPhone(payload) {
        return payload.phone || payload.mobile || payload.contact_number || payload.customer_phone ||
            payload.customer?.phone || payload.customer?.mobile ||
            payload.billing_address?.phone || payload.shipping_address?.phone || null;
    }

    _normalizeItems(payload) {
        const rawItems = payload.line_items || payload.items || payload.products || [];
        if (!Array.isArray(rawItems)) return [];
        return rawItems.map(item => ({
            title: item.title || item.name || item.product_name || 'Product',
            name: item.name || item.title || item.product_name || 'Product',
            quantity: parseInt(item.quantity || item.qty || 1, 10) || 1,
            price: item.price || item.unit_price || item.amount || 0,
            variant_title: item.variant_title || item.variant || item.variant_name || '',
            size: item.size || undefined,
            sku: item.sku || undefined,
            variant_id: item.variant_id || undefined,
            product_id: item.product_id || undefined,
            image_url: item.image_url || item.image || item.product_image || undefined
        }));
    }

    /**
     * Map a GoKwik "order placed/paid" payload to the Shopify-order shape that
     * abandonedCartService.handleOrderCreated() consumes.
     *
     * Order name preference: shopify_order_name | order_name | merchant_order_id | order_id
     * so GoKwik-ingested orders converge on the same order_id as the Shopify
     * fallback webhook (dedup then happens naturally on order_id).
     */
    normalizeOrder(payload) {
        const orderName = payload.shopify_order_name || payload.order_name ||
            payload.merchant_order_id || payload.moid ||
            (payload.order_id != null ? payload.order_id.toString() : null) ||
            (payload.gokwik_order_id != null ? payload.gokwik_order_id.toString() : null);

        const customer = payload.customer || {};
        const billing = payload.billing_address || payload.billing || {};
        const shipping = payload.shipping_address || payload.shipping || {};

        const isCod = this._isCodPayment(payload);
        // Non-COD keeps the actual method string so the [PAYMENT] log stays informative
        const gateway = isCod
            ? 'cod'
            : (payload.payment_method || payload.payment_mode || payload.payment_type || payload.gateway || 'gokwik');

        const normalized = {
            // ID fields
            checkout_id: payload.checkout_id || payload.checkout_token || payload.cart_id,
            cart_token: payload.cart_token || payload.cart_id,
            name: orderName,
            order_number: orderName,
            gokwik_order_id: (payload.gokwik_order_id || payload.gk_order_id || payload.order_id || '').toString() || undefined,

            // Contact
            phone: this._pickPhone(payload),
            email: payload.email || customer.email || billing.email || shipping.email || '',
            customer: {
                phone: customer.phone || customer.mobile,
                email: customer.email,
                first_name: customer.first_name || customer.firstname || (customer.name ? customer.name.split(' ')[0] : '') || billing.first_name || '',
                last_name: customer.last_name || customer.lastname || (customer.name ? customer.name.split(' ').slice(1).join(' ') : '') || billing.last_name || ''
            },
            billing_address: {
                phone: billing.phone || billing.mobile,
                name: billing.name || `${billing.first_name || ''} ${billing.last_name || ''}`.trim(),
                address1: billing.address1 || billing.address || billing.line1 || '',
                address2: billing.address2 || billing.line2 || '',
                city: billing.city || '',
                province: billing.province || billing.state || '',
                zip: billing.zip || billing.pincode || billing.postal_code || '',
                country: billing.country || 'India'
            },
            shipping_address: {
                phone: shipping.phone || shipping.mobile,
                name: shipping.name || `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
                address1: shipping.address1 || shipping.address || shipping.line1 || '',
                address2: shipping.address2 || shipping.line2 || '',
                city: shipping.city || '',
                province: shipping.province || shipping.state || '',
                zip: shipping.zip || shipping.pincode || shipping.postal_code || '',
                country: shipping.country || 'India'
            },

            // Items + money
            line_items: this._normalizeItems(payload),
            total_price: payload.total_price || payload.total || payload.grand_total || payload.order_amount || payload.amount,

            // Payment → drives existing COD/Prepaid detection in handleOrderCreated
            gateway: gateway,

            // Misc passthroughs used downstream
            order_status_url: payload.order_status_url || payload.status_url || payload.tracking_url,
            shipping_lines: payload.shipping_lines || []
        };

        return normalized;
    }

    /**
     * Map a GoKwik abandoned-cart/checkout payload to the Shopify-checkout shape
     * consumed by shopifyService.extractCheckoutData().
     */
    normalizeAbandonedCart(payload) {
        const customer = payload.customer || {};
        const billing = payload.billing_address || payload.billing || {};
        const shipping = payload.shipping_address || payload.shipping || {};

        return {
            id: payload.checkout_id || payload.cart_id || payload.id || payload.token,
            token: payload.token || payload.checkout_token || payload.cart_token || payload.cart_id,
            cart_token: payload.cart_token || payload.cart_id,
            email: payload.email || customer.email || '',
            phone: this._pickPhone(payload),
            customer: {
                phone: customer.phone || customer.mobile,
                email: customer.email,
                first_name: customer.first_name || customer.firstname || (customer.name ? customer.name.split(' ')[0] : ''),
                last_name: customer.last_name || customer.lastname || ''
            },
            billing_address: {
                phone: billing.phone || billing.mobile,
                name: billing.name || `${billing.first_name || ''} ${billing.last_name || ''}`.trim()
            },
            shipping_address: {
                phone: shipping.phone || shipping.mobile,
                name: shipping.name || `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim()
            },
            line_items: this._normalizeItems(payload),
            total_price: payload.total_price || payload.total || payload.grand_total || payload.cart_value || payload.amount,
            currency: payload.currency || 'INR',
            abandoned_checkout_url: payload.checkout_url || payload.cart_url || payload.abandoned_checkout_url
        };
    }

    // ── Outbound API scaffold ─────────────────────────────────────────────────
    // Generic signed request helper for future GoKwik API polling.
    // No endpoints are called yet — GoKwik's merchant API docs are needed first.
    async request(path, { method = 'GET', body = null } = {}) {
        if (!this.isConfigured()) {
            throw new Error('GoKwik credentials not configured (GOKWIK_APP_ID / GOKWIK_APP_SECRET)');
        }
        const url = `${this.baseUrl}${path}`;
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'app-id': this.appId,
                'app-secret': this.appSecret
            }
        };
        if (body) options.body = JSON.stringify(body);

        const response = await fetch(url, options);
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
        if (!response.ok) {
            console.error(`❌ GoKwik API ${method} ${path} failed (${response.status}):`, text.substring(0, 300));
            const err = new Error(`GoKwik API error ${response.status}`);
            err.status = response.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    // ── Outbound order-update sync ───────────────────────────────────────

    /**
     * Push an admin order edit (items / total / payment method / shipping
     * address) from the Shoppers Hub to GoKwik.
     *
     * Skips (never fails the caller) when credentials or the account-specific
     * GOKWIK_ORDER_UPDATE_PATH are missing — in that case GoKwik still stays
     * consistent via the Shopify order, which is synced separately.
     *
     * Returns { success, skipped, reason }.
     */
    async notifyOrderUpdate(orderId, changes = {}) {
        if (!this.isConfigured()) return { success: false, skipped: true, reason: 'gokwik_not_configured' };
        if (!this.orderUpdatePath) return { success: false, skipped: true, reason: 'GOKWIK_ORDER_UPDATE_PATH not set' };

        const orderName = String(orderId || '').trim();
        const payload = {
            event: 'order_updated',
            source: 'shoppers_hub',
            merchant_order_id: orderName.replace(/^#/, ''),
            shopify_order_name: orderName.startsWith('#') ? orderName : `#${orderName}`,
            updated_at: new Date().toISOString()
        };

        if (Array.isArray(changes.items)) {
            payload.line_items = changes.items.map(item => ({
                title: item.title || item.name || 'Product',
                quantity: parseInt(item.quantity, 10) || 1,
                price: parseFloat(item.price) || 0,
                size: item.size || undefined,
                sku: item.sku || undefined,
                variant_id: item.variant_id || undefined,
                product_id: item.product_id || undefined
            }));
        }
        if (changes.orderTotal !== undefined && changes.orderTotal !== null) {
            payload.total_price = parseFloat(changes.orderTotal) || 0;
        }
        if (changes.paymentMethod) {
            payload.payment_method = changes.paymentMethod;
            payload.is_cod = changes.paymentMethod === 'COD';
        }
        if (changes.shippingAddress) {
            const a = changes.shippingAddress;
            payload.shipping_address = {
                name: a.name || undefined,
                phone: a.phone || undefined,
                address1: a.address1 || a.address || undefined,
                city: a.city || undefined,
                state: a.state || a.province || undefined,
                pincode: a.pincode || a.zip || undefined
            };
        }

        try {
            await this.request(this.orderUpdatePath, { method: 'POST', body: payload });
            console.log(`🔄 GoKwik order update pushed for ${orderName} (${Object.keys(changes).join(', ')})`);
            return { success: true, skipped: false };
        } catch (error) {
            console.error(`⚠️ GoKwik order update failed for ${orderName}:`, error.message);
            return { success: false, skipped: false, reason: error.message };
        }
    }
}

module.exports = new GoKwikService();
