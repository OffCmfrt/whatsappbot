const whatsappService = require('../services/whatsappService');
const shiprocketService = process.env.USE_MOCK_SHIPROCKET === 'true'
    ? require('../services/mockShiprocketService')
    : require('../services/shiprocketService');
const Customer = require('../models/Customer');
const { orderHistoryMessage, errorMessages } = require('../utils/messageTemplates');
const branding = require('../config/branding');

class OrderHistoryHandler {
    // Handle order history request
    async handle(phone, searchPhone = null, lang = 'en') {
        try {
            // Use provided phone or sender's phone
            const phoneToSearch = searchPhone || phone;

            console.log(`Fetching order history for: ${phoneToSearch}${searchPhone ? ' (from message)' : ' (sender)'}`);

            // STEP 1: Check database first (instant!)
            const Order = require('../models/Order');
            let orders = await Order.findByCustomerPhone(phoneToSearch);

            // If we have cached orders, serve them IMMEDIATELY to the user
            if (orders && orders.length > 0) {
                const CACHE_EXPIRY_HOURS = 1;
                const isCacheFresh = orders[0].updated_at &&
                    (new Date() - new Date(orders[0].updated_at)) < (CACHE_EXPIRY_HOURS * 60 * 60 * 1000);

                if (isCacheFresh) {
                    // Fresh cache: send and done
                    console.log(`Found ${orders.length} fresh orders in database (<${CACHE_EXPIRY_HOURS}h old)`);
                    const message = this.formatOrderHistory(orders, phoneToSearch);
                    await whatsappService.sendRichNotification(phone, {
                        body: message,
                        buttonLabel: 'View All Orders',
                        buttonUrl: 'https://offcomfrt.in/pages/track-order',
                        imageUrl: branding.logoUrl,
                        plainFallback: message
                    });
                    return;
                }

                // Stale cache: serve cached data NOW, refresh in background
                console.log(`Cache is stale (>${CACHE_EXPIRY_HOURS}h old), serving cached data and refreshing in background...`);
                const message = this.formatOrderHistory(orders, phoneToSearch);
                await whatsappService.sendRichNotification(phone, {
                    body: message,
                    buttonLabel: 'View All Orders',
                    buttonUrl: 'https://offcomfrt.in/pages/track-order',
                    imageUrl: branding.logoUrl,
                    plainFallback: message
                });

                // Background refresh — fire-and-forget (no await)
                this._backgroundRefresh(phone, phoneToSearch).catch(err =>
                    console.error('Background refresh error:', err)
                );
                return;
            }

            // STEP 2: No cached data at all — must fetch from Shiprocket
            console.log(`No orders in database, searching Shiprocket...`);

            // Send waiting message to user
            await whatsappService.sendMessage(phone, `📱 *OffComfrt*\n\n▫️ *Searching for your orders...*\n▫️ This may take a few moments. Please wait.`);

            orders = await shiprocketService.getOrdersByPhone(phoneToSearch);

            if (!orders || orders.length === 0) {
                await whatsappService.sendMessage(phone, `📱 *OffComfrt*\n\n▫️ No orders found for *${phoneToSearch}*.\n\n▫️ Please verify:\n▫️ The phone number is correct\n▫️ Orders exist under this number\n\n▫️ For assistance, write to *support@offcomfrt.in*.\n`);
                return;
            }

            // Update database with fresh data (parallel writes)
            console.log(`Updating ${orders.length} orders in database...`);
            await this._cacheOrders(orders, phoneToSearch);

            // Format and send order history
            const message = this.formatOrderHistory(orders, phoneToSearch);

            await whatsappService.sendRichNotification(phone, {
                body: message,
                buttonLabel: 'View All Orders',
                buttonUrl: 'https://offcomfrt.in/pages/track-order',
                imageUrl: branding.logoUrl,
                plainFallback: message
            });

        } catch (error) {
            console.error('Error in OrderHistoryHandler:', error);
            await whatsappService.sendMessage(phone, errorMessages.apiError());
        }
    }

