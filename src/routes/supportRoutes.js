const express = require('express');
const os = require('os');
const router = express.Router();
const multer = require('multer');
const Support = require('../services/supportService');
const SupportSync = require('../services/supportSync');
const cloudinary = require('../services/cloudinaryService');

// ============================================================
// Customer-facing Support API — the "Help & Tickets" tab inside
// the Shopify customer account. Mounted at /api/support.
//
// Auth model: the theme injects the signed-in customer's phone
// server-side (Liquid), the JS echoes it on every request as
// X-Customer-Phone, and access additionally requires the phone to
// be on support_whitelist (managed from the desk). No password,
// no session — the storefront account is the identity provider.
// ============================================================

// Uploads go to Cloudinary; disk storage keeps big files off the heap
const upload = multer({
    storage: multer.diskStorage({
        dest: os.tmpdir() + '/ofc-support-uploads',
        filename: (req, file, cb) => cb(null, `tkt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 3 }
});

// Short-lived cache of Shopify-verified customers (phone -> profile)
const verifiedCustomers = new Map();
const VERIFY_TTL = 10 * 60 * 1000;

async function verifyCustomerPhone(req, res, next) {
    try {
        const raw = req.headers['x-customer-phone'];
        if (!raw) return res.status(401).json({ error: 'Phone required' });
        const phone = Support.normalizePhone(raw);
        if (!phone || phone.length < 10) return res.status(401).json({ error: 'Invalid phone' });
        // 60s in-memory whitelist snapshot (same one the webhooks use) — every
        // customer request used to pay a DB round trip here, which dominates
        // latency when the Render pool is cold. Revocations take up to 60s.
        if (!(await SupportSync.isWhitelistedCached(phone))) {
            return res.status(403).json({ error: 'Support access not enabled' });
        }
        req.customerPhone = phone;
        next();
    } catch (error) {
        console.error('[Support] customer auth error:', error.message);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

// Thread is trimmed for the customer view; the desk reads the full row
const publicTicket = Support.publicTicket;

// ── Whitelist gate (no auth — the phone comes from Liquid injection) ──
// Tells the theme whether to render the Help & Tickets tab at all.
router.get('/whitelist-check', async (req, res) => {
    try {
        const phone = Support.normalizePhone(req.query.phone || '');
        if (!phone) return res.json({ allowed: false });
        if (!(await SupportSync.isWhitelistedCached(phone))) return res.json({ allowed: false });

        const cached = verifiedCustomers.get(phone);
        if (cached && Date.now() - cached.ts < VERIFY_TTL) {
            return res.json({ allowed: true, name: cached.name, email: cached.email });
        }
        try {
            const data = await SupportSync.shopifyREST(`customers.json?phone=${encodeURIComponent('+' + phone)}&limit=1`);
            const c = data.customers && data.customers[0];
            if (!c) return res.json({ allowed: false });
            const profile = { name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email, ts: Date.now() };
            verifiedCustomers.set(phone, profile);
            if (verifiedCustomers.size > 500) verifiedCustomers.delete(verifiedCustomers.keys().next().value);
            res.json({ allowed: true, name: profile.name, email: profile.email });
        } catch (shopErr) {
            // Shopify lookup failed — the whitelist remains the access decision
            console.warn('[Support] Shopify verify skipped:', shopErr.message);
            res.json({ allowed: true });
        }
    } catch (error) {
        console.error('[Support] whitelist-check error:', error.message);
        res.json({ allowed: false });
    }
});

// ── Customer orders (read from the webhook-fed cache) ──
// Paginated: the storefront picker walks pages (default 5 per page) instead of
// shipping every cached order at once. ?orderId= returns just that one order —
// the per-order "Need Help?" flow uses it so a match on a later page never
// forces the whole history down the wire.
router.get('/orders', verifyCustomerPhone, async (req, res) => {
    try {
        const key = Support.normOrderId;
        if (req.query.orderId) {
            const order = await Support.getOrderByNumber(req.query.orderId, req.customerPhone);
            // Hub-sourced orders are already inside this phone's customer
            // context, so ownership is proven by construction (same rule as
            // /catalog; a cache-only order must match the requesting phone).
            if (!order || (!order.hubSourced && order.customerKey !== req.customerPhone)) {
                return res.status(404).json({ error: 'Order not found' });
            }
            const existing = await Support.openTicketForOrder(order.id);
            await Support.attachItemImages([order]);
            return res.json({
                orders: [{
                    ...order,
                    openTicket: existing ? { id: existing.id, number: existing.ticket_number, status: existing.status } : null
                }],
                page: 1, limit: 1, total: 1, hasMore: false
            });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 20);
        const offset = (page - 1) * limit;

        const [orders, tickets] = await Promise.all([
            Support.listOrdersByPhone(req.customerPhone),
            Support.listTicketsByPhone(req.customerPhone)
        ]);
        const openByOrder = {};
        tickets.filter(t => t.status !== 'closed').forEach(t => {
            openByOrder[key(t.order_id)] = { id: t.id, number: t.ticket_number, status: t.status };
        });
        const withTickets = orders.map(o => ({ ...o, openTicket: openByOrder[key(o.id)] || null }));
        const pageRows = withTickets.slice(offset, offset + limit);
        // Thumbnails are only resolved for the page being returned — the
        // catalog map is process-cached, so this stays a pure lookup.
        await Support.attachItemImages(pageRows);
        res.json({
            orders: pageRows,
            page, limit,
            total: withTickets.length,
            hasMore: offset + limit < withTickets.length
        });
    } catch (error) {
        console.error('[Support] orders error:', error.message);
        res.status(500).json({ error: 'Failed to load orders' });
    }
});

// ── Raise-ticket catalog with stage eligibility for one order ──
router.get('/catalog', verifyCustomerPhone, async (req, res) => {
    try {
        const orderId = req.query.orderId;
        let order = null;
        if (orderId) {
            order = await Support.getOrderByNumber(orderId, req.customerPhone);
            // Hub-sourced orders are already fetched inside this phone's
            // customer context, so ownership is proven by construction.
            if (!order || (!order.hubSourced && order.customerKey !== req.customerPhone)) {
                return res.status(404).json({ error: 'Order not found' });
            }
            const costCfg = (await Support.getSetting('cost_config')) || {};
            order.returnWindowDays = costCfg.return_window_days || 7;
            order.dnrReportDays = costCfg.dnr_report_days || 3;
        }
        res.json(Support.raiseCatalog(order));
    } catch (error) {
        console.error('[Support] catalog error:', error.message);
        res.status(500).json({ error: 'Failed to load catalog' });
    }
});

// ── Ticket list + status counts ──
router.get('/tickets', verifyCustomerPhone, async (req, res) => {
    try {
        const tickets = await Support.listTicketsByPhone(req.customerPhone);
        const counts = { open: 0, awaiting: 0, closed: 0 };
        tickets.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
        res.json({ tickets: tickets.map(publicTicket), counts });
    } catch (error) {
        console.error('[Support] ticket list error:', error.message);
        res.status(500).json({ error: 'Failed to load tickets' });
    }
});

// ── Ticket detail (owner only) ──
router.get('/tickets/:id', verifyCustomerPhone, async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t || t.customer_phone !== req.customerPhone) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        res.json({ ticket: { ...Support.customerTicket(t), images: await Support.listTicketImages(t.id) } });
    } catch (error) {
        console.error('[Support] ticket detail error:', error.message);
        res.status(500).json({ error: 'Failed to load ticket' });
    }
});

// ── Create ticket ──
router.post('/tickets', verifyCustomerPhone, async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.orderId || !b.reason || !b.sub) {
            return res.status(400).json({ error: 'orderId, reason and sub are required' });
        }
        const order = await Support.getOrderByNumber(b.orderId, req.customerPhone);
        if (!order || (!order.hubSourced && order.customerKey !== req.customerPhone)) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const existing = await Support.openTicketForOrder(order.id);
        if (existing) {
            return res.status(409).json({
                error: 'An open ticket already exists for this order',
                ticket: { id: existing.id, ticket_number: existing.ticket_number }
            });
        }
        // Re-check eligibility server-side — the UI lock is a hint, not a gate
        const costCfg = (await Support.getSetting('cost_config')) || {};
        order.returnWindowDays = costCfg.return_window_days || 7;
        order.dnrReportDays = costCfg.dnr_report_days || 3;
        const gate = Support.elig(order, b.reason, b.sub);
        if (!gate.ok) return res.status(400).json({ error: gate.why || 'This option is not available for this order' });

        const cat = Support.REASONS.find(r => r.id === b.reason);
        if (!cat) return res.status(400).json({ error: 'Unknown issue category' });
        const subDef = cat.subs.find(s => s[0] === b.sub);
        if (!subDef) return res.status(400).json({ error: 'Unknown sub-issue' });
        const requestKey = b.reason + '/' + b.sub;

        const ticket = await Support.createTicket({
            customerPhone: req.customerPhone,
            customerName: (verifiedCustomers.get(req.customerPhone) || {}).name || b.customerName || '',
            customerEmail: b.customerEmail || null,
            orderId: order.id,
            reason: b.reason,
            reasonLabel: cat.label,
            sub: b.sub,
            subLabel: subDef[1],
            otherText: b.otherText || null,
            preference: b.preference || null,
            contactVia: b.contactVia === 'phone' ? 'phone' : 'whatsapp',
            address: b.address || null,
            video: b.video || null,
            priority: subDef[2] ? 'high' : 'normal',
            requestLabel: Support.REQUESTS[requestKey] || null,
            history: await Support.customerHistory(req.customerPhone),
            desc: b.desc || '',
            images: Array.isArray(b.images) ? b.images.slice(0, 6) : []
        });
        res.json({ ticket: { id: ticket.id, ticket_number: ticket.ticket_number, status: ticket.status } });
    } catch (error) {
        console.error('[Support] create ticket error:', error.message);
        res.status(500).json({ error: 'Failed to create ticket' });
    }
});

// ── Customer reply ──
router.post('/tickets/:id/messages', verifyCustomerPhone, async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t || t.customer_phone !== req.customerPhone) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        if (t.status === 'closed') {
            return res.status(400).json({ error: 'Ticket is closed. Reopen it to reply.' });
        }
        const text = String((req.body && req.body.text) || '').trim().slice(0, 5000);
        if (!text) return res.status(400).json({ error: 'Message is empty' });
        const thread = Array.isArray(t.thread) ? t.thread : [];
        thread.push({ role: 'customer', text, at: Date.now() });
        const updated = await Support.updateTicket(t.id, {
            thread,
            status: t.status === 'awaiting' ? 'open' : t.status,
            last_customer_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error('[Support] customer reply error:', error.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ── CSAT rating (closed tickets only) ──
router.patch('/tickets/:id/csat', verifyCustomerPhone, async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t || t.customer_phone !== req.customerPhone) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        if (t.status !== 'closed') return res.status(400).json({ error: 'Only closed tickets can be rated' });
        const rating = Math.round(Number(req.body && req.body.csat));
        if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
        const thread = Array.isArray(t.thread) ? t.thread : [];
        thread.push({ kind: 'event', text: 'Customer rated this ' + rating + '/5', at: Date.now() });
        const updated = await Support.updateTicket(t.id, {
            csat: rating, thread, updated_at: new Date().toISOString()
        });
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error('[Support] csat error:', error.message);
        res.status(500).json({ error: 'Failed to save rating' });
    }
});

// ── Reopen (within 7 days of resolution, once) ──
router.post('/tickets/:id/reopen', verifyCustomerPhone, async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t || t.customer_phone !== req.customerPhone) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        if (t.status !== 'closed') return res.status(400).json({ error: 'Ticket is not closed' });
        if (t.resolution_at && Date.now() - new Date(t.resolution_at).getTime() > 7 * Support.DAY) {
            return res.status(400).json({ error: 'The 7-day reopen window has passed' });
        }
        if ((t.reopen_count || 0) >= 1) {
            return res.status(400).json({ error: 'This ticket has already been reopened once' });
        }
        const thread = Array.isArray(t.thread) ? t.thread : [];
        thread.push({ kind: 'event', text: 'Ticket reopened by customer', at: Date.now() });
        const text = String((req.body && req.body.text) || '').trim().slice(0, 5000);
        if (text) thread.push({ role: 'customer', text, at: Date.now() + 1 });
        const updated = await Support.updateTicket(t.id, {
            status: 'open', reopen_count: (t.reopen_count || 0) + 1, thread,
            last_customer_at: new Date().toISOString(), updated_at: new Date().toISOString()
        });
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error('[Support] reopen error:', error.message);
        res.status(500).json({ error: 'Failed to reopen ticket' });
    }
});

// ── Image upload (Cloudinary) — returns URLs the create call references ──
router.post('/upload', verifyCustomerPhone, upload.array('images', 3), async (req, res) => {
    try {
        const urls = [];
        for (const file of (req.files || [])) {
            try {
                urls.push(await cloudinary.uploadImage(file.path, 'support-tickets'));
            } catch (uploadErr) {
                console.error('[Support] cloudinary upload failed:', uploadErr.message);
            }
        }
        if (!urls.length) return res.status(400).json({ error: 'No images received' });
        res.json({ urls });
    } catch (error) {
        console.error('[Support] upload error:', error.message);
        res.status(500).json({ error: 'Upload failed' });
    }
});

module.exports = router;
