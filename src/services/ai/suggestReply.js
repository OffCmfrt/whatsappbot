/**
 * AI reply suggestions for customer WhatsApp chats.
 *
 * Gathers the customer's recent conversation + order/shipment/ticket context and
 * asks the model for up to 3 short reply drafts. Drafts are ONLY returned to the
 * dashboard — nothing is ever sent to the customer from here.
 */

const { chatCompletion, isConfigured } = require('./aiClient');
const aiStore = require('./aiStore');
const { findSimilarExamples } = require('./learning');
const Settings = require('../../models/Settings');
const { dbAdapter } = require('../../database/db');

// Suggestion cache + in-flight dedupe, keyed by phone+ticket. Entries are
// validated against the latest message id, so a new customer message always
// forces a fresh generation while repeat/prefetched requests return instantly
// (and cost nothing — cache hits skip the AI call and usage log entirely).
const SUGGEST_CACHE_TTL_MS = 10 * 60 * 1000;
const SUGGEST_CACHE_MAX = 100;
const suggestionCache = new Map(); // key -> { latestMsgId, result, at }
const inFlight = new Map();        // key -> Promise<result>

const SUGGEST_SYSTEM_PROMPT = `You are a customer support assistant for OFFCOMFRT (Indian D2C clothing brand). Draft WhatsApp replies for a human support agent to review and send.

CONTEXT KEYS (abbreviated to save tokens):
c=customer, conv=conversation(from/text), ord=orders(oid/st/awb/cr/item/amt/pay/eta/at), tkt=tickets(tn/msg/st/sent/sc/at), rnx=returns+exchanges(t=R or E, rid,oid,why,st,amt,rs=refund_status,diff=price_diff,ps=payment_status,old/new=items,at), sent=sentiment, sc=scenario, ex=approved examples.
Order/ticket fields: oid=order_id, st=status, cr=courier, item=product_name, amt=total, pay=payment_method, eta=expected_delivery, at=date, tn=ticket_number, msg=message.
Return fields(t=R): rid=return_id, why=reason, rs=refund_status, amt=refund_amount.
Exchange fields(t=E): rid=exchange_id, why=reason, diff=price_difference, ps=payment_status, old=old_items, new=new_items.

MANDATORY 4-STEP WORKFLOW PIPELINE:
1. STEP 1 — IDENTIFY SCENARIO: Identify customer's exact issue from 9 SOP classes (Where's my order, Delayed/Not received, Refund, Size change, Damaged/Wrong item, Address change, Payment/COD confusion, Cancellation, Escalation/Frustration).
2. STEP 2 — CHECK DATA FROM CONTEXT: Rely strictly on verified data in ord[], tkt[], rnx[]:
   - ord[]: order status, courier, tracking, payment method, delivery dates
   - rnx[]: return/exchange status, reason, refund amount/status, exchange price difference & payment status
   - tkt[]: ticket status, sentiment, classified scenario
3. STEP 3 — CROSS-CHECK KEY RULES (CRITICAL):
   - Where's my order: Follow partner sequence strictly (Shiprocket → Delhivery → Ekart prepaid). Unresolved edit details → calling executive → COD holds, prepaid ships as-is after 24h.
   - Delayed/not received: If "Delivered", ask about neighbours/security; else request POD, wait 24h.
   - Refund: Original payment method refund (5-7 days) ONLY for damaged item, wrong product, prepaid cancelled at confirmation, or RTO without customer receipt. Store credit for all others. Never promise cash refund for size/preference returns. Check rnx[].rs and rnx[].amt for refund status.
   - Size change: Pre-dispatch: Edit Details. Post-delivery: offcomfrt.in → Support → Return/Exchange portal. Check rnx[] where t=E for existing exchange requests.
   - Damaged/wrong item: Mandatory unboxing video for wrong product; photos for damage. Submitted via website portal only. Check rnx[] where t=R for existing claims.
   - Address change: Pre-ship: Edit Details. Post-ship: address cannot be changed on active shipment. For RTO: prepaid reships after RTO (or cancel in-transit for fresh order); COD dispatches fresh order immediately.
   - Payment/COD confusion: Discount not reapplied after edit converted to COD; customer pays cash at door, Offcomfrt refunds that amount separately. For exchange top-ups: check rnx[].ps (payment_status).
   - Cancellation: Actioned via Shoppers Hub confirmation text. Prepaid post-ship: cancel in-transit + refund. COD post-ship: instruct customer to refuse delivery.
   - Escalation/frustration: Resolve over chat first; consult admin before taking any action. Never default to phone callback.
4. STEP 4 — DRAFT OR REVERT: If context data is missing or rule validation fails, draft a response stating our team is checking with admin to resolve it immediately. NEVER invent unverified tracking, dates, or promises.

SENTIMENT AWARENESS:
- If sent is "frustrated" or "negative": lead with empathy, acknowledge the inconvenience, be extra reassuring.
- If sent is "positive": keep the tone light and friendly.
- If sc is provided, align your reply with that scenario's SOP rules.

Formatting Rules:
- Write up to 3 alternative reply drafts to the customer's latest messages.
- Tone: warm, professional, concise. WhatsApp style — short sentences, at most one emoji per draft.
- Use ONLY facts from provided context. Never invent order numbers or fake tracking.
- Reply in the same language style used by customer (English / Hindi / Hinglish).
- ex[] (if present) are golden SOP replies — prefer their wording.
- Respond with JSON only: {"suggestions": ["draft 1", "draft 2", "draft 3"]}. 1-3 drafts, each under 500 characters.`;

