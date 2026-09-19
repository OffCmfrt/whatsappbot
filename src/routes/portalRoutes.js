const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const whatsappService = require('../services/whatsappService');
const { dbAdapter } = require('../database/db');

// Portal auth middleware
async function verifyPortalToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No portal token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.portalId || !decoded.slug) {
            return res.status(401).json({ error: 'Invalid portal token.' });
        }

        // Single-session enforcement: only the newest portal login is valid.
        // Tokens missing a sid (issued before this enforcement) are rejected
        // so every portal must re-login once.
        const portals = await dbAdapter.query(
            'SELECT active_session_id FROM support_portals WHERE id = ?',
            [decoded.portalId]
        );
        const portal = portals && portals[0];
        if (!portal || !decoded.sid || decoded.sid !== portal.active_session_id) {
            return res.status(401).json({ error: 'Your session was ended — this portal is logged in somewhere else. Only one active session is allowed.' });
        }

        req.portal = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired portal token.' });
    }
}

// Cache Intl.DateTimeFormat per timezone — each instance allocates native ICU memory
// outside the V8 heap, so re-creating them on every check bloats RSS
const timeFormatterCache = new Map();
function getTimeFormatter(timezone) {
    let fmt = timeFormatterCache.get(timezone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit' });
        timeFormatterCache.set(timezone, fmt);
    }
    return fmt;
}

// Helper to check if a ticket's created time falls within portal time range
function isTicketInTimeRange(ticket, config) {
    if (!config || !config.time_start || !config.time_end) return true;

    const createdAt = new Date(ticket.created_at);
    const timezone = config.timezone || 'Asia/Kolkata';

    // Convert to target timezone using the cached formatter
    const timeStr = getTimeFormatter(timezone).format(createdAt);
    const [hour, minute] = timeStr.split(':').map(Number);
    const ticketMinutes = hour * 60 + minute;

    const [startHour, startMin] = config.time_start.split(':').map(Number);
    const [endHour, endMin] = config.time_end.split(':').map(Number);
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    if (startMinutes <= endMinutes) {
        // Normal range (e.g., 06:00 to 18:00)
        return ticketMinutes >= startMinutes && ticketMinutes < endMinutes;
    } else {
        // Overnight range (e.g., 18:00 to 06:00)
        return ticketMinutes >= startMinutes || ticketMinutes < endMinutes;
    }
}

// Build a Postgres WHERE fragment matching tickets whose created_at (stored as UTC) falls
// within the portal's IST time-of-day window. Returns null when the config has no range.
// Bounds are validated integers and the timezone is whitelisted, so inlining is injection-safe.
function timeRangeSqlClause(config, col = 'created_at') {
    if (!config || !config.time_start || !config.time_end) return null;
    const tz = /^[A-Za-z0-9_+\-/]+$/.test(config.timezone || '') ? config.timezone : 'Asia/Kolkata';
    const [sh, sm] = String(config.time_start).split(':').map(Number);
    const [eh, em] = String(config.time_end).split(':').map(Number);
    if ([sh, sm, eh, em].some(n => !Number.isFinite(n))) return null;
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const local = `(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${tz}')`;
    const mins = `(EXTRACT(HOUR FROM ${local}) * 60 + EXTRACT(MINUTE FROM ${local}))`;
    return start <= end
        ? `${mins} >= ${start} AND ${mins} < ${end}`
        : `(${mins} >= ${start} OR ${mins} < ${end})`;
}

