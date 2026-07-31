/**
 * AI Copilot panel + AI reply suggestions (admin dashboard).
 *
 * Self-contained: injects its own styles and DOM. Loaded after main.js so it can
 * reuse the global auth token and (for suggestions) the open support chat context
 * (currentSupportChatPhone / currentSupportTicketId).
 */
(function () {
    'use strict';

    const AI_API = '/api/admin/ai';

    function aiToken() {
        return localStorage.getItem('authToken') || (typeof authToken !== 'undefined' ? authToken : null);
    }

    async function aiFetch(path, method = 'GET', body = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${aiToken()}`
            }
        };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(`${AI_API}${path}`, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    // ---------- Styles ----------
    const style = document.createElement('style');
    style.textContent = `
    #aiCopilotFab { position: fixed; bottom: 24px; right: 24px; z-index: 9998; width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-size: 24px; box-shadow: 0 4px 16px rgba(99,102,241,.45); display: flex; align-items: center; justify-content: center; transition: transform .15s; }
    #aiCopilotFab:hover { transform: scale(1.08); }
    #aiCopilotPanel { position: fixed; bottom: 92px; right: 24px; z-index: 9999; width: 380px; max-width: calc(100vw - 32px); height: 540px; max-height: calc(100vh - 120px); background: #fff; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,.22); display: none; flex-direction: column; overflow: hidden; font-family: inherit; }
    #aiCopilotPanel.open { display: flex; }
    .ai-cp-header { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; }
    .ai-cp-header h4 { margin: 0; font-size: 15px; font-weight: 600; }
    .ai-cp-header small { opacity: .85; font-size: 11px; display: block; }
    .ai-cp-header-btns { display: flex; gap: 6px; }
    .ai-cp-header-btns button { background: rgba(255,255,255,.18); border: none; color: #fff; border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
    .ai-cp-messages { flex: 1; overflow-y: auto; padding: 14px; background: #f8fafc; display: flex; flex-direction: column; gap: 10px; }
    .ai-cp-msg { max-width: 85%; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
    .ai-cp-msg.user { align-self: flex-end; background: #6366f1; color: #fff; border-bottom-right-radius: 4px; }
    .ai-cp-msg.assistant { align-self: flex-start; background: #fff; color: #1e293b; border: 1px solid #e2e8f0; border-bottom-left-radius: 4px; }
    .ai-cp-msg.system { align-self: center; background: transparent; color: #64748b; font-size: 12px; text-align: center; }
    .ai-cp-typing { align-self: flex-start; color: #64748b; font-size: 12px; padding: 4px 8px; }
    .ai-cp-confirm { align-self: stretch; background: #fffbeb; border: 1px solid #fbbf24; border-radius: 10px; padding: 12px; font-size: 13px; }
    .ai-cp-confirm .ai-cp-confirm-title { font-weight: 600; color: #92400e; margin-bottom: 6px; font-size: 12px; }
    .ai-cp-confirm .ai-cp-confirm-summary { color: #78350f; margin-bottom: 10px; }
    .ai-cp-confirm-btns { display: flex; gap: 8px; }
    .ai-cp-confirm-btns button { flex: 1; padding: 7px 0; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; }
    .ai-cp-btn-yes { background: #16a34a; color: #fff; }
    .ai-cp-btn-no { background: #e2e8f0; color: #334155; }
    .ai-cp-input-area { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e2e8f0; background: #fff; }
    .ai-cp-input-area textarea { flex: 1; resize: none; border: 1px solid #cbd5e1; border-radius: 10px; padding: 9px 12px; font-size: 13px; font-family: inherit; max-height: 90px; outline: none; }
    .ai-cp-input-area textarea:focus { border-color: #6366f1; }
    .ai-cp-input-area button { background: #6366f1; color: #fff; border: none; border-radius: 10px; padding: 0 16px; cursor: pointer; font-size: 15px; }
    .ai-cp-input-area button:disabled { opacity: .5; cursor: not-allowed; }
    #aiSuggestReplyBtn { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; border-radius: 10px; padding: 0 12px; cursor: pointer; font-size: 16px; line-height: 1; }
    #aiSuggestReplyBtn:disabled { opacity: .5; cursor: wait; }
    #aiSuggestions { padding: 8px 12px 0; display: none; flex-direction: column; gap: 6px; background: #fff; }
    #aiSuggestions.open { display: flex; }
    .ai-suggestion-chip { text-align: left; background: #eef2ff; border: 1px solid #c7d2fe; color: #3730a3; border-radius: 10px; padding: 8px 10px; font-size: 12.5px; line-height: 1.4; cursor: pointer; }
    .ai-suggestion-chip:hover { background: #e0e7ff; }
    .ai-suggestions-note { font-size: 11px; color: #64748b; padding-bottom: 4px; }
    #aiLearnedView { position: absolute; top: 58px; left: 0; right: 0; bottom: 0; background: #f8fafc; display: none; flex-direction: column; z-index: 2; }
    #aiLearnedView.open { display: flex; }
    .ai-ln-toolbar { display: flex; gap: 6px; padding: 10px 12px; background: #fff; border-bottom: 1px solid #e2e8f0; }
    .ai-ln-toolbar input { flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; outline: none; }
    .ai-ln-toolbar button { background: #6366f1; color: #fff; border: none; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
    .ai-ln-list { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
    .ai-ln-item { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; font-size: 12.5px; }
    .ai-ln-item.pinned { border-color: #fbbf24; background: #fffbeb; }
    .ai-ln-q { font-weight: 600; color: #1e293b; margin-bottom: 4px; white-space: pre-wrap; word-wrap: break-word; }
    .ai-ln-a { color: #475569; white-space: pre-wrap; word-wrap: break-word; margin-bottom: 6px; }
    .ai-ln-meta { font-size: 11px; color: #94a3b8; margin-bottom: 6px; }
    .ai-ln-actions { display: flex; gap: 6px; }
    .ai-ln-actions button { border: 1px solid #e2e8f0; background: #f8fafc; color: #334155; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 11.5px; }
    .ai-ln-actions button:hover { background: #eef2ff; }
    @media (max-width: 640px) { #aiCopilotPanel { right: 8px; bottom: 84px; } #aiCopilotFab { bottom: 16px; right: 16px; } }
    `;
    document.head.appendChild(style);

    // ---------- Copilot panel ----------
    const fab = document.createElement('button');
    fab.id = 'aiCopilotFab';
    fab.title = 'AI Copilot';
    fab.innerHTML = '✨';

    const panel = document.createElement('div');
    panel.id = 'aiCopilotPanel';
    panel.innerHTML = `
        <div class="ai-cp-header">
            <div>
                <h4>AI Copilot</h4>
                <small>Ask about customers, orders, tickets, shipments…</small>
            </div>
            <div class="ai-cp-header-btns">
                <button id="aiCpLearned" title="Learned replies (what the AI has learned from your team)">📚</button>
                <button id="aiCpClear" title="Clear conversation">Clear</button>
                <button id="aiCpClose" title="Close">✕</button>
            </div>
        </div>
        <div id="aiLearnedView">
            <div class="ai-ln-toolbar">
                <button id="aiLnBack" title="Back to chat">←</button>
                <input id="aiLnSearch" placeholder="Search learned replies…">
                <button id="aiLnAdd" title="Add a golden Q→A example">＋ Add</button>
            </div>
            <div class="ai-ln-list" id="aiLnList"></div>
        </div>
        <div class="ai-cp-messages" id="aiCpMessages">
            <div class="ai-cp-msg system">Hi! I can look up customers, orders, tickets, carts, Shopify orders and tracking — and prepare actions for your confirmation.</div>
        </div>
        <div class="ai-cp-input-area">
            <textarea id="aiCpInput" rows="1" placeholder="e.g. open tickets today, track AWB 123…"></textarea>
            <button id="aiCpSend" title="Send">➤</button>
        </div>
    `;

    let panelBusy = false;
    let historyLoaded = false;

    function addMsg(role, text) {
        const messages = document.getElementById('aiCpMessages');
        const div = document.createElement('div');
        div.className = `ai-cp-msg ${role}`;
        div.textContent = text;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
        return div;
    }

    function addTyping() {
        const messages = document.getElementById('aiCpMessages');
        const div = document.createElement('div');
        div.className = 'ai-cp-typing';
        div.textContent = 'Thinking…';
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
        return div;
    }

    function addConfirmCard(pending) {
        const messages = document.getElementById('aiCpMessages');
        const card = document.createElement('div');
        card.className = 'ai-cp-confirm';
        card.innerHTML = `
            <div class="ai-cp-confirm-title">⚠️ Confirmation required</div>
            <div class="ai-cp-confirm-summary"></div>
            <div class="ai-cp-confirm-btns">
                <button class="ai-cp-btn-yes">Confirm &amp; execute</button>
                <button class="ai-cp-btn-no">Cancel</button>
            </div>
        `;
        card.querySelector('.ai-cp-confirm-summary').textContent = pending.summary || pending.toolName;
        const yes = card.querySelector('.ai-cp-btn-yes');
        const no = card.querySelector('.ai-cp-btn-no');

        yes.onclick = async () => {
            yes.disabled = true; no.disabled = true;
            yes.textContent = 'Executing…';
            try {
                const data = await aiFetch(`/confirm/${pending.id}`, 'POST');
                card.remove();
                addMsg('system', `✅ Done: ${data.summary || pending.summary}`);
                if (data.result && typeof data.result === 'object') {
                    const short = JSON.stringify(data.result).substring(0, 400);
                    addMsg('assistant', `Result: ${short}`);
                }
            } catch (e) {
                card.remove();
                addMsg('system', `❌ ${e.message}`);
            }
        };
        no.onclick = async () => {
            yes.disabled = true; no.disabled = true;
            try { await aiFetch(`/cancel/${pending.id}`, 'POST'); } catch (e) { /* already gone */ }
            card.remove();
            addMsg('system', 'Action cancelled.');
        };
        messages.appendChild(card);
        messages.scrollTop = messages.scrollHeight;
    }

    async function sendCopilotMessage() {
        const input = document.getElementById('aiCpInput');
        const text = input.value.trim();
        if (!text || panelBusy) return;
        panelBusy = true;
        document.getElementById('aiCpSend').disabled = true;
        input.value = '';
        addMsg('user', text);
        const typing = addTyping();
        try {
            const data = await aiFetch('/chat', 'POST', { message: text });
            typing.remove();
            addMsg('assistant', data.reply || 'Done.');
            if (data.pendingAction && data.pendingAction.id) addConfirmCard(data.pendingAction);
        } catch (e) {
            typing.remove();
            addMsg('system', `❌ ${e.message}`);
        } finally {
            panelBusy = false;
            document.getElementById('aiCpSend').disabled = false;
            input.focus();
        }
    }

    async function loadHistoryOnce() {
        if (historyLoaded) return;
        historyLoaded = true;
        try {
            const data = await aiFetch('/history');
            (data.history || []).forEach(turn => {
                if (turn.role === 'user' || turn.role === 'assistant') addMsg(turn.role, turn.content);
            });
        } catch (e) { /* history is optional */ }
    }

    function togglePanel(open) {
        const isOpen = typeof open === 'boolean' ? open : !panel.classList.contains('open');
        panel.classList.toggle('open', isOpen);
        if (isOpen) {
            loadHistoryOnce();
            setTimeout(() => document.getElementById('aiCpInput')?.focus(), 50);
        }
    }

    // ---------- Learned replies manager (curation) ----------
    let lnSearchTimer = null;

    function toggleLearnedView(open) {
        const view = document.getElementById('aiLearnedView');
        view.classList.toggle('open', open);
        if (open) loadLearned();
    }

    async function loadLearned() {
        const list = document.getElementById('aiLnList');
        const search = document.getElementById('aiLnSearch').value.trim();
        list.innerHTML = '<div class="ai-suggestions-note">Loading…</div>';
        try {
            const data = await aiFetch(`/learned?search=${encodeURIComponent(search)}`);
            const rows = data.learned || [];
            if (!rows.length) {
                list.innerHTML = '<div class="ai-suggestions-note">Nothing learned yet. Examples appear automatically as your team replies to customers — or add a golden one with ＋ Add.</div>';
                return;
            }
            list.innerHTML = '';
            rows.forEach(r => list.appendChild(renderLearnedItem(r)));
        } catch (e) {
            list.innerHTML = '';
            const note = document.createElement('div');
            note.className = 'ai-suggestions-note';
            note.textContent = `❌ ${e.message}`;
            list.appendChild(note);
        }
    }

    function renderLearnedItem(r) {
        const item = document.createElement('div');
        item.className = 'ai-ln-item' + (r.pinned ? ' pinned' : '');
        const q = document.createElement('div');
        q.className = 'ai-ln-q';
        q.textContent = (r.pinned ? '📌 ' : '') + r.customer_question;
        const a = document.createElement('div');
        a.className = 'ai-ln-a';
        a.textContent = r.agent_reply;
        const meta = document.createElement('div');
        meta.className = 'ai-ln-meta';
        meta.textContent = `reinforced ×${r.uses}` + (r.resolved_boost ? ` · resolved ×${r.resolved_boost}` : '');
        const actions = document.createElement('div');
        actions.className = 'ai-ln-actions';

        const pinBtn = document.createElement('button');
        pinBtn.textContent = r.pinned ? 'Unpin' : 'Pin';
        pinBtn.onclick = async () => {
            try { await aiFetch(`/learned/${r.id}`, 'PUT', { pinned: !r.pinned }); loadLearned(); }
            catch (e) { alert(e.message); }
        };
        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.onclick = async () => {
            const question = prompt('Customer question:', r.customer_question);
            if (question === null) return;
            const reply = prompt('Approved reply:', r.agent_reply);
            if (reply === null) return;
            try { await aiFetch(`/learned/${r.id}`, 'PUT', { question, reply }); loadLearned(); }
            catch (e) { alert(e.message); }
        };
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.onclick = async () => {
            if (!confirm('Delete this learned reply?')) return;
            try { await aiFetch(`/learned/${r.id}`, 'DELETE'); item.remove(); }
            catch (e) { alert(e.message); }
        };
        actions.append(pinBtn, editBtn, delBtn);
        item.append(q, a, meta, actions);
        return item;
    }

    // ---------- Suggest reply (support chat modal) ----------

    // Prefetch: warm the suggestion cache the moment a chat opens so the ✨
    // click feels instant. Failures are silent — the button still works as a
    // plain on-demand request.
    const suggestPrefetch = new Map(); // key -> { promise, at }
    const PREFETCH_FRESH_MS = 90 * 1000;

    function suggestKey(phone, ticketId) {
        return `${phone}:${ticketId || ''}`;
    }

    function prefetchSuggestions(phone, ticketId) {
        if (!phone || !aiToken()) return;
        const key = suggestKey(phone, ticketId);
        const existing = suggestPrefetch.get(key);
        if (existing && Date.now() - existing.at < PREFETCH_FRESH_MS) return;
        suggestPrefetch.set(key, {
            promise: aiFetch('/suggest-reply', 'POST', { phone, ticketId, prefetch: true }).catch(() => null),
            at: Date.now()
        });
    }

    // Wrap the dashboard's global openSupportChat (defined in main.js) so
    // every chat open kicks off a background prefetch
    function hookSupportChatOpen() {
        const orig = window.openSupportChat;
        if (typeof orig !== 'function' || orig.__aiPrefetchHooked) return;
        window.openSupportChat = function (ticketId, phone, ...rest) {
            try { prefetchSuggestions(phone, ticketId); } catch (e) { /* never block chat open */ }
            return orig.call(this, ticketId, phone, ...rest);
        };
        window.openSupportChat.__aiPrefetchHooked = true;
    }

    function injectSuggestReply() {
        const inputArea = document.querySelector('#supportChatModal .chat-input-area');
        if (!inputArea || document.getElementById('aiSuggestReplyBtn')) return;

        const suggestionsBox = document.createElement('div');
        suggestionsBox.id = 'aiSuggestions';
        inputArea.parentNode.insertBefore(suggestionsBox, inputArea);

        const btn = document.createElement('button');
        btn.id = 'aiSuggestReplyBtn';
        btn.title = 'AI: suggest replies from this conversation';
        btn.innerHTML = '✨';
        const sendBtn = document.getElementById('sendSupportChatBtn');
        inputArea.insertBefore(btn, sendBtn);

        btn.onclick = async () => {
            const phone = typeof currentSupportChatPhone !== 'undefined' ? currentSupportChatPhone : null;
            const ticketId = typeof currentSupportTicketId !== 'undefined' ? currentSupportTicketId : null;
            if (!phone) { alert('Open a customer chat first'); return; }
            btn.disabled = true;
            btn.innerHTML = '…';
            suggestionsBox.classList.add('open');
            suggestionsBox.innerHTML = '<div class="ai-suggestions-note">Generating suggestions…</div>';
            try {
                // Reuse the prefetch started when the chat opened — if it already
                // resolved this renders instantly; otherwise we just await it
                const key = suggestKey(phone, ticketId);
                const pre = suggestPrefetch.get(key);
                let data = (pre && Date.now() - pre.at < PREFETCH_FRESH_MS) ? await pre.promise : null;
                suggestPrefetch.delete(key); // single-use: next click re-checks the server
                if (!data || !data.suggestions) {
                    data = await aiFetch('/suggest-reply', 'POST', { phone, ticketId });
                }
                if (!data.suggestions || !data.suggestions.length) {
                    suggestionsBox.innerHTML = '<div class="ai-suggestions-note">No suggestions available for this chat.</div>';
                } else {
                    suggestionsBox.innerHTML = '<div class="ai-suggestions-note">✨ Tap a draft to insert it — review before sending:</div>';
                    data.suggestions.forEach(s => {
                        const chip = document.createElement('button');
                        chip.className = 'ai-suggestion-chip';
                        chip.textContent = s;
                        chip.onclick = () => {
                            const input = document.getElementById('supportChatInput');
                            if (input) {
                                input.value = s;
                                input.focus();
                                input.style.height = '48px';
                                input.style.height = Math.min(input.scrollHeight, 120) + 'px';
                            }
                            // Remember the draft so the send flow can report whether
                            // it was sent as-is or edited (AI learning signal)
                            window.__aiSuggestedReply = s;
                            suggestionsBox.classList.remove('open');
                            suggestionsBox.innerHTML = '';
                        };
                        suggestionsBox.appendChild(chip);
                    });
                }
            } catch (e) {
                suggestionsBox.innerHTML = '';
                const note = document.createElement('div');
                note.className = 'ai-suggestions-note';
                note.textContent = `❌ ${e.message}`;
                suggestionsBox.appendChild(note);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '✨';
            }
        };
    }

    // ---------- Init ----------
    function init() {
        document.body.appendChild(fab);
        document.body.appendChild(panel);
        fab.onclick = () => togglePanel();
        document.getElementById('aiCpClose').onclick = () => togglePanel(false);
        document.getElementById('aiCpClear').onclick = async () => {
            try { await aiFetch('/clear-history', 'POST'); } catch (e) { /* ignore */ }
            const messages = document.getElementById('aiCpMessages');
            messages.innerHTML = '<div class="ai-cp-msg system">Conversation cleared.</div>';
        };
        document.getElementById('aiCpSend').onclick = sendCopilotMessage;
        document.getElementById('aiCpLearned').onclick = () => toggleLearnedView(true);
        document.getElementById('aiLnBack').onclick = () => toggleLearnedView(false);
        document.getElementById('aiLnSearch').addEventListener('input', () => {
            clearTimeout(lnSearchTimer);
            lnSearchTimer = setTimeout(loadLearned, 350);
        });
        document.getElementById('aiLnAdd').onclick = async () => {
            const question = prompt('Customer question (pattern — use {{order_id}}, {{name}}… for variables):');
            if (!question) return;
            const reply = prompt('The ideal reply the AI should imitate:');
            if (!reply) return;
            try { await aiFetch('/learned', 'POST', { question, reply, pinned: true }); loadLearned(); }
            catch (e) { alert(e.message); }
        };
        document.getElementById('aiCpInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendCopilotMessage();
            }
        });
        injectSuggestReply();
        hookSupportChatOpen();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
