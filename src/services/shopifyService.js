const crypto = require('crypto');
const axios = require('axios');

class ShopifyService {
    // Verify webhook signature
    verifyWebhook(data, hmacHeader) {
        if (!process.env.SHOPIFY_WEBHOOK_SECRET) {
            console.warn('⚠️ SHOPIFY_WEBHOOK_SECRET not set, skipping verification');
            return true; // Skip if not configured (for dev) or return false in prod
        }

        try {
            const digest = crypto
                .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
                .update(data, 'utf8')
                .digest('base64');

            return digest === hmacHeader;
        } catch (error) {
            console.error('Webhook verification error:', error);
            return false;
        }
    }

    // Extract relevant data from checkout payload
    extractCheckoutData(payload) {
        try {
            if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) {
                console.error('Invalid payload format:', typeof payload);
                return null;
            }

            // Shopify checkout/cart payload structure
            const {
                id,
                token,
                cart_token,
                email,
                phone,
                shipping_address,
                billing_address,
                customer,
                line_items,
                total_price,
                currency,
                abandoned_checkout_url
            } = payload;

            if (!id && !token) {
                console.error('Checkout ID and Token are missing from payload. Keys available:', Object.keys(payload));
                return null;
            }

            // 1. Robust Phone Extraction: Check all possible Shopify data locations in order of reliability
            // Priority: Root Phone -> Customer Object Phone -> Billing Phone -> Shipping Phone (Because Pickup omits Shipping)
            let rawPhone =
                phone ||
                customer?.phone ||
                customer?.default_address?.phone ||
                billing_address?.phone ||
                shipping_address?.phone;

            let customerPhone = null;

            // 2. Strict Phone Normalization for WhatsApp API
            if (rawPhone) {
                // Strip all non-numeric characters (like + - ( ) spaces)
                const cleaned = rawPhone.toString().replace(/[^\d]/g, '');

                if (cleaned.length === 10) {
                    // Standard 10-digit Indian number
                    customerPhone = '91' + cleaned;
                } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
                    // Number prefixed with 0 (e.g. 09876543210 -> 919876543210)
                    customerPhone = '91' + cleaned.substring(1);
                } else if (cleaned.length >= 12 && cleaned.startsWith('91')) {
                    // Already includes country code
                    customerPhone = cleaned;
                } else if (cleaned.length > 10) {
                    // Fallback for international codes or unknown lengths
                    customerPhone = cleaned;
                }
            }

            // Customer Name
            const customerName =
                (shipping_address?.first_name ? shipping_address.first_name : '') ||
                (customer?.first_name ? customer.first_name : '') ||
                'Customer';

