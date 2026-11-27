/**
 * AI reply suggestions for the website Support Desk (/desk).
 *
 * Same engine as the CX portal (shared aiClient + SUGGEST_SYSTEM_PROMPT +
 * per-actor daily budget + cache), but the context is gathered from the desk's
 * own data model instead of the WhatsApp `messages` table:
 *   - conversation  → the ticket's `thread` JSON (customer/agent entries)
 *   - order/return/exchange/RTO → customerContextService (Shoppers Hub)
 *   - scenario      → derived from the ticket's structured reason/sub, which
 *                     website tickets always carry — the anchor that lets the
 *                     model "understand the query" far more precisely than the
 *                     portal's free-text-only flow.
 *
 * Drafts are ONLY returned to the desk composer — nothing is ever sent to the
 * customer from here.
 */

// aiClient/learning are called through the module object (not destructured)
// so the offline unit test can stub them without a DI framework.
const aiClient = require('./aiClient');
const { SUGGEST_SYSTEM_PROMPT } = require('./suggestReply');
const aiStore = require('./aiStore');
const learning = require('./learning');
const Settings = require('../../models/Settings');
const Support = require('../supportService');

// Cache + in-flight dedupe keyed by ticket. A generation is validated against
// the thread "version" (length + last timestamp), so a new message on either
// side forces a fresh generation while repeat/prefetch clicks return instantly
// and cost nothing (cache hits skip the AI call and the usage log entirely).
const DESK_CACHE_TTL_MS = 10 * 60 * 1000;
const DESK_CACHE_MAX = 200;
const deskCache = new Map();   // ticketId -> { version, result, at }
const inFlight = new Map();    // ticketId -> Promise<result>

// reason/sub → one of the 9 SOP classes named in SUGGEST_SYSTEM_PROMPT, so the
// model can anchor on the verified category the customer already picked rather
// than re-deriving it from prose. Falls back to a per-reason default.
const SCENARIO_BY_KEY = {
    'order/no_confirm': 'Where\'s my order',
    'order/edit': 'Address change',
    'order/cancel': 'Cancellation',
    'order/prepay': 'Payment/COD confusion',
    'order/cancelled_wrongly': 'Cancellation',
    'order/duplicate': 'Cancellation',
    'delivery/address_change': 'Address change',
    'delivery/reship_new': 'Address change',
    'delivery/pay_reship': 'Address change',
    'delivery/not_shipped': 'Where\'s my order',
    'delivery/delayed': 'Delayed/Not received',
    'delivery/tracking_stuck': 'Where\'s my order',
    'delivery/delivered_not_received': 'Delayed/Not received',
    'delivery/no_attempt': 'Delayed/Not received',
    'delivery/courier_extra': 'Escalation/Frustration',
    'product/wrong_product': 'Damaged/Wrong item',
    'product/wrong_size': 'Damaged/Wrong item',
    'product/damaged': 'Damaged/Wrong item',
    'product/defect': 'Damaged/Wrong item',
    'product/missing': 'Damaged/Wrong item',
    'product/tampered': 'Damaged/Wrong item',
    'fit/small': 'Size change',
    'fit/large': 'Size change',
    'fit/chart': 'Size change',
    'fit/fabric': 'Size change',
    'return/return_credit': 'Refund',
    'return/exchange_req': 'Size change',
    'return/pickup_not_scheduled': 'Refund',
    'return/pickup_missed': 'Escalation/Frustration',
    'return/exchange_not_received': 'Delayed/Not received',
    'return/exchange_stuck': 'Delayed/Not received',
    'return/qc_rejected': 'Escalation/Frustration',
    'credit/credit_missing': 'Refund',
    'credit/credit_invalid': 'Refund',
    'credit/charged_no_order': 'Payment/COD confusion',
    'credit/cod_wrong': 'Payment/COD confusion',
    'credit/refund_original': 'Refund'
};
const SCENARIO_BY_REASON = {
    order: 'Where\'s my order', delivery: 'Where\'s my order', product: 'Damaged/Wrong item',
    fit: 'Size change', return: 'Refund', credit: 'Payment/COD confusion', other: null
};
function scenarioOf(reason, sub) {
    if (!reason) return null;
    return SCENARIO_BY_KEY[`${reason}/${sub}`] || SCENARIO_BY_REASON[reason] || null;
}

