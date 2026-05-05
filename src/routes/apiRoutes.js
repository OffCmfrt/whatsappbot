const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const { dbAdapter } = require('../database/db');

// Internal endpoint to send WhatsApp notification
router.post('/send-notification', async (req, res) => {
    try {
        const { phone, message, type, requestId } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }

        console.log(`📨 Internal Request: Texting ${phone} for Ref: ${requestId || 'N/A'}`);

        // Clean phone number (ensure country code)
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.length === 10) {
            formattedPhone = '91' + formattedPhone;
        }

        const result = await whatsappService.sendMessage(formattedPhone, message);

        res.json({ success: true, messageId: result.messages?.[0]?.id });
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
