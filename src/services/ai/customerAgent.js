/**
 * Customer-facing AI agent for the OFFCOMFRT support widget.
 *
 * Separate from the admin copilot (agent.js) — this agent helps shoppers
 * track orders, answers FAQs, and escalates to a support ticket when needed.
 *
 * Uses the same aiClient.js pipeline (Groq/Gemini) but with a customer-friendly
 * system prompt and a restricted tool set (read-only + ticket creation).
 */

const { chatCompletion, isConfigured, estimateTokens } = require('./aiClient');
const { getTool } = require('./tools');
const { dbAdapter } = require('../../database/db');

// ---------- Session store (in-memory, 30-min TTL) ----------

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_TURNS = 10;

function getSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return { history: [] };
    if (Date.now() - entry.lastAccess > SESSION_TTL_MS) {
        sessions.delete(sessionId);
        return { history: [] };
    }
    entry.lastAccess = Date.now();
    return { history: entry.history || [] };
}

function saveSession(sessionId, history) {
    // Prune oldest turns to stay within budget
    while (history.length > MAX_HISTORY_TURNS * 2) {
        history.shift();
    }
    sessions.set(sessionId, { history, lastAccess: Date.now() });
}

// Periodic cleanup of expired sessions (every 10 min)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessions) {
        if (now - entry.lastAccess > SESSION_TTL_MS) sessions.delete(key);
    }
}, 10 * 60 * 1000).unref();

// ---------- System prompt ----------

const SYSTEM_PROMPT = `You are the OFFCOMFRT customer support assistant — a helpful, friendly AI that helps shoppers with their orders.

YOUR CAPABILITIES:
- Track orders by order number (e.g. #1234) or AWB tracking number
- Check delivery status across carriers (Delhivery, Ekart, Shiprocket)
- Answer questions about OFFCOMFRT's return/exchange policy, shipping times, sizing
- Create a support ticket when you cannot resolve the issue

OFFCOMFRT POLICIES (use these to answer FAQ):
- Returns: Accepted within 2 days of delivery via the support portal at offcomfrt.in
- Exchanges: Size exchanges available via the support portal within 2 days of delivery
- Shipping: Orders are shipped via Delhivery, Ekart, or Shiprocket depending on the location
- COD: Cash on delivery available for select pin codes
- Refunds: Processed to original payment method within 5-7 business days for eligible cases

RULES:
- Be warm, concise, and helpful. Use short paragraphs.
- Always ask for the order number or AWB before tracking.
- If you cannot resolve the issue after 2-3 attempts, offer to create a support ticket so the customer can continue on WhatsApp with a human agent.
- Never invent order numbers, tracking data, or policies. If unsure, say so.
- Amounts are in INR. Times are in IST (UTC+5:30).
- When creating a ticket, ask for the customer's name, phone number, and a brief description of their issue.
- Keep responses SHORT — this is a chat widget, not an email. 2-4 sentences max per reply.`;

// ---------- Customer tool set ----------

const CUSTOMER_TOOLS = ['shopify_search_orders', 'track_awb', 'check_serviceability'];

function getCustomerToolSchemas() {
    const { tools } = require('./tools');
    return tools
        .filter(t => CUSTOMER_TOOLS.includes(t.name))
        .map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
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

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.history,
        { role: 'user', content: message }
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

    // Detect if the AI is suggesting escalation
    let suggestedAction = null;
    if (/ticket|support agent|human agent|whatsapp|escalat/i.test(reply)) {
        suggestedAction = 'create_ticket';
    }

    // Save session
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: reply });
    saveSession(sessionId, session.history);

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

module.exports = { runCustomerAgent, createWidgetTicket };