// "2026-09-15T10:30:00.000Z" → "Sep 15" (saves ~15 chars per date vs ISO)
const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return `${_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Drop nulls/empties and truncate long strings so the prompt stays lean.
function prune(obj, caps = {}) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === null || v === undefined || v === '') continue;
        out[k] = (typeof v === 'string' && caps[k]) ? v.substring(0, caps[k]) : v;
    }
    return out;
}

function firstItemName(items) {
    const it = (Array.isArray(items) && items[0]) || null;
    if (!it) return null;
    const name = it.n || it.name || it.title || '';
    const variant = it.v || it.variant_title || '';
    return `${name}${variant ? ' - ' + variant : ''}`.substring(0, 60) || null;
}

// The ticket's own order (mapCachedOrder shape) leads, then recent orders from
// the hub context, deduped by id and capped — same short keys the SOP prompt
// documents for ord[].
function compactOrders(ticketOrder, ctxOrders) {
    const out = [];
    const seen = new Set();
    if (ticketOrder && ticketOrder.id) {
        seen.add(String(ticketOrder.id).replace(/^#/, ''));
        out.push(prune({
            oid: String(ticketOrder.id).replace(/^#/, ''),
            st: ticketOrder.stage || null,
            cr: ticketOrder.courier || null,
            awb: ticketOrder.awb || null,
            item: firstItemName(ticketOrder.items),
            amt: ticketOrder.total != null ? ticketOrder.total : null,
            pay: ticketOrder.payment || null,
            eta: ticketOrder.deliveredAt ? shortDate(new Date(ticketOrder.deliveredAt).toISOString()) : null,
            at: ticketOrder.placed ? shortDate(new Date(ticketOrder.placed).toISOString()) : null
        }, { item: 60 }));
    }
    for (const r of (ctxOrders || [])) {
        const oid = String(r.order_id || '').replace(/^#/, '');
        if (!oid || seen.has(oid)) continue;
        seen.add(oid);
        out.push(prune({
            oid,
            st: r.status || null,
            cr: r.courier_name || null,
            awb: r.awb || null,
            amt: r.order_total != null ? r.order_total : null,
            pay: r.payment_method || null,
            eta: r.delivered_at ? shortDate(r.delivered_at) : null,
            at: r.created_at ? shortDate(r.created_at) : null
        }));
    }
    return out.slice(0, 4);
}

// Merge returns + exchanges (local and portal sources carry slightly different
// field names) into one compact array with the t=R/E discriminator the prompt
// expects. RTO is already reflected through order status, so it needs no block.
function compactRnx(ctx) {
    const items = [];
    const seen = new Set();
    for (const r of ((ctx && ctx.returns) || []).slice(0, 4)) {
        const oid = String(r.order_number || r.order_id || '').replace(/^#/, '');
        const key = String(r.request_id || r.return_id || oid || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(prune({
            t: 'R', rid: r.request_id || r.return_id || oid, oid,
            st: r.status || null, why: String(r.reason || '').substring(0, 60) || null,
            amt: r.refund_amount != null ? r.refund_amount : (r.refundAmount != null ? r.refundAmount : null),
            rs: r.refund_status || r.refundStatus || null,
            at: shortDate(r.created_at || r.createdAt)
        }, { why: 60 }));
    }
    for (const r of ((ctx && ctx.exchanges) || []).slice(0, 4)) {
        const oid = String(r.order_number || r.order_id || '').replace(/^#/, '');
        const key = String(r.request_id || r.exchange_id || oid || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(prune({
            t: 'E', rid: r.request_id || r.exchange_id || oid, oid,
            st: r.status || null, why: String(r.reason || '').substring(0, 60) || null,
            diff: r.price_difference != null ? r.price_difference : (r.priceDifference != null ? r.priceDifference : null),
            ps: r.payment_status || r.paymentStatus || null,
            at: shortDate(r.created_at || r.createdAt)
        }, { why: 60 }));
    }
    return items.slice(0, 6);
}

function readThread(t) {
    let thread = t.thread;
    if (typeof thread === 'string') { try { thread = JSON.parse(thread); } catch { thread = []; } }
    return Array.isArray(thread) ? thread : [];
}

/**
 * Gather the desk-side context for one ticket. Returns everything the
 * generator needs plus a `version` string used to invalidate the cache when the
 * conversation changes.
 */
async function gatherDeskContext(ticketId) {
    const t = await Support.getTicket(ticketId);
    if (!t) {
        const err = new Error('Ticket not found.');
        err.code = 'NO_TICKET';
        throw err;
    }

    const thread = readThread(t);
    const conversation = thread
        .filter(m => m && m.kind !== 'event')
        .slice(-8)
        .map(m => ({ from: m.role === 'agent' ? 'agent' : 'customer', text: String(m.text || '').substring(0, 300) }));
    if (!conversation.length && String(t.message || '').trim()) {
        conversation.push({ from: 'customer', text: String(t.message).substring(0, 300) });
    }

    const phone = t.customer_phone || null;
    const [ctx, ticketOrder] = await Promise.all([
        phone ? Support.contextFor(phone) : Promise.resolve(null),
        t.order_id ? Support.getOrderByNumber(t.order_id, phone) : Promise.resolve(null)
    ]);

    const lastEntry = thread[thread.length - 1] || null;
    const version = `${thread.length}:${(lastEntry && (lastEntry.at || lastEntry.text || '')) || (t.message || '')}`;

    return {
        ticket: t,
        phone,
        customer: prune({
            name: t.customer_name || (ctx && ctx.customer && ctx.customer.name) || null,
            phone,
            email: t.customer_email || (ctx && ctx.customer && ctx.customer.email) || null,
            city: (ctx && ctx.customer && ctx.customer.city) || null
        }),
        conversation,
        orders: compactOrders(ticketOrder, ctx && ctx.orders),
        rnx: compactRnx(ctx),
        scenario: scenarioOf(t.reason, t.sub),
        sentiment: t.sentiment || null,
        // Golden wording: the desk already knows the exact SOP note for this
        // request type, so hand it to the model as a preferred-phrasing example.
        requestNote: (t.sub && Support.REQUEST_NOTES[t.sub])
            ? safeNote(Support.REQUEST_NOTES[t.sub], ticketOrder) : null,
        version
    };
}

function safeNote(fn, order) {
    try { return String(fn(order || {})).substring(0, 300); } catch { return null; }
}

/**
 * Generate reply suggestions for a desk ticket. Served from cache when the
 * thread hasn't changed; concurrent requests for the same ticket share one AI
 * call. Drafts only — never auto-sent.
 * @param {boolean} [prefetch] — cache-warming request (ticket just opened):
 *   keeps the tail of the daily budget reserved for explicit clicks.
 * @returns {{ suggestions: string[], customer: object }}
 */
async function suggestReplyDesk({ actor, ticketId, prefetch = false }) {
    if (!ticketId) {
        const err = new Error('Ticket id is required.');
        err.code = 'NO_TICKET';
        throw err;
    }
    if (!aiClient.isConfigured()) {
        const err = new Error('AI is not configured. Set AI_API_KEY in the server environment.');
        err.code = 'AI_NOT_CONFIGURED';
        throw err;
    }

    const enabled = await Settings.get('ai_admin_copilot_enabled', 'true');
    if (String(enabled) === 'false') {
        const err = new Error('The AI copilot is disabled in settings.');
        err.code = 'AI_DISABLED';
        throw err;
    }

    const context = await gatherDeskContext(ticketId);
    if (!context.conversation.length) {
        const err = new Error('No conversation history found for this ticket.');
        err.code = 'NO_HISTORY';
        throw err;
    }

    const cacheKey = String(ticketId);

    // Conversation unchanged since the last generation → instant, free
    const cached = deskCache.get(cacheKey);
    if (cached && cached.version === context.version && Date.now() - cached.at < DESK_CACHE_TTL_MS) {
        return cached.result;
    }
    deskCache.delete(cacheKey);

    // A generation for this ticket is already running (e.g. the open-ticket
    // prefetch) — share its result instead of paying for a second AI call
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    // Per-actor daily cap: every desk agent gets their own budget instead of
    // draining one shared pool. Prefetches stop at 90% so explicit ✨ clicks
    // keep the last slice.
    const dailyLimit = parseInt(await Settings.get(
        'ai_suggest_reply_daily_limit',
        process.env.AI_SUGGEST_REPLY_DAILY_LIMIT || '500'
    )) || 500;
    const actorKey = actor || 'desk:unknown';
    const usedToday = await aiStore.getTodayUsageCount(actorKey, 'suggest_reply');
    if (usedToday >= dailyLimit || (prefetch && usedToday >= dailyLimit * 0.9)) {
        const err = new Error(`AI suggestion daily limit reached (${dailyLimit}/day for this agent). Try again tomorrow or raise the limit in AI settings.`);
        err.code = 'AI_LIMIT';
        throw err;
    }

    const generation = generateDeskSuggestions({ actor: actorKey, context, cacheKey });
    inFlight.set(cacheKey, generation);
    try {
        return await generation;
    } finally {
        inFlight.delete(cacheKey);
    }
}

// The expensive part: learned-example lookup + AI call. Result is cached against
// the thread version for repeat requests.
async function generateDeskSuggestions({ actor, context, cacheKey }) {
    const lastCustomerMsg = [...context.conversation].reverse().find(m => m.from === 'customer');

    // Golden few-shot: learned team replies first, then the desk's own SOP note
    // for this request type (the customer already told us the category).
    const approvedExamples = lastCustomerMsg
        ? await learning.findSimilarExamples(lastCustomerMsg.text, 2)
        : [];
    const ex = approvedExamples.map(e => ({ q: e.q, a: e.a }));
    if (context.requestNote) {
        const label = context.ticket.sub_label || context.ticket.reason_label || 'this request';
        ex.push({ q: label, a: context.requestNote });
    }

    // Build the token-lean prompt using the same short-key vocabulary the
    // shared SUGGEST_SYSTEM_PROMPT documents (c/conv/ord/tkt/rnx/sent/sc/ex).
    const ctx = {
        c: context.customer,
        conv: context.conversation,
        ord: context.orders,
        tkt: [prune({
            tn: context.ticket.ticket_number || null,
            msg: String(context.ticket.message || '').substring(0, 200) || null,
            st: context.ticket.status || null,
            sc: context.scenario || null
        }, { msg: 200 })]
    };
    if (context.rnx.length) ctx.rnx = context.rnx;
    if (context.scenario) ctx.sc = context.scenario;
    if (context.sentiment) ctx.sent = context.sentiment;
    if (ex.length) ctx.ex = ex;

    const { message, usage, model } = await aiClient.chatCompletion({
        messages: [
            { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(ctx) }
        ],
        temperature: 0.5,
        maxTokens: 1500,
        responseFormat: { type: 'json_object' }
    });

    let suggestions = [];
    try {
        const parsed = JSON.parse(message.content);
        suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    } catch {
        // Model returned non-JSON despite response_format — fall back to raw text as one draft
        if (message.content) suggestions = [String(message.content).substring(0, 500)];
    }
    suggestions = suggestions
        .filter(s => typeof s === 'string' && s.trim())
        .map(s => s.trim().substring(0, 1000))
        .slice(0, 3);

    await aiStore.logUsage({
        actor,
        kind: 'suggest_reply',
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens
    });

    const result = { suggestions, customer: context.customer };
    if (suggestions.length) {
        if (deskCache.size >= DESK_CACHE_MAX) {
            // Evict the oldest entry (Map preserves insertion order)
            deskCache.delete(deskCache.keys().next().value);
        }
        deskCache.set(cacheKey, { version: context.version, result, at: Date.now() });
    }
    return result;
}

module.exports = { suggestReplyDesk, gatherDeskContext, scenarioOf };
