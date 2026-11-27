const express = require('express');
const os = require('os');
const router = express.Router();
const multer = require('multer');
const Support = require('../services/supportService');
const SupportSync = require('../services/supportSync');
const SupportAccess = require('../services/supportAccessService');
const broadcastService = require('../services/broadcastService');
const shopifyService = require('../services/shopifyService');
const razorpayService = require('../services/razorpayService');
const cloudinary = require('../services/cloudinaryService');
const supportMedia = require('../services/supportMediaService');
const supportCloudinary = require('../services/supportCloudinaryService');
const { verifyToken, requirePermission, requireAdmin } = require('../middleware/auth');

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

// ── Customer login activity (website account logins) ──
// The events live in the returns app's database (storefront OTP login writes
// customer_login_events there), so this proxies the shared internal endpoint
// over x-internal-token — same contract as SupportSync's other cross-server
// reads. Purely additive: the desk stays fully functional when the returns
// server is unreachable (the tab shows the error, the KPI pill goes quiet).
// Cached 60s per window because the panel polls and several agents may have
// the desk open at once.
const loginStatsCache = new Map(); // days -> { at, body }
router.get('/login-stats', async (req, res) => {
    try {
        const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
        const cached = loginStatsCache.get(days);
        if (cached && Date.now() - cached.at < 60000) return res.json(cached.body);

        const baseUrl = process.env.RETURNS_SERVER_URL;
        if (!baseUrl) return res.status(503).json({ error: 'Returns server not configured on this desk' });
        const axios = require('axios');
        const resp = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/login-stats`, {
            params: { days },
            headers: { 'x-internal-token': process.env.WHATSAPP_INTERNAL_TOKEN || '' },
            timeout: 15000
        });
        const data = resp.data || {};
        if (!data.success) return res.status(502).json({ error: 'Returns server returned an error' });

        // Enrich recent logins with names from the shared shoppers table —
        // phones there are stored in wildly different formats, so match on
        // digits via the functional index idx_ss_phone_digits (same pattern
        // as customerContextService).
        const recent = (data.recent || []).slice(0, 50).map(r => ({
            phone: String(r.phone || '').replace(/\D/g, ''),
            at: r.at
        })).filter(r => r.phone.length >= 10);
        const digitKeys = [...new Set(recent.flatMap(r => {
            const intl = r.phone.startsWith('91') ? r.phone : '91' + r.phone;
            const local = r.phone.startsWith('91') && r.phone.length > 10 ? r.phone.slice(2) : r.phone;
            return [r.phone, intl, local];
        }))];
        const nameByDigits = new Map();
        if (digitKeys.length) {
            try {
                const { dbAdapter } = require('../database/db');
                const placeholders = digitKeys.map((_, i) => '$' + (i + 1)).join(',');
                const rows = await dbAdapter.query(
                    `SELECT DISTINCT ON (REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'))
                            phone, name
                     FROM store_shoppers
                     WHERE REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') IN (${placeholders})
                       AND NULLIF(TRIM(COALESCE(name, '')), '') IS NOT NULL
                     ORDER BY REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), created_at DESC`,
                    digitKeys
                );
                for (const row of (rows || [])) {
                    nameByDigits.set(String(row.phone).replace(/\D/g, ''), row.name);
                }
            } catch (nameErr) {
                console.warn('[Support Desk] login name enrichment skipped:', nameErr.message);
            }
        }
        const body = {
            ...data,
            recent: recent.map(r => ({
                ...r,
                name: nameByDigits.get(r.phone) || nameByDigits.get(r.phone.replace(/^91/, '')) || null
            }))
        };
        loginStatsCache.set(days, { at: Date.now(), body });
        res.json(body);
    } catch (error) {
        console.error('[Support Desk] login-stats error:', error.message);
        res.status(502).json({ error: 'Login stats unavailable: ' + error.message });
    }
});

// ── Queue with filters ──
router.get('/tickets', async (req, res) => {
    try {
        const { status, team, priority, category, q, channel } = req.query;
        const rows = await Support.deskQueryTickets({ status, team, priority, reason: category, q, channel });

        // Enrich queue rows with cached order context
        const orderIds = [...new Set(rows.map(t => t.order_id).filter(Boolean))];
        const [cache, portalIndex, slaCfg] = await Promise.all([
            Support.cacheRowsFor(orderIds),
            // One cheap read for the whole page: which portal owns or claims each
            // row. Resolved with the same rule the portal surfaces use.
            Support.getPortalIndex(),
            Support.getSetting('sla')
        ]);
        const orderMap = {};
        cache.forEach(r => { orderMap[r.order_id] = r; });

        res.json({
            tickets: rows.map(t => ({
                ...publicTicket(t),
                customer_name: t.customer_name, customer_phone: t.customer_phone,
                channel: t.channel, has_images: t.has_images,
                portal: Support.describePortal(t, portalIndex),
                order: orderMap[t.order_id] ? {
                    stage: orderMap[t.order_id].stage, payment: orderMap[t.order_id].payment,
                    courier: orderMap[t.order_id].courier, awb: orderMap[t.order_id].awb, total: orderMap[t.order_id].total
                } : null,
                sla: Support.slaOf(t, slaCfg || {}),
                isRequest: !!Support.REQUESTS[t.reason + '/' + t.sub]
            }))
        });
    } catch (error) {
        console.error('[Support Desk] list error:', error.message);
        res.status(500).json({ error: 'Failed to load tickets' });
    }
});

// ── Ticket core: conversation + controls, served from three cheap reads ──
// The heavy customer/order aggregation lives in /tickets/:id/context so the
// agent sees the thread immediately instead of waiting on the hub build.
router.get('/tickets/:id', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const [images, media, settings, portalIndex] = await Promise.all([
            Support.listTicketImages(t.id),
            supportMedia.listForTicket(t.ticket_number),
            Support.getAllSettings(),
            Support.getPortalIndex()
        ]);
        // Opening the ticket is the agent's 'seen' receipt for customer media.
        await supportMedia.markSeen(t.ticket_number, 'outgoing');
        const key = t.reason + '/' + t.sub;
        res.json({
            ticket: { ...t, images, media: media.map(supportMedia.publicView), portal: Support.describePortal(t, portalIndex) },
            sla: Support.slaOf(t, settings.sla || {}),
            requestKey: Support.REQUESTS[key] ? key : null,
            requestLabel: Support.REQUESTS[key] || null,
            settings: {
                teams: settings.teams || {},
                canned_responses: settings.canned_responses || [],
                resolution_templates: settings.resolution_templates || {},
                sla: settings.sla || {}
            }
        });
    } catch (error) {
        console.error('[Support Desk] detail error:', error.message);
        res.status(500).json({ error: 'Failed to load ticket detail' });
    }
});

// ── Lazy context: order + history + risk + econ (Shoppers Hub aggregation) ──
// One hub build feeds everything; the full per-customer order list ships
// with items/tracking so the desk expands orders without more roundtrips.
router.get('/tickets/:id/context', async (req, res) => {
    try {
        const t = await Support.getTicket(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });
        const [ctx, settings] = await Promise.all([
            Support.contextFor(t.customer_phone),
            Support.getAllSettings()
        ]);
        const costCfg = settings.cost_config || {};
        // Newest-first full orders from the shared hub context; the ticket's
        // own order leads the list (live fallback when the hub misses it).
        let orders = t.customer_phone ? await Support.listOrdersByPhone(t.customer_phone) : [];
        const tid = Support.normOrderId(t.order_id);
        let order = (orders.find(o => Support.normOrderId(o.id) === tid) || null);
        if (!order && t.order_id) {
            order = await Support.getOrderByNumber(t.order_id, t.customer_phone);
        }
        if (order) orders = [order, ...orders.filter(o => o !== order)];
        const [history, ticketCount] = await Promise.all([
            Support.customerHistory(t.customer_phone, ctx),
            Support.countTicketsByPhone(t.customer_phone)
        ]);
        const enriched = { ...t, history };
        const trimReq = r => ({
            id: r.request_id || r.return_id || r.exchange_id, order_id: r.order_id || r.order_number,
            status: r.status, reason: r.reason || null, created_at: r.created_at, source: r.source
        });
        res.json({
            order,
            orders: orders.slice(0, 25),
            history,
            ticketCount,
            context: ctx ? {
                returns: (ctx.returns || []).slice(0, 10).map(trimReq),
                exchanges: (ctx.exchanges || []).slice(0, 10).map(trimReq),
                rto: (ctx.rto || []).slice(0, 10).map(o => ({ order_id: o.order_id, awb: o.awb, status: o.status }))
            } : null,
            risk: order ? Support.riskOf(enriched, order, costCfg, ticketCount) : null,
            econ: order ? Support.econOf(t, order, costCfg) : null,
            requestNote: t.sub ? (Support.REQUEST_NOTES[t.sub] || (() => null))(order || {}) : null
        });
    } catch (error) {
        console.error('[Support Desk] context error:', error.message);
        res.status(500).json({ error: 'Failed to load ticket context' });
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
            // Triage/team/hand-off lines are desk-only bookkeeping: they name
            // staff and expose the internal team map, so they carry the
            // internal flag the customer projection filters on.
            events.forEach(e => thread.push({ kind: 'event', text: e, at: Date.now(), internal: true }));
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
        const mediaIds = Array.isArray(req.body && req.body.media_ids) ? req.body.media_ids.map(Number).filter(Boolean) : [];
        if (!text && !mediaIds.length) return res.status(400).json({ error: 'Message is empty' });
        if (mediaIds.length > supportMedia.MAX_PER_MESSAGE) {
            return res.status(400).json({ error: `Only ${supportMedia.MAX_PER_MESSAGE} images per message` });
        }
        const agent = agentName(req);
        const now = Date.now();
        const patch = { updated_at: new Date(now).toISOString() };
        if (mode === 'note') {
            const notes = Array.isArray(t.notes) ? t.notes : [];
            notes.push({ text, at: now, agentId: agent });
            patch.notes = notes;
        } else {
            const thread = Array.isArray(t.thread) ? t.thread : [];
            const entry = { role: 'agent', text, at: now, agentId: agent, ask: mode === 'ask' };
            if (mediaIds.length) entry.media_ids = mediaIds;
            const entryIdx = thread.length;
            thread.push(entry);
            patch.thread = thread;
            patch.status = 'awaiting';
            patch.last_agent_at = new Date(now).toISOString();
            if (mediaIds.length) patch.has_images = true;
            if (!t.first_response_at) patch.first_response_at = new Date(now).toISOString();
            // Attach the media AFTER the thread write succeeds so the row
            // only flips to 'sent' once it is actually part of the ticket.
            await Support.updateTicket(t.id, patch);
            if (mediaIds.length) {
                await supportMedia.attachToMessage(mediaIds, { threadEntryIdx: entryIdx });
            }
            const updated = await Support.getTicket(t.id);
            return res.json({ ticket: publicTicket(updated) });
        }
        const updated = await Support.updateTicket(t.id, patch);
        // AI learning: pair this human reply with the customer's latest question
        // so future desk suggestions imitate approved answers (fire-and-forget).
        // suggestedText tells us whether an AI draft was accepted as-is or edited.
        if (mode === 'reply' && t.customer_phone) {
            const aiLearning = require('../services/ai/learning');
            const suggestedText = String((req.body && req.body.suggestedText) || '') || null;
            aiLearning.learnFromAgentReply({ phone: t.customer_phone, replyText: text, suggestedText }).catch(() => {});
        }
        res.json({ ticket: publicTicket(updated) });
    } catch (error) {
        console.error(`[Support Desk] ${mode} error:`, error.message);
        res.status(500).json({ error: 'Failed to send' });
    }
}
router.post('/tickets/:id/reply', (req, res) => agentComposer(req, res, 'reply'));
router.post('/tickets/:id/ask', (req, res) => agentComposer(req, res, 'ask'));
router.post('/tickets/:id/note', (req, res) => agentComposer(req, res, 'note'));

// ── AI reply suggestions (drafts only — never auto-sent) ──
// Desk-tuned engine: gathers context from the ticket thread + customerContext
// (order/return/exchange/RTO) + the structured reason/sub, then reuses the
// shared SOP prompt. Same per-actor daily budget as the portal, scoped to
// `desk:<agent>`.
router.post('/tickets/:id/suggest-reply', async (req, res) => {
    try {
        const { suggestReplyDesk } = require('../services/ai/suggestReplyDesk');
        const result = await suggestReplyDesk({
            actor: `desk:${agentName(req)}`,
            ticketId: req.params.id,
            prefetch: Boolean(req.body && req.body.prefetch)
        });
        res.json({ success: true, suggestions: result.suggestions });
    } catch (error) {
        console.error('[Support Desk] suggest-reply error:', error.message);
        const known = ['AI_NOT_CONFIGURED', 'AI_DISABLED', 'AI_LIMIT', 'NO_HISTORY', 'NO_TICKET', 'AI_RATE_LIMIT', 'AI_UNAVAILABLE'];
        const status = known.includes(error.code) ? 400 : 500;
        res.status(status).json({ success: false, error: known.includes(error.code) ? error.message : 'Failed to generate suggestions' });
    }
});

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
        // Start the 45-day media deletion timer from this closure instant.
        await supportMedia.armRetention(t.ticket_number, new Date(now).toISOString());
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
        // Named-staff action stays desk-side; the customer sees the status move.
        thread.push({ kind: 'event', text: 'Reopened by ' + agentName(req), at: Date.now(), internal: true });
        const updated = await Support.updateTicket(t.id, {
            status: 'open', thread, last_customer_at: new Date().toISOString(), updated_at: new Date().toISOString()
        });
        // Reopening cancels the pending deletion timer.
        await supportMedia.clearRetention(t.ticket_number);
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
// Legacy server-proxy path; new UI uses the signed direct-upload below.
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

// ============================================================
// Signed browser direct-upload (Cloudinary) — agent desk surface
// ============================================================
router.post('/media/intent', async (req, res) => {
    try {
        if (!supportCloudinary.isConfigured()) {
            return res.status(503).json({ error: 'Image upload is not configured' });
        }
        const b = req.body || {};
        const intent = await supportMedia.createIntent({
            channel: 'website',
            ticketRef: b.ticket_ref || null,
            direction: 'outgoing',
            actor: agentName(req)
        });
        res.json(intent);
    } catch (error) {
        console.error('[Support Desk] media intent error:', error.message);
        res.status(500).json({ error: 'Failed to start upload' });
    }
});

router.post('/media/:id/finalize', async (req, res) => {
    try {
        const row = await supportMedia.getById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Media not found' });
        const updated = await supportMedia.finalize({ mediaId: row.id });
        res.json({ media: supportMedia.publicView(updated) });
    } catch (error) {
        console.error('[Support Desk] media finalize error:', error.message);
        res.status(400).json({ error: error.message || 'Failed to confirm upload' });
    }
});

router.post('/media/:id/retry', async (req, res) => {
    try {
        const row = await supportMedia.getById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Media not found' });
        const fresh = await supportMedia.retry({ mediaId: row.id });
        res.json(fresh);
    } catch (error) {
        console.error('[Support Desk] media retry error:', error.message);
        res.status(400).json({ error: error.message || 'Failed to retry upload' });
    }
});

// ── Admin settings ──
// 'portal_routing' is the desk auto-pilot toggle consumed by
// Support.autoRouteTicket when a new ticket is created.
const SETTING_KEYS = ['sla', 'teams', 'canned_responses', 'resolution_templates', 'cost_config', 'portal_routing', 'access'];
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

// ============================================================
// Access console — segments, bulk grants and the access policy.
//
// The whitelist decides who gets the storefront Help & Tickets tab,
// so every mutation here goes through supportAccessService (which
// owns the shared snapshot) and invalidates it, rather than writing
// rows from three different places.
//
// Authority split: desk agents may add and remove numbers when the
// policy allows it, but anything that changes who gets in *globally*
// — the mode, the policy, emptying the list, re-pointing the whole
// list at a segment — stays master-admin only.
// ============================================================

// Shopify order sync is rate-limited, so a bulk grant only pulls orders
// for the head of the list; beyond that the desk points at "Re-sync".
const GRANT_SYNC_CAP = 100;

async function resolvePhones(req) {
    const body = req.body || {};
    if (Array.isArray(body.phones)) return body.phones;
    if (body.segment) return SupportAccess.segmentPhones(body.segment);
    if (body.text) return SupportAccess.parseImport(body.text).valid;
    return [];
}

// Grants/requisitions honour the policy's agentMayGrant toggle; global
// switches never do.
async function mayManageGrants(req, res, next) {
    try {
        if (req.admin && req.admin.role === 'admin') return next();
        const policy = await SupportAccess.getPolicy();
        if (!policy.agentMayGrant) {
            return res.status(403).json({ error: 'Access changes are restricted to the master admin (see Access › Policy).' });
        }
        next();
    } catch (e) {
        next(e);
    }
}

async function syncOrdersBounded(phones) {
    const targets = phones.slice(0, GRANT_SYNC_CAP);
    let orders = 0;
    let failed = 0;
    // Five at a time: enough to keep a 100-number grant under a minute,
    // few enough to stay clear of the Shopify API rate budget.
    for (let i = 0; i < targets.length; i += 5) {
        const batch = targets.slice(i, i + 5);
        const results = await Promise.all(batch.map(p =>
            SupportSync.syncOrdersForPhone(p).then(r => r.orders || 0).catch(() => { failed++; return 0; })
        ));
        orders += results.reduce((a, b) => a + b, 0);
    }
    return { synced: targets.length, orders, failed, capped: phones.length > targets.length };
}

// ---------- Support Desk intro message ----------
// The Meta template support_desk_intro (see create_support_desk_intro_template.js)
// announces the Support Desk to customers. It can ride along with any grant
// (the Access console's "Send intro message" checkbox, or the notifyOnGrant
// policy default) or go on demand to any selection/segment via /access/announce.
// Sending goes through the shared broadcast queue, so the customer name is
// resolved per recipient ({{name}}) and Meta's send rate is respected; if the
// template is still pending approval the sends fail in the queue, not here.
const SUPPORT_DESK_INTRO_TEMPLATE = 'support_desk_intro';
const INTRO_QUEUE_CAP = 2000;

async function queueSupportDeskIntro(phones, req) {
    const targets = (phones || []).slice(0, INTRO_QUEUE_CAP);
    if (!targets.length) return { queued: 0 };
    try {
        const result = await broadcastService.sendTemplateToPhones(
            SUPPORT_DESK_INTRO_TEMPLATE,
            'en',
            targets,
            agentName(req),
            [{ type: 'body', parameters: [{ type: 'text', text: '{{name}}' }] }],
            5,
            'Support Desk intro'
        );
        if (!result.success) return { error: result.message };
        return { queued: targets.length, broadcastId: result.broadcastId, capped: phones.length > targets.length };
    } catch (e) {
        console.error('[Support Desk] intro queue error:', e.message);
        return { error: e.message };
    }
}

// The grant checkbox always wins; without it the policy default decides.
function wantAnnounce(body, policy) {
    return body.announce !== undefined ? !!body.announce : !!policy.notifyOnGrant;
}

router.get('/access/overview', async (req, res) => {
    try {
        res.json(await SupportAccess.overview());
    } catch (error) {
        console.error('[Support Desk] access overview error:', error.message);
        res.status(500).json({ error: 'Failed to load access overview: ' + error.message });
    }
});

router.get('/access/roster', async (req, res) => {
    try {
        res.json({ rows: await SupportAccess.listRoster({ limit: req.query.limit, dormantDays: req.query.dormantDays }) });
    } catch (error) {
        console.error('[Support Desk] access roster error:', error.message);
        res.status(500).json({ error: 'Failed to load the access list: ' + error.message });
    }
});

router.get('/access/candidates', async (req, res) => {
    try {
        if (!req.query.segment) return res.status(400).json({ error: 'segment is required' });
        res.json(await SupportAccess.candidates(req.query.segment, {
            q: req.query.q, roster: req.query.roster, limit: req.query.limit, offset: req.query.offset
        }));
    } catch (error) {
        console.error('[Support Desk] access candidates error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

router.post('/access/grant', mayManageGrants, async (req, res) => {
    try {
        const body = req.body || {};
        const phones = await resolvePhones(req);
        if (!phones.length) return res.status(400).json({ error: 'Nothing to grant — no numbers matched' });
        const policy = await SupportAccess.getPolicy();
        const result = await SupportAccess.bulkGrant(phones, {
            addedBy: agentName(req),
            note: body.note || null,
            days: body.days,
            level: body.level,
            source: body.segment ? `segment:${body.segment}`.slice(0, 40) : (body.source || 'manual'),
            policy
        });
        const wantSync = body.sync !== undefined ? !!body.sync : policy.syncOnGrant;
        const sync = wantSync ? await syncOrdersBounded(result.phones || []) : null;
        const announce = wantAnnounce(body, policy) ? await queueSupportDeskIntro(result.phones || [], req) : null;
        res.json({ success: true, ...result, sync, announce });
    } catch (error) {
        console.error('[Support Desk] access grant error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

router.post('/access/revoke', mayManageGrants, async (req, res) => {
    try {
        const body = req.body || {};
        let phones;
        if (body.all) {
            if (req.admin && req.admin.role !== 'admin') {
                return res.status(403).json({ error: 'Clearing the whole access list is master-admin only.' });
            }
            phones = await SupportAccess.segmentPhones('granted');
        } else {
            phones = await resolvePhones(req);
        }
        if (!phones.length) return res.status(400).json({ error: 'Nothing to revoke' });
        const result = await SupportAccess.bulkRevoke(phones);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Support Desk] access revoke error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// "Allow only this group": grants everyone the segment matches and revokes
// everyone it does not, so the list can be re-pointed in one action.
router.post('/access/sync-to-segment', requireAdmin, async (req, res) => {
    try {
        const { segment, note } = req.body || {};
        if (!segment) return res.status(400).json({ error: 'segment is required' });
        const result = await SupportAccess.syncListToSegment(segment, { addedBy: agentName(req), note });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Support Desk] access sync-to-segment error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

router.post('/access/update', mayManageGrants, async (req, res) => {
    try {
        const body = req.body || {};
        const phones = await resolvePhones(req);
        if (!phones.length) return res.status(400).json({ error: 'Nothing selected' });
        const result = await SupportAccess.updateGrants(phones, { level: body.level, days: body.days, note: body.note });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Support Desk] access update error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

router.post('/access/cleanup', mayManageGrants, async (req, res) => {
    try {
        const { kind, days } = req.body || {};
        const result = await SupportAccess.cleanup(kind, { days });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[Support Desk] access cleanup error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Paste a column of numbers from a sheet or an export; the service normalizes
// and dedupes before anything is written.
router.post('/access/import', mayManageGrants, async (req, res) => {
    try {
        const body = req.body || {};
        const parsed = SupportAccess.parseImport(body.text);
        if (!parsed.valid.length) {
            return res.status(400).json({ error: 'No valid phone numbers found', invalid: parsed.invalid });
        }
        const policy = await SupportAccess.getPolicy();
        const result = await SupportAccess.bulkGrant(parsed.valid, {
            addedBy: agentName(req),
            note: body.note || null,
            days: body.days,
            level: body.level,
            source: 'import',
            policy
        });
        const announce = wantAnnounce(body, policy) ? await queueSupportDeskIntro(result.phones || [], req) : null;
        res.json({ success: true, parsed: parsed.valid.length, ignored: parsed.invalid.length, ...result, announce });
    } catch (error) {
        console.error('[Support Desk] access import error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Send the Support Desk intro on demand — to ticked numbers, a whole segment
// or pasted text, same resolution rules as a grant. Nothing is written to the
// whitelist here; this route only queues WhatsApp sends.
router.post('/access/announce', mayManageGrants, async (req, res) => {
    try {
        const phones = await resolvePhones(req);
        if (!phones.length) return res.status(400).json({ error: 'Nothing to send — no numbers matched' });
        res.json({ success: true, ...(await queueSupportDeskIntro(phones, req)) });
    } catch (error) {
        console.error('[Support Desk] access announce error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Re-pull Shopify orders for a selection without touching access itself.
router.post('/access/resync', async (req, res) => {
    try {
        const phones = await resolvePhones(req);
        if (!phones.length) return res.status(400).json({ error: 'Nothing selected' });
        res.json({ success: true, ...(await syncOrdersBounded(phones)) });
    } catch (error) {
        console.error('[Support Desk] access resync error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

router.put('/access/policy', requireAdmin, async (req, res) => {
    try {
        const value = req.body && req.body.value;
        if (!value || typeof value !== 'object') return res.status(400).json({ error: 'Policy must be an object' });
        res.json({ success: true, policy: await SupportAccess.savePolicy(value) });
    } catch (error) {
        console.error('[Support Desk] access policy error:', error.message);
        res.status(400).json({ error: error.message });
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
