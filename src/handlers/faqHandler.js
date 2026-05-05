const whatsappService = require('../services/whatsappService');
const branding = require('../config/branding');

class FAQHandler {
    constructor() {
        // FAQ database with keywords and responses
        this.faqs = [
            {
                keywords: ['return', 'refund', 'money back', 'return policy'],
                question: 'What is your return policy?',
                answer: `⚫ *OFFCOMFRT — RETURN POLICY*

▫️ We accept return requests filed within *2 days of delivery*.

▫️ *How to initiate a return:*
▫️ Visit our returns page on the website or type "return" here.

▫️ *Process:*
▫️ Submit your return request
▫️ Our team reviews it within 24 to 48 hours
▫️ Pickup is scheduled at your doorstep
▫️ Refund is provided as *store credit only* within 5 to 7 business days

▫️ *Conditions:*
▫️ Items must be unused, with tags attached
▫️ Original packaging is required
▫️ Request must be within 2 days of delivery

▫️ For questions, write to *support@offcomfrt.in*.`
            },
            {
                keywords: ['exchange', 'size change', 'wrong size', 'different size'],
                question: 'Can I exchange my order?',
                answer: `⚫ *OFFCOMFRT — SIZE EXCHANGE*

▫️ Yes, we offer free size exchanges within *2 days of delivery*.

▫️ *How to exchange:*
▫️ Visit our Exchange page or type "exchange" here.

▫️ *Process:*
▫️ Select your order and the new size
▫️ Our team picks up the old item
▫️ New size is shipped after quality check

▫️ Exchange is subject to stock availability. If the requested size is unavailable, store credit will be issued.`
            },
            {
                keywords: ['shipping', 'delivery', 'how long', 'when will i get', 'delivery time'],
                question: 'How long does shipping take?',
                answer: `⚫ *OFFCOMFRT — SHIPPING & DELIVERY*

▫️ *Delivery Timeline:*
▫️ Metro cities: 2 to 3 business days
▫️ Other cities: 4 to 6 business days
▫️ Remote areas: 6 to 8 business days

▫️ *Shipping Charges:*
▫️ Free on orders above Rs.999
▫️ Rs.99 for orders below Rs.999

▫️ *Track Your Order:*
▫️ Send your order ID in this chat for real-time updates.

▫️ *International Shipping:*
▫️ Currently not available.

`
            },
            {
                keywords: ['payment', 'pay', 'cod', 'cash on delivery', 'payment methods', 'upi'],
                question: 'What payment methods do you accept?',
                answer: `⚫ *OFFCOMFRT — PAYMENT METHODS*

▫️ We accept the following:
▫️ Credit and Debit Cards
▫️ UPI (GPay, PhonePe, Paytm)
▫️ Net Banking
▫️ Digital Wallets (Paytm, Mobikwik)
▫️ Cash on Delivery (COD)

▫️ *COD Terms:*
▫️ Available on orders up to Rs.5,000
▫️ Rs.50 COD handling charge applies

▫️ *Security:*
▫️ All transactions are fully encrypted and secure.

`
            },

            {
                keywords: ['quality', 'material', 'fabric', 'cotton', 'what is it made of'],
                question: 'What is the quality of your products?',
                answer: `⚫ *OFFCOMFRT — PREMIUM QUALITY*

▫️ *Materials:*
▫️ 100% Premium Cotton
▫️ Pre-shrunk fabric
▫️ Colourfast dyes
▫️ Reinforced stitching

▫️ *Certifications:*
▫️ OEKO-TEX certified
▫️ Eco-friendly materials
▫️ Sustainable production

▫️ *Care Instructions:*
▫️ Machine wash cold
▫️ Tumble dry low
▫️ Iron if needed

▫️ Defective products are eligible for store credit or replacement.`
            },
            {
                keywords: ['track', 'tracking', 'where is my order', 'order status', 'awb'],
                question: 'How can I track my order?',
                answer: `⚫ *OFFCOMFRT — TRACK YOUR ORDER*

▫️ Send us one of the following:
▫️ Your Order ID (e.g. ORD-2024-001)
▫️ Your AWB tracking number

▫️ We will show you:
▫️ Current status
▫️ Current Location
▫️ Courier Name
▫️ Expected delivery date
▫️ Track Online link
▫️ Complete shipment timeline

▫️ Do not have your order ID? Type "orders" to view all your orders.`
            },
            {
                keywords: ['cancel', 'cancellation', 'cancel order', 'dont want'],
                question: 'Can I cancel my order?',
                answer: `⚫ *OFFCOMFRT — ORDER CANCELLATION*

▫️ *Before Shipping:*
▫️ Cancellation is free. Store credit is issued instantly.

▫️ *After Shipping:*
▫️ The order cannot be cancelled.
▫️ You may return it after delivery (within 2 days).

▫️ *How to Cancel:*
▫️ 1. Send your order ID
▫️ 2. Type "cancel"
▫️ 3. Store credit will be issued within 3 to 5 business days

▫️ Need help? Write to *support@offcomfrt.in*.`
            },
            {
                keywords: ['discount', 'offer', 'coupon', 'promo code', 'sale'],
                question: 'Do you have any offers?',
                answer: `⚫ *OFFCOMFRT — CURRENT OFFERS*

▫️ *Active Deals:*
▫️ First Order: 10% off (Code: FIRST10)
▫️ Orders above Rs.1999: 15% off
▫️ Free shipping on Rs.999 and above

▫️ *Loyalty Programme:*
▫️ Earn points on every purchase and redeem them for discounts.

▫️ *Exclusive Offers:*
▫️ Subscribe to our updates for early access to sales.

`
            },
            {
                keywords: ['contact', 'support', 'help', 'customer care', 'phone number', 'email'],
                question: 'How can I contact support?',
                answer: `🎧 *Contact Support*

▫️ *Email:* support@offcomfrt.in

▫️ *WhatsApp:* You are already here — available 24/7

▫️ *Response Time:*
▫️ WhatsApp: Immediate
▫️ Email: Within 24 hours

▫️ *Business Hours:*
▫️ Monday to Saturday: 10 AM to 7 PM IST
▫️ Sunday: Closed

▫️ *We can help with:*
▫️ Order tracking
▫️ Returns and exchanges (within 2 days of delivery)
▫️ Product questions


`
            }
        ];
    }

