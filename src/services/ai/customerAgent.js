/**
 * Customer-facing AI agent for the OFFCOMFRT support widget.
 *
 * Separate from the admin copilot (agent.js) — this agent helps shoppers
 * track orders, answers FAQs, and escalates to a support ticket when needed.
 *
 * Uses the same aiClient.js pipeline (Groq/Gemini) but with a customer-friendly
 * system prompt and a restricted tool set (read-only + ticket creation).
 *
 * Enhanced with:
 * - Multi-turn context tracking (orderId, awb, entities persist across turns)
 * - Entity extraction from messages (order IDs, AWBs, pin codes)
 * - Expanded tool set (search_orders_by_phone, faq_lookup, check_return_eligibility)
 * - Multi-language awareness (detects and responds in customer's language)
 */

const { chatCompletion, isConfigured, estimateTokens } = require('./aiClient');
const { getTool } = require('./tools');
const { dbAdapter } = require('../../database/db');
const { detectLanguage } = require('./autoSupportAgent');

// ---------- Session store (in-memory, 30-min TTL) ----------

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_TURNS = 10;

function getSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return { history: [], context: {} };
    if (Date.now() - entry.lastAccess > SESSION_TTL_MS) {
        sessions.delete(sessionId);
        return { history: [], context: {} };
    }
    entry.lastAccess = Date.now();
    return { history: entry.history || [], context: entry.context || {} };
}

function saveSession(sessionId, history, context) {
    while (history.length > MAX_HISTORY_TURNS * 2) {
        history.shift();
    }
    sessions.set(sessionId, { history, context: context || {}, lastAccess: Date.now() });
}

// Periodic cleanup of expired sessions (every 10 min)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessions) {
        if (now - entry.lastAccess > SESSION_TTL_MS) sessions.delete(key);
    }
}, 10 * 60 * 1000).unref();

// ---------- Entity extraction ----------

