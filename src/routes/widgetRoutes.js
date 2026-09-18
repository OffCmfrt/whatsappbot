const express = require('express');
const router = express.Router();
const { createWidgetTicket, generateEscalationSummary } = require('../services/ai/customerAgent');

/**
 * POST /api/widget/create-ticket
 * Create a context-rich support ticket with AI summary and WhatsApp deep link
 */
router.post('/create-ticket', async (req, res) => {
    try {
        const {
            name,
            phone,
            email,
            message,
            orderId,
            source,
            sessionId,
            visitorId,
            context,
            chatHistory
        } = req.body || {};

        const result = await createWidgetTicket({
            name,
            phone,
            email,
            message,
            orderId,
            source: source || 'widget',
            sessionId,
            visitorId,
            context: context || {},
            chatHistory: chatHistory || []
        });

        return res.json(result);
    } catch (error) {
        console.error('Error in /api/widget/create-ticket:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to create support ticket'
        });
    }
});

/**
 * POST /api/widget/chat
 * Bot simulation endpoint for testbot widget
 */
router.post('/chat', async (req, res) => {
    try {
        const { message, sessionId, orderId, context } = req.body || {};
        const cleanMsg = (message || '').trim();
        const lowerMsg = cleanMsg.toLowerCase();

        let responseText = '';
        let detectedScenario = context?.detectedScenario || null;
        let actionCards = null;

        // SOP Scenarios diagnostic & response routing
        if (lowerMsg.includes('track') || lowerMsg.includes('status') || lowerMsg.includes('where is my order')) {
            detectedScenario = 'ORDER_TRACKING';
            responseText = `Your order #${orderId || '53686'} is currently in transit with OFFCOMFRT Fulfillment. Estimated delivery: 2 business days.`;
        } else if (lowerMsg.includes('delivered but not received') || lowerMsg.includes('fake delivery') || lowerMsg.includes('pod')) {
            detectedScenario = 'POD_INVESTIGATION';
            responseText = `We apologize for the delivery discrepancy. We have logged a priority 24-hour POD (Proof of Delivery) investigation for Order #${orderId || '53686'} with the carrier.`;
        } else if (lowerMsg.includes('cod') || lowerMsg.includes('cash') || lowerMsg.includes('double payment')) {
            detectedScenario = 'COD_DOUBLE_PAYMENT_REFUND';
            responseText = `If the courier requested COD cash for an online prepaid order #${orderId || '53686'}, please collect the courier receipt. We will issue an immediate doorstep refund to your original payment mode upon verification.`;
        } else if (lowerMsg.includes('return') || lowerMsg.includes('exchange')) {
            detectedScenario = 'RETURN_ELIGIBILITY';
            responseText = `Returns are eligible within 48 hours of delivery. Store credit is provided for preference or size returns; original payment refund applies for damaged or wrong items.`;
        } else if (lowerMsg.includes('wrong item')) {
            detectedScenario = 'WRONG_ITEM_CLAIM';
            responseText = `We sincerely apologize for sending the wrong item. Please provide an unboxing video showing the shipping label for verification.`;
        } else if (lowerMsg.includes('damaged')) {
            detectedScenario = 'DAMAGED_ITEM_CLAIM';
            responseText = `We apologize for the damaged item in Order #${orderId || '53686'}. Please share clear photos showing the damaged product with tags attached.`;
        } else if (lowerMsg.includes('escalate') || lowerMsg.includes('human') || lowerMsg.includes('agent')) {
            detectedScenario = 'HUMAN_ESCALATION';
            responseText = `Connecting you to human support specialist...`;
        } else {
            responseText = `Thank you for contacting OFFCOMFRT Support! How can I assist you today with Order #${orderId || '53686'}?`;
        }

        return res.json({
            success: true,
            reply: responseText,
            detectedScenario,
            orderId: orderId || '53686',
            actionCards
        });
    } catch (error) {
        console.error('Error in /api/widget/chat:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