// Helper to get portal tickets
async function getPortalTickets(portalId, portalType, portalConfig) {
    if (portalType === 'time_based') {
        const config = portalConfig
            ? (typeof portalConfig === 'string' ? JSON.parse(portalConfig) : portalConfig)
            : {};
        const rangeClause = timeRangeSqlClause(config);
        if (!rangeClause) {
            // No time window configured — fall back to explicitly-assigned tickets only
            return await dbAdapter.query(
                'SELECT * FROM support_tickets WHERE portal_id = ? ORDER BY created_at DESC LIMIT 200',
                [portalId]
            );
        }
        // Show BOTH explicitly-assigned tickets (from round-robin or split/transfer)
        // AND unassigned tickets whose created_at falls within the portal's time window.
        // This ensures the portal sees its full fair share regardless of how tickets arrived.
        return await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE portal_id = ? OR (portal_id IS NULL AND ${rangeClause})
             ORDER BY created_at DESC LIMIT 200`,
            [portalId]
        );
    } else {
        // manual or auto
        return await dbAdapter.query(
            'SELECT * FROM support_tickets WHERE portal_id = ? ORDER BY created_at DESC LIMIT 200',
            [portalId]
        );
    }
}

// Helper to verify a phone belongs to the portal
async function verifyPhoneInPortal(phone, portal) {
    const tickets = await getPortalTickets(portal.portalId, portal.type, portal.config);
    
    // Instagram customers: phone is the raw IG user ID (numeric).
    // Match via channel = 'instagram' AND ig_user_id = phone.
    const isIG = tickets.some(t => (t.channel || 'whatsapp') === 'instagram' && t.ig_user_id === phone);
    if (isIG) return true;

    // Normalize the input phone number
    const cleanPhone = phone.replace(/\D/g, '');
    const possibleFormats = [
        cleanPhone,
        `+${cleanPhone}`,
        `91${cleanPhone}`,
        `+91${cleanPhone}`
    ];
    
    // Check if any ticket's customer_phone matches any of the possible formats
    return tickets.some(t => {
        const ticketPhone = t.customer_phone.replace(/\D/g, '');
        return possibleFormats.some(format => format.replace(/\D/g, '') === ticketPhone);
    });
}

// Portal authentication
router.post('/auth', async (req, res) => {
    try {
        const { slug, password } = req.body;

        if (!slug || !password) {
            return res.status(400).json({ success: false, error: 'Slug and password are required' });
        }

        const portals = await dbAdapter.query(
            'SELECT * FROM support_portals WHERE slug = ?',
            [slug]
        );

        if (!portals || portals.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid portal credentials' });
        }

        const portal = portals[0];
        const validPassword = await bcrypt.compare(password, portal.password_hash);

        if (!validPassword) {
            return res.status(401).json({ success: false, error: 'Invalid portal credentials' });
        }

        // Single-session enforcement: mint a session id and store it on the
        // portal — any earlier portal session stops working immediately.
        const crypto = require('crypto');
        const sid = crypto.randomBytes(24).toString('hex');
        await dbAdapter.run(
            'UPDATE support_portals SET active_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [sid, portal.id]
        );

        const token = jwt.sign(
            { portalId: portal.id, slug: portal.slug, type: portal.type, config: portal.config, sid },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            success: true,
            token,
            portal: {
                id: portal.id,
                name: portal.name,
                slug: portal.slug,
                type: portal.type
            }
        });
    } catch (error) {
        console.error('Portal auth error:', error);
        res.status(500).json({ success: false, error: 'Authentication failed' });
    }
});

// Verify portal token is still valid
router.get('/:slug/verify', verifyPortalToken, async (req, res) => {
    res.json({ success: true, portal: { slug: req.portal.slug, name: req.portal.name || req.portal.slug } });
});

// Get tickets for a portal
router.get('/:slug/tickets', verifyPortalToken, async (req, res) => {
    try {
        const { slug } = req.params;

        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }

        const portals = await dbAdapter.query(
            'SELECT * FROM support_portals WHERE slug = ?',
            [slug]
        );

        if (!portals || portals.length === 0) {
            return res.status(404).json({ error: 'Portal not found' });
        }

        const portal = portals[0];
        const { status, channel } = req.query;
        let tickets = await getPortalTickets(portal.id, portal.type, portal.config);

        if (status) {
            tickets = tickets.filter(t => t.status === status);
        }

        // Channel filter: 'whatsapp', 'instagram', or undefined for all
        if (channel) {
            tickets = tickets.filter(t => {
                const ticketChannel = t.channel || 'whatsapp';
                return ticketChannel === channel;
            });
        }

        res.json({ success: true, tickets });
    } catch (error) {
        console.error('Portal tickets error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch tickets' });
    }
});

// Get chat history for a phone (portal-scoped)
router.get('/:slug/chat/:phone', verifyPortalToken, async (req, res) => {
    try {
        const { slug, phone } = req.params;

        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }

        // Verify this phone has a ticket in the portal
        const hasAccess = await verifyPhoneInPortal(phone, req.portal);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Phone not associated with this portal' });
        }

        // Determine if this is an Instagram customer by checking ticket channel.
        // phone param is the raw IG user ID for Instagram, or phone number for WhatsApp.
        const igTicket = await dbAdapter.query(
            `SELECT channel, ig_user_id FROM support_tickets 
             WHERE ig_user_id = ? AND status != 'resolved'
             ORDER BY created_at DESC LIMIT 1`,
            [phone]
        );
        const isInstagram = !!(igTicket?.[0]?.ig_user_id && (igTicket[0].channel || 'whatsapp') === 'instagram');
        let formattedPhone, customerInfo, messages, channel = 'whatsapp';

        if (isInstagram) {
            // Instagram customer — phone is the raw IG user ID
            const igUserId = phone;
            channel = 'instagram';

            // Get customer by IG PSID
            customerInfo = await dbAdapter.query(
                `SELECT name, phone, email, ig_username, ig_psid, primary_channel FROM customers 
                 WHERE ig_psid = ? LIMIT 1`,
                [igUserId]
            );

            // Get messages for this IG customer
            messages = await dbAdapter.query(
                `SELECT id, customer_phone, message_type, message_content, status, wa_message_id, channel, external_message_id, created_at
                 FROM messages
                 WHERE customer_phone = ?
                 ORDER BY created_at DESC
                 LIMIT 200`,
                [igUserId]
            );

            formattedPhone = igUserId;
        } else {
            // WhatsApp customer — original logic
            const cleanPhone = phone.replace(/\D/g, '');
            formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;

            // Get customer info - try multiple phone format variations
            customerInfo = await dbAdapter.query(
                `SELECT name, phone, email FROM customers 
                 WHERE phone = ? OR phone = ? OR phone = ? OR phone = ?
                 LIMIT 1`,
                [formattedPhone, `+${cleanPhone}`, `91${cleanPhone}`, cleanPhone]
            );

            // Get messages - try multiple phone format variations and get most recent 200
            messages = await dbAdapter.query(
                `SELECT id, customer_phone, message_type, message_content, status, wa_message_id, created_at
                 FROM messages
                 WHERE customer_phone = ? OR customer_phone = ? OR customer_phone = ? OR customer_phone = ?
                 ORDER BY created_at DESC
                 LIMIT 200`,
                [formattedPhone, `+${cleanPhone}`, `91${cleanPhone}`, cleanPhone]
            );
        }

        const formattedMessages = messages.reverse().map(msg => ({
            id: msg.id,
            type: msg.message_type,
            content: msg.message_content,
            status: msg.status,
            waMessageId: msg.wa_message_id,
            channel: msg.channel || 'whatsapp',
            externalMessageId: msg.external_message_id || null,
            timestamp: msg.created_at,
            isAdmin: msg.message_type === 'manual_reply' || msg.message_type === 'outgoing'
        }));

        // Mark ticket as read when chat is opened
        if (isInstagram) {
            await dbAdapter.query(
                `UPDATE support_tickets SET is_read = true WHERE ig_user_id = ? AND is_read = false`,
                [phone]
            );
        } else {
            const cleanPhone = phone.replace(/\D/g, '');
            await dbAdapter.query(
                `UPDATE support_tickets SET is_read = true WHERE customer_phone IN (?, ?, ?, ?) AND is_read = false`,
                [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`]
            );
        }

        res.json({
            success: true,
            phone: formattedPhone,
            channel,
            customer: customerInfo?.[0] || null,
            messages: formattedMessages
        });
    } catch (error) {
        console.error('Portal chat history error:', error);
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

// AI reply suggestions for a portal chat (drafts only — never auto-sent).
// Same engine as the admin dashboard, scoped to phones that belong to this portal.
router.post('/:slug/ai/suggest-reply', verifyPortalToken, async (req, res) => {
    try {
        const { slug } = req.params;
        const { phone, ticketId, prefetch } = req.body;

        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Customer phone is required' });
        }

        // Verify this phone has a ticket in the portal
        const hasAccess = await verifyPhoneInPortal(phone, req.portal);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Phone not associated with this portal' });
        }

        const { suggestReply } = require('../services/ai/suggestReply');
        const result = await suggestReply({
            actor: `portal:${slug}`,
            phone,
            ticketId: ticketId || null,
            prefetch: Boolean(prefetch)
        });
        res.json({ success: true, suggestions: result.suggestions });
    } catch (error) {
        console.error('Portal AI suggest-reply error:', error.message);
        const known = ['AI_NOT_CONFIGURED', 'AI_DISABLED', 'AI_LIMIT', 'NO_HISTORY', 'AI_RATE_LIMIT', 'AI_UNAVAILABLE'];
        const status = known.includes(error.code) ? 400 : 500;
        res.status(status).json({ success: false, error: known.includes(error.code) ? error.message : 'Failed to generate suggestions' });
    }
});