async function gatherContext(phone, ticketId) {
    const digits = String(phone).replace(/\D/g, '');
    const phonePattern = `%${digits.slice(-10)}`;

    const [messages, customer, orders, tickets, returns, exchanges] = await Promise.all([
        dbAdapter.query(
            `SELECT id, message_type, message_content FROM messages
             WHERE customer_phone LIKE ? ORDER BY id DESC LIMIT 12`,
            [phonePattern]
        ),
        dbAdapter.query('SELECT phone, name, email FROM customers WHERE phone LIKE ? LIMIT 1', [phonePattern]),
        dbAdapter.query(
            `SELECT order_id, status, awb, courier_name, product_name, total, payment_method, expected_delivery, created_at
             FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 5`,
            [phonePattern]
        ),
        ticketId
            ? dbAdapter.query('SELECT id, ticket_number, message, status, sentiment, ai_confidence, ai_scenario, created_at FROM support_tickets WHERE id = ?', [ticketId])
            : dbAdapter.query(
                `SELECT id, ticket_number, message, status, sentiment, ai_confidence, ai_scenario, created_at FROM support_tickets
                 WHERE customer_phone LIKE ? AND status = 'open' ORDER BY created_at DESC LIMIT 3`,
                [phonePattern]
            ),
        // Returns: only essential fields, most recent 5 — items truncated for token savings
        dbAdapter.query(
            `SELECT return_id, order_id, items, reason, status, refund_amount, refund_status, created_at
             FROM returns WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 5`,
            [phonePattern]
        ),
        // Exchanges: only essential fields, most recent 5 — items truncated for token savings
        dbAdapter.query(
            `SELECT exchange_id, order_id, old_items, new_items, reason, status, price_difference, payment_status, created_at
             FROM exchanges WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 5`,
            [phonePattern]
        )
    ]);

    return {
        customer: customer[0] || { phone: digits },
        latestMsgId: messages[0]?.id || null,
        conversation: messages.reverse().map(m => ({
            from: m.message_type === 'incoming' ? 'customer' : 'agent',
            text: String(m.message_content || '').substring(0, 300)
        })),
        orders: orders.map(compactOrder),
        tickets: tickets.map(compactTicket),
        // Merged returns+exchanges: single compact array, short keys, short dates
        rnx: compactReturnsExchanges(returns, exchanges),
        // Carry forward AI classification for context-aware suggestions
        sentiment: tickets[0]?.sentiment || null,
        aiScenario: tickets[0]?.ai_scenario || null,
        aiConfidence: tickets[0]?.ai_confidence || null
    };
}

