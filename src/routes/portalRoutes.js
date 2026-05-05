const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const whatsappService = require('../services/whatsappService');
const { dbAdapter } = require('../database/db');

// Portal auth middleware
function verifyPortalToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No portal token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.portalId || !decoded.slug) {
            return res.status(401).json({ error: 'Invalid portal token.' });
        }
        req.portal = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired portal token.' });
    }
}

// Helper to check if a ticket's created time falls within portal time range
function isTicketInTimeRange(ticket, config) {
    if (!config || !config.time_start || !config.time_end) return true;

    const createdAt = new Date(ticket.created_at);
    const timezone = config.timezone || 'Asia/Kolkata';

    // Convert to target timezone
    const options = { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit' };
    const timeStr = new Intl.DateTimeFormat('en-US', options).format(createdAt);
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

// Helper to get portal tickets (optimized)
async function getPortalTickets(portalId, portalType, portalConfig) {
    if (portalType === 'time_based') {
        const config = portalConfig ? JSON.parse(portalConfig) : {};
        // OPTIMIZED: Limit to last 500 tickets to avoid loading entire table
        const allTickets = await dbAdapter.query(
            'SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 500'
        );
        return allTickets.filter(t => isTicketInTimeRange(t, config));
    } else {
        // manual or auto
        return await dbAdapter.query(
            'SELECT * FROM support_tickets WHERE portal_id = ? ORDER BY created_at DESC LIMIT 500',
            [portalId]
        );
    }
}

// Helper to verify a phone belongs to the portal
async function verifyPhoneInPortal(phone, portal) {
    const tickets = await getPortalTickets(portal.portalId, portal.type, portal.config);
    return tickets.some(t => t.customer_phone === phone || t.customer_phone.replace(/\D/g, '') === phone.replace(/\D/g, ''));
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

        const token = jwt.sign(
            { portalId: portal.id, slug: portal.slug, type: portal.type, config: portal.config },
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
        const { status } = req.query;
        let tickets = await getPortalTickets(portal.id, portal.type, portal.config);

        if (status) {
            tickets = tickets.filter(t => t.status === status);
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

        const cleanPhone = phone.replace(/\D/g, '');
        const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;

        // Get customer info
        const customerInfo = await dbAdapter.query(
            'SELECT name, phone, email FROM customers WHERE phone IN (?, ?, ?, ?)',
            [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`]
        );

        // Get messages (optimized - normalize phone to single format)
        const messages = await dbAdapter.query(
            `SELECT id, customer_phone, message_type, message_content, status, wa_message_id, created_at
             FROM messages
             WHERE customer_phone = ?
             ORDER BY created_at DESC
             LIMIT 200`,
            [cleanPhone]
        );

        const formattedMessages = messages.reverse().map(msg => ({
            id: msg.id,
            type: msg.message_type,
            content: msg.message_content,
            status: msg.status,
            waMessageId: msg.wa_message_id,
            timestamp: msg.created_at,
            isAdmin: msg.message_type === 'manual_reply' || msg.message_type === 'outgoing'
        }));

        // Mark ticket as read when chat is opened
        await dbAdapter.query(
            `UPDATE support_tickets SET is_read = 1 WHERE customer_phone IN (?, ?, ?, ?) AND is_read = 0`,
            [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`]
        );

        res.json({
            success: true,
            phone: formattedPhone,
            customer: customerInfo[0] || null,
            messages: formattedMessages
        });
    } catch (error) {
        console.error('Portal chat history error:', error);
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

// Send message via portal
router.post('/:slug/chat/send', verifyPortalToken, async (req, res) => {
    try {
        const { slug } = req.params;
        const { phone, message, type = 'text' } = req.body;

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

        const cleanPhone = phone.replace(/\D/g, '');
        const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;

        let result;
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

        // Update shopper record if exists
        await dbAdapter.run(
            `UPDATE store_shoppers 
             SET last_response_at = ?,
                 response_count = COALESCE(response_count, 0) + 1
             WHERE phone = ? OR phone = ?`,
            [new Date().toISOString(), formattedPhone, cleanPhone]
        );

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

        // For time-based, also verify time range
        if (portal.type === 'time_based') {
            const config = portal.config ? JSON.parse(portal.config) : {};
            if (!isTicketInTimeRange(tickets[0], config)) {
                return res.status(403).json({ error: 'Ticket not in portal time range' });
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

        await dbAdapter.query(
            `UPDATE support_tickets SET is_read = 1 WHERE id = ?`,
            [id]
        );

        res.json({ success: true, message: 'Ticket marked as read' });
    } catch (error) {
        console.error('Portal mark ticket as read error:', error);
        res.status(500).json({ success: false, error: 'Failed to mark ticket as read' });
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
        
        // Fetch ALL orders from database (no limit)
        const orders = await dbAdapter.query(
            'SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC',
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