// Send message via portal
router.post('/:slug/chat/send', verifyPortalToken, async (req, res) => {
    try {
        const { slug } = req.params;
        const { phone, message, type = 'text', suggestedText = null } = req.body;

        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }

        // Verify this phone has a ticket in the portal
        const hasAccess = await verifyPhoneInPortal(phone, req.portal);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Phone not associated with this portal' });
        }

        // Check if this is an Instagram ticket
        const ticketRows = await dbAdapter.query(
            `SELECT channel, ig_user_id FROM support_tickets 
             WHERE customer_phone = ? AND status != 'resolved'
             ORDER BY created_at DESC LIMIT 1`,
            [phone]
        );
        const ticketChannel = ticketRows?.[0]?.channel || 'whatsapp';
        const igUserId = ticketRows?.[0]?.ig_user_id;

        let result;

        if (ticketChannel === 'instagram' && igUserId) {
            // Route through Instagram
            const instagramService = require('../services/instagramService');
            const igResult = await instagramService.sendMessage(igUserId, message, 'manual_reply');
            result = { messages: [{ id: igResult?.message_id || null }] };
        } else {
            // Route through WhatsApp (original logic)
            const cleanPhone = phone.replace(/\D/g, '');
            const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;

            if (type === 'template' && req.body.templateName) {
                const templateData = {
                    name: req.body.templateName,
                    language: { code: req.body.language || 'en_US' },
                    components: req.body.components || []
                };
                result = await whatsappService.sendTemplate(formattedPhone, templateData, 'manual_reply');
            } else {
                result = await whatsappService.sendMessage(formattedPhone, message, 'manual_reply');
            }

            // Update the WhatsApp shopper record using normalized phone variants.
            await dbAdapter.run(
                `UPDATE store_shoppers
                 SET last_response_at = ?,
                     response_count = COALESCE(response_count, 0) + 1
                 WHERE phone = ? OR phone = ? OR phone = ? OR phone = ?`,
                [new Date().toISOString(), formattedPhone, `+${cleanPhone}`, `91${cleanPhone}`, cleanPhone]
            );
        }

        // AI learning: pair this human reply with the customer's latest question
        // so future suggestions imitate approved answers (fire-and-forget).
        // suggestedText tells us if an AI draft was accepted as-is or corrected.
        if (type === 'text' && message) {
            const aiLearning = require('../services/ai/learning');
            aiLearning.learnFromAgentReply({ phone, replyText: message, suggestedText }).catch(() => {});
        }

        res.json({
            success: true,
            message: 'Message sent successfully',
            messageId: result?.messages?.[0]?.id || null
        });
    } catch (error) {
        console.error('Portal send message error:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

// Update ticket status via portal
router.put('/:slug/tickets/:id', verifyPortalToken, async (req, res) => {
    try {
        const { slug, id } = req.params;
        const { status } = req.body;

        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }

        if (!status) {
            return res.status(400).json({ success: false, error: 'Status is required' });
        }

        // Verify ticket belongs to portal
        const portals = await dbAdapter.query(
            'SELECT * FROM support_portals WHERE slug = ?',
            [slug]
        );

        if (!portals || portals.length === 0) {
            return res.status(404).json({ error: 'Portal not found' });
        }

        const portal = portals[0];
        let ticketQuery = 'SELECT * FROM support_tickets WHERE id = ?';
        const ticketParams = [id];

        if (portal.type !== 'time_based') {
            ticketQuery += ' AND portal_id = ?';
            ticketParams.push(portal.id);
        }

        const tickets = await dbAdapter.query(ticketQuery, ticketParams);

        if (!tickets || tickets.length === 0) {
            return res.status(403).json({ error: 'Ticket not found in this portal' });
        }

        // For time-based, verify ownership: explicitly-assigned tickets (split/transfer)
        // belong only to their portal; otherwise the ticket must fall in the time range.
        if (portal.type === 'time_based') {
            const t = tickets[0];
            if (t.portal_id) {
                if (String(t.portal_id) !== String(portal.id)) {
                    return res.status(403).json({ error: 'Ticket not in this portal' });
                }
            } else {
                const config = portal.config ? JSON.parse(portal.config) : {};
                if (!isTicketInTimeRange(t, config)) {
                    return res.status(403).json({ error: 'Ticket not in portal time range' });
                }
            }
        }

        await dbAdapter.run(
            'UPDATE support_tickets SET status = ? WHERE id = ?',
            [status, id]
        );

        res.json({ success: true, message: 'Ticket updated successfully' });
    } catch (error) {
        console.error('Portal update ticket error:', error);
        res.status(500).json({ success: false, error: 'Failed to update ticket' });
    }
});

// Mark ticket as read via portal
router.patch('/:slug/tickets/:id/mark-read', verifyPortalToken, async (req, res) => {
    try {
        const { slug, id } = req.params;

        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }

        // Verify ticket belongs to portal
        const portals = await dbAdapter.query(
            'SELECT * FROM support_portals WHERE slug = ?',
            [slug]
        );

        if (!portals || portals.length === 0) {
            return res.status(404).json({ error: 'Portal not found' });
        }

        const portal = portals[0];
        let ticketQuery = 'SELECT * FROM support_tickets WHERE id = ?';
        const ticketParams = [id];

        if (portal.type !== 'time_based') {
            ticketQuery += ' AND portal_id = ?';
            ticketParams.push(portal.id);
        }

        const tickets = await dbAdapter.query(ticketQuery, ticketParams);

        if (!tickets || tickets.length === 0) {
            return res.status(403).json({ error: 'Ticket not found in this portal' });
        }

        // Time-based ownership: assigned tickets (split/transfer) belong only to their portal;
        // otherwise the ticket must fall within this portal's time range.
        if (portal.type === 'time_based') {
            const t = tickets[0];
            if (t.portal_id) {
                if (String(t.portal_id) !== String(portal.id)) {
                    return res.status(403).json({ error: 'Ticket not in this portal' });
                }
            } else {
                const config = portal.config ? JSON.parse(portal.config) : {};
                if (!isTicketInTimeRange(t, config)) {
                    return res.status(403).json({ error: 'Ticket not in portal time range' });
                }
            }
        }

        await dbAdapter.query(
            `UPDATE support_tickets SET is_read = true WHERE id = ?`,
            [id]
        );

        res.json({ success: true, message: 'Ticket marked as read' });
    } catch (error) {
        console.error('Portal mark ticket as read error:', error);
        res.status(500).json({ success: false, error: 'Failed to mark ticket as read' });
    }
});