            return {
                checkout_id: id ? id.toString() : token.toString(),
                cart_token: cart_token || token,
                customer_phone: customerPhone,
                customer_email: email,
                customer_name: customerName,
                total_amount: total_price,
                currency: currency,
                cart_url: abandoned_checkout_url,
                cart_items: (line_items || []).map(item => ({
                    title: item.title,
                    quantity: item.quantity,
                    price: item.price,
                    variant_title: item.variant_title,
                    image_url: item.image_url // Note: Webhook might not always have image_url directly in line_items depending on version
                }))
            };
        } catch (error) {
            console.error('Error extracting checkout data:', error);
            return null;
        }
    }

    // Extract relevant data from Shiprocket Checkout abandoned-cart webhook payload.
    // Shiprocket Checkout (SR Checkout / Fastrr) has a different payload structure
    // from Shopify's native checkout webhook. This maps it to the same shape
    // that abandonedCartService.processAbandonedCheckout() expects.
    extractShiprocketCheckoutData(payload) {
        try {
            if (!payload || typeof payload !== 'object') {
                console.error('[Shiprocket] Invalid payload format:', typeof payload);
                return null;
            }

            // ── Checkout ID ──────────────────────────────────────────────────────────
            // Shiprocket may send: checkout_id | id | order_token | reference_id
            const checkoutId =
                payload.checkout_id ||
                payload.id ||
                payload.order_token ||
                payload.reference_id ||
                payload.token;

            if (!checkoutId) {
                console.error('[Shiprocket] No checkout identifier found. Keys:', Object.keys(payload));
                return null;
            }

            // ── Phone Extraction ─────────────────────────────────────────────────────
            // Shiprocket nests phone in multiple places depending on checkout stage
            const rawPhone =
                payload.phone ||
                payload.customer?.phone ||
                payload.customer?.customer_phone ||
                payload.customer?.mobile ||
                payload.billing_address?.phone ||
                payload.billing_address?.billing_phone ||
                payload.billing_address?.mobile ||
                payload.shipping_address?.phone ||
                payload.shipping_address?.mobile ||
                payload.contact_number ||
                payload.mobile;

            let customerPhone = null;
            if (rawPhone) {
                const cleaned = rawPhone.toString().replace(/[^\d]/g, '');
                if (cleaned.length === 10) {
                    customerPhone = '91' + cleaned;
                } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
                    customerPhone = '91' + cleaned.substring(1);
                } else if (cleaned.length >= 12 && cleaned.startsWith('91')) {
                    customerPhone = cleaned;
                } else if (cleaned.length > 10) {
                    customerPhone = cleaned; // international fallback
                }
            }

            // ── Customer Name ────────────────────────────────────────────────────────
            const firstName =
                payload.customer?.first_name ||
                payload.billing_address?.first_name ||
                payload.shipping_address?.first_name ||
                payload.customer?.name ||
                '';
            const lastName =
                payload.customer?.last_name ||
                payload.billing_address?.last_name ||
                payload.shipping_address?.last_name ||
                '';
            const customerName = `${firstName} ${lastName}`.trim() || 'Customer';

            // ── Email ────────────────────────────────────────────────────────────────
            const email =
                payload.email ||
                payload.customer?.email ||
                payload.billing_address?.email;

            // ── Cart Items ───────────────────────────────────────────────────────────
            // Shiprocket may use cart_details.items | line_items | items | products
            const rawItems =
                payload.cart_details?.items ||
                payload.line_items ||
                payload.items ||
                payload.products ||
                [];

            const cartItems = rawItems.map(item => ({
                title: item.product_name || item.name || item.title || 'Product',
                quantity: item.quantity || 1,
                price: item.price || item.selling_price || item.unit_price || 0,
                variant_title: item.variant_title || item.variant || '',
                image_url: item.image_url || item.image || ''
            }));

            // ── Total Amount ─────────────────────────────────────────────────────────
            const totalAmount =
                payload.cart_details?.total_amount ||
                payload.total_price ||
                payload.total_amount ||
                payload.grand_total ||
                0;

            // ── Cart / Checkout URL ──────────────────────────────────────────────────
            const cartUrl =
                payload.checkout_url ||
                payload.abandoned_checkout_url ||
                payload.cart_url ||
                payload.recovery_url;

            return {
                checkout_id: checkoutId.toString(),
                cart_token: checkoutId.toString(),
                customer_phone: customerPhone,
                customer_email: email,
                customer_name: customerName,
                total_amount: totalAmount,
                currency: payload.currency || payload.cart_details?.currency || 'INR',
                cart_url: cartUrl,
                cart_items: cartItems
            };
        } catch (error) {
            console.error('[Shiprocket] Error extracting checkout data:', error);
            return null;
        }
    }

    /**
     * Get a single order by ID from Shopify API
     * @param {string|number} orderId - The Shopify order ID or order number
     * @returns {object|null} - Order details or null if not found
     */
    async getOrderById(orderId) {
        try {
            const shopUrl = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE;
            const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

            if (!shopUrl || !accessToken) {
                console.error('❌ Shopify credentials not configured');
                return null;
            }

            // Clean shop URL if it contains .myshopify.com
            const cleanShopUrl = shopUrl.replace('.myshopify.com', '');

            // Try to fetch by order ID (numeric) or order number (like 12345)
            let apiUrl;
            if (typeof orderId === 'string' && orderId.startsWith('#')) {
                // Order name (e.g., #12345) - need to search (status=any so closed/archived orders are found too)
                const orderNumber = orderId.replace('#', '');
                apiUrl = `https://${cleanShopUrl}.myshopify.com/admin/api/2024-01/orders.json?name=${orderNumber}&status=any`;
            } else {
                // Direct order ID
                apiUrl = `https://${cleanShopUrl}.myshopify.com/admin/api/2024-01/orders/${orderId}.json`;
            }

            const response = await axios.get(apiUrl, {
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            // If we searched by name, extract first order
            if (typeof orderId === 'string' && orderId.startsWith('#')) {
                return response.data?.orders?.[0] || null;
            }

            return response.data?.order || null;
        } catch (error) {
            if (error.response?.status === 404) {
                console.log(`⚠️ Order ${orderId} not found in Shopify`);
                return null;
            }
            console.error(`❌ Error fetching order ${orderId} from Shopify:`, error.message);
            return null;
        }
    }

    // Fetch the full active product catalog (variants, price, stock) for the admin product picker.
    // Paginated via Link headers and cached in-memory for 10 minutes.
    async getProductCatalog(forceRefresh = false) {
        const CATALOG_TTL = 10 * 60 * 1000;
        if (!forceRefresh && this._catalogCache && (Date.now() - this._catalogCacheAt) < CATALOG_TTL) {
            return this._catalogCache;
        }

        const shopUrl = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE;
        const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

        if (!shopUrl || !accessToken) {
            console.error('❌ Shopify credentials not configured');
            return this._catalogCache || [];
        }

        const cleanShopUrl = shopUrl.replace('.myshopify.com', '');
        const headers = {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
        };

        try {
            const rawProducts = [];
            let apiUrl = `https://${cleanShopUrl}.myshopify.com/admin/api/2024-01/products.json?limit=250&status=active&fields=id,title,handle,image,variants`;

            // Follow Shopify cursor pagination (rel="next" Link header), hard cap for safety
            while (apiUrl && rawProducts.length < 2000) {
                const response = await axios.get(apiUrl, { headers, timeout: 20000 });
                rawProducts.push(...(response.data?.products || []));
                const linkHeader = response.headers?.link || '';
                const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                apiUrl = nextMatch ? nextMatch[1] : null;
            }

            const catalog = rawProducts.map(p => ({
                id: p.id,
                title: p.title,
                image: p.image?.src || null,
                variants: (p.variants || []).map(v => ({
                    id: v.id,
                    title: v.title === 'Default Title' ? '' : (v.title || ''),
                    price: parseFloat(v.price) || 0,
                    compare_at_price: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
                    sku: v.sku || '',
                    inventory: (typeof v.inventory_quantity === 'number') ? v.inventory_quantity : null,
                    available: v.inventory_policy === 'continue' || (v.inventory_quantity || 0) > 0
                }))
            }));

            this._catalogCache = catalog;
            this._catalogCacheAt = Date.now();
            console.log(`✅ Shopify product catalog loaded: ${catalog.length} products`);
            return catalog;
        } catch (error) {
            console.error('❌ Error fetching Shopify product catalog:', error.message);
            // Serve stale cache rather than failing the picker outright
            return this._catalogCache || [];
        }
    }

    // ==========================================
    // ADMIN EDIT → SHOPIFY SYNC
    // Pushes Shoppers Hub order edits (items, payment method, shipping address)
    // back to the Shopify order, so Shopify — and GoKwik, which operates on the
    // Shopify order — always match what the admin sees in the hub.
    // ==========================================

    _restConfig() {
        const shopUrl = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE;
        const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
        if (!shopUrl || !accessToken) return null;
        return {
            base: `https://${shopUrl.replace('.myshopify.com', '')}.myshopify.com/admin/api/2024-01`,
            headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' }
        };
    }

    // store_shoppers.order_id is usually the order NAME ("#1234" or "1234");
    // only long numeric strings are real Shopify order IDs.
    _toLookupId(orderId) {
        const str = String(orderId || '').trim();
        if (/^\d{11,}$/.test(str)) return str;
        return '#' + str.replace(/^#/, '');
    }

    async graphql(query, variables = {}) {
        const cfg = this._restConfig();
        if (!cfg) throw new Error('Shopify credentials not configured');
        const response = await axios.post(`${cfg.base}/graphql.json`, { query, variables }, { headers: cfg.headers, timeout: 20000 });
        if (response.data?.errors?.length) {
            throw new Error(response.data.errors.map(e => e.message).join('; '));
        }
        return response.data?.data;
    }

    /**
     * Sync admin order edits (line items and/or payment method) to Shopify.
     * Best-effort: never throws — returns { success, actions, warnings }.
     */
    async syncOrderEdits(orderId, { items = null, paymentMethod = null } = {}) {
        const result = { success: false, actions: [], warnings: [] };
        const cfg = this._restConfig();
        if (!cfg) {
            result.warnings.push('Shopify credentials not configured');
            return result;
        }

        try {
            const order = await this.getOrderById(this._toLookupId(orderId));
            if (!order) {
                result.warnings.push(`Order ${orderId} not found in Shopify`);
                return result;
            }

            // --- Line items (Shopify Order Editing API) ---
            if (Array.isArray(items) && items.length > 0) {
                if (order.cancelled_at) {
                    result.warnings.push('Order is cancelled in Shopify — line items not synced');
                } else if (order.fulfillment_status === 'fulfilled') {
                    result.warnings.push('Order already fulfilled in Shopify — line items not synced');
                } else if (!this._supportsLineItemEditing(order)) {
                    // Orders created by a third-party checkout (e.g. GoKwik) are locked
                    // by Shopify's Order Editing API — orderEditBegin returns
                    // "The order cannot be edited" regardless of scope/token. Skip cleanly.
                    result.warnings.push('Line items can\'t be synced to Shopify for this order (created via third-party checkout like GoKwik) — edit line items in GoKwik instead');
                } else {
                    try {
                        const itemActions = await this._syncLineItems(order, items, result.warnings);
                        result.actions.push(...itemActions);
                    } catch (err) {
                        const msg = /cannot be edited/i.test(err.message)
                            ? 'Shopify does not allow editing this order\'s line items (third-party checkout / non-editable order) — edit in GoKwik instead'
                            : err.message;
                        result.warnings.push(`Line item sync failed: ${msg}`);
                    }
                }
            }

            // --- Payment method (COD ⇄ Prepaid) ---
            if (paymentMethod === 'Prepaid' || paymentMethod === 'COD') {
                await this._syncPaymentMethod(cfg, order, paymentMethod, result);
            }

            result.success = result.actions.length > 0 || result.warnings.length === 0;
            const summary = result.actions.length ? result.actions.join(' | ') : 'no changes needed';
            console.log(`🔄 Shopify sync for ${orderId}: ${summary}${result.warnings.length ? ` | ⚠️ ${result.warnings.join(' | ')}` : ''}`);
            return result;
        } catch (error) {
            console.error(`❌ Shopify order sync error for ${orderId}:`, error.message);
            result.warnings.push(error.message);
            return result;
        }
    }

    // Shopify's Order Editing API (orderEditBegin) only works on orders whose
    // sales channel supports editing (online store, draft orders, POS, mobile).
    // Orders created by third-party one-page checkouts like GoKwik are attributed
    // to that app as the source and Shopify blocks editing them, returning
    // "The order cannot be edited". Detect those up front so we skip cleanly.
    _supportsLineItemEditing(order) {
        if (!order) return false;
        const tags = (order.tags || '').toLowerCase();
        if (tags.includes('gokwik')) return false;
        const source = String(order.source_name || '').trim();
        // Known editable, first-party sources.
        const editableSources = new Set(['web', 'pos', 'shopify_draft_order', 'iphone', 'android', 'shopify']);
        if (editableSources.has(source.toLowerCase())) return true;
        // A purely numeric source_name is a third-party app/channel id (e.g. GoKwik)
        // whose orders are not editable via the Order Editing API.
        if (/^\d+$/.test(source)) return false;
        // Unknown source: allow the attempt (the try/catch will surface any error).
        return true;
    }

    // Diff the hub's edited items against the Shopify order and apply via the
    // GraphQL Order Editing API (begin → setQuantity/addVariant/addCustomItem → commit).
    async _syncLineItems(order, desiredItems, warnings) {
        const actions = [];
        const norm = s => (s || '').toString().trim().toLowerCase();

        const begin = await this.graphql(`
            mutation orderEditBegin($id: ID!) {
                orderEditBegin(id: $id) {
                    calculatedOrder {
                        id
                        lineItems(first: 100) {
                            edges { node { id quantity title variant { legacyResourceId } } }
                        }
                    }
                    userErrors { field message }
                }
            }`, { id: order.admin_graphql_api_id });

        const beginErrors = begin?.orderEditBegin?.userErrors || [];
        if (beginErrors.length) throw new Error(beginErrors.map(e => e.message).join('; '));
        const calc = begin?.orderEditBegin?.calculatedOrder;
        if (!calc) throw new Error('Could not start Shopify order edit session');

        const existingLines = (calc.lineItems?.edges || []).map(e => e.node);
        const matchedLineIds = new Set();
        let changed = false;

        // Original REST line items — used to detect hub price changes on existing lines
        const restLineByVariant = new Map();
        const restLineByTitle = new Map();
        (order.line_items || []).forEach(li => {
            if (li.variant_id) restLineByVariant.set(String(li.variant_id), li);
            restLineByTitle.set(norm(li.title || li.name), li);
        });

        for (const item of desiredItems) {
            const qty = Math.max(1, parseInt(item.quantity) || 1);
            const hubPrice = parseFloat(item.price) || 0;

            // Match existing order line: by variant first, then by title
            let line = item.variant_id
                ? existingLines.find(l => !matchedLineIds.has(l.id) && String(l.variant?.legacyResourceId) === String(item.variant_id))
                : null;
            let swapped = false;
            if (!line) {
                const titleLine = existingLines.find(l => !matchedLineIds.has(l.id) && norm(l.title) === norm(item.title));
                if (titleLine && item.variant_id && titleLine.variant?.legacyResourceId
                    && String(titleLine.variant.legacyResourceId) !== String(item.variant_id)) {
                    // Size/variant swap on the same product — remove the old
                    // variant line so the new one gets added below
                    matchedLineIds.add(titleLine.id);
                    if (titleLine.quantity > 0) await this._orderEditSetQuantity(calc.id, titleLine.id, 0);
                    swapped = true;
                    changed = true;
                } else {
                    line = titleLine;
                }
            }

            if (line) {
                matchedLineIds.add(line.id);
                const restLine = (item.variant_id && restLineByVariant.get(String(item.variant_id))) || restLineByTitle.get(norm(line.title));
                const currentPrice = restLine ? parseFloat(restLine.price) : null;
                if (currentPrice !== null && Math.abs(currentPrice - hubPrice) > 0.01) {
                    warnings.push(`"${item.title}": Shopify keeps the original unit price ₹${currentPrice} (hub price ₹${hubPrice}) — existing line prices can't be edited on Shopify orders`);
                }
                if (line.quantity !== qty) {
                    await this._orderEditSetQuantity(calc.id, line.id, qty);
                    actions.push(`"${item.title}" qty ${line.quantity} → ${qty}`);
                    changed = true;
                }
            } else if (item.variant_id) {
                await this._orderEditAddVariant(calc.id, item, qty, hubPrice, warnings, actions);
                if (swapped) actions.push(`"${item.title}": size/variant swapped on Shopify order`);
                changed = true;
            } else {
                // Free-typed (non-catalog) item — added at the hub price
                await this._orderEditAddCustomItem(calc.id, item.title, hubPrice, qty, order.currency || 'INR');
                actions.push(`Added custom item "${item.title}" ×${qty}`);
                changed = true;
            }
        }

        // Lines the admin removed in the hub → zero them out (restocks inventory)
        for (const line of existingLines) {
            if (!matchedLineIds.has(line.id) && line.quantity > 0) {
                await this._orderEditSetQuantity(calc.id, line.id, 0);
                actions.push(`Removed "${line.title}"`);
                changed = true;
            }
        }

        // Nothing changed — abandon the edit session (Shopify discards uncommitted edits)
        if (!changed) return actions;

        const commit = await this.graphql(`
            mutation orderEditCommit($id: ID!, $staffNote: String) {
                orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
                    order { id }
                    userErrors { field message }
                }
            }`, { id: calc.id, staffNote: 'Edited from Shoppers Hub' });
        const commitErrors = commit?.orderEditCommit?.userErrors || [];
        if (commitErrors.length) throw new Error(`Commit failed: ${commitErrors.map(e => e.message).join('; ')}`);
        return actions;
    }

    async _orderEditSetQuantity(calcOrderId, lineItemId, quantity) {
        const data = await this.graphql(`
            mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
                orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: true) {
                    userErrors { field message }
                }
            }`, { id: calcOrderId, lineItemId, quantity });
        const errs = data?.orderEditSetQuantity?.userErrors || [];
        if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
    }

    async _orderEditAddVariant(calcOrderId, item, quantity, hubPrice, warnings, actions) {
        const data = await this.graphql(`
            mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
                orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
                    calculatedLineItem { id originalUnitPriceSet { shopMoney { amount } } }
                    userErrors { field message }
                }
            }`, { id: calcOrderId, variantId: `gid://shopify/ProductVariant/${item.variant_id}`, quantity });
        const payload = data?.orderEditAddVariant;
        const errs = payload?.userErrors || [];
        if (errs.length) throw new Error(`Add "${item.title}" failed: ${errs.map(e => e.message).join('; ')}`);
        actions.push(`Added "${item.title}" ×${quantity}`);

        // Honor a hub price below catalog via a line discount; Shopify can't price above catalog
        const catalogPrice = parseFloat(payload?.calculatedLineItem?.originalUnitPriceSet?.shopMoney?.amount);
        if (!isNaN(catalogPrice) && hubPrice > 0 && catalogPrice > 0 && Math.abs(catalogPrice - hubPrice) > 0.01) {
            if (hubPrice < catalogPrice) {
                const percent = Math.round(((catalogPrice - hubPrice) / catalogPrice) * 10000) / 100;
                const disc = await this.graphql(`
                    mutation orderEditAddLineItemDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
                        orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
                            userErrors { field message }
                        }
                    }`, {
                    id: calcOrderId,
                    lineItemId: payload.calculatedLineItem.id,
                    discount: { percentValue: percent, description: 'Shoppers Hub price adjustment' }
                });
                const derrs = disc?.orderEditAddLineItemDiscount?.userErrors || [];
                if (derrs.length) warnings.push(`"${item.title}": discount to hub price ₹${hubPrice} failed — ${derrs.map(e => e.message).join('; ')}`);
                else actions.push(`"${item.title}" discounted to ₹${hubPrice}`);
            } else {
                warnings.push(`"${item.title}": hub price ₹${hubPrice} is above the catalog price ₹${catalogPrice} — Shopify keeps ₹${catalogPrice}`);
            }
        }
    }

    async _orderEditAddCustomItem(calcOrderId, title, price, quantity, currency) {
        const data = await this.graphql(`
            mutation orderEditAddCustomItem($id: ID!, $title: String!, $price: MoneyInput!, $quantity: Int!) {
                orderEditAddCustomItem(id: $id, title: $title, price: $price, quantity: $quantity) {
                    userErrors { field message }
                }
            }`, { id: calcOrderId, title, price: { amount: String(price), currencyCode: currency }, quantity });
        const errs = data?.orderEditAddCustomItem?.userErrors || [];
        if (errs.length) throw new Error(`Add custom "${title}" failed: ${errs.map(e => e.message).join('; ')}`);
    }

    // COD → Prepaid: mark the Shopify order as paid; either way, tag the order
    // so the conversion is visible in Shopify (and to GoKwik reporting).
    async _syncPaymentMethod(cfg, order, paymentMethod, result) {
        const gateways = ((order.payment_gateway_names || []).join(',') + ',' + (order.gateway || '')).toLowerCase();
        const isCodInShopify = gateways.includes('cash on delivery') || gateways.includes('cod');
        const isPendingPayment = ['pending', 'authorized', 'partially_paid'].includes(order.financial_status);

        if (paymentMethod === 'Prepaid' && isPendingPayment) {
            try {
                await axios.post(`${cfg.base}/orders/${order.id}/transactions.json`,
                    { transaction: { kind: 'capture' } },
                    { headers: cfg.headers, timeout: 15000 });
                result.actions.push('Marked as paid in Shopify (COD → Prepaid)');
            } catch (captureErr) {
                // No authorization to capture (typical for COD/manual) — record an external sale
                try {
                    await axios.post(`${cfg.base}/orders/${order.id}/transactions.json`,
                        { transaction: { kind: 'sale', source: 'external', gateway: 'manual', amount: order.total_price } },
                        { headers: cfg.headers, timeout: 15000 });
                    result.actions.push('Marked as paid in Shopify (COD → Prepaid)');
                } catch (saleErr) {
                    const detail = saleErr.response?.data?.errors ? JSON.stringify(saleErr.response.data.errors) : saleErr.message;
                    result.warnings.push(`Could not mark order paid in Shopify: ${detail}`);
                }
            }
        } else if (paymentMethod === 'COD' && order.financial_status === 'paid' && !isCodInShopify) {
            result.warnings.push('Order is already PAID in Shopify — cannot convert back to COD there (hub updated only)');
        }

        try {
            const tags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            const tag = paymentMethod === 'Prepaid' ? 'converted-to-prepaid' : 'converted-to-cod';
            if (!tags.includes(tag)) {
                tags.push(tag);
                await axios.put(`${cfg.base}/orders/${order.id}.json`,
                    { order: { id: order.id, tags: tags.join(', ') } },
                    { headers: cfg.headers, timeout: 15000 });
                result.actions.push(`Tagged order "${tag}"`);
            }
        } catch (tagErr) {
            result.warnings.push(`Could not tag order in Shopify: ${tagErr.message}`);
        }
    }

    /**
     * Fetch the current shipping address of a Shopify order (normalized).
     * Returns null when the order or its shipping address is missing.
     */
    async getShippingAddress(orderId) {
        const order = await this.getOrderById(this._toLookupId(orderId));
        const a = order?.shipping_address || order?.customer?.default_address;
        if (!a) return null;
        return {
            name: a.name || `${a.first_name || ''} ${a.last_name || ''}`.trim(),
            phone: a.phone || '',
            address1: a.address1 || '',
            address2: a.address2 || '',
            city: a.city || '',
            province: a.province || '',
            zip: a.zip || '',
            country: a.country || ''
        };
    }

    /**
     * Mirror consignee edits made in the Ship modal to the Shopify order's
     * shipping address. Best-effort: never throws.
     */
    async updateShippingAddress(orderId, addr = {}) {
        const result = { success: false, warnings: [] };
        const cfg = this._restConfig();
        if (!cfg) {
            result.warnings.push('Shopify credentials not configured');
            return result;
        }

        try {
            const order = await this.getOrderById(this._toLookupId(orderId));
            if (!order) {
                result.warnings.push(`Order ${orderId} not found in Shopify`);
                return result;
            }

            const shipping = { ...(order.shipping_address || {}) };
            if (addr.name) {
                const parts = addr.name.trim().split(/\s+/);
                shipping.first_name = parts.shift();
                shipping.last_name = parts.join(' ') || shipping.last_name || '';
                shipping.name = addr.name.trim();
            }
            if (addr.phone) shipping.phone = addr.phone;
            if (addr.address1) shipping.address1 = addr.address1;
            if (addr.city) shipping.city = addr.city;
            if (addr.state) shipping.province = addr.state;
            if (addr.pincode) shipping.zip = addr.pincode;

            await axios.put(`${cfg.base}/orders/${order.id}.json`,
                { order: { id: order.id, shipping_address: shipping } },
                { headers: cfg.headers, timeout: 15000 });
            result.success = true;
            return result;
        } catch (error) {
            const detail = error.response?.data?.errors ? JSON.stringify(error.response.data.errors) : error.message;
            result.warnings.push(detail);
            return result;
        }
    }

    // ==========================================
    // DIRECT-CARRIER FULFILLMENT → SHOPIFY
    // Shiprocket/Delhivery ship under the Shopify channel, so fulfillments and
    // tracking land back in Shopify automatically. Direct carriers (Ekart)
    // have no such link — this posts the fulfillment + AWB to the Shopify
    // order so it shows as fulfilled with tracking, like any channel order.
    // Best-effort: never throws — returns { success, action, warning }.
    // ==========================================
    async syncFulfillment(orderId, { awb, courierName = null, trackingUrl = null, notifyCustomer = true } = {}) {
        const result = { success: false, action: null, warning: null };
        const cfg = this._restConfig();
        if (!cfg) {
            result.warning = 'Shopify credentials not configured';
            return result;
        }
        if (!awb) {
            result.warning = 'No AWB to sync';
            return result;
        }

        try {
            const order = await this.getOrderById(this._toLookupId(orderId));
            if (!order) {
                result.warning = `Order ${orderId} not found in Shopify`;
                return result;
            }

            const trackingCompany = (courierName || 'Ekart').replace(/\s*\(.*\)$/, '').trim() || 'Ekart';

            // Re-ship: an existing fulfillment may carry the old AWB — update
            // its tracking instead of creating a duplicate fulfillment
            const fulfillments = await axios.get(`${cfg.base}/orders/${order.id}/fulfillments.json`, {
                headers: cfg.headers, timeout: 15000
            });
            const active = (fulfillments.data?.fulfillments || []).find(f =>
                !['cancelled', 'failure'].includes(f.status)
            );

            if (active) {
                if ((active.tracking_numbers || []).includes(awb)) {
                    result.success = true;
                    result.action = `Fulfillment ${active.id} already tracks AWB ${awb}`;
                    return result;
                }
                await axios.put(`${cfg.base}/orders/${order.id}/fulfillments/${active.id}/tracking.json`,
                    { tracking: { number: awb, company: trackingCompany, url: trackingUrl || undefined, notify_customer: false } },
                    { headers: cfg.headers, timeout: 15000 });
                result.success = true;
                result.action = `Updated Shopify fulfillment ${active.id} tracking to AWB ${awb}`;
                return result;
            }

            // Fulfill every line item on the order. Shopify routes newer
            // orders through FulfillmentOrders — the legacy endpoint below
            // then answers 406, so fall back to the FulfillmentOrders flow.
            const lineItems = (order.line_items || []).map(li => ({ id: li.id, quantity: li.quantity }));
            try {
                await axios.post(`${cfg.base}/orders/${order.id}/fulfillments.json`, {
                    fulfillment: {
                        tracking_number: awb,
                        tracking_company: trackingCompany,
                        tracking_urls: trackingUrl ? [trackingUrl] : [],
                        notify_customer: Boolean(notifyCustomer),
                        ...(lineItems.length ? { line_items: lineItems } : {})
                    }
                }, { headers: cfg.headers, timeout: 20000 });
            } catch (legacyError) {
                if (legacyError.response?.status !== 406) throw legacyError;
                await this._fulfillViaFulfillmentOrders(cfg, order, {
                    awb, trackingCompany, trackingUrl, notifyCustomer, result
                });
                if (!result.success) return result;
            }

            result.success = true;
            result.action = result.action || `Marked Shopify order ${order.name || order.id} fulfilled with AWB ${awb}`;
            return result;
        } catch (error) {
            const detail = error.response?.data?.errors ? JSON.stringify(error.response.data.errors) : error.message;
            console.error(`❌ Shopify fulfillment sync failed for ${orderId}:`, detail);
            result.warning = detail;
            return result;
        }
    }

    // FulfillmentOrders flow — required when the legacy create answers 406.
    // Lists the order's open fulfillment orders and fulfils them in one go.
    // Needs the merchant-managed fulfillment-order scopes on the API token;
    // a 403 here means they must be added to the custom app configuration.
    async _fulfillViaFulfillmentOrders(cfg, order, { awb, trackingCompany, trackingUrl, notifyCustomer, result }) {
        let fulfillmentOrders;
        try {
            const foRes = await axios.get(`${cfg.base}/orders/${order.id}/fulfillment_orders.json`, {
                headers: cfg.headers, timeout: 15000
            });
            fulfillmentOrders = foRes.data?.fulfillment_orders || [];
        } catch (error) {
            if (error.response?.status === 403) {
                result.warning = 'Shopify requires the FulfillmentOrders API for this order — add the ' +
                    'read/write "merchant managed fulfillment orders" scopes to the custom app ' +
                    '(Settings → Apps and sales channels → Develop apps → API access scopes), ' +
                    'regenerate the Admin API token and update SHOPIFY_ACCESS_TOKEN.';
            } else {
                result.warning = `FulfillmentOrders lookup failed (${error.response?.status || error.message})`;
            }
            return;
        }

        const open = fulfillmentOrders.filter(fo => ['open', 'in_progress', 'scheduled'].includes(fo.status));
        if (open.length === 0) {
            result.warning = `Order ${order.name || order.id} has no open fulfillment orders at Shopify`;
            return;
        }

        await axios.post(`${cfg.base}/fulfillments.json`, {
            fulfillment: {
                line_items_by_fulfillment_order: open.map(fo => ({ fulfillment_order_id: fo.id })),
                tracking_info: {
                    number: awb,
                    company: trackingCompany,
                    ...(trackingUrl ? { url: trackingUrl } : {})
                },
                notify_customer: Boolean(notifyCustomer)
            }
        }, { headers: cfg.headers, timeout: 20000 });

        result.success = true;
        result.action = `Marked Shopify order ${order.name || order.id} fulfilled with AWB ${awb} (FulfillmentOrders)`;
    }

    // New: Sync all customers from Shopify Admin API
    async syncAllCustomers() {
        try {
            const { dbAdapter } = require('../database/db');
            const shop = process.env.SHOPIFY_STORE;
            const token = process.env.SHOPIFY_ACCESS_TOKEN;

            if (!shop || !token) {
                console.error('❌ Shopify credentials missing (SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN)');
                throw new Error('Shopify credentials missing');
            }

            console.log(`🔄 Syncing Shopify customers from ${shop}...`);
            
            let customersCount = 0;
            let nextUrl = `https://${shop}/admin/api/2024-01/customers.json?limit=250`;

            while (nextUrl) {
                const response = await axios.get(nextUrl, {
                    headers: { 'X-Shopify-Access-Token': token }
                });

                const customers = response.data.customers || [];
                if (customers.length === 0) break;

                for (const customer of customers) {
                    let rawPhone = customer.phone || customer.default_address?.phone;
                    if (!rawPhone) continue;

                    // Standardize phone (Shopify Source)
                    const cleaned = rawPhone.toString().replace(/\D/g, '');
                    if (!cleaned || cleaned.length < 10) continue;
                    
                    let phone = cleaned;
                    if (cleaned.length === 10) {
                        phone = '91' + cleaned;
                    } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
                        phone = '91' + cleaned.substring(1);
                    } else if (cleaned.length > 10) {
                        // Ensure it ends with 10 digits and has 91 prefix
                        phone = cleaned.slice(-10).padStart(12, '91');
                    }

                    const firstName = customer.first_name || customer.default_address?.first_name || '';
                    const lastName = customer.last_name || customer.default_address?.last_name || '';
                    let name = `${firstName} ${lastName}`.trim();
                    
                    // Final fallback to address name or "Customer"
                    if (!name) {
                        name = customer.default_address?.name || 
                               (customer.addresses && customer.addresses[0]?.name) || 
                               'Customer';
                    }
                    const email = customer.email;
                    const createdAt = customer.created_at;

                    try {
                        // Upsert into Turso
                        const orderCount = customer.orders_count || 0;
                        await dbAdapter.query(`
                            INSERT INTO customers (phone, name, email, order_count, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(phone) DO UPDATE SET
                                name = excluded.name,
                                email = excluded.email,
                                order_count = excluded.order_count,
                                updated_at = CURRENT_TIMESTAMP
                        `, [phone, name, email, orderCount, createdAt]);
                        
                        customersCount++;
                    } catch (dbErr) {
                        console.error(`Error saving customer ${phone}:`, dbErr.message);
                    }
                }

                // Handle pagination
                const linkHeader = response.headers['link'];
                nextUrl = null;
                if (linkHeader) {
                    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                    if (nextMatch) nextUrl = nextMatch[1];
                }
            }

            console.log(`✅ Shopify sync complete: ${customersCount} customers processed.`);
            return customersCount;
        } catch (error) {
            console.error('❌ Shopify sync error:', error.response?.data || error.message);
            throw error;
        }
    }
}

module.exports = new ShopifyService();
