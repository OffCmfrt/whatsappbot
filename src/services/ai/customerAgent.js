const { getAIResponse } = require('./aiClient');

/**
 * Clean PII from text (redact card numbers, passwords, sensitive tokens)
 */
function redactPII(text) {
    if (!text) return '';
    let cleaned = String(text);
    // Redact card numbers (13-19 digits)
    cleaned = cleaned.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]');
    // Redact password references
    cleaned = cleaned.replace(/password\s*[:=]\s*\S+/gi, 'password: [REDACTED]');
    return cleaned;
}

/**
 * Generate a concise 1-sentence AI summary of customer issue for escalation tickets.
 */
async function generateEscalationSummary(chatHistory = [], message = '', context = {}) {
    try {
        const rawMessage = message || (chatHistory.length ? chatHistory[chatHistory.length - 1].content || chatHistory[chatHistory.length - 1].text : '');
        const scenario = context.detectedScenario || context.scenario || '';
        const orderId = context.orderId || '';

        // If context already contains explicit summary, use it sanitized
        if (context.summary) {
            return redactPII(context.summary);
        }

        // Rule-based fallback summary builder for fast, reliable distillation
        let summary = '';
        const lowerMsg = (rawMessage + ' ' + (context.issueDescription || '')).toLowerCase();

        if (scenario === 'COD_DOUBLE_PAYMENT_REFUND' || lowerMsg.includes('cod') || lowerMsg.includes('double payment') || lowerMsg.includes('cash')) {
            summary = `Customer paid online for Order #${orderId || 'N/A'} but delivery courier requested COD cash at doorstep; customer requesting refund of collected cash.`;
        } else if (scenario === 'POD_INVESTIGATION' || lowerMsg.includes('delivered but not received') || lowerMsg.includes('pod') || lowerMsg.includes('fake delivery')) {
            summary = `Customer states Order #${orderId || 'N/A'} shows delivered but was not physically received; requesting POD investigation.`;
        } else if (scenario === 'DAMAGED_ITEM_CLAIM' || lowerMsg.includes('damaged') || lowerMsg.includes('broken') || lowerMsg.includes('defective')) {
            summary = `Customer received damaged/defective item for Order #${orderId || 'N/A'} and is requesting replacement or refund.`;
        } else if (scenario === 'WRONG_ITEM_CLAIM' || lowerMsg.includes('wrong item') || lowerMsg.includes('different product')) {
            summary = `Customer received wrong product for Order #${orderId || 'N/A'} with unboxing proof; requesting correct item replacement.`;
        } else if (scenario === 'PRE_DISPATCH_EDIT' || lowerMsg.includes('change size') || lowerMsg.includes('change address') || lowerMsg.includes('pre-dispatch')) {
            summary = `Customer requesting size/address edit for unfulfilled Order #${orderId || 'N/A'} prior to dispatch.`;
        } else if (scenario === 'RETURN_ELIGIBILITY' || lowerMsg.includes('return') || lowerMsg.includes('exchange')) {
            summary = `Customer requesting return/exchange for Order #${orderId || 'N/A'}.`;
        } else if (lowerMsg.trim().length > 0) {
            summary = `Customer issue regarding Order #${orderId || 'N/A'}: ${rawMessage.trim().slice(0, 120)}`;
        } else {
            summary = `Support escalation requested for Order #${orderId || 'N/A'}.`;
        }

        // Try AI distillation if available and history exists
        if (chatHistory && chatHistory.length > 1) {
            try {
                const historyText = chatHistory.slice(-5).map(m => `${m.sender || m.role || 'User'}: ${m.text || m.content || ''}`).join('\n');
                const prompt = `Distill the customer's core problem into a single 1-sentence issue summary for a support ticket. Do not include passwords or card numbers.\nHistory:\n${historyText}\nLast message: ${rawMessage}`;
                const aiSummary = await getAIResponse(prompt, { temperature: 0.2 });
                if (aiSummary && aiSummary.trim().length > 10 && aiSummary.trim().length < 250) {
                    summary = aiSummary.trim().replace(/\n/g, ' ');
                }
            } catch (err) {
                // Fall back to rule-based summary
            }
        }

        return redactPII(summary);
    } catch (error) {
        console.error('Error generating escalation summary:', error);
        return `Support escalation requested for customer issue.`;
    }
}

/**
 * Create enriched support ticket with AI summary and WhatsApp deep link
 */
async function createWidgetTicket({
    name = 'Guest Customer',
    phone = '',
    email = '',
    message = '',
    orderId = '',
    source = 'widget',
    sessionId = '',
    visitorId = '',
    context = {},
    chatHistory = []
} = {}) {
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    const ticketNumber = `WDG-${randomSuffix}`;
    const ticketId = `TICK-${Date.now()}-${randomSuffix}`;

    const summary = await generateEscalationSummary(chatHistory, message, context);
    const scenario = context.detectedScenario || context.scenario || (orderId ? 'ORDER_QUERY' : 'GENERAL_QUERY');
    
    // Determine sentiment
    let sentiment = context.sentiment || 'Neutral';
    const combinedText = (message + ' ' + (chatHistory.map(m => m.text || m.content || '').join(' '))).toLowerCase();
    if (combinedText.includes('urgent') || combinedText.includes('immediately') || combinedText.includes('asap')) {
        sentiment = 'Urgent';
    } else if (combinedText.includes('angry') || combinedText.includes('cheat') || combinedText.includes('scam') || combinedText.includes('terrible') || combinedText.includes('legal')) {
        sentiment = 'Frustrated';
    }

    const supportPhone = process.env.SUPPORT_WHATSAPP_NUMBER || '919876543210';
    
    // Build pre-filled WhatsApp message
    const formattedOrderId = orderId ? `#${orderId.replace(/^#/, '')}` : 'N/A';
    const waMessageLines = [
        'Hi OFFCOMFRT Support,',
        `Ticket: ${ticketNumber}`,
        `Order: ${formattedOrderId}`,
        `Summary: ${summary}`,
        'Please connect me with a support specialist.'
    ];
    const waMessageText = waMessageLines.join('\n');
    const whatsappLink = `https://wa.me/${supportPhone}?text=${encodeURIComponent(waMessageText)}`;

    const ticket = {
        ticketId,
        ticketNumber,
        name,
        phone,
        email,
        orderId: formattedOrderId,
        scenario: `[${scenario}]`,
        summary,
        sentiment,
        message: redactPII(message),
        source,
        sessionId,
        visitorId,
        whatsappLink,
        status: 'open',
        createdAt: new Date().toISOString()
    };

    return {
        success: true,
        ticketNumber,
        ticketId,
        summary,
        whatsappLink,
        ticket
    };
}

module.exports = {
    redactPII,
    generateEscalationSummary,
    createWidgetTicket
};
