const { translate } = require('./translations');

const welcomeMessage = (name = 'there', lang = 'en') => translate('welcome', lang, name);

// Order status message
const orderStatusMessage = (orderData, lang = 'en') => {
    // Product details
    const productName = orderData.product_name || (orderData.products && orderData.products.length > 0 ? orderData.products[0].name : 'Item');
    const productCount = orderData.products ? orderData.products.length : 1;
    const otherItems = productCount > 1 ? ` +${productCount - 1} others` : '';

    // Price and Payment
    const price = orderData.total || orderData.net_total || orderData.payment_amount || 'N/A';
    const paymentMethod = orderData.payment_method || (orderData.payment_code === 'COD' ? 'Cash on Delivery' : 'Prepaid');

    // Human-readable status
    const statusLabel = (orderData.status || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    let message = `📦 *${translate('orderStatus', lang).toUpperCase()}*

▫️ *${translate('orderId', lang)}:* #${orderData.channel_order_id || orderData.channelOrderId || orderData.id || orderData.orderId}
▫️ *Product:* ${productName}${otherItems}
▫️ *Amount:* Rs.${price} (${paymentMethod})
▫️ *${translate('status', lang)}:* ${statusLabel}
▫️ *Order Date:* ${formatDate(orderData.created_at || orderData.orderDate)}`;

    if (orderData.awb || orderData.awb_code) {
        message += `\n▫️ *AWB:* ${orderData.awb || orderData.awb_code}`;
    }
    if (orderData.courier_name || orderData.courierName) {
        message += `\n▫️ *Courier Name:* ${orderData.courier_name || orderData.courierName}`;
    }
    
    if (orderData.current_location) {
        message += `\n📍 *Current Location:* ${orderData.current_location}`;
    }

    if (orderData.expected_delivery_date || orderData.expectedDelivery) {
        message += `\n🚚 *${translate('expectedDelivery', lang)}:* ${formatDate(orderData.expected_delivery_date || orderData.expectedDelivery)}`;
    }
    
    if (orderData.delivered_date || orderData.deliveredDate) {
        message += `\n✅ *Delivered On:* ${formatDate(orderData.delivered_date || orderData.deliveredDate)}`;
    }
    
    if (orderData.tracking_url) {
        message += `\n🌐 *Track Online:* ${orderData.tracking_url}`;
    }

    message += `\n\n📌 *TRACKING HISTORY*`;

    return message.trim();
};

// Order timeline message
const orderTimelineMessage = (timeline, lang = 'en') => {
    if (!timeline || !Array.isArray(timeline) || timeline.length === 0) {
        return `▫️ _No updates available yet._`;
    }

    let message = ``;

    // Show up to 10 latest updates
    timeline.slice(0, 10).forEach((event, index) => {
        const isLatest = index === 0;
        const marker = isLatest ? '🟢' : '🔘';

        message += `${marker} *${event.activity}*\n`;
        message += `   ▫️ ${event.date} ${event.time || ''}\n`;
        if (event.location) {
            message += `   ▫️ ${event.location}\n`;
        }
        message += '\n';
    });

    if (timeline.length > 10) {
        message += `▫️ _...and ${timeline.length - 10} more updates_`;
    }

    return message.trim();
};

// Order history list message
const orderHistoryMessage = (orders, lang = 'en') => {
    if (!orders || orders.length === 0) {
        return `🕰️ *ORDER HISTORY*\n\n▫️ No previous orders found.\n\nVisit *offcomfrt.in* to place your first order.`;
    }

    let message = `🕰️ *ORDER HISTORY*\n\n`;

    orders.slice(0, 10).forEach((order, index) => {
        const statusLabel = (order.status || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        message += `📦 *Order #${order.order_id}*\n`;
        message += `   ▫️ Status: ${statusLabel}\n`;
        message += `   ▫️ Date: ${formatDate(order.order_date)}\n\n`;
    });

    if (orders.length > 10) {
        message += `▫️ _...and ${orders.length - 10} more orders_\n\n`;
    }

    message += `\n📱 Send an order ID to view details.`;

    return message.trim();
};

// Error messages
const errorMessages = {
    orderNotFound: (orderId, lang = 'en') => {
        if (lang === 'en') {
            return `❌ *Order #${orderId} could not be found.*

▫️ Please verify:
▫️ The order ID is correct
▫️ You are messaging from the registered number

✉️ If you used a different number, please message from that number or write to *support@offcomfrt.in*.`.trim();
        }
        return `❌ ${translate('orderNotFound', lang)}\nID: ${orderId}`;
    },

    invalidOrderId: (lang = 'en') => {
        if (lang === 'en') return `⚠️ *That does not appear to be a valid order ID.*

▫️ Please send:
▫️ Your order number (e.g. 12345)
▫️ Or your AWB tracking number

💡 Type *help* for more options.`.trim();
        return `⚠️ ${translate('error', lang)}`;
    },

    apiError: (lang = 'en') => {
        if (lang === 'en') return `⚠️ *We encountered an issue on our end.*

▫️ Please try again in a moment.
▫️ If the problem persists, reach out to *support@offcomfrt.in*.`.trim();
        return `⚠️ ${translate('error', lang)}`;
    },

    noOrders: (lang = 'en') => {
        if (lang === 'en') return `🛍️ *You do not have any orders with us yet.*

▫️ Visit *offcomfrt.in* to place your first order.
▫️ Once you do, we will help you track it here.`.trim();
        return `🛍️ ${translate('orderNotFound', lang)}`;
    }
};

// Help message
const helpMessage = () => `🎧 *OFFCOMFRT SUPPORT*

📦 *Check Order Status*
▫️ Send your order ID or AWB tracking number.

🕰️ *View Order History*
▫️ Type "orders" or "history".

🔄 *Returns and Exchanges*
▫️ Type "return" or "exchange".
▫️ Requests must be filed within *2 days of delivery*.

⌨️ *Available Commands*
▫️ "status" — Check order status
▫️ "orders" — View all orders
▫️ "help" — Show this message

📞 *Need Assistance?*
▫️ Email: support@offcomfrt.in
▫️ Website: offcomfrt.in

We are available around the clock to help.`.trim();

// Broadcast/Offer message template
const broadcastMessage = (title, content) => `📢 *${title}*

${content}

Reply STOP to unsubscribe from promotional messages.`.trim();

// Helper function to format dates
function formatDate(dateString) {
    if (!dateString) return 'N/A';

    const date = new Date(dateString);
    const options = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    };

    return date.toLocaleDateString('en-IN', options);
}

module.exports = {
    welcomeMessage,
    orderStatusMessage,
    orderTimelineMessage,
    orderHistoryMessage,
    errorMessages,
    helpMessage,
    broadcastMessage,
    formatDate
};
