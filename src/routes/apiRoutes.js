const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const { dbAdapter } = require('../database/db');

// Internal token validation middleware
function validateInternalToken(req, res, next) {
    const token = req.headers['x-internal-token'];
    const expectedToken = process.env.WHATSAPP_INTERNAL_TOKEN;
    
    // Skip validation if token is not configured (dev mode)
    if (!expectedToken) {
        console.warn('⚠️ WHATSAPP_INTERNAL_TOKEN not configured - skipping validation');
        return next();
    }
    
    if (token !== expectedToken) {
        console.warn(`❌ Unauthorized internal request - token mismatch`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
}

// Internal endpoint to send WhatsApp notification
// Supports both plain text messages and template-based notifications for return coupons
router.post('/send-notification', validateInternalToken, async (req, res) => {
    try {
        const { phone, message, type, requestId, templateData } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'Phone is required' });
        }

        // Clean phone number (ensure country code)
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.length === 10) {
            formattedPhone = '91' + formattedPhone;
        }

        // Check if this is a return approved discount template request
        // The discount code is already created by exchange-return-tracking server
        if (templateData?.templateName === 'return_approved_discount') {
            console.log(`🎁 [${requestId}] Processing return approved discount template for ${formattedPhone}`);
            
            try {
                // Send WhatsApp template with the pre-generated discount code
                // The discount code (discountCode) is passed from exchange-return-tracking
                const templatePayload = {
                    name: 'return_approved_discount',
                    language: { code: 'en_US' },
                    components: [{
                        type: 'body',
                        parameters: [
                            { type: 'text', text: templateData.customerName || 'Valued Customer' },
                            { type: 'text', text: templateData.orderNumber || 'N/A' },
                            { type: 'text', text: templateData.discountCode || templateData.code || 'N/A' },
                            { type: 'text', text: templateData.value || '10%' },
                            { type: 'text', text: templateData.usage || 'Unlimited' }
                        ]
                    }]
                };
                
                const result = await whatsappService.sendTemplate(formattedPhone, templatePayload);
                
                console.log(`📤 [${requestId}] WhatsApp template sent to ${formattedPhone}`);
                res.json({ 
                    success: true, 
                    messageId: result.messages?.[0]?.id
                });
            } catch (templateError) {
                console.error(`❌ [${requestId}] Failed to send template:`, templateError.message);
                
                // Fallback: send plain text message if template fails
                if (message) {
                    console.log(`📤 [${requestId}] Falling back to plain text message`);
                    const fallbackResult = await whatsappService.sendMessage(formattedPhone, message);
                    res.json({ 
                        success: true, 
                        messageId: fallbackResult.messages?.[0]?.id,
                        fallback: true
                    });
                } else {
                    res.status(500).json({ error: 'Failed to send return coupon notification' });
                }
            }
        } else {
            // Existing behavior: send plain text message
            if (!message) {
                return res.status(400).json({ error: 'Message is required for plain text notifications' });
            }

            console.log(`📨 Internal Request: Texting ${formattedPhone} for Ref: ${requestId || 'N/A'}`);

            const result = await whatsappService.sendMessage(formattedPhone, message);

            res.json({ success: true, messageId: result.messages?.[0]?.id });
        }
    } catch (error) {
        console.error('❌ Failed to send internal notification:', error.message);
        res.status(500).json({ error: 'Failed to send WhatsApp message' });
    }
});

// Authenticate Shoppers Hub Access
router.post('/shoppers/auth', (req, res) => {
    try {
        const { password } = req.body;
        const expectedPassword = process.env.SHOPPERS_HUB_PASSWORD;

        if (!expectedPassword) {
            console.error('❌ SHOPPERS_HUB_PASSWORD is not set in environment variables');
            return res.status(500).json({ success: false, error: 'Server configuration error. Contact admin.' });
        }

        const submitted = (password || '').toString().trim();
        const expected = (expectedPassword || '').toString().trim();

        if (submitted === expected) {
            const jwt = require('jsonwebtoken');
            const token = jwt.sign(
                { username: 'shopper_admin', role: 'admin' },
                process.env.JWT_SECRET || 'fallback_secret',
                { expiresIn: '24h' }
            );
            res.json({ success: true, token });
        } else {
            console.log(`❌ Auth failed. Submitted length: ${submitted.length}, Expected length: ${expected.length}`);
            res.status(401).json({ success: false, error: 'Invalid Credentials Provided' });
        }
    } catch (error) {
        console.error('❌ Auth error:', error.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

module.exports = router;
