const express = require('express');
const router = express.Router();
const razorpayService = require('../services/razorpayService');
const returnService = require('../services/returnService');
const whatsappService = require('../services/whatsappService');
const { dbAdapter } = require('../database/db');

/**
 * Razorpay Payment Webhook
 */
router.post('/razorpay', async (req, res) => {
    try {
        const webhookSignature = req.headers['x-razorpay-signature'];
        const webhookBody = req.body;

        // Verify signature
        const isValid = razorpayService.verifyWebhookSignature(webhookBody, webhookSignature);

        if (!isValid) {
            console.error('Invalid Razorpay webhook signature');
            return res.status(400).json({ error: 'Invalid signature' });
        }

        const event = webhookBody.event;
        const payload = webhookBody.payload.payment.entity;

        console.log('Razorpay webhook event:', event);

        // Handle payment success
        if (event === 'payment.captured') {
            await handlePaymentSuccess(payload);
        }

        // Handle payment failure
        if (event === 'payment.failed') {
            await handlePaymentFailure(payload);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Razorpay webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/**
 * Shiprocket Return Status Webhook
 */
router.post('/shiprocket/return', async (req, res) => {
    try {
        const webhookData = req.body;
        console.log('Shiprocket return webhook:', webhookData);

        const { order_id, status, awb } = webhookData;

        // Find return by Shiprocket order ID
        const returns = await dbAdapter.select('returns', { shiprocket_return_id: order_id }, { limit: 1 });
        const returnRecord = returns[0];

        if (returnRecord) {
            // Update return status
            await returnService.updateReturnStatus(returnRecord.return_id, status);

            // Notify customer
            await notifyCustomerReturnStatus(returnRecord, status);
        }

        // Check for exchange
        const exchanges = await dbAdapter.select('exchanges', { shiprocket_exchange_id: order_id }, { limit: 1 });
        const exchangeRecord = exchanges[0];

        if (exchangeRecord) {
            // Update exchange status
            await returnService.updateExchangeStatus(exchangeRecord.exchange_id, status);

            // Notify customer
            await notifyCustomerExchangeStatus(exchangeRecord, status);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Shiprocket webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/**
 * Handle successful payment
 */
async function handlePaymentSuccess(payment) {
    try {
        const orderId = payment.notes.order_id;
        const paymentId = payment.id;

        console.log('Payment successful for order:', orderId);

        // Find exchange by order ID
        const exchanges = await dbAdapter.select('exchanges', { order_id: orderId, payment_status: 'pending' }, { limit: 1 });
        const exchange = exchanges[0];

        if (exchange) {
            // Complete the exchange
            const result = await returnService.completeExchange(
                exchange.exchange_id,
                exchange.payment_link_id
            );

            if (result.success) {
                const body = [
                    `⚫ *OFFCOMFRT — PAYMENT CONFIRMED*`,
                    ``,
                    ``,
                    `▫️ Your payment has been successfully processed.`,
                    ``,
                    `▫️ *Exchange ID:* ${exchange.exchange_id}`,
                    `▫️ *Payment ID:* ${paymentId}`,
                    `▫️ *Pickup Date:* ${result.pickupDate}`,
                    ``,
                    `▫️ Please keep your old items ready for pickup.`,
                    `▫️ Your new items will be shipped after quality check.`,
                    ``,
                    ``,
                    ''
                ].join('\n');

                await whatsappService.sendRichNotification(exchange.customer_phone, {
                    body,
                    buttonLabel: 'Track Exchange',
                    buttonUrl: 'https://offcomfrt.in/pages/track-request',
                    
                    plainFallback: `Payment confirmed. Exchange ID: ${exchange.exchange_id}. Pickup: ${result.pickupDate}`
                });
            }
        }
    } catch (error) {
        console.error('Payment success handler error:', error);
    }
}

/**
 * Handle failed payment
 */
async function handlePaymentFailure(payment) {
    try {
        const orderId = payment.notes.order_id;

        console.log('Payment failed for order:', orderId);

        // Find exchange
        const exchanges = await dbAdapter.select('exchanges', { order_id: orderId, payment_status: 'pending' }, { limit: 1 });
        const exchange = exchanges[0];

        if (exchange) {
            const reason = payment.error_description || 'Payment declined';
            const body = [
                `⚫ *OFFCOMFRT — PAYMENT UNSUCCESSFUL*`,
                ``,
                ``,
                `▫️ We were unable to process your payment.`,
                ``,
                `▫️ *Exchange ID:* ${exchange.exchange_id}`,
                `▫️ *Reason:* ${reason}`,
                ``,
                `▫️ Please try again using the button below.`,
                `▫️ If you need assistance, reply or write to *support@offcomfrt.in*.`,
                ``,
                ``,
                ''
            ].join('\n');

            // Use the Razorpay payment link if available so customer can retry
            const retryUrl = exchange.payment_link || 'https://offcomfrt.in/pages/track-request';

            await whatsappService.sendRichNotification(exchange.customer_phone, {
                body,
                buttonLabel: 'Retry Payment',
                buttonUrl: retryUrl,
                
                plainFallback: `Payment failed for Exchange ${exchange.exchange_id}. Reason: ${reason}. Please try again.`
            });
        }
    } catch (error) {
        console.error('Payment failure handler error:', error);
    }
}

/**
 * Notify customer of return status update
 */
async function notifyCustomerReturnStatus(returnRecord, status) {
    try {
        const statusInfo = {
            'pickup_scheduled': {
                detail: `Your return pickup has been scheduled. Please keep your items ready with the original packaging.`
            },
            'picked_up': {
                detail: `Your return items have been picked up and are on their way to our warehouse.`
            },
            'delivered_to_warehouse': {
                detail: `Your items have reached our warehouse. Quality check is now in progress.`
            },
            'qc_passed': {
                detail: `Your return has been approved. Store credit will be issued within 3 to 5 business days.`
            },
            'qc_failed': {
                detail: `Your return could not be approved. Items will be sent back to you. Please reply to this message or write to *support@offcomfrt.in* for assistance.`
            },
            'refund_processed': {
                detail: `Your store credit of *Rs.${returnRecord.refund_amount}* has been issued and is now available in your account.`
            },
            'completed': {
                detail: `Your return has been successfully completed. Thank you for choosing Offcomfrt.`
            }
        };

        const info = statusInfo[status];
        if (!info) return;

        const humanStatus = status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

        const body = [
            `⚫ *OFFCOMFRT — RETURN STATUS UPDATE*`,
            ``,
            ``,
            `▫️ *Return ID:* ${returnRecord.return_id}`,
            `▫️ *Status:* ${humanStatus}`,
            ``,
            `▫️ ${info.detail}`,
            ``,
            ``,
            ''
        ].join('\n');

        await whatsappService.sendRichNotification(returnRecord.customer_phone, {
            body,
            buttonLabel: 'View Return Status',
            buttonUrl: 'https://offcomfrt.in/pages/track-request',
            
            plainFallback: `Return ${returnRecord.return_id} — ${humanStatus}: ${info.detail}`
        });
    } catch (error) {
        console.error('Return notification error:', error);
    }
}

/**
 * Notify customer of exchange status update
 */
async function notifyCustomerExchangeStatus(exchangeRecord, status) {
    try {
        const statusInfo = {
            'pickup_scheduled': {
                detail: `Your exchange pickup has been scheduled. Please keep your old items ready for the courier.`
            },
            'picked_up': {
                detail: `Your old items have been picked up and are heading to our warehouse for quality check.`
            },
            'qc_passed': {
                detail: `Quality check passed. Your new items will be shipped shortly.`
            },
            'qc_failed': {
                detail: `Your exchange could not be approved. Please reply to this message or write to *support@offcomfrt.in* for assistance.`
            },
            'new_order_created': {
                detail: `Your new items have been dispatched. Tracking details will be shared once available.`
            },
            'completed': {
                detail: `Your exchange is complete. We hope you enjoy your new items. Thank you for choosing Offcomfrt.`
            }
        };

        const info = statusInfo[status];
        if (!info) return;

        const humanStatus = status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

        const body = [
            `⚫ *OFFCOMFRT — EXCHANGE STATUS UPDATE*`,
            ``,
            ``,
            `▫️ *Exchange ID:* ${exchangeRecord.exchange_id}`,
            `▫️ *Status:* ${humanStatus}`,
            ``,
            `▫️ ${info.detail}`,
            ``,
            ``,
            ''
        ].join('\n');

        await whatsappService.sendRichNotification(exchangeRecord.customer_phone, {
            body,
            buttonLabel: 'Track Exchange',
            buttonUrl: 'https://offcomfrt.in/pages/track-request',
            
            plainFallback: `Exchange ${exchangeRecord.exchange_id} — ${humanStatus}: ${info.detail}`
        });
    } catch (error) {
        console.error('Exchange notification error:', error);
    }
}

/**
 * Payment callback (for redirect after payment)
 */
router.get('/payment/callback', async (req, res) => {
    const { razorpay_payment_id, razorpay_payment_link_id } = req.query;

    if (razorpay_payment_id) {
        res.send(`
            <html>
                <head>
                    <title>Payment Successful</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; }
                        .success { color: #28a745; font-size: 24px; margin: 20px; }
                        .info { color: #666; margin: 10px; }
                    </style>
                </head>
                <body>
                    <h1 class="success">✅ Payment Successful!</h1>
                    <p class="info">Your exchange request is being processed.</p>
                    <p class="info">You'll receive updates on WhatsApp.</p>
                    <p class="info">Payment ID: ${razorpay_payment_id}</p>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>Payment Failed</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; }
                        .error { color: #dc3545; font-size: 24px; margin: 20px; }
                        .info { color: #666; margin: 10px; }
                    </style>
                </head>
                <body>
                    <h1 class="error">❌ Payment Failed</h1>
                    <p class="info">Your payment could not be processed.</p>
                    <p class="info">Please try again or contact support.</p>
                </body>
            </html>
        `);
    }
});

module.exports = router;
