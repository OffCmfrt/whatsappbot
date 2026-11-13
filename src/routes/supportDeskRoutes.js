const express = require('express');
const os = require('os');
const router = express.Router();
const multer = require('multer');
const Support = require('../services/supportService');
const SupportSync = require('../services/supportSync');
const shopifyService = require('../services/shopifyService');
const razorpayService = require('../services/razorpayService');
const cloudinary = require('../services/cloudinaryService');
const { verifyToken, requirePermission } = require('../middleware/auth');

// ============================================================
// Support Desk API — the premium agent dashboard at /desk.
// Mounted at /api/support/admin, so the storefront-facing router
// never sees these paths. Auth is the app's admin JWT (operators
// need the 'support_desk' permission).
//
// Every ticket detail carries full order context, customer
// history, risk scoring and the economic comparison so an agent
// can decide without leaving the page.
// ============================================================

const upload = multer({
    storage: multer.diskStorage({
        dest: os.tmpdir() + '/ofc-desk-uploads',
        filename: (req, file, cb) => cb(null, `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 4 }
});

const publicTicket = Support.publicTicket;
// Both admin login paths land the identity on req.admin (see middleware/auth)
const agentName = (req) => (req.admin && (req.admin.username || req.admin.role)) || 'agent';

router.use(verifyToken, requirePermission('support_desk'));

// ---------- Shopify side effects ----------
// Tags + notes are how the desk hands work to the calling/logistics teams
// without double-writing orders through a second system.
async function shopifyTagAndNote(shopifyOrderId, addTag, noteLine) {
    try {
        const { order: o } = await SupportSync.shopifyREST(`orders/${shopifyOrderId}.json`);
        if (!o) throw new Error('Shopify order not found');
        const tags = [o.tags, addTag].filter(Boolean).join(', ');
        const note = [o.note, noteLine].filter(Boolean).join('\n');
        await SupportSync.shopifyREST(`orders/${shopifyOrderId}.json`, {
            method: 'PUT',
            body: { order: { id: o.id, tags, note } }
        });
    } catch (e) {
        console.warn('[Support Desk] shopifyTagAndNote skipped (local/demo mode):', e.message);
    }
}

// Desk address payload → the shape shopifyService merges into the order
function toShopifyAddress(addr = {}) {
    return {
        name: addr.name || null,
        phone: addr.phone || null,
        address1: addr.address1 || null,
        address2: addr.address2 || null,
        city: addr.city || null,
        state: addr.state || addr.province || null,
        pincode: addr.pincode || addr.zip || null
    };
}

function oneLineAddress(addr = {}) {
    return [addr.address1, addr.address2, addr.city, addr.state || addr.province, addr.pincode || addr.zip, addr.country]
        .filter(Boolean).join(', ');
}

// Return/exchange approvals queue work in the shared `requests` table, which is
// what the return-exchange dashboard and pickup flow read. It lives in the other
// Supabase project, so it is reached over PostgREST (see SupportSync).
async function insertReturnRequest({ t, order, agent, isExchange }) {
    const requestId = (isExchange ? 'EXC-' : 'RET-')
        + String(order.id).replace(/\D/g, '') + '-' + Date.now().toString(36).slice(-4).toUpperCase();
    try {
        const images = await Support.listTicketImages(t.id);
        await SupportSync.requestsInsert({
            request_id: requestId,
            order_number: String(order.id).replace(/^#/, ''),
            email: t.customer_email || null,
            customer_name: t.customer_name || null,
            customer_phone: t.customer_phone || null,
            type: isExchange ? 'exchange' : 'return',
            status: 'pending',
            reason: t.sub_label || 'Support ticket',
            comments: t.message || '',
            items: order.items || [],
            new_address: t.new_address || null,
            images: images,
            admin_notes: `Created from support ticket ${t.ticket_number} by ${agent}`,
            carrier: 'shiprocket'
        });
    } catch (e) {
        console.warn('[Support Desk] requestsInsert skipped (local/demo mode):', e.message);
    }
    return requestId;
}

// ── KPI bar ──
// One aggregate query (see Support.deskStatsAgg) — the desk polls this every 30s.
router.get('/stats', async (req, res) => {
    try {
        const slaCfg = (await Support.getSetting('sla')) || {};
        const requestPairs = Object.keys(Support.REQUESTS).map(k => k.split('/'));
        const stats = await Support.deskStatsAgg(slaCfg, req.query.channel || 'website', requestPairs);
        res.json(stats);
    } catch (error) {
        console.error('[Support Desk] stats error:', error.message);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// ── Queue with filters ──
router.get('/tickets', async (req, res) => {
    try {
        const { status, team, priority, category, q, channel } = req.query;
        const rows = await Support.deskQueryTickets({ status, team, priority, reason: category, q, channel });

        // Enrich queue rows with cached order context
        const orderIds = [...new Set(rows.map(t => t.order_id).filter(Boolean))];
        const cache = await Support.cacheRowsFor(orderIds);
        const orderMap = {};
        cache.forEach(r => { orderMap[r.order_id] = r; });

        const slaCfg = (await Support.getSetting('sla')) || {};
        res.json({
            tickets: rows.map(t => ({
                ...publicTicket(t),
                customer_name: t.customer_name, customer_phone: t.customer_phone,
                channel: t.channel, has_images: t.has_images,
                order: orderMap[t.order_id] ? {
                    stage: orderMap[t.order_id].stage, payment: orderMap[t.order_id].payment,
                    courier: orderMap[t.order_id].courier, awb: orderMap[t.order_id].awb, total: orderMap[t.order_id].total
                } : null,
                sla: Support.slaOf(t, slaCfg),
                isRequest: !!Support.REQUESTS[t.reason + '/' + t.sub]
            }))
        });
    } catch (error) {
        console.error('[Support Desk] list error:', error.message);
        res.status(500).json({ error: 'Failed to load tickets' });
    }
});

// ── Full detail: order + history + risk + econ + settings ──
router.get('/tickets/:id', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const [order, settings, history, ticketCount, images, ctx] = await Promise.all([
            Support.getOrderByNumber(t.order_id, t.customer_phone),
            Support.getAllSettings(),
            Support.customerHistory(t.customer_phone),
            Support.countTicketsByPhone(t.customer_phone),
            Support.listTicketImages(t.id),
            // Shoppers Hub customer context (orders/returns/exchanges/RTO) —
            // cached, so this is one shared read for everything above too.
            Support.contextFor(t.customer_phone)
        ]);
        const slaCfg = settings.sla || {}, costCfg = settings.cost_config || {};
        const enriched = { ...t, history };
        const key = t.reason + '/' + t.sub;
        const trimReq = r => ({
            id: r.request_id || r.return_id || r.exchange_id, order_id: r.order_id || r.order_number,
            status: r.status, reason: r.reason || null, created_at: r.created_at, source: r.source
        });
        res.json({
            ticket: { ...t, images },
            order,
            history,
            ticketCount,
            context: ctx ? {
                orders: (ctx.orders || []).slice(0, 10).map(o => ({
                    order_id: o.order_id, status: o.status, awb: o.awb, courier_name: o.courier_name,
                    total: o.order_total, created_at: o.created_at, delivered_at: o.delivered_at
                })),
                returns: (ctx.returns || []).slice(0, 10).map(trimReq),
                exchanges: (ctx.exchanges || []).slice(0, 10).map(trimReq),
                rto: (ctx.rto || []).slice(0, 10).map(o => ({ order_id: o.order_id, awb: o.awb, status: o.status }))
            } : null,
            sla: Support.slaOf(t, slaCfg),
            risk: order ? Support.riskOf(enriched, order, costCfg, ticketCount) : null,
            econ: order ? Support.econOf(t, order, costCfg) : null,
            requestKey: Support.REQUESTS[key] ? key : null,
            requestLabel: Support.REQUESTS[key] || null,
            requestNote: (Support.REQUEST_NOTES[t.sub] || (() => null))(order || {}),
            settings: {
                teams: settings.teams || {},
                canned_responses: settings.canned_responses || [],
                resolution_templates: settings.resolution_templates || {},
                sla: slaCfg
            }
        });
    } catch (error) {
        console.error('[Support Desk] detail error:', error.message);
        res.status(500).json({ error: 'Failed to load ticket detail' });
    }
});

// ── Update priority / team / assignment ──
router.patch('/tickets/:id', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const patch = { updated_at: new Date().toISOString() };
        const events = [];
        const b = req.body || {};
        if (b.priority === 'high' || b.priority === 'normal') {
            if (b.priority !== t.priority) events.push('Priority set to ' + (b.priority === 'high' ? 'High' : 'Normal'));
            patch.priority = b.priority;
        }
        if (b.team && typeof b.team === 'string') {
            if (b.team !== t.team) {
                const teams = (await Support.getSetting('teams')) || {};
                events.push('Assigned to ' + (teams[b.team] || b.team));
            }
            patch.team = b.team;
        }
        if (typeof b.assigned_to === 'string') {
            if (b.assigned_to && b.assigned_to !== t.assigned_to) events.push('Taken by ' + b.assigned_to);
            patch.assigned_to = b.assigned_to || null;
        }
        if (events.length) {
            const thread = Array.isArray(t.thread) ? t.thread : [];
            events.forEach(e => thread.push({ kind: 'event', text: e, at: Date.now() }));
            patch.thread = thread;
        }
        const updated = await Support.updateTicket(t.id, patch);
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error('[Support Desk] patch error:', error.message);
        res.status(500).json({ error: 'Failed to update ticket' });
    }
});

// ── Agent reply / ask / note ──
async function agentComposer(req, res, mode) {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const text = String((req.body && req.body.text) || '').trim().slice(0, 5000);
        if (!text) return res.status(400).json({ error: 'Message is empty' });
        const agent = agentName(req);
        const now = Date.now();
        const patch = { updated_at: new Date(now).toISOString() };
        if (mode === 'note') {
            const notes = Array.isArray(t.notes) ? t.notes : [];
            notes.push({ text, at: now, agentId: agent });
            patch.notes = notes;
        } else {
            const thread = Array.isArray(t.thread) ? t.thread : [];
            thread.push({ role: 'agent', text, at: now, agentId: agent, ask: mode === 'ask' });
            patch.thread = thread;
            patch.status = 'awaiting';
            patch.last_agent_at = new Date(now).toISOString();
            if (!t.first_response_at) patch.first_response_at = new Date(now).toISOString();
        }
        const updated = await Support.updateTicket(t.id, patch);
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error(`[Support Desk] ${mode} error:`, error.message);
        res.status(500).json({ error: 'Failed to send' });
    }
}
router.post('/tickets/:id/reply', (req, res) => agentComposer(req, res, 'reply'));
router.post('/tickets/:id/ask', (req, res) => agentComposer(req, res, 'ask'));
router.post('/tickets/:id/note', (req, res) => agentComposer(req, res, 'note'));

// ── Resolve & close ──
router.post('/tickets/:id/resolve', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        if (t.status === 'closed') return res.status(400).json({ error: 'Ticket is already closed' });
        const b = req.body || {};
        const templates = (await Support.getSetting('resolution_templates')) || {};
        const order = await Support.getOrderByNumber(t.order_id, t.customer_phone);
        const label = String(b.type || 'info');
        const message = String(b.message || templates[label] || '').trim();
        if (!message) return res.status(400).json({ error: 'Resolution message is required' });
        const agent = agentName(req);
        const now = Date.now();
        const thread = Array.isArray(t.thread) ? t.thread : [];
        thread.push({ role: 'agent', text: Support.fillTemplate(message, t, order), at: now, agentId: agent });
        thread.push({ kind: 'event', text: 'Closed: ' + label.replace(/_/g, ' '), at: now + 1 });
        const updated = await Support.updateTicket(t.id, {
            status: 'closed',
            resolution_type: label,
            resolution_label: label.replace(/_/g, ' '),
            resolution_at: new Date(now).toISOString(),
            resolution_by: agent,
            thread,
            last_agent_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString()
        });
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error('[Support Desk] resolve error:', error.message);
        res.status(500).json({ error: 'Failed to resolve ticket' });
    }
});

// ── Agent reopen ──
router.post('/tickets/:id/reopen', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const thread = Array.isArray(t.thread) ? t.thread : [];
        thread.push({ kind: 'event', text: 'Reopened by ' + agentName(req), at: Date.now() });
        const updated = await Support.updateTicket(t.id, {
            status: 'open', thread, last_customer_at: new Date().toISOString(), updated_at: new Date().toISOString()
        });
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error('[Support Desk] reopen error:', error.message);
        res.status(500).json({ error: 'Failed to reopen ticket' });
    }
});

// ── Request approvals ──
router.post('/tickets/:id/approve', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const key = t.reason + '/' + t.sub;
        if (!Support.REQUESTS[key]) return res.status(400).json({ error: 'This ticket is not an actionable request' });
        const b = req.body || {};
        const agent = agentName(req);
        const order = await Support.getOrderByNumber(t.order_id, t.customer_phone);
        if (!order) return res.status(404).json({ error: 'Cached order not found for this ticket' });
        const raw = await Support.getCacheRow(order.id);
        const shopifyId = raw && raw.shopify_id;
        const thread = Array.isArray(t.thread) ? t.thread : [];
        const now = Date.now();
        const event = (text) => thread.push({ kind: 'event', text, at: now });
        const patch = { updated_at: new Date(now).toISOString(), thread, last_agent_at: new Date(now).toISOString() };
        const extra = {};

        switch (key) {
            case 'order/cancel': {
                if (shopifyId) await shopifyTagAndNote(shopifyId, 'support-cancelled', `Cancelled via ticket ${t.ticket_number} by ${agent}`);
                await Support.patchCachedOrder(order.id, { stage: 'cancelled' });
                event('Request approved: Cancel order');
                break;
            }
            case 'order/edit': {
                const note = String(b.note || b.editNote || '').trim();
                if (shopifyId) await shopifyTagAndNote(shopifyId, 'support-edit', `Edit request via ${t.ticket_number}: ${note || 'see ticket'}`);
                event('Request approved: Edit order');
                break;
            }
            case 'order/prepay': {
                if (!razorpayService.isEnabled()) return res.status(503).json({ error: 'Payment gateway not configured' });
                const amount = Math.round(Number(order.total) || 0);
                const link = await razorpayService.createSupportLink({
                    amount,
                    description: `Offcomfrt prepay \u2014 order #${order.id}`,
                    name: t.customer_name || 'Customer',
                    contact: t.customer_phone,
                    email: t.customer_email || null,
                    notes: { ticket_number: t.ticket_number, order_number: String(order.id), source: 'support_desk' }
                });
                if (!link.success) return res.status(502).json({ error: link.error || 'Payment link failed' });
                patch.payment_link = link.shortUrl || link.longUrl || null;
                patch.payment_link_id = link.paymentLinkId || null;
                event('Request approved: Convert to prepaid (link generated)');
                extra.paymentLink = link.shortUrl || link.longUrl;
                extra.amount = amount;
                break;
            }
            case 'delivery/address_change': {
                const addr = b.address || null;
                if (addr && addr.address1) {
                    const upd = await shopifyService.updateShippingAddress(String(order.id).replace(/^#/, ''), toShopifyAddress(addr));
                    if (upd.success) {
                        await Support.patchCachedOrder(order.id, { address: oneLineAddress(addr) });
                        event('Request approved: address updated in Shopify');
                    } else {
                        if (shopifyId) await shopifyTagAndNote(shopifyId, 'support-address-change', `Address change via ${t.ticket_number}: ${oneLineAddress(addr)}`);
                        event('Request approved: Change delivery address (queued for ops)');
                    }
                } else {
                    if (shopifyId) await shopifyTagAndNote(shopifyId, 'support-address-change', `Address change via ${t.ticket_number}: ${t.new_address || 'see ticket'}`);
                    event('Request approved: Change delivery address');
                }
                break;
            }
            case 'delivery/reship_new':
            case 'delivery/pay_reship': {
                if (shopifyId) {
                    const items = (order.items || []).map(i => ({
                        title: i.n, variant_title: i.v || null, quantity: i.q, price: String(i.p)
                    }));
                    const draftBody = {
                        draft_order: {
                            line_items: items,
                            note: `Replacement via ticket ${t.ticket_number} (original #${order.id})`,
                            tags: 'support-reship'
                        }
                    };
                    const addr = b.address || null;
                    if (addr && addr.address1) draftBody.draft_order.shipping_address = toShopifyAddress(addr);
                    await SupportSync.shopifyREST('draft_orders.json', { method: 'POST', body: draftBody });
                    await shopifyTagAndNote(shopifyId, 'support-reshipped', `Replacement dispatched via ticket ${t.ticket_number}`);
                }
                await Support.patchCachedOrder(order.id, { replacements: (order.replacements || 0) + 1 });
                event('Request approved: ' + Support.REQUESTS[key]);
                break;
            }
            case 'return/return_credit':
            case 'return/exchange_req': {
                const requestId = await insertReturnRequest({
                    t, order, agent, isExchange: t.sub === 'exchange_req'
                });
                event(`Request approved: ${Support.REQUESTS[key]} (${requestId})`);
                extra.requestId = requestId;
                break;
            }
            default:
                return res.status(400).json({ error: 'Unsupported request type' });
        }
        if (b.note) thread.push({ role: 'agent', text: String(b.note).slice(0, 5000), at: now + 1, agentId: agent });
        const updated = await Support.updateTicket(t.id, patch);
        res.json({ ticket: publicTicket(updated), ...extra });
    } catch (error) {
        console.error('[Support Desk] approve error:', error.message);
        res.status(500).json({ error: 'Failed to approve request: ' + error.message });
    }
});

