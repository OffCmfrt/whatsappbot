// OFFCOMFRT Widget Testbot Logic (Change 14 & Change 15)

const state = {
    sessionId: sessionStorage.getItem('offcomfrt_session_id') || `sess_${Date.now()}`,
    orderId: sessionStorage.getItem('offcomfrt_order_id') || '53686',
    detectedScenario: null,
    chatHistory: JSON.parse(sessionStorage.getItem('offcomfrt_chat_history') || '[]'),
    activeTicket: JSON.parse(sessionStorage.getItem('offcomfrt_active_ticket') || 'null')
};

// Save session state
sessionStorage.setItem('offcomfrt_session_id', state.sessionId);

document.addEventListener('DOMContentLoaded', () => {
    // Restore past chat history if available
    if (state.chatHistory && state.chatHistory.length > 0) {
        state.chatHistory.forEach(msg => {
            appendMessageUI(msg.text, msg.sender);
        });
    }
    if (state.activeTicket) {
        renderEscalationCardUI(state.activeTicket);
    }
});

function appendMessageUI(text, sender = 'bot') {
    const chatBody = document.getElementById('chatBody');
    if (!chatBody) return;

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${sender === 'user' ? 'user-msg' : 'bot-msg'}`;
    bubble.textContent = text;
    chatBody.appendChild(bubble);
    chatBody.scrollTop = chatBody.scrollHeight;
}

function handleKeyPress(e) {
    if (e.key === 'Enter') {
        sendMessage();
    }
}

async function sendMessage(textOverride = null) {
    const input = document.getElementById('chatInput');
    const message = textOverride || input.value.trim();
    if (!message) return;

    if (!textOverride && input) input.value = '';

    // Append user message
    appendMessageUI(message, 'user');
    state.chatHistory.push({ sender: 'user', text: message });
    sessionStorage.setItem('offcomfrt_chat_history', JSON.stringify(state.chatHistory));

    const lowerMsg = message.toLowerCase();

    // Check if user specifically requested escalation/ticket creation
    if (lowerMsg.includes('escalate') || lowerMsg.includes('ticket') || lowerMsg.includes('human') || lowerMsg.includes('agent') || lowerMsg.includes('cash') || lowerMsg.includes('cod')) {
        await createEscalationTicket(message);
        return;
    }

    try {
        const res = await fetch('/api/widget/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                sessionId: state.sessionId,
                orderId: state.orderId,
                context: { detectedScenario: state.detectedScenario }
            })
        });

        const data = await res.json();
        if (data && data.reply) {
            appendMessageUI(data.reply, 'bot');
            state.chatHistory.push({ sender: 'bot', text: data.reply });
            if (data.detectedScenario) state.detectedScenario = data.detectedScenario;
            sessionStorage.setItem('offcomfrt_chat_history', JSON.stringify(state.chatHistory));
        }
    } catch (err) {
        console.error('Error sending message:', err);
        appendMessageUI("I'm having trouble connecting right now. Let me connect you with support.", 'bot');
        await createEscalationTicket(message);
    }
}

function triggerScenario(scenarioType) {
    if (scenarioType === 'track') {
        sendMessage("Track my order #53686");
    } else if (scenarioType === 'cod') {
        sendMessage("Courier requested ₹1299 cash for my prepaid COD order #53686");
    } else if (scenarioType === 'escalate') {
        sendMessage("Connect me with a human support agent");
    }
}

async function createEscalationTicket(message = '') {
    appendMessageUI("Creating context-rich ticket for support escalation...", 'bot');

    try {
        const res = await fetch('/api/widget/create-ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Guest Customer',
                orderId: state.orderId,
                message,
                sessionId: state.sessionId,
                context: {
                    detectedScenario: state.detectedScenario || 'COD_DOUBLE_PAYMENT_REFUND',
                    orderId: state.orderId
                },
                chatHistory: state.chatHistory
            })
        });

        const data = await res.json();
        if (data.success) {
            state.activeTicket = data;
            sessionStorage.setItem('offcomfrt_active_ticket', JSON.stringify(data));
            renderEscalationCardUI(data);
        } else {
            appendMessageUI("Could not generate escalation ticket. Please try again.", 'bot');
        }
    } catch (err) {
        console.error('Ticket creation error:', err);
        appendMessageUI("Error creating support ticket.", 'bot');
    }
}

function renderEscalationCardUI(ticketData) {
    const chatBody = document.getElementById('chatBody');
    if (!chatBody) return;

    const card = document.createElement('div');
    card.className = 'escalation-card';
    card.innerHTML = `
        <div class="ticket-header-row">
            <span class="ticket-badge">Ticket ${ticketData.ticketNumber}</span>
            <span style="font-size:0.75rem; color:#94A3B8;">Status: Open</span>
        </div>
        <div class="summary-pill">
            <strong>Issue Summary:</strong> ${ticketData.summary}
        </div>
        <a href="${ticketData.whatsappLink}" target="_blank" class="btn-whatsapp">
            <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/>
            </svg>
            Continue on WhatsApp
        </a>
        <button class="btn-secondary" onclick="resetWidgetMenu()">
            Back to Menu
        </button>
    `;

    chatBody.appendChild(card);
    chatBody.scrollTop = chatBody.scrollHeight;
}

function resetWidgetMenu() {
    state.activeTicket = null;
    sessionStorage.removeItem('offcomfrt_active_ticket');
    appendMessageUI("Returned to main menu. How else can I help you?", 'bot');
}
