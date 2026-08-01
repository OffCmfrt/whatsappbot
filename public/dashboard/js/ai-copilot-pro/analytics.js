/**
 * AI Copilot Pro — Analytics Section
 *
 * AI usage dashboard with charts, cost tracking, tool usage breakdown,
 * and smart insights (ticket categories, resolution times, suggestions).
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'analytics';
    let initialized = false;

    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
    #section-analytics { padding: 24px; gap: 20px; overflow-y: auto; }
    .analytics-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .analytics-stat { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
    .analytics-stat .label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
    .analytics-stat .value { font-size: 24px; font-weight: 700; }
    .analytics-stat .sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .analytics-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .analytics-chart-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
    .analytics-chart-card h3 { font-size: 14px; font-weight: 600; margin-bottom: 16px; }
    .chart-container { position: relative; height: 220px; }
    .insight-cards { display: flex; flex-direction: column; gap: 10px; }
    .insight-card { display: flex; gap: 12px; padding: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); align-items: flex-start; }
    .insight-icon { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 16px; }
    .insight-card .text { font-size: 13px; line-height: 1.5; }
    .insight-card .action-btn { margin-top: 6px; font-size: 12px; color: var(--accent-hover); cursor: pointer; background: none; border: none; padding: 0; font-weight: 600; }
    .top-questions-list { display: flex; flex-direction: column; gap: 8px; }
    .top-q-item { display: flex; align-items: center; gap: 10px; padding: 10px; background: var(--bg-input); border-radius: var(--radius-sm); }
    .top-q-rank { width: 24px; height: 24px; border-radius: 50%; background: var(--accent-bg); color: var(--accent-hover); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
    .top-q-text { flex: 1; font-size: 13px; }
    .top-q-uses { font-size: 12px; color: var(--text-muted); }
    .category-bar { display: flex; height: 24px; border-radius: 6px; overflow: hidden; margin-bottom: 12px; }
    .category-bar div { display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; min-width: 30px; }
    .category-legend { display: flex; flex-wrap: wrap; gap: 10px; }
    .category-legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .category-dot { width: 10px; height: 10px; border-radius: 3px; }
    @media (max-width: 768px) { .analytics-row { grid-template-columns: 1fr; } }
    `;
    document.head.appendChild(style);

    const CAT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#64748b'];

    // ── Render ──
    function render() {
        const root = document.getElementById('section-analytics');
        root.innerHTML = `
        <div class="analytics-stats" id="anStats">
            <div class="analytics-stat"><div class="label">Total Requests</div><div class="value" id="anTotalReq">—</div><div class="sub" id="anTotalSub">Last 30 days</div></div>
            <div class="analytics-stat"><div class="label">Total Cost</div><div class="value" id="anTotalCost">—</div><div class="sub">Estimated LLM cost</div></div>
            <div class="analytics-stat"><div class="label">Tokens Used</div><div class="value" id="anTotalTokens">—</div><div class="sub">Prompt + completion</div></div>
            <div class="analytics-stat"><div class="label">Today's Requests</div><div class="value" id="anTodayReq">—</div><div class="sub" id="anTodaySub"></div></div>
        </div>
        <div class="analytics-row">
            <div class="analytics-chart-card">
                <h3>Daily Usage</h3>
                <div class="chart-container"><canvas id="anUsageChart"></canvas></div>
            </div>
            <div class="analytics-chart-card">
                <h3>Ticket Categories</h3>
                <div id="anTicketCats"><span class="loading-spinner"></span> Loading…</div>
            </div>
        </div>
        <div class="analytics-row">
            <div class="analytics-chart-card">
                <h3>Smart Insights</h3>
                <div class="insight-cards" id="anInsights"><span class="loading-spinner"></span> Analyzing…</div>
            </div>
            <div class="analytics-chart-card">
                <h3>Top Customer Questions</h3>
                <div class="top-questions-list" id="anTopQ"><span class="loading-spinner"></span> Loading…</div>
            </div>
        </div>
        <div class="analytics-chart-card" style="margin-top:0;">
            <h3>Resolution Time by Portal</h3>
            <div id="anResTime"><span class="loading-spinner"></span> Loading…</div>
        </div>`;

        loadData();
    }

    async function loadData() {
        try {
            const [usageData, insightsData] = await Promise.all([
                CP.apiFetch('/ai/usage?days=30'),
                CP.apiFetch('/ai/insights')
            ]);
            renderUsageStats(usageData);
            renderUsageChart(usageData);
            renderInsights(insightsData);
            renderTopQuestions(insightsData);
            renderTicketCategories(insightsData);
            renderResolutionTimes(insightsData);
        } catch (e) {
            console.error('Analytics load failed:', e);
        }
    }

    function renderUsageStats(data) {
        const totals = data.totals || {};
        document.getElementById('anTotalReq').textContent = totals.requests || 0;
        document.getElementById('anTotalCost').textContent = `$${parseFloat(totals.cost_usd || 0).toFixed(2)}`;
        const totalTokens = (parseInt(totals.prompt_tokens) || 0) + (parseInt(totals.completion_tokens) || 0);
        document.getElementById('anTotalTokens').textContent = totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens;
        // Today
        const today = (data.daily || []).find(d => {
            const date = new Date(d.day);
            const now = new Date();
            return date.toDateString() === now.toDateString();
        });
        document.getElementById('anTodayReq').textContent = today?.requests || 0;
        if (today?.cost_usd) {
            document.getElementById('anTodaySub').textContent = `$${parseFloat(today.cost_usd).toFixed(2)} cost`;
        }
    }

    function renderUsageChart(data) {
        const canvas = document.getElementById('anUsageChart');
        if (!canvas) return;
        const daily = (data.daily || []).slice().reverse();
        if (!daily.length) {
            canvas.parentElement.innerHTML = '<div class="empty-state"><p>No usage data yet</p></div>';
            return;
        }
        // Simple bar chart using canvas
        const ctx = canvas.getContext('2d');
        const w = canvas.parentElement.clientWidth;
        const h = 220;
        canvas.width = w;
        canvas.height = h;
        const maxVal = Math.max(...daily.map(d => d.requests || 0), 1);
        const barW = Math.max(4, (w - 40) / daily.length - 2);
        const padding = 30;

        ctx.clearRect(0, 0, w, h);
        // Grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padding + (h - padding * 2) * (1 - i / 4);
            ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(w - 10, y); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '10px Inter';
            ctx.fillText(Math.round(maxVal * i / 4), 2, y + 3);
        }
        // Bars
        daily.forEach((d, i) => {
            const val = d.requests || 0;
            const barH = (val / maxVal) * (h - padding * 2);
            const x = padding + i * ((w - padding - 10) / daily.length);
            const y = h - padding - barH;
            ctx.fillStyle = '#6366f1';
            ctx.beginPath();
            ctx.roundRect(x, y, barW, barH, 2);
            ctx.fill();
        });
    }

    function renderTicketCategories(data) {
        const container = document.getElementById('anTicketCats');
        if (!container) return;
        const cats = data.ticketCategories?.categories || {};
        const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
        const total = data.ticketCategories?.total || 0;
        if (!entries.length) {
            container.innerHTML = '<div class="empty-state"><p>No open tickets to analyze</p></div>';
            return;
        }
        let html = `<div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">${total} open tickets analyzed</div>`;
        html += '<div class="category-bar">';
        entries.forEach(([cat, count], i) => {
            const pct = Math.max(5, (count / total) * 100);
            html += `<div style="width:${pct}%;background:${CAT_COLORS[i % CAT_COLORS.length]};" title="${cat}: ${count}">${pct > 10 ? count : ''}</div>`;
        });
        html += '</div><div class="category-legend">';
        entries.forEach(([cat, count], i) => {
            html += `<div class="category-legend-item"><div class="category-dot" style="background:${CAT_COLORS[i % CAT_COLORS.length]};"></div>${cat}: ${count}</div>`;
        });
        html += '</div>';
        container.innerHTML = html;
    }

    function renderInsights(data) {
        const container = document.getElementById('anInsights');
        if (!container) return;
        const suggestions = data.suggestions || [];
        if (!suggestions.length) {
            container.innerHTML = '<div class="empty-state"><p>No insights right now. Everything looks good!</p></div>';
            return;
        }
        container.innerHTML = '';
        const iconMap = { training: '&#x1F4DA;', action: '&#x26A1;', info: '&#x2139;' };
        const colorMap = { high: 'var(--danger)', medium: 'var(--warning)', low: 'var(--text-muted)' };
        suggestions.forEach(s => {
            const card = document.createElement('div');
            card.className = 'insight-card';
            card.innerHTML = `
            <div class="insight-icon" style="background:${s.priority === 'high' ? 'rgba(239,68,68,.12)' : s.priority === 'medium' ? 'rgba(245,158,11,.12)' : 'var(--accent-bg)'};">${iconMap[s.type] || '&#x2139;'}</div>
            <div>
                <div class="text">${s.text}</div>
                ${s.action ? `<button class="action-btn" data-page="${s.action.page}">Go to ${s.action.page} &rarr;</button>` : ''}
            </div>`;
            const actionBtn = card.querySelector('.action-btn');
            if (actionBtn) {
                actionBtn.addEventListener('click', () => {
                    location.hash = s.action.page;
                });
            }
            container.appendChild(card);
        });
    }

    function renderTopQuestions(data) {
        const container = document.getElementById('anTopQ');
        if (!container) return;
        const questions = data.topQuestions || [];
        if (!questions.length) {
            container.innerHTML = '<div class="empty-state"><p>No learned questions yet</p></div>';
            return;
        }
        container.innerHTML = '';
        questions.slice(0, 10).forEach((q, i) => {
            const item = document.createElement('div');
            item.className = 'top-q-item';
            item.innerHTML = `
            <div class="top-q-rank">${i + 1}</div>
            <div class="top-q-text">${escapeHtml(q.customer_question).substring(0, 100)}</div>
            <div class="top-q-uses">${q.uses}x</div>`;
            container.appendChild(item);
        });
    }

    function renderResolutionTimes(data) {
        const container = document.getElementById('anResTime');
        if (!container) return;
        const times = data.resolutionTimes || [];
        if (!times.length) {
            container.innerHTML = '<div class="empty-state"><p>No resolution data in the last 30 days</p></div>';
            return;
        }
        let html = '<table class="training-table" style="width:100%;"><thead><tr><th>Portal ID</th><th>Avg Hours</th><th>Resolved</th></tr></thead><tbody>';
        times.forEach(t => {
            html += `<tr><td>Portal #${t.portal_id || 'N/A'}</td><td>${parseFloat(t.avg_hours).toFixed(1)}h</td><td>${t.resolved_count}</td></tr>`;
        });
        html += '</tbody></table>';
        container.innerHTML = html;
    }

    function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    // ── Lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
            else loadData(); // refresh on revisit
        }
    });
})();