// "2026-09-15T10:30:00.000Z" → "Sep 15"  (saves ~15 chars per date vs ISO)
const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function shortDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return `${_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Remap an object's keys via a map, drop nulls/empties
function remapKeys(obj, keyMap) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === null || v === undefined || v === '') continue;
        const short = keyMap[k] || k;
        out[short] = v;
    }
    return out;
}

// Compact order for prompt: short keys + short date, drop nulls
const ORDER_KEY_MAP = {
    order_id: 'oid', status: 'st', awb: 'awb', courier_name: 'cr',
    product_name: 'item', total: 'amt', payment_method: 'pay',
    expected_delivery: 'eta', created_at: 'at'
};
function compactOrder(r) {
    const o = remapKeys(r, ORDER_KEY_MAP);
    if (o.at) o.at = shortDate(r.created_at);
    if (o.eta) o.eta = shortDate(r.expected_delivery);
    if (o.item) o.item = String(o.item).substring(0, 60);
    return o;
}

// Compact ticket for prompt: short keys + short date
const TICKET_KEY_MAP = {
    ticket_number: 'tn', message: 'msg', status: 'st',
    sentiment: 'sent', ai_scenario: 'sc', created_at: 'at'
};
function compactTicket(r) {
    const o = remapKeys(r, TICKET_KEY_MAP);
    if (o.at) o.at = shortDate(r.created_at);
    if (o.msg) o.msg = String(o.msg).substring(0, 200);
    return o;
}

// Merge returns + exchanges into one compact array with type discriminator.
// Short keys, short dates, truncated item text — minimum tokens.
const RETURN_KEY_MAP = {
    return_id: 'rid', order_id: 'oid', reason: 'why', status: 'st',
    refund_amount: 'amt', refund_status: 'rs', created_at: 'at'
};
const EXCHANGE_KEY_MAP = {
    exchange_id: 'rid', order_id: 'oid', reason: 'why', status: 'st',
    price_difference: 'diff', payment_status: 'ps', created_at: 'at'
};
function compactReturnsExchanges(returns, exchanges) {
    const items = [];
    for (const r of (returns || []).slice(0, 3)) {
        const o = remapKeys(r, RETURN_KEY_MAP);
        if (o.at) o.at = shortDate(r.created_at);
        o.items = String(r.items || '').substring(0, 80);
        o.t = 'R'; // type = return
        items.push(o);
    }
    for (const r of (exchanges || []).slice(0, 3)) {
        const o = remapKeys(r, EXCHANGE_KEY_MAP);
        if (o.at) o.at = shortDate(r.created_at);
        o.old = String(r.old_items || '').substring(0, 50);
        o.new = String(r.new_items || '').substring(0, 50);
        o.t = 'E'; // type = exchange
        items.push(o);
    }
    // Sort by date descending (most recent first), limit to 5 total
    return items.sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 5);
}

/**
 * Generate reply suggestions for a customer's chat.
 * Served from cache when the conversation hasn't changed since the last
 * generation; concurrent requests for the same chat share one AI call.
 * @param {boolean} [prefetch] — cache-warming request (chat just opened):
 *   keeps the tail of the daily budget reserved for explicit clicks.
 * @returns {{ suggestions: string[], context: object }}
 */
async function suggestReply({ actor, phone, ticketId, prefetch = false }) {
    if (!isConfigured()) {
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

    const context = await gatherContext(phone, ticketId);
    if (!context.conversation.length) {
        const err = new Error('No conversation history found for this customer.');
        err.code = 'NO_HISTORY';
        throw err;
    }

    const cacheKey = `${String(phone).replace(/\D/g, '').slice(-10)}:${ticketId || ''}`;

    // Conversation unchanged since the last generation → instant, free
    const cached = suggestionCache.get(cacheKey);
    if (cached && cached.latestMsgId === context.latestMsgId
        && Date.now() - cached.at < SUGGEST_CACHE_TTL_MS) {
        return cached.result;
    }
    suggestionCache.delete(cacheKey);

    // A generation for this chat is already running (e.g. the open-chat
    // prefetch) — share its result instead of paying for a second AI call
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    // Per-actor daily cap for suggestions — every admin username and every CX
    // portal (`portal:<slug>`) gets its OWN budget instead of draining one shared
    // pool. Prefetches stop at 90% so explicit ✨ clicks keep the last slice.
    const dailyLimit = parseInt(await Settings.get(
        'ai_suggest_reply_daily_limit',
        process.env.AI_SUGGEST_REPLY_DAILY_LIMIT || '500'
    )) || 500;
    const actorKey = actor || 'unknown';
    const usedToday = await aiStore.getTodayUsageCount(actorKey, 'suggest_reply');
    if (usedToday >= dailyLimit || (prefetch && usedToday >= dailyLimit * 0.9)) {
        const subject = String(actorKey).startsWith('portal:') ? 'portal' : 'admin';
        const err = new Error(`AI suggestion daily limit reached (${dailyLimit}/day for this ${subject}). Try again tomorrow or raise the limit in AI settings.`);
        err.code = 'AI_LIMIT';
        throw err;
    }

    const generation = generateSuggestions({ actor, context, cacheKey });
    inFlight.set(cacheKey, generation);
    try {
        return await generation;
    } finally {
        inFlight.delete(cacheKey);
    }
}

// The expensive part: learned-example lookup + AI call. Result is cached
// against the conversation version (latest message id) for repeat requests.
async function generateSuggestions({ actor, context, cacheKey }) {
    // Learned few-shot examples: what our team actually replied to similar questions
    const lastCustomerMsg = [...context.conversation].reverse().find(m => m.from === 'customer');
    const approvedExamples = lastCustomerMsg
        ? await findSimilarExamples(lastCustomerMsg.text, 3)
        : [];

    // Build token-lean prompt: short keys, compact dates, merged returns+exchanges
    const ctx = {
        c: context.customer,                    // customer
        conv: context.conversation.slice(-6),   // last 3 turns
        ord: context.orders,                    // recent orders (compact)
        tkt: context.tickets,                   // open tickets (compact)
    };
    // Only include rnx if non-empty — zero token cost for customers without returns/exchanges
    if (context.rnx?.length) ctx.rnx = context.rnx;
    if (context.sentiment) ctx.sent = context.sentiment;
    if (context.aiScenario) ctx.sc = context.aiScenario;
    if (approvedExamples.length) ctx.ex = approvedExamples.map(e => ({ q: e.q, a: e.a }));

    const userContent = JSON.stringify(ctx);

    const { message, usage, model } = await chatCompletion({
        messages: [
            { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
            { role: 'user', content: userContent }
        ],
        temperature: 0.5,
        maxTokens: 800,
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
        if (suggestionCache.size >= SUGGEST_CACHE_MAX) {
            // Evict the oldest entry (Map preserves insertion order)
            suggestionCache.delete(suggestionCache.keys().next().value);
        }
        suggestionCache.set(cacheKey, { latestMsgId: context.latestMsgId, result, at: Date.now() });
    }
    return result;
}

module.exports = { suggestReply };
