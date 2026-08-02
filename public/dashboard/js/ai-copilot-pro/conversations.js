/**
 * AI Copilot Pro — Conversations Section
 *
 * Conversation Review Center: list support tickets with filters, view full
 * conversation threads, see AI classification (sentiment, scenario, confidence),
 * and quality metrics.
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'conversations';
    let initialized = false;
    let currentTab = 'list'; // list | quality
    let currentFilters = { status: '', sentiment: '', scenario: '', search: '' };
    let currentOffset = 0;
    const PAGE_SIZE = 30;

    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
    #section-conversations { padding: 0; gap: 0; overflow: hidden; display: flex; flex-direction: column; }
    .conv-layout { display: flex; flex: 1; overflow: hidden; }
    .conv-list-panel { width: 420px; min-width: 320px; border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
    .conv-detail-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .conv-toolbar { padding: 12px 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--border); background: var(--bg-secondary); }
    .conv-toolbar .input-field { max-width: 200px; font-size: 12px; padding: 6px 10px; }
    .conv-toolbar select.input-field { max-width: 140px; }
    .conv-tabs { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--bg-secondary); }
    .conv-tab { padding: 6px 14px; border-radius: var(--radius-sm); border: none; background: transparent; color: var(--text-secondary); font-size: 12px; font-weight: 600; cursor: pointer; }
    .conv-tab.active { background: var(--accent); color: #fff; }
    .conv-items { flex: 1; overflow-y: auto; }
    .conv-item { padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .15s; }
    .conv-item:hover { background: var(--bg-input); }
    .conv-item.active { background: var(--accent-bg); border-left: 3px solid var(--accent); }
    .conv-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .conv-item-name { font-size: 13px; font-weight: 600; }
    .conv-item-time { font-size: 11px; color: var(--text-muted); }
    .conv-item-msg { font-size: 12px; color: var(--text-secondary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .conv-item-meta { display: flex; gap: 6px; margin-top: 6px; align-items: center; flex-wrap: wrap; }

    /* Badges */
    .conv-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .conv-badge-positive { background: rgba(34,197,94,.12); color: #22c55e; }
    .conv-badge-neutral { background: rgba(148,163,184,.12); color: #94a3b8; }
    .conv-badge-negative { background: rgba(245,158,11,.12); color: #f59e0b; }
    .conv-badge-frustrated { background: rgba(239,68,68,.12); color: #ef4444; }
    .conv-badge-status { padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
    .conv-badge-open { background: rgba(99,102,241,.12); color: #818cf8; }
    .conv-badge-resolved { background: rgba(34,197,94,.12); color: #22c55e; }
    .conv-badge-closed { background: rgba(100,116,139,.12); color: #64748b; }
    .conv-confidence { font-size: 10px; color: var(--text-muted); }

    /* Detail panel */
    .conv-detail-header { padding: 16px 20px; border-bottom: 1px solid var(--border); background: var(--bg-secondary); }
    .conv-detail-header h3 { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
    .conv-detail-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
    .conv-detail-actions { display: flex; gap: 8px; margin-top: 10px; }
    .conv-detail-actions button { padding: 5px 12px; border-radius: var(--radius-sm); border: none; font-size: 11px; font-weight: 600; cursor: pointer; }
    .conv-thread { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
    .conv-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; }
    .conv-msg-incoming { align-self: flex-start; background: var(--bg-input); border-bottom-left-radius: 4px; }
    .conv-msg-outgoing { align-self: flex-end; background: var(--accent-bg); color: var(--accent-hover); border-bottom-right-radius: 4px; }
    .conv-msg-time { font-size: 10px; color: var(--text-muted); margin-top: 4px; }
    .conv-msg-ai { align-self: center; background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.2); border-radius: 8px; font-size: 12px; color: var(--warning); max-width: 90%; padding: 8px 12px; }
    .conv-orders { padding: 12px 20px; border-top: 1px solid var(--border); background: var(--bg-secondary); }
    .conv-orders h4 { font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--text-muted); text-transform: uppercase; }
    .conv-order-row { display: flex; gap: 12px; font-size: 12px; padding: 4px 0; color: var(--text-secondary); }

    /* Quality metrics */
    .conv-quality { padding: 24px; overflow-y: auto; }
    .conv-quality-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .conv-quality-stat { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
    .conv-quality-stat .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; }
    .conv-quality-stat .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .conv-quality-stat .sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .conv-dist-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .conv-dist-item { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--bg-input); border-radius: var(--radius-sm); font-size: 12px; }
    .conv-dist-bar { height: 8px; border-radius: 4px; min-width: 20px; }

    .conv-empty { text-align: center; padding: 48px 24px; color: var(--text-muted); }
    .conv-empty p { margin-top: 8px; font-size: 13px; }

    @media (max-width: 768px) {
        .conv-list-panel { width: 100%; border-right: none; }
        .conv-detail-panel { display: none; }
        .conv-layout.detail-open .conv-list-panel { display: none; }
        .conv-layout.detail-open .conv-detail-panel { display: flex; }
    }
    `;
    document.head.appendChild(style);

    // ── Render ──
    function render() {
        const root = document.getElementById('section-conversations');
        root.innerHTML = `
        <div class="conv-tabs">
            <button class="conv-tab active" data-ctab="list">Conversations</button>
            <button class="conv-tab" data-ctab="quality">Quality Metrics</button>
        </div>
        <div id="convContent"></div>`;

        root.querySelectorAll('.conv-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                root.querySelectorAll('.conv-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentTab = tab.dataset.ctab;
                renderTab();
            });
        });
        renderTab();
    }

    function renderTab() {
        const content = document.getElementById('convContent');
        if (!content) return;
        if (currentTab === 'list') renderList(content);
        else renderQuality(content);
    }

    // ── List View ──
    function renderList(container) {
        container.innerHTML = `
        <div class="conv-layout" id="convLayout">
            <div class="conv-list-panel">
                <div class="conv-toolbar">
                    <input class="input-field" id="convSearch" placeholder="Search name, phone, ticket..." value="${escapeHtml(currentFilters.search)}">
                    <select class="input-field" id="convStatusFilter">
                        <option value="">All Status</option>
                        <option value="open" ${currentFilters.status === 'open' ? 'selected' : ''}>Open</option>
                        <option value="resolved" ${currentFilters.status === 'resolved' ? 'selected' : ''}>Resolved</option>
                        <option value="closed" ${currentFilters.status === 'closed' ? 'selected' : ''}>Closed</option>
                    </select>
                    <select class="input-field" id="convSentimentFilter">
                        <option value="">All Sentiment</option>
                        <option value="positive" ${currentFilters.sentiment === 'positive' ? 'selected' : ''}>Positive</option>
                        <option value="neutral" ${currentFilters.sentiment === 'neutral' ? 'selected' : ''}>Neutral</option>
                        <option value="negative" ${currentFilters.sentiment === 'negative' ? 'selected' : ''}>Negative</option>
                        <option value="frustrated" ${currentFilters.sentiment === 'frustrated' ? 'selected' : ''}>Frustrated</option>
                    </select>
                    <select class="input-field" id="convScenarioFilter">
                        <option value="">All Scenarios</option>
                        <option value="tracking">Tracking</option>
                        <option value="delayed_pod">Delayed</option>
                        <option value="refund_policy">Refund</option>
                        <option value="size_exchange">Size/Exchange</option>
                        <option value="damaged_wrong_item">Damaged/Wrong</option>
                        <option value="address_change">Address</option>
                        <option value="cod_confusion">COD</option>
                        <option value="cancellation">Cancellation</option>
                        <option value="escalation">Escalation</option>
                    </select>
                </div>
                <div class="conv-items" id="convItems">
                    <div class="conv-empty"><span class="loading-spinner"></span><p>Loading conversations...</p></div>
                </div>
            </div>
            <div class="conv-detail-panel" id="convDetail">
                <div class="conv-empty" style="margin:auto;">
                    <p>Select a conversation to view details</p>
                </div>
            </div>
        </div>`;

        // Event listeners
        let searchTimer;
        document.getElementById('convSearch').addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                currentFilters.search = e.target.value;
                currentOffset = 0;
                loadConversations();
            }, 350);
        });
        document.getElementById('convStatusFilter').addEventListener('change', (e) => {
            currentFilters.status = e.target.value;
            currentOffset = 0;
            loadConversations();
        });
        document.getElementById('convSentimentFilter').addEventListener('change', (e) => {
            currentFilters.sentiment = e.target.value;
            currentOffset = 0;
            loadConversations();
        });
        document.getElementById('convScenarioFilter').addEventListener('change', (e) => {
            currentFilters.scenario = e.target.value;
            currentOffset = 0;
            loadConversations();
        });

        loadConversations();
    }

    async function loadConversations() {
        const container = document.getElementById('convItems');
        if (!container) return;
        container.innerHTML = '<div class="conv-empty"><span class="loading-spinner"></span><p>Loading...</p></div>';

        try {
            const params = new URLSearchParams();
            if (currentFilters.status) params.set('status', currentFilters.status);
            if (currentFilters.sentiment) params.set('sentiment', currentFilters.sentiment);
            if (currentFilters.scenario) params.set('scenario', currentFilters.scenario);
            if (currentFilters.search) params.set('search', currentFilters.search);
            params.set('limit', PAGE_SIZE);
            params.set('offset', currentOffset);

            const data = await CP.apiFetch(`/ai/conversations?${params.toString()}`);
            const conversations = data.conversations || [];

            if (!conversations.length) {
                container.innerHTML = '<div class="conv-empty"><p>No conversations found</p></div>';
                return;
            }

            container.innerHTML = '';
            conversations.forEach(conv => {
                const item = document.createElement('div');
                item.className = 'conv-item';
                item.dataset.id = conv.id;

                const name = conv.customer_name || conv.customer_display_name || 'Customer';
                const time = timeAgo(conv.created_at);
                const msgPreview = String(conv.message || '').split('\n')[0].substring(0, 120);

                let metaHtml = '';
                // Status badge
                const statusClass = conv.status === 'open' ? 'open' : conv.status === 'resolved' ? 'resolved' : 'closed';
                metaHtml += `<span class="conv-badge-status conv-badge-${statusClass}">${conv.status}</span>`;
                // Sentiment badge
                if (conv.sentiment) {
                    metaHtml += `<span class="conv-badge conv-badge-${conv.sentiment}">${conv.sentiment}</span>`;
                }
                // Scenario
                if (conv.ai_scenario) {
                    metaHtml += `<span class="conv-badge" style="background:var(--accent-bg);color:var(--accent-hover);">${conv.ai_scenario.replace('_', ' ')}</span>`;
                }
                // Confidence
                if (conv.ai_confidence != null) {
                    const confPct = Math.round(parseFloat(conv.ai_confidence) * 100);
                    const confColor = confPct >= 70 ? 'var(--success)' : confPct >= 50 ? 'var(--warning)' : 'var(--danger)';
                    metaHtml += `<span class="conv-confidence" style="color:${confColor}">${confPct}% conf</span>`;
                }

                item.innerHTML = `
                    <div class="conv-item-header">
                        <span class="conv-item-name">${escapeHtml(name)}</span>
                        <span class="conv-item-time">${time}</span>
                    </div>
                    <div class="conv-item-msg">${escapeHtml(msgPreview)}</div>
                    <div class="conv-item-meta">${metaHtml}</div>`;

                item.addEventListener('click', () => {
                    document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    loadConversationDetail(conv.id);
                });

                container.appendChild(item);
            });
        } catch (e) {
            container.innerHTML = `<div class="conv-empty" style="color:var(--danger);"><p>${e.message}</p></div>`;
        }
    }

    async function loadConversationDetail(ticketId) {
        const panel = document.getElementById('convDetail');
        if (!panel) return;
        panel.innerHTML = '<div class="conv-empty" style="margin:auto;"><span class="loading-spinner"></span><p>Loading conversation...</p></div>';

        try {
            const data = await CP.apiFetch(`/ai/conversations/${ticketId}`);
            const ticket = data.ticket || {};
            const messages = data.messages || [];
            const orders = data.orders || [];

            let html = `
            <div class="conv-detail-header">
                <h3>${escapeHtml(ticket.customerName || 'Customer')} <span style="font-weight:400;color:var(--text-muted);font-size:13px;">${escapeHtml(ticket.ticketNumber || '')}</span></h3>
                <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(ticket.customerPhone || '')} ${ticket.customerEmail ? ' &middot; ' + escapeHtml(ticket.customerEmail) : ''}</div>
                <div class="conv-detail-meta">
                    <span class="conv-badge-status conv-badge-${ticket.status}">${ticket.status}</span>
                    ${ticket.sentiment ? `<span class="conv-badge conv-badge-${ticket.sentiment}">${ticket.sentiment}</span>` : ''}
                    ${ticket.aiScenario ? `<span class="conv-badge" style="background:var(--accent-bg);color:var(--accent-hover);">${ticket.aiScenario.replace('_', ' ')}</span>` : ''}
                    ${ticket.aiConfidence != null ? `<span class="conv-confidence">Confidence: ${Math.round(parseFloat(ticket.aiConfidence) * 100)}%</span>` : ''}
                    ${ticket.source ? `<span class="conv-badge" style="background:var(--bg-input);color:var(--text-muted);">${ticket.source}</span>` : ''}
                </div>
                <div class="conv-detail-actions">
                    ${ticket.status === 'open' ? `<button class="btn-primary" data-action="resolve" data-id="${ticket.id}">Mark Resolved</button>` : ''}
                    ${ticket.status !== 'closed' ? `<button class="btn-secondary" data-action="close" data-id="${ticket.id}">Close</button>` : ''}
                    <button class="btn-secondary" data-action="train" data-id="${ticket.id}">Add to Training</button>
                </div>
            </div>
            <div class="conv-thread">`;

            // Render messages
            messages.forEach(msg => {
                const isIncoming = msg.message_type === 'incoming';
                const time = formatTime(msg.created_at);
                html += `
                <div class="conv-msg ${isIncoming ? 'conv-msg-incoming' : 'conv-msg-outgoing'}">
                    ${escapeHtml(msg.message_content || '')}
                    <div class="conv-msg-time">${time}</div>
                </div>`;
            });

            // Show AI suggestion if present
            if (ticket.aiSuggestion) {
                html += `
                <div class="conv-msg-ai">
                    <div style="font-weight:600;margin-bottom:4px;">AI Suggestion (${escapeHtml(ticket.aiSuggestion.scenario)})</div>
                    ${escapeHtml(ticket.aiSuggestion.reply || '').substring(0, 500)}
                </div>`;
            }

            html += '</div>';

            // Orders section
            if (orders.length) {
                html += '<div class="conv-orders"><h4>Recent Orders</h4>';
                orders.forEach(o => {
                    html += `<div class="conv-order-row">
                        <span style="font-weight:600;">#${escapeHtml(o.order_id)}</span>
                        <span>${escapeHtml(o.status || '')}</span>
                        ${o.awb ? `<span>AWB: ${escapeHtml(o.awb)}</span>` : ''}
                        <span>${escapeHtml(o.courier_name || '')}</span>
                    </div>`;
                });
                html += '</div>';
            }

            panel.innerHTML = html;

            // Bind action buttons via event listeners (CSP-safe, no inline handlers)
            panel.querySelectorAll('[data-action]').forEach(btn => {
                const id = parseInt(btn.dataset.id);
                if (btn.dataset.action === 'resolve') btn.onclick = () => resolveTicket(id);
                else if (btn.dataset.action === 'close') btn.onclick = () => closeTicket(id);
                else if (btn.dataset.action === 'train') btn.onclick = () => addtotraining(id);
            });

            // Mobile: show detail
            const layout = document.getElementById('convLayout');
            if (layout) layout.classList.add('detail-open');

        } catch (e) {
            panel.innerHTML = `<div class="conv-empty" style="color:var(--danger);"><p>${e.message}</p></div>`;
        }
    }

    // ── Quality Metrics ──
    async function renderQuality(container) {
        container.innerHTML = '<div class="conv-quality"><div class="conv-empty"><span class="loading-spinner"></span><p>Loading quality metrics...</p></div></div>';

        try {
            const data = await CP.apiFetch('/ai/quality-metrics');

            const sentimentDist = data.sentimentDistribution || [];
            const scenarioDist = data.scenarioDistribution || [];
            const avgConf = Math.round((data.avgConfidence || 0) * 100);
            const escRate = data.escalationRate || 0;
            const resRate = data.resolutionRate || 0;

            const sentimentColors = { positive: '#22c55e', neutral: '#94a3b8', negative: '#f59e0b', frustrated: '#ef4444' };

            let html = '<div class="conv-quality">';
            html += '<div class="conv-quality-grid">';
            html += `<div class="conv-quality-stat"><div class="label">Avg AI Confidence</div><div class="value" style="color:${avgConf >= 70 ? 'var(--success)' : avgConf >= 50 ? 'var(--warning)' : 'var(--danger)'};">${avgConf}%</div><div class="sub">${data.totalClassified || 0} tickets classified</div></div>`;
            html += `<div class="conv-quality-stat"><div class="label">Escalation Rate</div><div class="value">${escRate}%</div><div class="sub">Auto-escalated to admin</div></div>`;
            html += `<div class="conv-quality-stat"><div class="label">Resolution Rate</div><div class="value" style="color:var(--success);">${resRate}%</div><div class="sub">Tickets resolved/closed</div></div>`;
            html += '</div>';

            // Sentiment distribution
            html += '<div class="card" style="margin-bottom:16px;"><div class="card-header"><h3>Sentiment Distribution (30 days)</h3></div>';
            if (sentimentDist.length) {
                html += '<div class="conv-dist-row">';
                sentimentDist.forEach(s => {
                    const color = sentimentColors[s.sentiment] || '#64748b';
                    html += `<div class="conv-dist-item"><div class="conv-dist-bar" style="background:${color};width:${Math.max(20, s.count * 3)}px;"></div>${s.sentiment}: <strong>${s.count}</strong></div>`;
                });
                html += '</div>';
            } else {
                html += '<div class="empty-state"><p>No sentiment data yet</p></div>';
            }
            html += '</div>';

            // Scenario distribution
            html += '<div class="card"><div class="card-header"><h3>Scenario Distribution (30 days)</h3></div>';
            if (scenarioDist.length) {
                html += '<div class="conv-dist-row">';
                scenarioDist.forEach(s => {
                    html += `<div class="conv-dist-item"><div class="conv-dist-bar" style="background:var(--accent);width:${Math.max(20, s.count * 3)}px;"></div>${s.ai_scenario.replace('_', ' ')}: <strong>${s.count}</strong></div>`;
                });
                html += '</div>';
            } else {
                html += '<div class="empty-state"><p>No scenario data yet</p></div>';
            }
            html += '</div>';

            html += '</div>';
            container.innerHTML = html;
        } catch (e) {
            container.innerHTML = `<div class="conv-quality"><div class="conv-empty" style="color:var(--danger);"><p>${e.message}</p></div></div>`;
        }
    }

    // ── Actions ──
    async function resolveTicket(id) {
        try {
            await CP.apiFetch(`/ai/conversations/${id}`, 'PUT', { status: 'resolved' });
            loadConversations();
        } catch (e) { alert(e.message); }
    }

    async function closeTicket(id) {
        try {
            await CP.apiFetch(`/ai/conversations/${id}`, 'PUT', { status: 'closed' });
            loadConversations();
        } catch (e) { alert(e.message); }
    }

    function addtotraining(id) {
        // Find the ticket's messages to extract Q&A pair
        CP.apiFetch(`/ai/conversations/${id}`).then(data => {
            const messages = data.messages || [];
            const incoming = messages.find(m => m.message_type === 'incoming');
            const outgoing = messages.find(m => m.message_type === 'outgoing');
            if (incoming && outgoing) {
                const q = encodeURIComponent(incoming.message_content || '');
                const a = encodeURIComponent(outgoing.message_content || '');
                location.hash = `training?prefill_q=${q}&prefill_a=${a}`;
            } else {
                location.hash = 'training';
            }
        }).catch(() => { location.hash = 'training'; });
    }

    // Actions are bound via event listeners in openTicket (CSP-safe)

    // ── Helpers ──
    function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function timeAgo(dateStr) {
        if (!dateStr) return '';
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        const days = Math.floor(hrs / 24);
        if (days < 7) return `${days}d`;
        return new Date(dateStr).toLocaleDateString();
    }

    function formatTime(dateStr) {
        if (!dateStr) return '';
        return new Date(dateStr).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    // ── Lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
            else if (currentTab === 'list') loadConversations();
        }
    });
})();
