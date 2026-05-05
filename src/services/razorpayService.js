const Razorpay = require('razorpay');

class RazorpayService {
    constructor() {
        // Only initialize Razorpay if keys are provided
        if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
            this.razorpay = new Razorpay({
                key_id: process.env.RAZORPAY_KEY_ID,
                key_secret: process.env.RAZORPAY_KEY_SECRET
            });
            this.enabled = true;
            console.log('✅ Razorpay service initialized');
        } else {
            this.enabled = false;
            console.log('⚠️  Razorpay not configured - payment features disabled');
        }
    }

    /**
     * Check if Razorpay is enabled
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Create a payment link for exchange balance
     */
    async createPaymentLink(amount, orderId, customerDetails) {
        if (!this.enabled) {
            return {
                success: false,
                error: 'Razorpay not configured. Please add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to environment variables.'
            };
        }

        try {
            const paymentLink = await this.razorpay.paymentLink.create({
                amount: amount * 100, // Convert to paise
                currency: 'INR',
                description: `Exchange balance for Order ${orderId}`,
                customer: {
                    name: customerDetails.name || 'Customer',
                    contact: customerDetails.phone,
                    email: customerDetails.email || `${customerDetails.phone}@customer.com`
                },
                notify: {
                    sms: true,
                    email: false
                },
                reminder_enable: true,
                notes: {
                    order_id: orderId,
                    type: 'exchange_balance'
                },
                callback_url: `${process.env.APP_URL}/payment/callback`,
                callback_method: 'get',
                expire_by: Math.floor(Date.now() / 1000) + 86400 // 24 hours
            });

            return {
                success: true,
                paymentLinkId: paymentLink.id,
                shortUrl: paymentLink.short_url,
                amount: amount,
                expiresAt: new Date(paymentLink.expire_by * 1000)
            };
        } catch (error) {
            console.error('Razorpay payment link error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get payment link status
     */
    async getPaymentStatus(paymentLinkId) {
        if (!this.enabled) {
            return { success: false, error: 'Razorpay not configured' };
        }
        try {
            const paymentLink = await this.razorpay.paymentLink.fetch(paymentLinkId);

            return {
                success: true,
                status: paymentLink.status, // created, paid, partially_paid, expired, cancelled
                amountPaid: paymentLink.amount_paid / 100,
                payments: paymentLink.payments
            };
        } catch (error) {
            console.error('Razorpay status check error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Process refund for returns
     */
    async processRefund(paymentId, amount, notes = {}) {
        if (!this.enabled) {
            return { success: false, error: 'Razorpay not configured' };
        }
        try {
            const refund = await this.razorpay.payments.refund(paymentId, {
                amount: amount * 100, // Convert to paise
                speed: 'normal', // normal or optimum
                notes: notes
            });

            return {
                success: true,
                refundId: refund.id,
                amount: refund.amount / 100,
                status: refund.status
            };
        } catch (error) {
            console.error('Razorpay refund error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Verify payment webhook signature
     */
    verifyWebhookSignature(webhookBody, webhookSignature) {
        try {
            const crypto = require('crypto');
            const expectedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                .update(JSON.stringify(webhookBody))
                .digest('hex');

            return expectedSignature === webhookSignature;
        } catch (error) {
            console.error('Signature verification error:', error);
            return false;
        }
    }

    /**
     * Get payment details
     */
    async getPaymentDetails(paymentId) {
        if (!this.enabled) {
            return { success: false, error: 'Razorpay not configured' };
        }
        try {
            const payment = await this.razorpay.payments.fetch(paymentId);

            return {
                success: true,
                payment: {
                    id: payment.id,
                    amount: payment.amount / 100,
                    status: payment.status,
                    method: payment.method,
                    createdAt: new Date(payment.created_at * 1000),
                    notes: payment.notes
                }
            };
        } catch (error) {
            console.error('Payment details error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Cancel payment link
     */
    async cancelPaymentLink(paymentLinkId) {
        if (!this.enabled) {
            return { success: false, error: 'Razorpay not configured' };
        }
        try {
            const paymentLink = await this.razorpay.paymentLink.cancel(paymentLinkId);

            return {
                success: true,
                status: paymentLink.status
            };
        } catch (error) {
            console.error('Payment link cancellation error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = new RazorpayService();
