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
                // Order name (e.g., #12345) - need to search
                const orderNumber = orderId.replace('#', '');
                apiUrl = `https://${cleanShopUrl}.myshopify.com/admin/api/2024-01/orders.json?name=${orderNumber}`;
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
