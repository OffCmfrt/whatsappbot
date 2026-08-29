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
// Smart login:
//   - username + password → operator login (hub_operators table, scoped JWT)
//   - password only       → legacy master-admin access code
router.post('/shoppers/auth', async (req, res) => {
    try {
        const { username, password } = req.body;
        const jwt = require('jsonwebtoken');
        const bcrypt = require('bcryptjs');
        const secret = process.env.JWT_SECRET || 'fallback_secret';
        const submittedUser = (username || '').toString().trim().toLowerCase();

        // Operator login (ID + password)
        if (submittedUser) {
            const rows = await dbAdapter.query(
                'SELECT * FROM hub_operators WHERE LOWER(username) = ? LIMIT 1',
                [submittedUser]
            );
            const operator = rows[0];

            if (!operator) {
                return res.status(401).json({ success: false, error: 'Invalid Credentials Provided' });
            }
            if (!operator.is_active) {
                return res.status(403).json({ success: false, error: 'This account has been deactivated. Contact admin.' });
            }

            const passwordOk = await bcrypt.compare((password || '').toString(), operator.password_hash);
            if (!passwordOk) {
                await dbAdapter.run(
                    'INSERT INTO hub_operator_activity (operator_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)',
                    [operator.id, operator.username, 'login_failed', 'Invalid password', (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)]
                ).catch(() => {});
                return res.status(401).json({ success: false, error: 'Invalid Credentials Provided' });
            }

            const permissions = Array.isArray(operator.permissions) ? operator.permissions : [];

            // Single-session enforcement: mint a unique session id and store it
            // on the account. Any previously active session stops working the
            // moment this login commits (newest login wins). Admin is exempt.
            const crypto = require('crypto');
            const sid = crypto.randomBytes(24).toString('hex');
            const token = jwt.sign(
                { operatorId: operator.id, username: operator.username, role: 'operator', permissions, sid },
                secret,
                { expiresIn: '12h' }
            );

            const clientIp = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);

            // Update last login + claim the single-session slot. This must not
            // fail silently — the token is useless unless the sid is stored.
            await dbAdapter.run(
                'UPDATE hub_operators SET last_login_at = CURRENT_TIMESTAMP, active_session_id = ?, session_ip = ?, session_started_at = CURRENT_TIMESTAMP WHERE id = ?',
                [sid, clientIp, operator.id]
            );
            await dbAdapter.run(
                'INSERT INTO hub_operator_activity (operator_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)',
                [operator.id, operator.username, 'login', operator.active_session_id ? 'Operator logged in (replaced an existing session)' : 'Operator logged in', clientIp]
            ).catch(() => {});

            return res.json({
                success: true,
                token,
                role: 'operator',
                username: operator.username,
                name: operator.name || operator.username,
                permissions
            });
        }

        // Legacy password-only master admin login
        const expectedPassword = process.env.SHOPPERS_HUB_PASSWORD;

        if (!expectedPassword) {
            console.error('❌ SHOPPERS_HUB_PASSWORD is not set in environment variables');
            return res.status(500).json({ success: false, error: 'Server configuration error. Contact admin.' });
        }

        const submitted = (password || '').toString().trim();
        const expected = (expectedPassword || '').toString().trim();

        if (submitted === expected) {
            // credFp ties the session to the current SHOPPERS_HUB_PASSWORD so
            // changing it in the environment instantly invalidates old sessions
            const { hubCredentialFingerprint } = require('../middleware/auth');
            const token = jwt.sign(
                { username: 'shopper_admin', role: 'admin', credFp: hubCredentialFingerprint() },
                secret,
                { expiresIn: '24h' }
            );
            res.json({ success: true, token, role: 'admin' });
        } else {
            console.log(`❌ Auth failed. Submitted length: ${submitted.length}, Expected length: ${expected.length}`);
            res.status(401).json({ success: false, error: 'Invalid Credentials Provided' });
        }
    } catch (error) {
        console.error('❌ Auth error:', error.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// Internal read-only data endpoint for the exchange-return system's AI copilot.
// Auth: x-internal-token (WHATSAPP_INTERNAL_TOKEN). Resources: stats, tickets, messages, carts, customers.
router.get('/ai-data', validateInternalToken, async (req, res) => {
    try {
        const { resource, query = '', limit } = req.query;
        const n = Math.min(parseInt(limit) || 20, 50);
        const q = String(query).trim();

        switch (resource) {
            case 'stats': {
                const [customers, tickets, carts, messages] = await Promise.all([
                    dbAdapter.query('SELECT COUNT(*)::int AS c FROM customers'),
                    dbAdapter.query(`SELECT COUNT(*)::int AS c FROM support_tickets WHERE status = 'open'`),
                    dbAdapter.query(`SELECT COUNT(*)::int AS c FROM abandoned_carts WHERE status = 'pending'`),
                    dbAdapter.query('SELECT COUNT(*)::int AS c FROM messages')
                ]);
                return res.json({
                    totalCustomers: customers[0]?.c || 0,
                    openTickets: tickets[0]?.c || 0,
                    pendingAbandonedCarts: carts[0]?.c || 0,
                    totalMessages: messages[0]?.c || 0
                });
            }
            case 'tickets': {
                const params = [];
                let sql = 'SELECT id, ticket_number, customer_phone, customer_name, message, status, created_at FROM support_tickets WHERE 1=1';
                if (q) { sql += ' AND (customer_phone LIKE ? OR status = ? OR ticket_number ILIKE ?)'; params.push(`%${q.replace(/\D/g, '').slice(-10) || q}`, q, `%${q}%`); }
                sql += ' ORDER BY created_at DESC LIMIT ?';
                params.push(n);
                const rows = await dbAdapter.query(sql, params);
                return res.json({ count: rows.length, tickets: rows });
            }
            case 'messages': {
                if (!q) return res.status(400).json({ error: 'query (phone) is required for messages' });
                const rows = await dbAdapter.query(
                    `SELECT message_type, message_content, status, created_at FROM messages
                     WHERE customer_phone LIKE ? ORDER BY id DESC LIMIT ?`,
                    [`%${q.replace(/\D/g, '').slice(-10)}`, n]
                );
                return res.json({ count: rows.length, messages: rows.reverse() });
            }
            case 'carts': {
                const params = [];
                let sql = 'SELECT checkout_id, customer_phone, customer_name, total_amount, currency, status, created_at FROM abandoned_carts WHERE 1=1';
                if (q) { sql += ' AND (status = ? OR customer_phone LIKE ?)'; params.push(q, `%${q.replace(/\D/g, '').slice(-10) || q}`); }
                sql += ' ORDER BY created_at DESC LIMIT ?';
                params.push(n);
                const rows = await dbAdapter.query(sql, params);
                return res.json({ count: rows.length, carts: rows });
            }
            case 'customers': {
                if (!q) return res.status(400).json({ error: 'query is required for customers' });
                const like = `%${q}%`;
                const rows = await dbAdapter.query(
                    `SELECT phone, name, email, order_count, created_at FROM customers
                     WHERE phone ILIKE ? OR name ILIKE ? OR email ILIKE ? ORDER BY updated_at DESC NULLS LAST LIMIT ?`,
                    [like, like, like, n]
                );
                return res.json({ count: rows.length, customers: rows });
            }
            default:
                return res.status(400).json({ error: `Unknown resource '${resource}'. Use: stats, tickets, messages, carts, customers` });
        }
    } catch (error) {
        console.error('❌ AI data endpoint error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
