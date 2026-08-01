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

MANDATORY 4-STEP WORKFLOW PIPELINE:
1. STEP 1 — IDENTIFY SCENARIO: Identify customer's exact issue scenario from the 9 SOP classes (Where's my order, Delayed/Not received, Refund, Size change, Damaged/Wrong item, Address change, Payment/COD confusion, Cancellation, Escalation/Frustration).
2. STEP 2 — CHECK DATA FROM RELIABLE SOURCES ONLY: Rely strictly on verified data present in the context:
   - Shoppers Hub (order confirmation & edit status)
   - Shiprocket / Delhivery One / Ekart (shipping status)
   - Shopify & Return/Exchange portal (payment status, pending amount, submitted proof uploads)
3. STEP 3 — CROSS-CHECK KEY RULES (CRITICAL):
   - Where's my order: Follow partner sequence strictly (Shiprocket → Delhivery → Ekart prepaid). Unresolved edit details → calling executive → COD holds, prepaid ships as-is after 24h.
   - Delayed/not received: If "Delivered", ask about neighbours/security; else request POD, wait 24h.
   - Refund: Original payment method refund (5-7 days) ONLY for damaged item, wrong product, prepaid cancelled at confirmation, or RTO without customer receipt. Store credit for all others. Never promise cash refund for size/preference returns.
   - Size change: Pre-dispatch: Edit Details. Post-delivery: offcomfrt.in → Support → Return/Exchange portal.
   - Damaged/wrong item: Mandatory unboxing video for wrong product; photos for damage. Submitted via website portal only.
   - Address change: Pre-ship: Edit Details. Post-ship: address cannot be changed on active shipment. For RTO: prepaid reships after RTO (or cancel in-transit for fresh order); COD dispatches fresh order immediately.
   - Payment/COD confusion: Discount not reapplied after edit converted to COD; customer pays cash at door, Offcomfrt refunds that amount separately.
   - Cancellation: Actioned via Shoppers Hub confirmation text. Prepaid post-ship: cancel in-transit + refund. COD post-ship: instruct customer to refuse delivery.
   - Escalation/frustration: Resolve over chat first; consult admin before taking any action. Never default to phone callback.
4. STEP 4 — DRAFT OR REVERT: If context data is missing or rule validation fails, draft a response stating our team is checking with admin to resolve it immediately. NEVER invent unverified tracking, dates, or promises.

Formatting Rules:
- Write up to 3 alternative reply drafts to the customer's latest messages.
- Tone: warm, professional, concise. WhatsApp style — short sentences, at most one emoji per draft.
- Use ONLY facts from provided context. Never invent order numbers or fake tracking.
- Reply in the same language style used by customer (English / Hindi / Hinglish).
- approvedExamples (if present) are golden SOP replies — prefer their wording.
- Respond with JSON only: {"suggestions": ["draft 1", "draft 2", "draft 3"]}. 1-3 drafts, each under 500 characters.`;

async function gatherContext(phone, ticketId) {
    const digits = String(phone).replace(/\D/g, '');
    const phonePattern = `%${digits.slice(-10)}`;

    const [messages, customer, orders, tickets] = await Promise.all([
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
            ? dbAdapter.query('SELECT id, ticket_number, message, status, created_at FROM support_tickets WHERE id = ?', [ticketId])
            : dbAdapter.query(
                `SELECT id, ticket_number, message, status, created_at FROM support_tickets
                 WHERE customer_phone LIKE ? AND status = 'open' ORDER BY created_at DESC LIMIT 3`,
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
        recentOrders: orders.map(compactRow),
        tickets: tickets.map(compactRow)
    };
}

// Drop null/empty fields — they add tokens without adding information
function compactRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) {
        if (v === null || v === undefined || v === '') continue;
        out[k] = v;
    }
    return out;
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

    // Separate daily cap for suggestions (shared across admins). Prefetches
    // stop at 90% so explicit ✨ clicks keep the last slice of the budget.
    const dailyLimit = parseInt(await Settings.get('ai_suggest_reply_daily_limit', '100')) || 100;
    const totalToday = await countAllSuggestionsToday();
    if (totalToday >= dailyLimit || (prefetch && totalToday >= dailyLimit * 0.9)) {
        const err = new Error(`AI suggestion daily limit reached (${dailyLimit}). Try again tomorrow.`);
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

    const userContent = JSON.stringify({
        customer: context.customer,
        conversation: context.conversation,
        recentOrders: context.recentOrders,
        openTickets: context.tickets,
        ...(approvedExamples.length ? { approvedExamples: approvedExamples.map(e => ({ q: e.q, a: e.a })) } : {})
    });

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

async function countAllSuggestionsToday() {
    const rows = await dbAdapter.query(
        `SELECT COUNT(*)::int AS count FROM ai_usage_log
         WHERE kind = 'suggest_reply' AND created_at >= date_trunc('day', NOW())`
    );
    return rows[0]?.count || 0;
}

module.exports = { suggestReply };