    // Background refresh: re-fetch from Shiprocket and update DB
    async _backgroundRefresh(phone, phoneToSearch) {
        const Order = require('../models/Order');
        try {
            const freshOrders = await shiprocketService.getOrdersByPhone(phoneToSearch);
            if (freshOrders && freshOrders.length > 0) {
                console.log(`[BG Refresh] Updating ${freshOrders.length} orders for ${phoneToSearch}`);
                await this._cacheOrders(freshOrders, phoneToSearch);
                console.log(`[BG Refresh] Done for ${phoneToSearch}`);
            }
        } catch (err) {
            console.error(`[BG Refresh] Failed for ${phoneToSearch}:`, err.message);
        }
    }

    // Cache orders to DB using parallel writes
    async _cacheOrders(orders, phoneToSearch) {
        const Order = require('../models/Order');
        const writePromises = orders.map(async (order) => {
            try {
                const orderData = {
                    order_id: order.channel_order_id || order.id,
                    customer_phone: phoneToSearch,
                    shiprocket_order_id: order.id,
                    awb: order.awb,
                    status: order.status,
                    courier_name: order.courier_name,
                    product_name: order.products?.[0]?.name,
                    order_date: order.created_at,
                    expected_delivery: order.expected_delivery_date,
                    total: order.total || order.net_total || order.payment_amount,
                    payment_method: order.payment_method || (order.payment_code === 'COD' ? 'COD' : 'Prepaid'),
                    tracking_url: order.tracking_url || null
                };

                const existing = await Order.findByOrderId(orderData.order_id);
                if (existing) {
                    await Order.updateStatus(orderData.order_id, orderData.status, {
                        awb: orderData.awb,
                        courier_name: orderData.courier_name,
                        expected_delivery: orderData.expected_delivery,
                        total: orderData.total,
                        payment_method: orderData.payment_method,
                        tracking_url: orderData.tracking_url
                    });
                } else {
                    await Order.create(orderData);
                }
            } catch (err) {
                console.error(`Error caching order ${order.channel_order_id || order.id}:`, err.message);
            }
        });

        await Promise.all(writePromises);
    }

    // Format order history message
    formatOrderHistory(orders, phoneNumber) {
        let message = `⚫ *OFFCOMFRT — ORDER HISTORY*\n`;
        message += ``;
        message += `▫️ Phone: ${phoneNumber}\n`;
        message += `▫️ Total Orders: ${orders.length}\n\n`;

        // Show up to 10 most recent orders
        const recentOrders = orders.slice(0, 10);

        recentOrders.forEach((order, index) => {
            const statusLabel = (order.status || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

            // Product details
            const productName = order.product_name || (order.products && order.products.length > 0 ? order.products[0].name : 'Item');
            const productCount = order.products ? order.products.length : 1;
            const otherItems = productCount > 1 ? ` +${productCount - 1} others` : '';

            // Price and Payment
            const price = order.total || order.net_total || order.payment_amount || 'N/A';
            const paymentMethod = order.payment_method || (order.payment_code === 'COD' ? 'Cash on Delivery' : 'Prepaid');

            message += `▫️ *Order #${order.channel_order_id || order.id}*\n`;
            message += `   ▫️ ${productName}${otherItems}\n`;
            message += `   ▫️ Rs.${price} (${paymentMethod})\n`;
            message += `   ▫️ Status: ${statusLabel}\n`;
            message += `   ▫️ Date: ${new Date(order.created_at || order.order_date).toLocaleDateString()}\n`;
            if (order.awb) message += `   ▫️ AWB: ${order.awb}\n`;
            if (order.tracking_url) message += `   ▫️ Track Online: ${order.tracking_url}\n`;
            message += `\n`;
        });

        if (orders.length > 10) {
            message += `\n▫️ _...and ${orders.length - 10} more orders_\n`;
        }

        message += ``;
        message += `▫️ Send an order ID to track a specific order.`;

        return message;
    }

    // Get order details by ID
    async getOrderDetails(phone, orderId) {
        try {
            const orders = await Customer.getOrders(phone);
            const order = orders.find(o => o.order_id === orderId);

            if (!order) {
                await whatsappService.sendMessage(phone, errorMessages.orderNotFound(orderId));
                return;
            }

            // Use order status handler to show details
            const orderStatusHandler = require('./orderStatusHandler');
            await orderStatusHandler.handle(phone, orderId);

        } catch (error) {
            console.error('Error getting order details:', error);
            await whatsappService.sendMessage(phone, errorMessages.apiError());
        }
    }
}

module.exports = new OrderHistoryHandler();