// ── Decline request (mandatory note) ──
router.post('/tickets/:id/decline', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const note = String((req.body && req.body.note) || '').trim();
        if (!note) return res.status(400).json({ error: 'A decline note is required' });
        const agent = agentName(req);
        const now = Date.now();
        const thread = Array.isArray(t.thread) ? t.thread : [];
        thread.push({ kind: 'event', text: 'Request declined', at: now });
        thread.push({ role: 'agent', text: note.slice(0, 5000), at: now + 1, agentId: agent });
        const updated = await Support.updateTicket(t.id, {
            thread, last_agent_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString()
        });
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error('[Support Desk] decline error:', error.message);
        res.status(500).json({ error: 'Failed to decline request' });
    }
});

// ── Desk agent uploads (proof images pasted into a reply) ──
router.post('/upload', upload.array('images', 4), async (req, res) => {
    try {
        const urls = [];
        for (const file of (req.files || [])) {
            try {
                urls.push(await cloudinary.uploadImage(file.path, 'support-desk'));
            } catch (uploadErr) {
                console.error('[Support Desk] cloudinary upload failed:', uploadErr.message);
            }
        }
        if (!urls.length) return res.status(400).json({ error: 'No images received' });
        res.json({ urls });
    } catch (error) {
        console.error('[Support Desk] upload error:', error.message);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// ── Admin settings ──
const SETTING_KEYS = ['sla', 'teams', 'canned_responses', 'resolution_templates', 'cost_config'];
router.get('/settings', async (req, res) => {
    try {
        res.json(await Support.getAllSettings());
    } catch (error) {
        console.error('[Support Desk] settings error:', error.message);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});
router.put('/settings/:key', async (req, res) => {
    try {
        const key = req.params.key;
        if (!SETTING_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown setting key' });
        const value = req.body && req.body.value;
        if (value === undefined || value === null || typeof value !== 'object') {
            return res.status(400).json({ error: 'Setting value must be an object or array' });
        }
        await Support.putSetting(key, value);
        res.json({ success: true });
    } catch (error) {
        console.error('[Support Desk] settings put error:', error.message);
        res.status(500).json({ error: 'Failed to save setting' });
    }
});

// ── Whitelist management (who sees the Help & Tickets tab) ──
router.get('/whitelist', async (req, res) => {
    try {
        res.json({ whitelist: await Support.listWhitelist() });
    } catch (error) {
        console.error('[Support Desk] whitelist error:', error.message);
        res.status(500).json({ error: 'Failed to load whitelist' });
    }
});
router.post('/whitelist', async (req, res) => {
    try {
        const { phone, note } = req.body || {};
        const added = await Support.addWhitelist(phone, agentName(req), note);
        // Pull this customer's orders immediately so the tab is useful at once
        let orders = 0;
        try { orders = (await SupportSync.syncOrdersForPhone(added)).orders; } catch (syncErr) {
            console.warn('[Support Desk] post-whitelist sync skipped:', syncErr.message);
        }
        res.json({ success: true, phone: added, orders });
    } catch (error) {
        console.error('[Support Desk] whitelist add error:', error.message);
        res.status(400).json({ error: error.message });
    }
});
router.delete('/whitelist/:phone', async (req, res) => {
    try {
        await Support.removeWhitelist(decodeURIComponent(req.params.phone));
        res.json({ success: true });
    } catch (error) {
        console.error('[Support Desk] whitelist remove error:', error.message);
        res.status(500).json({ error: 'Failed to remove phone' });
    }
});

// ── Order cache view + manual sync ──
router.get('/order-cache', async (req, res) => {
    try {
        res.json({ orders: await Support.listOrderCache(100) });
    } catch (error) {
        console.error('[Support Desk] order cache error:', error.message);
        res.status(500).json({ error: 'Failed to load order cache' });
    }
});
router.post('/order-cache/sync', async (req, res) => {
    try {
        const { phone } = req.body || {};
        const result = phone
            ? { customers: 1, results: [await SupportSync.syncOrdersForPhone(phone)] }
            : await SupportSync.syncAllWhitelisted();
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Support Desk] order sync error:', error.message);
        res.status(500).json({ error: 'Sync failed: ' + error.message });
    }
});
// Live re-pull of one order (webhooks can lag behind a courier scan)
router.post('/order-cache/refresh', async (req, res) => {
    try {
        const row = await SupportSync.refreshOrder((req.body || {}).orderId);
        if (!row) return res.status(404).json({ error: 'Order not found in Shopify' });
        res.json({ success: true, order: Support.mapCachedOrder(row) });
    } catch (error) {
        console.error('[Support Desk] order refresh error:', error.message);
        res.status(500).json({ error: 'Refresh failed: ' + error.message });
    }
});

module.exports = router;
