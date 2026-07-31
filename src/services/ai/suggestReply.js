/**
 * AI reply suggestions for customer WhatsApp chats.
 *
 * Gathers the customer's recent conversation + order/shipment/ticket context and
 * asks the model for up to 3 short reply drafts. Drafts are ONLY returned to the
 * dashboard — nothing is ever sent to the customer from here.
 */

const { chatCompletion, isConfigured } = require('./aiClient');
const aiStore = require('./aiStore');
const Settings = require('../../models/Settings');
const { dbAdapter } = require('../../database/db');

const SUGGEST_SYSTEM_PROMPT = `You are a customer support assistant for OFFCOMFRT (Indian D2C clothing brand). Draft WhatsApp replies for a human support agent to review and send.

Rules:
- Write up to 3 alternative reply drafts to the customer's latest messages.
- Tone: warm, professional, concise. WhatsApp style — short sentences, no formal letter format, at most one emoji per draft.
- Use ONLY facts from the provided context (orders, tracking, tickets). Never invent order numbers, dates, refund amounts or policies.
- If the context lacks the answer, the draft should ask the customer for the missing detail or say the team is checking.
- Reply in the same language style the customer used (English / Hindi / Hinglish).
- Respond with JSON only: {"suggestions": ["draft 1", "draft 2", "draft 3"]}. 1-3 drafts, each under 500 characters.`;

async function gatherContext(phone, ticketId) {
    const digits = String(phone).replace(/\D/g, '');
    const phonePattern = `%${digits.slice(-10)}`;

    const [messages, customer, orders, tickets] = await Promise.all([
        dbAdapter.query(
            `SELECT message_type, message_content FROM messages
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
 * @returns {{ suggestions: string[], context: object }}
 */
async function suggestReply({ actor, phone, ticketId }) {
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

    // Separate daily cap for suggestions (shared across admins)
    const dailyLimit = parseInt(await Settings.get('ai_suggest_reply_daily_limit', '100')) || 100;
    const totalToday = await countAllSuggestionsToday();
    if (totalToday >= dailyLimit) {
        const err = new Error(`AI suggestion daily limit reached (${dailyLimit}). Try again tomorrow.`);
        err.code = 'AI_LIMIT';
        throw err;
    }

    const context = await gatherContext(phone, ticketId);
    if (!context.conversation.length) {
        const err = new Error('No conversation history found for this customer.');
        err.code = 'NO_HISTORY';
        throw err;
    }

    const userContent = JSON.stringify({
        customer: context.customer,
        conversation: context.conversation,
        recentOrders: context.recentOrders,
        openTickets: context.tickets
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

    return { suggestions, customer: context.customer };
}

async function countAllSuggestionsToday() {
    const rows = await dbAdapter.query(
        `SELECT COUNT(*)::int AS count FROM ai_usage_log
         WHERE kind = 'suggest_reply' AND created_at >= date_trunc('day', NOW())`
    );
    return rows[0]?.count || 0;
}

module.exports = { suggestReply };