    // Check if message matches any FAQ
    async matchFAQ(message) {
        const lowerMessage = message.toLowerCase();
        const { dbAdapter } = require('../database/db');
        
        // Try DB first (Check all automation types)
        try {
            const configs = await dbAdapter.query('SELECT * FROM automation_config');
            for (const config of configs) {
                let content;
                try {
                    content = typeof config.content === 'string' ? JSON.parse(config.content) : config.content;
                } catch (e) {
                    continue;
                }

                const keywords = content.keywords || [];
                // If the key itself is used as a keyword
                if (lowerMessage.includes(config.key.toLowerCase()) || keywords.some(k => lowerMessage.includes(k.toLowerCase()))) {
                    // Standardize for messageHandler
                    return {
                        ...content,
                        type: config.type,
                        key: config.key
                    };
                }
            }
        } catch (err) {
            console.log('FAQ DB fetch failed:', err.message);
        }

        // Fallback to hardcoded
        for (const faq of this.faqs) {
            for (const keyword of faq.keywords) {
                if (lowerMessage.includes(keyword)) {
                    return faq;
                }
            }
        }

        return null;
    }

    // Handle FAQ query
    async handle(phone, message, lang = 'en') {
        const matchedFAQ = await this.matchFAQ(message);

        if (matchedFAQ) {
            const messageHandler = require('./messageHandler');
            await messageHandler.sendRichResponse(phone, matchedFAQ);
            return true;
        }

        return false;
    }

    // Get all FAQs for help menu
    getAllFAQs() {
        return this.faqs.map(faq => faq.question);
    }
}

module.exports = new FAQHandler();