// ── Customer Details (aggregated: customer info + orders + returns) ──
// Phone numbers are stored in wildly different formats across tables:
//   tickets: 917499609179  (digits, country code)
//   store_shoppers: +91 8756560652, +916386146008 (+ prefix, spaces)
//   orders: 916000525998  (digits, country code)
// Solution: normalize by stripping all non-digits in SQL via REGEXP_REPLACE,
// then compare against the cleaned input phone.
//
// store_shoppers is the primary order source (every Shopify order creates a row).
// The orders table adds tracking data (AWB, courier, tracking_url).
// We merge both: store_shoppers for order details + orders for tracking info.
router.get('/:slug/customers/:phone/details', verifyPortalToken, async (req, res) => {
    try {
        const { slug, phone } = req.params;
        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }

        // Strip to digits only — this is the canonical comparison key
        const digits = phone.replace(/\D/g, '');
        const localDigits = digits.startsWith('91') && digits.length > 10 ? digits.slice(2) : digits;
        const intlDigits = !digits.startsWith('91') ? '91' + digits : digits;
        const digitVariants = [...new Set([digits, localDigits, intlDigits])];
        const placeholders = digitVariants.map(() => '?').join(',');

        console.log(`[PORTAL DETAILS] Looking up customer for phone=${phone}, digitVariants=${digitVariants.join(',')}`);

        // Parallel fetch: store_shoppers (orders+customer info), orders (tracking), returns server
        const [shoppers, trackingOrders, returnsResult] = await Promise.all([
            // ALL store_shoppers rows for this phone — these are the customer's orders
            dbAdapter.query(
                `SELECT phone, name, email, order_id, items_json, order_total, payment_method,
                        status, address, city, province, zip, country, delivery_type, source,
                        customer_message, created_at
                 FROM store_shoppers
                 WHERE REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') IN (${placeholders})
                 ORDER BY created_at DESC LIMIT 50`,
                digitVariants
            ),
            // Tracking data from orders table — match by phone OR by order_id from shoppers
            dbAdapter.query(
                `SELECT * FROM orders
                 WHERE customer_phone IN (${placeholders})
                    OR REGEXP_REPLACE(COALESCE(customer_phone, ''), '[^0-9]', '', 'g') IN (${placeholders})
                 ORDER BY created_at DESC LIMIT 50`,
                [...digitVariants, ...digitVariants]
            ),
            // Returns/exchanges from external server
            (async () => {
                const baseUrl = process.env.RETURNS_SERVER_URL;
                const token = process.env.WHATSAPP_INTERNAL_TOKEN;
                if (!baseUrl) return { connected: false, requests: [] };
                try {
                    const axios = require('axios');
                    const resp = await axios.get(
                        `${baseUrl.replace(/\/$/, '')}/api/internal/inventory-open-requests`,
                        { params: { window: 60 }, headers: { 'x-internal-token': token || '' }, timeout: 15000 }
                    );
                    if (!resp.data?.success) return { connected: false, requests: [] };
                    return { connected: true, requests: Array.isArray(resp.data.requests) ? resp.data.requests : [] };
                } catch (err) {
                    console.warn(`[PORTAL DETAILS] Returns server fetch failed: ${err.message}`);
                    return { connected: false, requests: [] };
                }
            })()
        ]);

        // Build tracking lookup by order_id — start with orders table
        const trackingByOrderId = new Map();
        for (const o of (trackingOrders || [])) {
            if (o.order_id) trackingByOrderId.set(String(o.order_id), o);
        }

        // Also query shipments table (authoritative source for tracking data)
        const shopperOrderIds = [...new Set((shoppers || []).map(s => String(s.order_id)))];
        if (shopperOrderIds.length > 0) {
            const oidPlaceholders = shopperOrderIds.map(() => '?').join(',');
            try {
                const shipments = await dbAdapter.query(
                    `SELECT order_id, awb, courier_name, tracking_url, status, carrier
                     FROM shipments
                     WHERE order_id IN (${oidPlaceholders})
                       AND status NOT IN ('cancelled', 'failed')
                     ORDER BY created_at DESC`,
                    [...shopperOrderIds]
                );
                for (const s of (shipments || [])) {
                    const oid = String(s.order_id);
                    const existing = trackingByOrderId.get(oid) || {};
                    // Shipments data takes priority for tracking fields
                    trackingByOrderId.set(oid, {
                        ...existing,
                        order_id: s.order_id,
                        awb: s.awb || existing.awb,
                        courier_name: s.courier_name || s.carrier || existing.courier_name,
                        tracking_url: s.tracking_url || existing.tracking_url,
                        shiprocket_order_id: existing.shiprocket_order_id,
                        expected_delivery: existing.expected_delivery
                    });
                }
                console.log(`[PORTAL DETAILS] Shipments lookup: ${shipments?.length || 0} rows for ${shopperOrderIds.size} orders`);
            } catch (err) {
                console.warn(`[PORTAL DETAILS] Shipments lookup failed: ${err.message}`);
            }
        }

        // Build unified order list from store_shoppers, enriched with tracking data
        const orders = (shoppers || []).map(s => {
            const tracking = trackingByOrderId.get(String(s.order_id));
            // Parse items_json if present
            let items = [];
            try {
                if (s.items_json) {
                    const parsed = JSON.parse(s.items_json);
                    items = Array.isArray(parsed) ? parsed : [parsed];
                }
            } catch (_) {}

            return {
                order_id: s.order_id,
                status: s.status || 'pending',
                created_at: s.created_at,
                total: s.order_total,
                payment_method: s.payment_method,
                product_name: items.length ? items.map(i => i.name || i.title || '').filter(Boolean).join(', ') : null,
                items,
                address: s.address ? [s.address, s.city, s.province, s.zip, s.country].filter(Boolean).join(', ') : null,
                city: s.city,
                province: s.province,
                delivery_type: s.delivery_type,
                // Tracking data from orders + shipments tables
                awb: tracking?.awb || null,
                courier_name: tracking?.courier_name || null,
                tracking_url: tracking?.tracking_url || null,
                shiprocket_order_id: tracking?.shiprocket_order_id || null,
                expected_delivery: tracking?.expected_delivery || null
            };
        });

        // If store_shoppers had no rows but orders table did, include those too
        const includedOrderIds = new Set(orders.map(o => String(o.order_id)));
        for (const to of (trackingOrders || [])) {
            if (!includedOrderIds.has(String(to.order_id))) {
                orders.push({
                    order_id: to.order_id,
                    status: to.status || 'pending',
                    created_at: to.created_at,
                    total: to.total,
                    payment_method: to.payment_method,
                    product_name: to.product_name || null,
                    items: [],
                    address: null,
                    awb: to.awb || null,
                    courier_name: to.courier_name || null,
                    tracking_url: to.tracking_url || null,
                    shiprocket_order_id: to.shiprocket_order_id || null,
                    expected_delivery: to.expected_delivery || null
                });
            }
        }

        // Sort by date descending
        orders.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        // Build customer profile from first store_shoppers row
        const firstShopper = shoppers?.[0];
        const customer = {
            name: firstShopper?.name || null,
            phone: firstShopper?.phone || phone,
            email: firstShopper?.email || null,
            city: firstShopper?.city || null,
            province: firstShopper?.province || null,
            totalOrders: orders.length,
            firstOrderAt: orders.length ? orders[orders.length - 1].created_at : null,
            lastOrderAt: orders.length ? orders[0].created_at : null
        };

        // Filter returns/exchanges to this customer's orders (fuzzy match on order_number)
        const allOrderIds = orders.map(o => String(o.order_id));
        const orderNums = new Set(allOrderIds);
        allOrderIds.forEach(id => {
            const numeric = id.replace(/\D/g, '');
            if (numeric) orderNums.add(numeric);
        });
        const customerReturns = (returnsResult.requests || []).filter(r => {
            const rn = String(r.order_number);
            const rnNumeric = rn.replace(/\D/g, '');
            return orderNums.has(rn) || orderNums.has(rnNumeric);
        });

        console.log(`[PORTAL DETAILS] ${orders.length} orders (${shoppers?.length || 0} from shoppers, ${trackingOrders?.length || 0} tracking), ${customerReturns.length} returns for ${phone}`);

        res.json({
            success: true,
            customer,
            orders: orders.slice(0, 50),
            returns: customerReturns,
            returnsConnected: returnsResult.connected
        });
    } catch (error) {
        console.error('[PORTAL DETAILS] Error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch customer details', details: error.message });
    }
});

// Get all-time orders by phone from local database (portal-scoped)
router.get('/:slug/customers/:phone/all-orders', verifyPortalToken, async (req, res) => {
    try {
        const { slug, phone } = req.params;
        
        if (slug !== req.portal.slug) {
            return res.status(403).json({ error: 'Portal mismatch' });
        }
        
        console.log(`[PORTAL ALL ORDERS] Fetching all-time orders from database for: ${phone}`);
        
        // Capped at 50 most recent orders to bound DB egress (portal history use)
        const orders = await dbAdapter.query(
            'SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 50',
            [phone]
        );
        
        const cleanPhone = phone.replace(/\D/g, '');
        const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;
        
        console.log(`[PORTAL ALL ORDERS] Found ${(orders || []).length} orders for ${phone}`);
        
        res.json({ success: true, phone: formattedPhone, orders: orders || [], source: 'database' });
    } catch (error) {
        console.error('Portal all orders error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch orders from database',
            details: error.message 
        });
    }
});

module.exports = router;
