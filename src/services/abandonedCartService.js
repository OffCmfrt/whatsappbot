const AbandonedCart = require('../models/AbandonedCart');
const Settings = require('../models/Settings');
const shopifyService = require('./shopifyService');
const whatsappService = require('./whatsappService');
const { dbAdapter } = require('../database/db');

class AbandonedCartService {

    // Process incoming checkout webhook
    async processAbandonedCheckout(payload) {
        try {
            const data = shopifyService.extractCheckoutData(payload);

            if (!data || !data.customer_phone) {
                console.log('⚠️ Skipping abandoned cart: No phone number found');
                return;
            }

            // Use the improved create method that handles duplicates
            await AbandonedCart.create(data);

        } catch (error) {
            // Log but don't throw - webhooks should always return 200
            if (error.code === 'SQLITE_CONSTRAINT' || (error.message && error.message.includes('UNIQUE constraint'))) {
                console.log(`⚡ Duplicate checkout ${data?.checkout_id} handled gracefully`);
            } else {
                console.error('Error processing abandoned checkout:', error);
            }
        }
    }

    // Mark cart as recovered (called on Order Create webhook)
    async handleOrderCreated(payload) {
        try {
            const checkoutId = payload.checkout_id?.toString();
            const email = payload.email || payload.customer?.email;

            // Extract phone number robustly from the order payload (Priority: Root -> Customer -> Billing -> Shipping)
            let phone =
                payload.phone ||
                payload.customer?.phone ||
                payload.customer?.default_address?.phone ||
                payload.billing_address?.phone ||
                payload.shipping_address?.phone;

            if (phone) {
                const cleaned = phone.toString().replace(/[^\d]/g, '');
                if (cleaned.length === 10) phone = '91' + cleaned;
                else if (cleaned.length === 11 && cleaned.startsWith('0')) phone = '91' + cleaned.substring(1);
                else phone = cleaned;
            }

            let cart = null;
            let matchStrategy = 'none';

            // Strategy 1: Match by checkout_id
            if (checkoutId) {
                cart = await AbandonedCart.findByCheckoutId(checkoutId);
                if (cart) matchStrategy = 'checkout_id';
            }

            // Strategy 2: Match by Phone Number fallback
            if (!cart && phone) {
                cart = await AbandonedCart.findRecentByPhone(phone, 48);
                if (cart) matchStrategy = 'phone';
            }

            // Strategy 3: Match by Email fallback
            if (!cart && email) {
                cart = await AbandonedCart.findRecentByEmail(email, 48);
                if (cart) matchStrategy = 'email';
            }

            if (cart) {
                await AbandonedCart.updateStatus(cart.checkout_id, 'recovered', {
                    recovered_at: new Date().toISOString()
                });
                console.log(`✅ Cart recovered via ${matchStrategy} (Checkout: ${cart.checkout_id})`);
            } else {
                if (!checkoutId && !phone && !email) {
                    console.log(`ℹ️ Order processed: No unique identifiers found to check for abandoned carts.`);
                } else {
                    console.log(`ℹ️ Order processed: No matching abandoned cart found (Direct order or webhook delay).`);
                }
            }

            // --- NEW: Shopper Automation ---
            if (phone) {
                const customerName = payload.customer?.first_name 
                    ? `${payload.customer.first_name} ${payload.customer.last_name || ''}`.trim()
                    : (payload.billing_address?.name || payload.shipping_address?.name || 'Customer');
                
                const orderId = payload.name || payload.order_number || payload.id?.toString();

                // Extract order amount, product image, and order URL for rich message
                let orderTotal = payload.total_price || payload.total_amount || payload.grand_total;
                if (!orderTotal && cart && cart.total_amount) orderTotal = cart.total_amount;
                
                let productImage = null;
                if (cart && cart.cart_items) {
                    try {
                        const items = typeof cart.cart_items === 'string' ? JSON.parse(cart.cart_items) : cart.cart_items;
                        if (items && items.length > 0 && items[0].image_url) {
                            productImage = items[0].image_url;
                        }
                    } catch(e) {}
                }
                if (!productImage) {
                    const items = payload.line_items || payload.products || payload.items || [];
                    if (items.length > 0) {
                        productImage = items[0].image_url || items[0].image;
                    }
                }

                const orderUrl = payload.order_status_url || payload.status_url || 'https://offcomfrt.in/pages/track-order';

                console.log(`🛍️ New Shopper: ${phone} (${customerName}) - Order: ${orderId}`);

                // Extract more shopper details for the Super Card
                const email = payload.email || payload.customer?.email || '';
                const shipping = payload.shipping_address || payload.billing_address || {};
                const address = `${shipping.address1 || ''} ${shipping.address2 || ''}`.trim();
                const city = shipping.city || '';
                const province = shipping.province || '';
                const zip = shipping.zip || '';
                const country = shipping.country || '';
                const gateway = payload.gateway || (payload.payment_gateway_names && payload.payment_gateway_names[0]) || 'Unknown';
                
                // Improved payment method detection
                // Shopify uses "manual" for COD orders, "razorpay"/"stripe" for prepaid
                let paymentMethod = 'Prepaid';
                if (gateway && typeof gateway === 'string') {
                    const gatewayLower = gateway.toLowerCase();
                    // Check for COD in various formats
                    // Shopify: "manual" = COD, "cod" = COD, "cash on delivery" = COD
                    // Prepaid: "razorpay", "stripe", "credit_card", "upi", etc.
                    if (gatewayLower.includes('cod') || 
                        gatewayLower.includes('cash on delivery') || 
                        gatewayLower.includes('cash_on_delivery') ||
                        gatewayLower === 'manual') {
                        paymentMethod = 'COD';
                    }
                }
                
                console.log(`[PAYMENT] Order ${orderId}: gateway="${gateway}" → paymentMethod="${paymentMethod}"`);
                console.log(`[PAYMENT DEBUG] Full payload keys:`, Object.keys(payload).join(', '));
                if (payload.payment_gateway_names) {
                    console.log(`[PAYMENT DEBUG] payment_gateway_names:`, payload.payment_gateway_names);
                }
                const rawItems = payload.line_items || payload.products || payload.items || [];
                
                // Extract delivery type from Shopify shipping_lines
                let deliveryType = 'Standard';
                const shippingLines = payload.shipping_lines || [];
                if (shippingLines.length > 0) {
                    const shippingTitle = (shippingLines[0].title || shippingLines[0].code || '').toLowerCase();
                    if (shippingTitle.includes('express') || shippingTitle.includes('priority') || shippingTitle.includes('fast') || shippingTitle.includes('overnight')) {
                        deliveryType = 'Express';
                    }
                }
                
                // Extract size from each item and add it as a property for display
                const items = rawItems.map(item => {
                    let size = '';
                    // Try variant_title first (contains "Size: M" or just "M")
                    if (item.variant_title) {
                        const sizeMatch = item.variant_title.match(/Size:\s*(\w+)/i) || item.variant_title.match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
                        if (sizeMatch) size = sizeMatch[1].toUpperCase();
                    }
                    // Fallback to direct size property
                    if (!size && item.size) {
                        size = item.size;
                    }
                    // Return item with extracted size property
                    return {
                        ...item,
                        size: size || undefined
                    };
                });
                
                const itemsJson = JSON.stringify(items);

                // 1. Save to store_shoppers table
                const now = new Date().toISOString(); // Explicit UTC timestamp
                const shopperData = {
                    id: `shop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    phone: phone,
                    name: customerName,
                    email: email,
                    order_id: orderId,
                    address: address,
                    city: city,
                    province: province,
                    zip: zip,
                    country: country,
                    payment_method: paymentMethod,
                    items_json: itemsJson,
                    order_total: orderTotal,
                    delivery_type: deliveryType,
                    source: 'shopify',
                    status: 'pending',
                    created_at: now,  // Explicit UTC
                    updated_at: now   // Explicit UTC
                };

                // Check if shopper already exists for this order_id (UNIQUE constraint is on order_id alone)
                const existingShopper = await dbAdapter.query('SELECT id FROM store_shoppers WHERE order_id = ?', [orderId]);
                
                // Extract product details with size for the template
                // Size is included with each product to avoid confusion for multi-product orders
                const productDetails = items.map(item => {
                    const name = item.title || item.name || 'Product';
                    const qty = item.quantity || 1;
                    const size = item.size ? ` (Size: ${item.size})` : '';
                    return `${name}${size} x${qty}`;
                }).join(', ');
                
                // Size parameter kept for template compatibility - shows first item's size or 'Various'
                const productSize = items.length > 1 ? 'Various' : (items[0]?.size || 'N/A');

                // Save/update shopper data (handle missing table gracefully)
                try {
                    if (existingShopper && existingShopper.length > 0) {
                        const { id, ...updateData } = shopperData;
                        await dbAdapter.update('store_shoppers', updateData, { order_id: orderId });
                        console.log(`[UPDATE] Updated existing shopper for order ${orderId}`);
                    } else {
                        await dbAdapter.insert('store_shoppers', shopperData);
                        console.log(`[INSERT] Inserted new shopper for order ${orderId}`);
                    }
                } catch (shopperError) {
                    if (shopperError.message && shopperError.message.includes('no such table')) {
                        console.warn(`[WARN] store_shoppers table does not exist. Skipping shopper data save.`);
                    } else if (shopperError.message && shopperError.message.includes('UNIQUE constraint failed')) {
                        // Race condition: another webhook already inserted this order
                        console.log(`[RACE] Order ${orderId} already being processed by another webhook`);
                        // Update instead of insert
                        try {
                            const { id, ...updateData } = shopperData;
                            await dbAdapter.update('store_shoppers', updateData, { order_id: orderId });
                        } catch (updateError) {
                            console.error(`[ERROR] Failed to update shopper for order ${orderId}:`, updateError.message);
                        }
                    } else {
                        throw shopperError;
                    }
                }

                // RACE CONDITION FIX: Insert confirmation record FIRST, then send message
                // The UNIQUE constraint on (phone, order_id) prevents duplicates at database level
                let confirmationInserted = false;
                try {
                    await dbAdapter.insert('shopper_confirmations', {
                        id: `conf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        phone: phone,
                        order_id: orderId,
                        sent_at: now  // Use same UTC timestamp
                    });
                    confirmationInserted = true;
                } catch (insertError) {
                    if (insertError.message && insertError.message.includes('UNIQUE constraint failed')) {
                        console.log(`[SKIP] Confirmation already sent for ${phone} / ${orderId}`);
                    } else if (insertError.message && insertError.message.includes('no such table')) {
                        console.warn(`[WARN] shopper_confirmations table does not exist. Proceeding without deduplication.`);
                        confirmationInserted = true; // Proceed anyway if table missing
                    } else {
                        throw insertError;
                    }
                }

                // Only send if we successfully inserted (we're the first webhook)
                if (confirmationInserted) {
                    // 2. Send official confirmation template (Meta approved - v7)
                    // Size is now included in productDetails for each item
                    await whatsappService.sendShopperConfirmation(phone, customerName, orderId, orderTotal, paymentMethod, '', productDetails);
                    
                    // 3. Set 48-hour conversation lock to prevent bot interference
                    // During this period, only button clicks will be processed, no automated responses
                    try {
                        await dbAdapter.query(
                            'UPDATE store_shoppers SET conversation_lock_until = datetime(\'now\', \'+48 hours\') WHERE phone = ? AND order_id = ?',
                            [phone, orderId]
                        );
                        console.log(`[LOCK] 48-hour conversation lock set for ${phone} / ${orderId}`);
                    } catch (lockError) {
                        console.error('[LOCK] Failed to set conversation lock:', lockError.message);
                        // Don't throw - this is non-critical
                    }
                }
            }

        } catch (error) {
            console.error('Error handling order created:', error);
        }
    }

    // Send Reminder — rich message with product image header + CTA button
    async sendReminder(cart, type) {
        try {
            // 1. Validate eligibility
            if (cart.status === 'recovered' || cart.status === 'expired') return;

            // ── Parse cart items ─────────────────────────────────────────────────
            let items = [];
            try {
                items = typeof cart.cart_items === 'string'
                    ? JSON.parse(cart.cart_items)
                    : (cart.cart_items || []);
            } catch (e) { /* ignore parse errors */ }

            const firstItem = items && items.length > 0 ? items[0] : {};
            const firstName = cart.customer_name ? cart.customer_name.split(' ')[0] : 'there';
            const productTitle = firstItem.title || 'Your item';
            const productImage = firstItem.image_url || null; // may be null — handled below
            const itemCount = items.length;
            const totalAmount = cart.total_amount
                ? `₹${parseFloat(cart.total_amount).toFixed(0)}`
                : '';

            // ── Build the checkout URL ───────────────────────────────────────────
            // For template buttons the dynamic part is a URL *suffix* appended to
            // the base URL registered in Meta. For the fallback we use the full URL.
            let dynamicUrlSuffix = 'cart'; // safe fallback
            let fullCartUrl = cart.cart_url || 'https://offcomfrt.in/cart';

            if (cart.cart_url) {
                try {
                    const urlObj = new URL(cart.cart_url);
                    dynamicUrlSuffix = urlObj.pathname.replace(/^\/+/g, '') + urlObj.search;
                } catch (e) {
                    dynamicUrlSuffix = cart.cart_url.replace(/^\/+/g, '');
                }
            }
            if (!dynamicUrlSuffix || dynamicUrlSuffix.trim() === '') {
                dynamicUrlSuffix = 'cart';
            }

            // ── Pick template name by reminder type ──────────────────────────────
            // Make sure you have BOTH of these approved in Meta Business Manager:
            //   • abandoned_cart_reminder_1  (first nudge, warmer tone)
            //   • abandoned_cart_reminder_2  (second nudge, urgency tone)
            const templateName = type === 'first_reminder'
                ? 'abandoned_cart_v1'
                : 'abandoned_cart_v2';

            // ── Build template components ────────────────────────────────────────
            // Note: Header is now STATIC TEXT in the abandoned_cart_v1/v2 templates
            // to ensure 100% delivery reliability.
            const components = [];

            /* 
            if (productImage) {
                components.push({
                    type: 'header',
                    parameters: [
                        {
                            type: 'image',
                            image: { link: productImage }
                        }
                    ]
                });
            }
            */

            components.push({
                type: 'body',
                parameters: [
                    { type: 'text', text: firstName },
                    { type: 'text', text: productTitle }
                ]
            });

            components.push({
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [
                    { type: 'text', text: dynamicUrlSuffix }
                ]
            });

            const templateData = {
                name: templateName,
                language: { code: 'en' },
                components
            };

            console.log(`📤 Sending ${type} template "${templateName}" to ${cart.customer_phone}${productImage ? ' 🖼️ with image' : ''}`);

            // ── Send template (with retry) ────────────────────────────────────────
            let success = false;
            let templateFailed = false;
            
            const Settings = require('../models/Settings');
            const autoTemplatesEnabled = await Settings.get('auto_template_sending', 'false');

            if (String(autoTemplatesEnabled) === 'true') {
                try {
                    success = await whatsappService.sendTemplateWithRetry(cart.customer_phone, templateData, 3);
                } catch (templateError) {
                    const errDetails = templateError.response?.data?.error?.error_data?.details || '';
                    const defaultLogo = 'https://offcomfrt.in/cdn/shop/files/logo_black_1.png';
                    
                    if (productImage && (errDetails.includes('media') || errDetails.includes('download') || templateError.response?.data?.error?.code === 131053)) {
                        console.warn(`[WARN] Product image download failed for template. Retrying with default logo...`);
                        try {
                            // Find and replace the header image link in components
                            const headerComponent = templateData.components.find(c => c.type === 'header');
                            if (headerComponent && headerComponent.parameters && headerComponent.parameters[0].image) {
                                headerComponent.parameters[0].image.link = defaultLogo;
                            }
                            success = await whatsappService.sendTemplateWithRetry(cart.customer_phone, templateData, 3);
                        } catch (retryError) {
                            console.warn(`[WARN] Template retry with default logo also failed.`);
                            templateFailed = true;
                        }
                    } else {
                        templateFailed = true;
                    }
                }
            } else {
                console.warn(`[WARN] Auto Templates disabled. Bypassing templates for abandoned cart...`);
                templateFailed = true;
            }

            if (templateFailed) {
                // ── Rich CTA fallback ─────────────────────────────────────────────
                // If the template is not yet approved / name mismatch, send a rich
                // interactive cta_url message instead. This only works inside the
                // 24-hour customer service window, so it is best-effort.
                console.warn(`⚠️ Template "${templateName}" failed. Trying rich CTA fallback...`);

                const bodyLines = [
                    `📱 *OffComfrt*`,
                    ``,
                    ``,
                    `▫️ Hello ${firstName},`,
                    ``,
                    `▫️ You left *${productTitle}* in your cart${itemCount > 1 ? ` (+${itemCount - 1} more)` : ''}.${totalAmount ? ` Total: *${totalAmount}*` : ''}`,
                    ``,
                    type === 'first_reminder'
                        ? `▫️ Complete your order before it is no longer available.`
                        : `▫️ Your items are still in your cart. This is a final reminder before they are released.`,
                    ``,
                    ``
                ].join('\n');

                const defaultLogo = 'https://offcomfrt.in/cdn/shop/files/logo_black_1.png';

                try {
                    await whatsappService.sendCtaUrlMessage(
                        cart.customer_phone,
                        bodyLines,
                        'Complete My Order',
                        fullCartUrl,
                        productImage || defaultLogo,
                        'Offcomfrt | Free shipping on orders Rs.499+'
                    );
                    success = true;
                    console.log(`✅ Rich CTA fallback sent to ${cart.customer_phone}`);
                } catch (ctaError) {
                    const errDetails = ctaError.response?.data?.error?.error_data?.details || '';
                    if (productImage && (errDetails.includes('media') || errDetails.includes('download') || ctaError.response?.data?.error?.code === 131053)) {
                        console.warn(`⚠️ CTA fallback image failed. Retrying with default logo...`);
                        try {
                            await whatsappService.sendCtaUrlMessage(
                                cart.customer_phone,
                                bodyLines,
                                'Complete My Order',
                                fullCartUrl,
                                defaultLogo,
                                'Offcomfrt | Free shipping on orders Rs.499+'
                            );
                            success = true;
                            console.log(`✅ Rich CTA fallback (with default logo) sent to ${cart.customer_phone}`);
                        } catch (ctaRetryError) {
                            console.error(`❌ CTA fallback retry also failed for ${cart.customer_phone}:`, ctaRetryError.message);
                            success = false;
                        }
                    } else {
                        console.error(`❌ CTA fallback also failed for ${cart.customer_phone}:`, ctaError.message);
                        success = false;
                    }
                }
            }

            if (success === false) {
                // Meta API cleanly rejected (e.g. unregistered sandbox number)
                await AbandonedCart.updateStatus(cart.checkout_id, 'failed', {
                    updated_at: new Date().toISOString()
                });
                console.log(`❌ Marked cart ${cart.checkout_id} as failed (Invalid phone / rejected).`);
                return;
            }

            // ── Update status ─────────────────────────────────────────────────────
            const updateData = {};
            if (type === 'first_reminder') {
                updateData.first_reminder_sent_at = new Date().toISOString();
                updateData.status = 'sent_first';
            } else {
                updateData.second_reminder_sent_at = new Date().toISOString();
                updateData.status = 'sent_second';
            }

            await AbandonedCart.updateStatus(cart.checkout_id, updateData.status, updateData);
            console.log(`📩 Sent ${type} to ${cart.customer_phone} — status → ${updateData.status}`);

        } catch (error) {
            console.error(`Error sending template reminder to ${cart.customer_phone}:`, error);

            // Mark permanently failed for 4xx errors (bad phone, policy block) — not 401
            if (error.response && error.response.status >= 400 && error.response.status < 500 && error.response.status !== 401) {
                await AbandonedCart.updateStatus(cart.checkout_id, 'failed', {
                    updated_at: new Date().toISOString()
                });
                console.log(`❌ Marked cart ${cart.checkout_id} as failed (persistent Meta API rejection).`);
            }
        }
    }


    // Process all pending reminders (called by Cron)
    async processReminders() {
        // Fetch dynamic delays from the db, default to 1 and 24 if missing
        // Use getBulk to fetch both settings in a single query
        const settings = await Settings.getBulk('abandoned_cart_');
        const firstDelay = Number(settings.abandoned_cart_first_delay_hours || 1);
        const secondDelay = Number(settings.abandoned_cart_second_delay_hours || 24);

        console.log(`⏱️ Processing Abandoned Carts with First Delay: ${firstDelay}h, Second Delay: ${secondDelay}h`);

        // 1. First Reminders
        const pendingFirst = await AbandonedCart.getPendingFirstReminders(firstDelay);
        for (const cart of pendingFirst) {
            await this.sendReminder(cart, 'first_reminder');
        }

        // 2. Second Reminders
        const pendingSecond = await AbandonedCart.getPendingSecondReminders(secondDelay);
        for (const cart of pendingSecond) {
            await this.sendReminder(cart, 'second_reminder');
        }

        // 3. Expire Old Carts (always expire after 7 days)
        await AbandonedCart.expireOldCarts(7);
    }
}

module.exports = new AbandonedCartService();
