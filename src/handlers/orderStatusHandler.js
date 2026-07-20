const shiprocketService = process.env.USE_MOCK_SHIPROCKET === 'true'
    ? require('../services/mockShiprocketService')
    : require('../services/shiprocketService');
const whatsappService = require('../services/whatsappService');
const Order = require('../models/Order');
const { orderStatusMessage, orderTimelineMessage, errorMessages } = require('../utils/messageTemplates');
const { isValidOrderId, isValidAWB, extractOrderId, extractPhoneNumber } = require('../utils/validators');
const branding = require('../config/branding');

class OrderStatusHandler {
    // Handle order status query
    async handle(phone, message, lang = 'en') {
        try {
            // Extract order ID from message
            const orderId = extractOrderId(message);

            if (!orderId) {
                await whatsappService.sendMessage(phone, errorMessages.invalidOrderId(lang));
                return;
            }

            // Extract phone number from message (if customer provided registered number)
            const registeredPhone = extractPhoneNumber(message);

            // Use extracted phone if available, otherwise use sender's phone
            const searchPhone = registeredPhone || phone;

            console.log(`Searching order ${orderId} with phone: ${searchPhone}${registeredPhone ? ' (from message)' : ' (sender)'}`);

            // Check if it's an AWB or Order ID
            const isAWB = isValidAWB(orderId);

            let orderData;

            if (isAWB) {
                // Fetch by AWB
                orderData = await shiprocketService.getTrackingByAWB(orderId);

                if (orderData && orderData.tracking_data) {
                    const timeline = await shiprocketService.getTrackingTimeline(orderId);
                    const statusMsg = this.formatAWBStatus(orderData.tracking_data, lang);
                    const timelineMsg = orderTimelineMessage(timeline, lang);

                    const fullMessage = `${statusMsg}\n\n${timelineMsg}`;

                    await whatsappService.sendRichNotification(phone, {
                        body: fullMessage,
                        buttonLabel: 'Track on Website',
                        buttonUrl: 'https://offcomfrt.in/pages/track-order',
                        imageUrl: branding.logoUrl,
                        
                        plainFallback: fullMessage
                    });
                    return;
                }
            } else {
                // Fetch by Order ID (use searchPhone for fallback search)
                orderData = await shiprocketService.getOrderStatus(orderId, searchPhone);

                if (orderData) {
                    const statusMsg = orderStatusMessage(orderData, lang);

                    // Get timeline if AWB exists
                    let fullMessage = statusMsg;
                    if (orderData.awb) {
                        const timeline = await shiprocketService.getTrackingTimeline(orderData.awb);
                        const timelineMsg = orderTimelineMessage(timeline, lang);
                        fullMessage = `${statusMsg}\n\n${timelineMsg}`;
                    }

                    await whatsappService.sendRichNotification(phone, {
                        body: fullMessage,
                        buttonLabel: 'Track on Website',
                        buttonUrl: orderData.tracking_url || 'https://offcomfrt.in/pages/track-order',
                        imageUrl: branding.logoUrl,
                        
                        plainFallback: fullMessage
                    });

                    // Save order to DB
                    await this.updateOrderInDB(orderData, phone);
                    return;
                }
            }

            // If order not found after all checks
            await whatsappService.sendMessage(phone, errorMessages.orderNotFound(orderId, lang));

        } catch (error) {
            console.error('Error in OrderStatusHandler:', error);
            await whatsappService.sendMessage(phone, errorMessages.apiError(lang));
        }
    }

    // Format AWB tracking status
    formatAWBStatus(trackingData, lang = 'en') {
        const { translate } = require('../utils/translations');
        const trackInfo = (trackingData.shipment_track && trackingData.shipment_track.length > 0) 
            ? trackingData.shipment_track[0] 
            : trackingData;

        let message = `⚫ *OFFCOMFRT — ${translate('orderStatus', lang).toUpperCase()}*

▫️ *AWB:* ${trackInfo.awb_code || 'N/A'}
▫️ *${translate('status', lang)}:* ${trackInfo.current_status || 'Unknown'}
▫️ *Courier Name:* ${trackInfo.courier_name || 'N/A'}`;

        if (trackInfo.current_location) {
            message += `\n▫️ *Current Location:* ${trackInfo.current_location}`;
        }

        message += `\n▫️ *Shipped Date:* ${trackInfo.shipped_date || 'N/A'}
▫️ *${translate('expectedDelivery', lang)}:* ${trackInfo.edd || 'N/A'}`;

        if (trackInfo.delivered_date) {
            message += `\n▫️ *Delivered On:* ${trackInfo.delivered_date}`;
        }

        if (trackInfo.tracking_url) {
            message += `\n▫️ *Track Online:* ${trackInfo.tracking_url}`;
        }

        message += `\n⚫ *TRACKING HISTORY*`;

        return message.trim();
    }

    // Update order in database
    async updateOrderInDB(orderData, phone) {
        try {
            const existingOrder = await Order.findByOrderId(orderData.channelOrderId || orderData.orderId);

            if (existingOrder) {
                // Update existing order
                await Order.updateStatus(existingOrder.order_id, orderData.status, {
                    awb: orderData.awb,
                    courier_name: orderData.courierName,
                    expected_delivery: orderData.expectedDelivery
                });
            } else {
                // Create new order
                await Order.create({
                    order_id: orderData.channelOrderId || orderData.orderId,
                    customer_phone: phone,
                    shiprocket_order_id: orderData.orderId,
                    awb: orderData.awb,
                    status: orderData.status,
                    courier_name: orderData.courierName,
                    product_name: orderData.products?.[0]?.name,
                    order_date: orderData.orderDate,
                    expected_delivery: orderData.expectedDelivery
                });
            }
        } catch (error) {
            console.error('Error updating order in DB:', error);
        }
    }

    // Append main menu after any order status result
    async sendMainMenu(phone) {
        const whatsappService = require('../services/whatsappService');
        await whatsappService.sendListMessage(
            phone,
            `📱 *OffComfrt*\n\n▫️ What else can we help you with?\n\n▫️ Select from the menu below.`,
            'Menu',
            [{
                title: 'Orders',
                rows: [
                    { id: 'track_order', title: 'Track Order', description: '▫️ Track your current order' },
                    { id: 'order_history', title: 'My Orders', description: '▫️ View all your orders' }
                ]
            }, {
                title: 'Support',
                rows: [
                    { id: 'menu_return', title: 'Return', description: '▫️ Within 2 days of delivery' },
                    { id: 'menu_exchange', title: 'Exchange', description: '▫️ Swap to a different size' },

                    { id: 'menu_language', title: 'Language', description: '▫️ Change language' }
                ]
            }],
                    null,
                    null
        );
    }
}

module.exports = new OrderStatusHandler();
