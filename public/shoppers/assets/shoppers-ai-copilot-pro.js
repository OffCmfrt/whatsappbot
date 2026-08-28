// ==========================================
// OFFCOMFRT - Shoppers Hub AI Copilot Pro v2
// Full-screen copilot overlay with Chat, Training, Actions, Analytics, Workflows.
// Self-contained: injects its own styles and DOM.
// ==========================================
(function () {
    'use strict';

    // Same-origin API base (this file is served from the bot server)
    const API_BASE = '/api/admin';

    function getToken() { return localStorage.getItem('authToken'); }

    async function apiFetch(path, method = 'GET', body = null) {
        const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${API_BASE}${path}`, opts);
        if (res.status === 401) throw new Error('Session expired — refresh and log in again.');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
    #aiCopilotFab{position:fixed;bottom:24px;right:24px;z-index:9998;width:56px;height:56px;border-radius:50%;border:1px solid rgba(255,255,255,.15);cursor:pointer;background:linear-gradient(135deg,#005c4b,#00735e);color:#e8f5e9;font-size:24px;box-shadow:0 4px 16px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;transition:transform .15s}
    #aiCopilotFab:hover{transform:scale(1.08)}
    #aiCopilotFullscreen{position:fixed;inset:0;z-index:10000;background:#0b141a;display:none;flex-direction:column;font-family:'Inter',sans-serif;color:#e2e8f0}
    #aiCopilotFullscreen.open{display:flex}
    .cp-fs-header{height:56px;background:#111b21;border-bottom:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:space-between;padding:0 20px;flex-shrink:0}
    .cp-fs-header h2{font-size:16px;font-weight:600;color:#e8f5e9;display:flex;align-items:center;gap:8px}
    .cp-fs-close{background:none;border:none;color:#8696a0;font-size:20px;cursor:pointer;padding:8px}
    .cp-fs-close:hover{color:#e8f5e9}
    .cp-fs-body{display:flex;flex:1;overflow:hidden}
    .cp-fs-sidebar{width:200px;background:#111b21;border-right:1px solid rgba(255,255,255,.1);padding:12px 8px;display:flex;flex-direction:column;gap:2px;flex-shrink:0}
    .cp-fs-nav{padding:10px 14px;border-radius:8px;border:none;background:transparent;color:#8696a0;font-size:13px;font-weight:500;cursor:pointer;text-align:left;width:100%;display:flex;align-items:center;gap:8px;font-family:inherit}
    .cp-fs-nav:hover{background:rgba(255,255,255,.06);color:#e2e8f0}
    .cp-fs-nav.active{background:rgba(0,92,75,.3);color:#d1fae5}
    .cp-fs-content{flex:1;overflow-y:auto;display:flex;flex-direction:column}
    .cp-fs-section{display:none;flex-direction:column;height:100%}
    .cp-fs-section.active{display:flex}
    /* Chat */
    .cp-chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
    .cp-msg{max-width:75%;padding:10px 14px;border-radius:14px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
    .cp-msg.user{align-self:flex-end;background:#005c4b;color:#e8f5e9;border-bottom-right-radius:4px}
    .cp-msg.assistant{align-self:flex-start;background:rgba(255,255,255,.06);color:#e2e8f0;border:1px solid rgba(255,255,255,.1);border-bottom-left-radius:4px}
    .cp-msg.system{align-self:center;background:transparent;color:#8696a0;font-size:12px;text-align:center}
    .cp-typing{align-self:flex-start;color:#8696a0;font-size:12px;padding:6px 14px}
    .cp-confirm{align-self:stretch;max-width:460px;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.3);border-radius:10px;padding:14px}
    .cp-confirm-title{font-weight:600;color:#fbbf24;font-size:12px;margin-bottom:6px}
    .cp-confirm-summary{color:#fde68a;font-size:13px;margin-bottom:10px}
    .cp-confirm-btns{display:flex;gap:8px}
    .cp-confirm-btns button{flex:1;padding:8px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
    .cp-confirm-yes{background:#16a34a;color:#fff}
    .cp-confirm-no{background:rgba(255,255,255,.1);color:#e2e8f0}
    .cp-quick-bar{padding:8px 16px;display:flex;gap:6px;overflow-x:auto;border-top:1px solid rgba(255,255,255,.08);background:#111b21}
    .cp-quick-chip{white-space:nowrap;padding:5px 12px;border-radius:16px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#8696a0;font-size:12px;cursor:pointer;flex-shrink:0;font-family:inherit}
    .cp-quick-chip:hover{background:rgba(0,92,75,.2);color:#d1fae5;border-color:rgba(0,115,94,.5)}
    .cp-input-area{display:flex;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);background:#111b21;align-items:flex-end}
    .cp-input-area textarea{flex:1;resize:none;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 12px;font-size:13px;background:rgba(255,255,255,.06);color:#fff;outline:none;max-height:100px;min-height:42px;font-family:inherit}
    .cp-input-area textarea::placeholder{color:rgba(255,255,255,.3)}
    .cp-input-area textarea:focus{border-color:#00735e}
    .cp-send-btn{background:#005c4b;color:#e8f5e9;border:none;border-radius:10px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:16px}
    .cp-send-btn:disabled{opacity:.4;cursor:not-allowed}
    /* Shared cards */
    .cp-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px}
    .cp-card h3{font-size:14px;font-weight:600;margin-bottom:12px;color:#e8f5e9}
    .cp-input{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 12px;color:#fff;font-size:13px;outline:none;width:100%;font-family:inherit}
    .cp-input:focus{border-color:#00735e}
    .cp-input::placeholder{color:rgba(255,255,255,.25)}
    textarea.cp-input{resize:vertical;min-height:60px}
    select.cp-input{appearance:none;cursor:pointer}
    .cp-btn{padding:8px 16px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
    .cp-btn-primary{background:#005c4b;color:#e8f5e9}
    .cp-btn-primary:hover{background:#00735e}
    .cp-btn-secondary{background:rgba(255,255,255,.08);color:#e2e8f0;border:1px solid rgba(255,255,255,.12)}
    .cp-section-pad{padding:20px;display:flex;flex-direction:column;gap:16px;overflow-y:auto}
    .cp-empty{text-align:center;padding:32px;color:#64748b;font-size:13px}
    /* Training table */
    .cp-table{width:100%;border-collapse:collapse;font-size:12.5px}
    .cp-table th{text-align:left;padding:8px 10px;background:rgba(255,255,255,.04);color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid rgba(255,255,255,.08)}
    .cp-table td{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06);color:#94a3b8;max-width:250px;word-break:break-word}
    .cp-table tr:hover td{background:rgba(255,255,255,.03)}
    .cp-table .q{color:#e2e8f0;font-weight:500}
    /* Action cards */
    .cp-actions-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
    .cp-action-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px}
    .cp-action-card h4{font-size:13px;font-weight:600;margin-bottom:8px;color:#e8f5e9}
    .cp-action-card p{font-size:12px;color:#64748b;margin-bottom:10px}
    .cp-action-result{margin-top:10px;padding:8px;border-radius:6px;font-size:12px;display:none}
    .cp-action-result.show{display:block}
    .cp-action-result.ok{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.2)}
    .cp-action-result.err{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.2)}
    .cp-action-result.info{background:rgba(0,92,75,.15);color:#d1fae5;border:1px solid rgba(0,92,75,.3)}
    /* Analytics */
    .cp-stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
    .cp-stat{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px}
    .cp-stat .label{font-size:11px;color:#64748b}
    .cp-stat .value{font-size:22px;font-weight:700;color:#e8f5e9;margin-top:2px}
    /* Workflows */
    .wf-item{display:flex;align-items:center;gap:12px;padding:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;margin-bottom:8px}
    .wf-item.disabled{opacity:.45}
    .wf-name{font-size:13px;font-weight:600;color:#e8f5e9}
    .wf-rule{font-size:12px;color:#8696a0;margin-top:2px}
    .wf-btns{display:flex;gap:4px;margin-left:auto}
    .wf-btns button{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#8696a0;padding:4px 8px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit}
    .wf-btns button:hover{background:rgba(255,255,255,.12);color:#e2e8f0}
    @media(max-width:640px){.cp-fs-sidebar{width:60px}.cp-fs-nav span{display:none}.cp-actions-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);

    // ── FAB ──
    const fab = document.createElement('button');
    fab.id = 'aiCopilotFab';
    fab.title = 'AI Copilot Pro';
    fab.innerHTML = '&#x2728;';

    // ── Fullscreen container ──
    const fs = document.createElement('div');
    fs.id = 'aiCopilotFullscreen';
    fs.innerHTML = `
    <div class="cp-fs-header">
        <h2>&#x2728; AI Copilot Pro</h2>
        <button class="cp-fs-close" id="cpFsClose">&times;</button>
    </div>
    <div class="cp-fs-body">
        <div class="cp-fs-sidebar">
            <button class="cp-fs-nav active" data-sec="chat">&#x1F4AC; <span>Chat</span></button>
            <button class="cp-fs-nav" data-sec="training">&#x1F4DA; <span>Training</span></button>
            <button class="cp-fs-nav" data-sec="actions">&#x26A1; <span>Actions</span></button>
            <button class="cp-fs-nav" data-sec="analytics">&#x1F4CA; <span>Analytics</span></button>
            <button class="cp-fs-nav" data-sec="workflows">&#x1F504; <span>Workflows</span></button>
        </div>
        <div class="cp-fs-content">
            <div id="cpSec-chat" class="cp-fs-section active"></div>
            <div id="cpSec-training" class="cp-fs-section"></div>
            <div id="cpSec-actions" class="cp-fs-section"></div>
            <div id="cpSec-analytics" class="cp-fs-section"></div>
            <div id="cpSec-workflows" class="cp-fs-section"></div>
        </div>
    </div>`;

    let chatBusy = false;
    let chatHistoryLoaded = false;
    const sectionInited = {};

    // ── Navigation ──
    function switchSec(name) {
        fs.querySelectorAll('.cp-fs-nav').forEach(b => b.classList.toggle('active', b.dataset.sec === name));
        fs.querySelectorAll('.cp-fs-section').forEach(s => s.classList.toggle('active', s.id === `cpSec-${name}`));
        if (!sectionInited[name]) { initSection(name); sectionInited[name] = true; }
    }

    // ── Chat section ──
    function initChatSection() {
        const root = document.getElementById('cpSec-chat');
        root.innerHTML = `
        <div class="cp-chat-messages" id="cpChatMsgs">
            <div class="cp-msg system">Hi! I can look up shoppers, orders, tickets, shipments, and perform actions — all with your confirmation.</div>
        </div>
        <div class="cp-quick-bar">
            <button class="cp-quick-chip" data-p="Show open tickets">Open tickets</button>
            <button class="cp-quick-chip" data-p="Dashboard stats">Stats</button>
            <button class="cp-quick-chip" data-p="Pending shipments">Pending shipments</button>
            <button class="cp-quick-chip" data-p="Track AWB">Track AWB</button>
        </div>
        <div class="cp-input-area">
            <textarea id="cpChatInput" rows="1" placeholder="Ask about shoppers, orders, shipments…"></textarea>
            <button class="cp-send-btn" id="cpChatSend">&#x27A4;</button>
        </div>`;
        root.querySelector('#cpChatSend').onclick = sendChat;
        root.querySelector('#cpChatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
        root.querySelectorAll('.cp-quick-chip').forEach(c => c.onclick = () => { root.querySelector('#cpChatInput').value = c.dataset.p; sendChat(); });
        loadChatHistory();
    }

    function addChatMsg(role, text) {
        const c = document.getElementById('cpChatMsgs');
        if (!c) return;
        const d = document.createElement('div');
        d.className = `cp-msg ${role}`;
        d.textContent = text;
        c.appendChild(d);
        c.scrollTop = c.scrollHeight;
    }

    async function loadChatHistory() {
        if (chatHistoryLoaded) return;
        chatHistoryLoaded = true;
        try {
            const data = await apiFetch('/ai/history');
            (data.history || []).forEach(t => { if (t.role === 'user' || t.role === 'assistant') addChatMsg(t.role, t.content); });
        } catch (e) { /* optional */ }
    }

    async function sendChat() {
        const input = document.getElementById('cpChatInput');
        const text = input.value.trim();
        if (!text || chatBusy) return;
        chatBusy = true;
        document.getElementById('cpChatSend').disabled = true;
        input.value = '';
        addChatMsg('user', text);
        const typing = document.createElement('div');
        typing.className = 'cp-typing';
        typing.textContent = 'Thinking…';
        document.getElementById('cpChatMsgs').appendChild(typing);
        try {
            const data = await apiFetch('/ai/chat', 'POST', { message: text });
            typing.remove();
            addChatMsg('assistant', data.reply || 'Done.');
            if (data.pendingAction?.id) addConfirmCard(data.pendingAction);
        } catch (e) {
            typing.remove();
            addChatMsg('system', `Error: ${e.message}`);
        } finally {
            chatBusy = false;
            document.getElementById('cpChatSend').disabled = false;
            input.focus();
        }
    }

    function addConfirmCard(pending) {
        const c = document.getElementById('cpChatMsgs');
        if (!c) return;
        const card = document.createElement('div');
        card.className = 'cp-confirm';
        card.innerHTML = `<div class="cp-confirm-title">Confirmation required</div><div class="cp-confirm-summary"></div><div class="cp-confirm-btns"><button class="cp-confirm-yes">Confirm & Execute</button><button class="cp-confirm-no">Cancel</button></div>`;
        card.querySelector('.cp-confirm-summary').textContent = pending.summary || pending.toolName;
        card.querySelector('.cp-confirm-yes').onclick = async () => {
            try {
                const data = await apiFetch(`/ai/confirm/${pending.id}`, 'POST');
                card.remove();
                addChatMsg('system', `Executed: ${data.summary || pending.summary}`);
            } catch (e) { card.remove(); addChatMsg('system', `Failed: ${e.message}`); }
        };
        card.querySelector('.cp-confirm-no').onclick = async () => {
            try { await apiFetch(`/ai/cancel/${pending.id}`, 'POST'); } catch (e) { /* ignore */ }
            card.remove();
            addChatMsg('system', 'Cancelled.');
        };
        c.appendChild(card);
        c.scrollTop = c.scrollHeight;
    }

    // ── Training section ──
    function initTrainingSection() {
        const root = document.getElementById('cpSec-training');
        root.innerHTML = `
        <div class="cp-section-pad">
            <div style="display:flex;gap:8px;align-items:center;">
                <input class="cp-input" id="cpTrSearch" placeholder="Search learned replies…" style="flex:1;">
                <button class="cp-btn cp-btn-primary" id="cpTrAdd">+ Add</button>
            </div>
            <div style="overflow-x:auto;flex:1;">
                <table class="cp-table"><thead><tr><th>Question</th><th>Reply</th><th>Uses</th><th>Actions</th></tr></thead>
                <tbody id="cpTrBody"><tr><td colspan="4" class="cp-empty">Loading…</td></tr></tbody></table>
            </div>
        </div>`;
        let timer;
        root.querySelector('#cpTrSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadLearned, 350); });
        root.querySelector('#cpTrAdd').onclick = () => {
            const q = prompt('Customer question pattern:');
            if (!q) return;
            const a = prompt('Approved reply:');
            if (!a) return;
            apiFetch('/ai/learned', 'POST', { question: q, reply: a, pinned: true }).then(() => loadLearned()).catch(e => alert(e.message));
        };
        loadLearned();
    }

    async function loadLearned() {
        const body = document.getElementById('cpTrBody');
        if (!body) return;
        const search = document.getElementById('cpTrSearch')?.value || '';
        try {
            const data = await apiFetch(`/ai/learned?search=${encodeURIComponent(search)}`);
            const rows = data.learned || [];
            if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="cp-empty">No learned replies yet.</td></tr>'; return; }
            body.innerHTML = '';
            rows.forEach(r => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td class="q">${esc(r.customer_question)}</td><td>${esc(r.agent_reply).substring(0, 120)}</td><td>${r.uses}</td>
                <td><button class="cp-btn cp-btn-secondary" style="padding:3px 8px;font-size:11px;" data-act="del">Delete</button></td>`;
                tr.querySelector('[data-act="del"]').onclick = async () => { if (confirm('Delete?')) { await apiFetch(`/ai/learned/${r.id}`, 'DELETE'); tr.remove(); } };
                body.appendChild(tr);
            });
        } catch (e) { body.innerHTML = `<tr><td colspan="4" class="cp-empty">${e.message}</td></tr>`; }
    }

    // ── Actions section ──
    function initActionsSection() {
        const root = document.getElementById('cpSec-actions');
        root.innerHTML = `
        <div class="cp-section-pad">
            <div class="cp-actions-grid">
                <div class="cp-action-card">
                    <h4>&#x1F4E9; Batch Update Tickets</h4>
                    <p>Resolve or close multiple tickets at once</p>
                    <select class="cp-input" id="cpActTicketFilter" style="margin-bottom:8px;"><option value="open">Open</option><option value="resolved">Resolved</option></select>
                    <select class="cp-input" id="cpActTicketNew" style="margin-bottom:8px;"><option value="resolved">Resolved</option><option value="closed">Closed</option></select>
                    <button class="cp-btn cp-btn-primary" id="cpActTicketExec">Execute</button>
                    <div class="cp-action-result" id="cpActTicketRes"></div>
                </div>
                <div class="cp-action-card">
                    <h4>&#x1F4E6; Pending Shipments</h4>
                    <p>View orders ready for shipment booking</p>
                    <button class="cp-btn cp-btn-primary" id="cpActPendShip">Load Pending</button>
                    <div class="cp-action-result" id="cpActPendShipRes"></div>
                </div>
                <div class="cp-action-card">
                    <h4>&#x26A1; Smart Triage</h4>
                    <p>AI categorizes and prioritizes open tickets</p>
                    <button class="cp-btn cp-btn-primary" id="cpActTriage">Analyze Tickets</button>
                    <div class="cp-action-result" id="cpActTriageRes"></div>
                </div>
                <div class="cp-action-card">
                    <h4>&#x1F4AC; Bulk WhatsApp</h4>
                    <p>Send message to a customer segment</p>
                    <select class="cp-input" id="cpActWaSeg" style="margin-bottom:8px;"><option value="open_tickets">Open tickets</option><option value="pending_carts">Abandoned carts</option></select>
                    <textarea class="cp-input" id="cpActWaMsg" rows="2" placeholder="Message text…" style="margin-bottom:8px;"></textarea>
                    <button class="cp-btn cp-btn-primary" id="cpActWaExec">Send (needs confirmation)</button>
                    <div class="cp-action-result" id="cpActWaRes"></div>
                </div>
            </div>
        </div>`;

        root.querySelector('#cpActTicketExec').onclick = async () => {
            const res = root.querySelector('#cpActTicketRes');
            const filter = root.querySelector('#cpActTicketFilter').value;
            const newSt = root.querySelector('#cpActTicketNew').value;
            showRes(res, 'info', 'Sending to AI…');
            try {
                const data = await apiFetch('/ai/chat', 'POST', { message: `Batch update all "${filter}" tickets to "${newSt}"` });
                showRes(res, 'ok', data.pendingAction ? `Prepared: ${data.pendingAction.summary}. Confirm in Chat.` : (data.reply || 'Done.'));
            } catch (e) { showRes(res, 'err', e.message); }
        };
        root.querySelector('#cpActPendShip').onclick = async () => {
            const res = root.querySelector('#cpActPendShipRes');
            showRes(res, 'info', 'Loading…');
            try {
                const data = await apiFetch('/ai/chat', 'POST', { message: 'Show pending shipments' });
                showRes(res, 'ok', data.reply || 'Loaded.');
            } catch (e) { showRes(res, 'err', e.message); }
        };
        root.querySelector('#cpActTriage').onclick = async () => {
            const res = root.querySelector('#cpActTriageRes');
            showRes(res, 'info', 'Analyzing…');
            try {
                const data = await apiFetch('/ai/chat', 'POST', { message: 'Triage open tickets by category and priority' });
                showRes(res, 'ok', data.reply || 'Analysis complete.');
            } catch (e) { showRes(res, 'err', e.message); }
        };
        root.querySelector('#cpActWaExec').onclick = async () => {
            const res = root.querySelector('#cpActWaRes');
            const seg = root.querySelector('#cpActWaSeg').value;
            const msg = root.querySelector('#cpActWaMsg').value.trim();
            if (!msg) { showRes(res, 'err', 'Enter a message'); return; }
            showRes(res, 'info', 'Sending…');
            try {
                const data = await apiFetch('/ai/chat', 'POST', { message: `Bulk send WhatsApp to "${seg}": ${msg}` });
                showRes(res, 'ok', data.pendingAction ? `Prepared: ${data.pendingAction.summary}. Confirm in Chat.` : (data.reply || 'Done.'));
            } catch (e) { showRes(res, 'err', e.message); }
        };
    }

    function showRes(el, type, text) { el.className = `cp-action-result show ${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`; el.textContent = text; }

    // ── Analytics section ──
    function initAnalyticsSection() {
        const root = document.getElementById('cpSec-analytics');
        root.innerHTML = `<div class="cp-section-pad"><div class="cp-stats-row" id="cpAnStats"><div class="cp-stat"><div class="label">Loading…</div></div></div><div class="cp-card" id="cpAnInsights"><h3>Smart Insights</h3><div class="cp-empty">Loading…</div></div><div class="cp-card" id="cpAnTopQ"><h3>Top Customer Questions</h3><div class="cp-empty">Loading…</div></div></div>`;
        loadAnalytics();
    }

    async function loadAnalytics() {
        try {
            const [usage, insights] = await Promise.all([apiFetch('/ai/usage?days=30'), apiFetch('/ai/insights')]);
            const t = usage.totals || {};
            document.getElementById('cpAnStats').innerHTML = `
            <div class="cp-stat"><div class="label">Total Requests (30d)</div><div class="value">${t.requests || 0}</div></div>
            <div class="cp-stat"><div class="label">Total Cost</div><div class="value">$${parseFloat(t.cost_usd || 0).toFixed(2)}</div></div>
            <div class="cp-stat"><div class="label">Tokens Used</div><div class="value">${((parseInt(t.prompt_tokens || 0) + parseInt(t.completion_tokens || 0)) / 1000).toFixed(1)}k</div></div>`;
            // Insights
            const ins = document.getElementById('cpAnInsights');
            const suggestions = insights.suggestions || [];
            if (!suggestions.length) { ins.querySelector('.cp-empty').textContent = 'No insights right now.'; }
            else { ins.innerHTML = '<h3>Smart Insights</h3>' + suggestions.map(s => `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px;color:#94a3b8;">${s.text}</div>`).join(''); }
            // Top questions
            const topQ = document.getElementById('cpAnTopQ');
            const questions = insights.topQuestions || [];
            if (!questions.length) { topQ.querySelector('.cp-empty').textContent = 'No data yet.'; }
            else { topQ.innerHTML = '<h3>Top Customer Questions</h3>' + questions.slice(0, 8).map((q, i) => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;font-size:13px;"><span style="color:#00735e;font-weight:700;">${i+1}</span><span style="flex:1;color:#94a3b8;">${esc(q.customer_question).substring(0,80)}</span><span style="color:#64748b;font-size:12px;">${q.uses}x</span></div>`).join(''); }
        } catch (e) { console.error('Analytics error:', e); }
    }

    // ── Workflows section ──
    function initWorkflowsSection() {
        const root = document.getElementById('cpSec-workflows');
        root.innerHTML = `<div class="cp-section-pad"><div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="font-size:15px;font-weight:600;">Automation Workflows</h3><button class="cp-btn cp-btn-primary" id="cpWfNew">+ New</button></div><div id="cpWfList"><div class="cp-empty">Loading…</div></div></div>`;
        root.querySelector('#cpWfNew').onclick = () => alert('Workflow creation is available in the admin dashboard AI Copilot Pro.');
        loadWorkflowsList();
    }

    async function loadWorkflowsList() {
        const list = document.getElementById('cpWfList');
        if (!list) return;
        try {
            const data = await apiFetch('/ai/workflows');
            const wfs = data.workflows || [];
            if (!wfs.length) { list.innerHTML = '<div class="cp-empty">No workflows yet. Create them from the admin dashboard.</div>'; return; }
            list.innerHTML = '';
            wfs.forEach(wf => {
                const item = document.createElement('div');
                item.className = `wf-item${wf.enabled ? '' : ' disabled'}`;
                item.innerHTML = `<div><div class="wf-name">${esc(wf.name)}</div><div class="wf-rule">${wf.trigger_type} → ${wf.action_type} · Fired ${wf.fire_count || 0} times</div></div>
                <div class="wf-btns"><button data-act="toggle">${wf.enabled ? 'Disable' : 'Enable'}</button></div>`;
                item.querySelector('[data-act="toggle"]').onclick = async () => { await apiFetch(`/ai/workflows/${wf.id}`, 'PUT', { enabled: !wf.enabled }); loadWorkflowsList(); };
                list.appendChild(item);
            });
        } catch (e) { list.innerHTML = `<div class="cp-empty">${e.message}</div>`; }
    }

    // ── Section init dispatcher ──
    function initSection(name) {
        switch (name) {
            case 'chat': initChatSection(); break;
            case 'training': initTrainingSection(); break;
            case 'actions': initActionsSection(); break;
            case 'analytics': initAnalyticsSection(); break;
            case 'workflows': initWorkflowsSection(); break;
        }
    }

    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    // ── Init ──
    function init() {
        if (!getToken()) return;
        document.body.appendChild(fab);
        document.body.appendChild(fs);
        fab.onclick = () => { fs.classList.add('open'); if (!sectionInited.chat) { initSection('chat'); sectionInited.chat = true; } };
        fs.querySelector('#cpFsClose').onclick = () => fs.classList.remove('open');
        fs.querySelectorAll('.cp-fs-nav').forEach(btn => btn.addEventListener('click', () => switchSec(btn.dataset.sec)));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