function extractEntities(text) {
    const entities = {};
    // Order IDs: #1234, ORD-1234, or a standalone 4-5 digit order number (e.g. "42000")
    const orderMatch = text.match(/#(\d{3,})/)
        || text.match(/\b(?:ORD|ORDER)[-_ ]?(\d{3,})\b/i)
        || text.match(/\b(\d{4,5})\b/);
    if (orderMatch) entities.orderId = orderMatch[1];
    // AWB: 10-16 digit numbers (order IDs are only 4-5 digits, so no clash)
    const awbMatch = text.match(/\b(\d{10,16})\b/);
    if (awbMatch && !entities.orderId) entities.awb = awbMatch[1];
    // Pin code: 6-digit number
    const pinMatch = text.match(/\b(\d{6})\b/);
    if (pinMatch) entities.pincode = pinMatch[1];
    return entities;
}

// ---------- System prompt ----------

function buildSystemPrompt(context, language) {
    const langInstruction =
        language === 'hindi'
            ? 'Respond in Hindi (Devanagari script).'
            : language === 'hinglish'
                ? 'Respond in Hinglish (Latin script, Hindi-English mix).'
                : 'Respond in English.';

    let contextStr = '';
    if (context.orderId) contextStr += `\n- Customer's order ID (from earlier in conversation): #${context.orderId}`;
    if (context.awb) contextStr += `\n- AWB tracking number (from earlier): ${context.awb}`;
    if (context.pincode) contextStr += `\n- Pincode mentioned: ${context.pincode}`;
    if (context.lastScenario) contextStr += `\n- Previous topic: ${context.lastScenario}`;

    return `You are the OFFCOMFRT customer support assistant — a helpful, friendly AI that helps shoppers with their orders.

${langInstruction}

YOUR CAPABILITIES:
- Track orders using just the order number (a 4-5 digit number, e.g. 42000 or #42000)
- Tracking is resolved automatically from Shoppers Hub data — the customer never needs an AWB
- Check delivery status across carriers (Delhivery, Ekart, Shiprocket)
- Answer questions about OFFCOMFRT's return/exchange policy, shipping times, sizing
- Check if an order is eligible for return
- Search customer's recent orders by phone
- Look up FAQ answers from the knowledge base
- Create a support ticket when you cannot resolve the issue

OFFCOMFRT POLICIES (use these to answer FAQ):
- Returns: Accepted within 2 days of delivery via the support portal at offcomfrt.in
- Exchanges: Size exchanges available via the support portal within 2 days of delivery
- Shipping: Orders are shipped via Delhivery, Ekart, or Shiprocket depending on the location
- COD: Cash on delivery available for select pin codes
- Refunds: Processed to original payment method within 5-7 business days for eligible cases
  - Eligible: damaged item, wrong product, prepaid cancelled at confirmation, RTO without receipt
  - All other returns = store credit only

${contextStr ? `CONVERSATION CONTEXT (from earlier messages):${contextStr}` : ''}

RULES:
- Be warm, concise, and helpful. Use short paragraphs.
- If the customer previously shared an order number, use it for follow-up questions without asking again.
- To track, you only need the order number (a 4-5 digit number, "#" prefix optional). Treat any standalone 4-5 digit number the customer sends as their order ID and track it directly.
- NEVER ask the customer for an AWB / courier tracking number — the system resolves tracking internally from the order ID. Use track_order_by_id, not track_awb.
- If an order ID appears in the CONVERSATION CONTEXT above, NEVER ask for the order number again — use that order ID directly with the tools.
- When you need to show an example order number, always use 42000 — never invent other examples.
- If you cannot resolve the issue after 2-3 attempts, offer to create a support ticket.
- Never invent order numbers, tracking data, or policies. If unsure, say so.
- Amounts are in INR. Times are in IST (UTC+5:30).
- When creating a ticket, ask for the customer's name, phone number, and a brief description of their issue.
- Keep responses SHORT — this is a chat widget, not an email. 2-4 sentences max per reply.`;
}

// ---------- Customer tool set ----------

const CUSTOMER_TOOLS = [
    'shopify_search_orders',
    'track_order_by_id',
    'track_awb',
    'check_serviceability',
    'search_orders_by_phone',
    'faq_lookup',
    'check_return_eligibility'
];

function getCustomerToolSchemas() {
    const { tools } = require('./tools');
    return tools
        .filter(t => CUSTOMER_TOOLS.includes(t.name))
        .map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
}

/**
 * Record an entity (e.g. order ID typed into the direct tracking flow)
 * into the AI session context so follow-up questions like "where is my
 * order" already know which order the customer means.
 */
function noteSessionContext({ sessionId, entities }) {
    if (!sessionId || !entities) return;
    const session = getSession(sessionId);
    const context = { ...session.context, ...entities };
    saveSession(sessionId, session.history, context);
}

/**
 * Append a synthetic exchange to the session history (used when the widget
 * handles something outside the AI chat, e.g. the direct tracking card) so
 * subsequent AI turns see it as prior conversation. No LLM call is made.
 */
function appendSessionExchange({ sessionId, userMessage, botMessage, entities }) {
    if (!sessionId) return;
    const session = getSession(sessionId);
    if (userMessage) session.history.push({ role: 'user', content: String(userMessage).slice(0, 500) });
    if (botMessage) session.history.push({ role: 'assistant', content: String(botMessage).slice(0, 500) });
    const context = entities ? { ...session.context, ...entities } : session.context;
    saveSession(sessionId, session.history, context);
}

// ---------- Main chat function ----------

/**
 * Run one customer widget turn.
 * @param {object} opts
 * @param {string} opts.sessionId  - Client-generated session UUID
 * @param {string} opts.message    - Customer's message
 * @returns {{ reply: string, suggestedAction: string|null }}
 */
async function runCustomerAgent({ sessionId, message }) {
    if (!isConfigured()) {
        return {
            reply: 'Our support assistant is currently unavailable. Please reach out to us on WhatsApp for help.',
            suggestedAction: null
        };
    }

    const session = getSession(sessionId);
    const toolSchemas = getCustomerToolSchemas();

    // Extract entities from this message and merge into session context
    const newEntities = extractEntities(message);
    const context = { ...session.context, ...newEntities };

    // Detect language
    const language = detectLanguage(message);

    const systemPrompt = buildSystemPrompt(context, language);

    // If the customer asks about an order without repeating the number,
    // remind the model of the order ID we already have so it never asks again.
    let userContent = message;
    if (context.orderId && !newEntities.orderId && /track|status|where|order|deliver|ship|kaha|kya/i.test(message)) {
        userContent = `${message}\n\n[System note: the customer's order ID from earlier in this conversation is ${context.orderId}. Use track_order_by_id with this order ID — do NOT ask for the order number again.]`;
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        ...session.history,
        { role: 'user', content: userContent }
    ];

    let reply = null;
    const MAX_ROUNDS = 3;

    for (let round = 0; round <= MAX_ROUNDS; round++) {
        const { message: aiMessage } = await chatCompletion({
            messages,
            tools: toolSchemas.length ? toolSchemas : undefined,
            maxTokens: 512,
            temperature: 0.4
        });

        const toolCalls = aiMessage.tool_calls || [];
        if (!toolCalls.length) {
            reply = aiMessage.content || 'Let me know if there is anything else I can help with!';
            break;
        }

        if (round === MAX_ROUNDS) {
            reply = aiMessage.content || 'I was unable to complete the lookup. Would you like to speak with a support agent?';
            break;
        }

        messages.push(aiMessage);

        for (const call of toolCalls) {
            const name = call.function?.name;
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* keep {} */ }

            const tool = getTool(name);
            let result;

            if (!tool) {
                result = { error: `Unknown tool: ${name}` };
            } else {
                try {
                    result = await tool.execute(args, {});
                } catch (e) {
                    result = { error: e.message };
                }
            }

            // Clamp result size
            let json = JSON.stringify(result);
            if (json.length > 3000) json = json.substring(0, 3000) + '...';

            messages.push({ role: 'tool', tool_call_id: call.id, content: json });
        }
    }

    if (reply === null) reply = 'Sorry, I could not process your request. Please try again or contact support.';

    // Update context with detected scenario from reply
    if (reply) {
        if (/track|order|status|deliver|ship/i.test(message)) context.lastScenario = 'tracking';
        else if (/return|exchange|size/i.test(message)) context.lastScenario = 'return_exchange';
        else if (/cancel/i.test(message)) context.lastScenario = 'cancellation';
        else if (/refund|money back/i.test(message)) context.lastScenario = 'refund';
    }

    // Detect if the AI is suggesting escalation
    let suggestedAction = null;
    if (/ticket|support agent|human agent|whatsapp|escalat/i.test(reply)) {
        suggestedAction = 'create_ticket';
    }

    // Save session with updated context
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: reply });
    saveSession(sessionId, session.history, context);

    return { reply, suggestedAction };
}

// ---------- Ticket creation ----------

/**
 * Create a support ticket from the widget.
 * @returns {{ ticketNumber: string, whatsappLink: string }}
 */
async function createWidgetTicket({ name, phone, email, message, orderId }) {
    const ticketNumber = 'WDG-' + Date.now().toString(36).toUpperCase();

    await dbAdapter.insert('support_tickets', {
        ticket_number: ticketNumber,
        customer_name: name || 'Widget Customer',
        customer_phone: phone || '',
        customer_email: email || '',
        message: message || '',
        order_id: orderId || null,
        status: 'open',
        source: 'widget',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    });

    // Build WhatsApp deep link
    const businessNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
    const prefilledText = `Hi, I need help with my order.\nTicket: ${ticketNumber}\n${orderId ? 'Order: ' + orderId + '\n' : ''}${message ? 'Issue: ' + message.substring(0, 200) : ''}`;
    const whatsappLink = `https://wa.me/${businessNumber}?text=${encodeURIComponent(prefilledText)}`;

    return { ticketNumber, whatsappLink };
}

module.exports = { runCustomerAgent, createWidgetTicket, noteSessionContext, appendSessionExchange };
