/**
 * AI Copilot Pro — Chat Section
 *
 * Full-height conversational copilot with rich message rendering,
 * action confirmation cards, quick-action chips, and conversation save.
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'chat';
    let initialized = false;
    let busy = false;
    let historyLoaded = false;

    // ── Styles (scoped to #section-chat) ──
    const style = document.createElement('style');
    style.textContent = `
    #section-chat { background: var(--bg-primary); }
    .chat-layout { display: flex; flex-direction: column; height: 100%; }
    .chat-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .chat-msg { max-width: 75%; padding: 12px 16px; border-radius: 16px; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; }
    .chat-msg.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
    .chat-msg.assistant { align-self: flex-start; background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
    .chat-msg.system { align-self: center; background: transparent; color: var(--text-muted); font-size: 12px; text-align: center; max-width: 90%; }
    .chat-msg.assistant table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
    .chat-msg.assistant th, .chat-msg.assistant td { padding: 4px 8px; border: 1px solid var(--border); text-align: left; }
    .chat-msg.assistant th { background: var(--bg-input); font-weight: 600; }
    .chat-typing { align-self: flex-start; color: var(--text-muted); font-size: 12px; padding: 8px 16px; display: flex; align-items: center; gap: 6px; }
    .chat-typing .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); animation: typingDot 1.2s infinite; }
    .chat-typing .dot:nth-child(2) { animation-delay: .2s; }
    .chat-typing .dot:nth-child(3) { animation-delay: .4s; }
    @keyframes typingDot { 0%,80%,100%{opacity:.3} 40%{opacity:1} }

    /* Confirmation card */
    .chat-confirm { align-self: stretch; max-width: 500px; background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.3); border-radius: var(--radius); padding: 16px; }
    .chat-confirm-title { font-weight: 600; color: var(--warning); font-size: 12px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .chat-confirm-summary { color: var(--text-primary); font-size: 13px; margin-bottom: 12px; line-height: 1.5; }
    .chat-confirm-btns { display: flex; gap: 8px; }
    .chat-confirm-btns button { flex: 1; padding: 8px; border-radius: var(--radius-sm); border: none; font-size: 13px; font-weight: 600; }
    .chat-confirm-yes { background: var(--success); color: #fff; }
    .chat-confirm-no { background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border) !important; }

    /* Quick chips */
    .chat-quick-bar { padding: 8px 20px; display: flex; gap: 8px; overflow-x: auto; border-top: 1px solid var(--border); background: var(--bg-secondary); }
    .quick-chip { white-space: nowrap; padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-secondary); font-size: 12px; cursor: pointer; flex-shrink: 0; }
    .quick-chip:hover { background: var(--accent-bg); color: var(--accent-hover); border-color: var(--accent); }

    /* Input area */
    .chat-input-area { display: flex; gap: 10px; padding: 16px 20px; border-top: 1px solid var(--border); background: var(--bg-secondary); align-items: flex-end; }
    .chat-input-area textarea { flex: 1; resize: none; border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; font-size: 13.5px; background: var(--bg-input); color: var(--text-primary); outline: none; max-height: 120px; min-height: 44px; line-height: 1.4; }
    .chat-input-area textarea:focus { border-color: var(--accent); }
    .chat-input-area textarea::placeholder { color: var(--text-muted); }
    .chat-send-btn { background: var(--accent); color: #fff; border: none; border-radius: var(--radius); width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .chat-send-btn:disabled { opacity: .4; cursor: not-allowed; }
    .chat-send-btn svg { width: 18px; height: 18px; }

    /* Save conversation btn */
    .chat-save-btn { align-self: flex-end; background: none; border: 1px solid var(--border); color: var(--text-muted); font-size: 11px; padding: 4px 10px; border-radius: 12px; cursor: pointer; margin-top: -4px; }
    .chat-save-btn:hover { color: var(--accent-hover); border-color: var(--accent); }
    `;
    document.head.appendChild(style);

    // ── Render ──
    function render() {
        const root = document.getElementById('section-chat');
        root.innerHTML = `
        <div class="chat-layout">
            <div class="chat-messages" id="chatMessages">
                <div class="chat-msg system">Welcome to AI Copilot Pro. I can look up customers, orders, tickets, shipments, run analytics, and perform actions — all with your confirmation.</div>
            </div>
            <div class="chat-quick-bar" id="chatQuickBar">
                <button class="quick-chip" data-prompt="Show me open support tickets today">Open tickets today</button>
                <button class="quick-chip" data-prompt="What are the dashboard stats?">Dashboard stats</button>
                <button class="quick-chip" data-prompt="Triage my open tickets by category and priority">Triage tickets</button>
                <button class="quick-chip" data-prompt="List pending shipments that need booking">Pending shipments</button>
                <button class="quick-chip" data-prompt="Top customer questions this week">Top questions</button>
                <button class="quick-chip" data-prompt="Show AI usage and cost summary">AI cost summary</button>
            </div>
            <div class="chat-input-area">
                <textarea id="chatInput" rows="1" placeholder="Ask about customers, orders, tickets, shipments… or say 'triage tickets'"></textarea>
                <button class="chat-send-btn" id="chatSendBtn" title="Send">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
            </div>
        </div>`;

        // Event listeners
        document.getElementById('chatSendBtn').addEventListener('click', sendMessage);
        document.getElementById('chatInput').addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        document.querySelectorAll('.quick-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.getElementById('chatInput').value = chip.dataset.prompt;
                sendMessage();
            });
        });
    }

    // ── Message rendering ──
    function addMsg(role, text) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const div = document.createElement('div');
        div.className = `chat-msg ${role}`;
        if (role === 'assistant') {
            div.innerHTML = renderRichContent(text);
        } else {
            div.textContent = text;
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    function renderRichContent(text) {
        let html = escapeHtml(text);
        // Convert simple dash lists
        html = html.replace(/^- (.+)$/gm, '<span style="display:block;padding-left:12px;">&#8226; $1</span>');
        // Detect inline JSON tables (tool results)
        html = html.replace(/\{(\w+):[^}]+\}/g, match => `<code style="font-size:11px;background:var(--bg-input);padding:2px 6px;border-radius:4px;">${match}</code>`);
        return html;
    }

    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function addTyping() {
        const container = document.getElementById('chatMessages');
        if (!container) return null;
        const div = document.createElement('div');
        div.className = 'chat-typing';
        div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span> Thinking…';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    function addConfirmCard(pending) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const card = document.createElement('div');
        card.className = 'chat-confirm';
        card.innerHTML = `
            <div class="chat-confirm-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Confirmation required
            </div>
            <div class="chat-confirm-summary"></div>
            <div class="chat-confirm-btns">
                <button class="chat-confirm-yes">Confirm &amp; Execute</button>
                <button class="chat-confirm-no">Cancel</button>
            </div>`;
        card.querySelector('.chat-confirm-summary').textContent = pending.summary || pending.toolName;
        const yes = card.querySelector('.chat-confirm-yes');
        const no = card.querySelector('.chat-confirm-no');

        yes.onclick = async () => {
            yes.disabled = true; no.disabled = true;
            yes.textContent = 'Executing…';
            try {
                const data = await CP.apiFetch(`/ai/confirm/${pending.id}`, 'POST');
                card.remove();
                addMsg('system', `Executed: ${data.summary || pending.summary}`);
                if (data.result && typeof data.result === 'object') {
                    addMsg('assistant', `Result: ${JSON.stringify(data.result, null, 2).substring(0, 600)}`);
                }
            } catch (e) {
                card.remove();
                addMsg('system', `Failed: ${e.message}`);
            }
        };
        no.onclick = async () => {
            yes.disabled = true; no.disabled = true;
            try { await CP.apiFetch(`/ai/cancel/${pending.id}`, 'POST'); } catch (e) { /* ignore */ }
            card.remove();
            addMsg('system', 'Action cancelled.');
        };
        container.appendChild(card);
        container.scrollTop = container.scrollHeight;
    }

    // ── Send message ──
    async function sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text || busy) return;
        busy = true;
        document.getElementById('chatSendBtn').disabled = true;
        input.value = '';
        input.style.height = '44px';
        addMsg('user', text);
        const typing = addTyping();
        try {
            const data = await CP.apiFetch('/ai/chat', 'POST', { message: text });
            if (typing) typing.remove();
            addMsg('assistant', data.reply || 'Done.');
            if (data.pendingAction && data.pendingAction.id) addConfirmCard(data.pendingAction);
            // Add save-to-training button on last assistant message
            addSaveBtn(data.reply);
        } catch (e) {
            if (typing) typing.remove();
            addMsg('system', `Error: ${e.message}`);
        } finally {
            busy = false;
            document.getElementById('chatSendBtn').disabled = false;
            input.focus();
        }
    }

    function addSaveBtn(replyText) {
        if (!replyText || replyText.length < 20) return;
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const btn = document.createElement('button');
        btn.className = 'chat-save-btn';
        btn.textContent = 'Save as training example';
        btn.onclick = async () => {
            const question = prompt('What customer question does this answer?');
            if (!question) return;
            try {
                await CP.apiFetch('/ai/learned', 'POST', { question, reply: replyText, pinned: true });
                btn.textContent = 'Saved!';
                btn.style.color = 'var(--success)';
                btn.style.borderColor = 'var(--success)';
            } catch (e) {
                btn.textContent = 'Failed: ' + e.message;
            }
        };
        container.appendChild(btn);
    }

    // ── Load history ──
    async function loadHistory() {
        if (historyLoaded) return;
        historyLoaded = true;
        try {
            const data = await CP.apiFetch('/ai/history');
            (data.history || []).forEach(turn => {
                if (turn.role === 'user' || turn.role === 'assistant') addMsg(turn.role, turn.content);
            });
        } catch (e) { /* optional */ }
    }

    // ── Section lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
            loadHistory();
        }
    });
})();
