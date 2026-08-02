/**
 * AI Copilot Pro — Analytics Section
 *
 * AI usage dashboard with charts, cost tracking, tool usage breakdown,
 * smart insights, sentiment trends, scenario breakdown, AI performance,
 * and real-time live monitoring.
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'analytics';
    let initialized = false;
    let currentTab = 'overview'; // overview | live
    let liveInterval = null;

    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
    #section-analytics { padding: 0; gap: 0; overflow: hidden; display: flex; flex-direction: column; }
    .an-tabs { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--bg-secondary); }
    .an-tab { padding: 6px 14px; border-radius: var(--radius-sm); border: none; background: transparent; color: var(--text-secondary); font-size: 12px; font-weight: 600; cursor: pointer; }
    .an-tab.active { background: var(--accent); color: #fff; }
    .an-tab-content { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; }
    .analytics-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .analytics-stat { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
    .analytics-stat .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
    .analytics-stat .value { font-size: 24px; font-weight: 700; }
    .analytics-stat .sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .analytics-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .analytics-chart-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
    .analytics-chart-card h3 { font-size: 14px; font-weight: 600; margin-bottom: 16px; }
    .chart-container { position: relative; height: 200px; }
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

    /* Sentiment trend bars */
    .sentiment-bar-wrap { display: flex; flex-direction: column; gap: 6px; }
    .sentiment-day-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
    .sentiment-day-label { width: 56px; color: var(--text-muted); flex-shrink: 0; }
    .sentiment-bar-inner { display: flex; height: 16px; border-radius: 4px; overflow: hidden; flex: 1; }
    .sentiment-bar-inner div { min-width: 2px; transition: width .3s; }

    /* Escalation bar chart */
    .esc-bar-chart { display: flex; flex-direction: column; gap: 8px; }
    .esc-bar-row { display: flex; align-items: center; gap: 10px; }
    .esc-bar-label { width: 100px; font-size: 12px; color: var(--text-secondary); text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .esc-bar-track { flex: 1; height: 20px; background: var(--bg-input); border-radius: 4px; overflow: hidden; }
    .esc-bar-fill { height: 100%; border-radius: 4px; transition: width .4s; display: flex; align-items: center; padding-left: 6px; font-size: 10px; font-weight: 600; color: #fff; }
    .esc-bar-count { width: 36px; font-size: 12px; font-weight: 600; color: var(--text-muted); text-align: right; }

    /* Live tab */
    .live-header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: an-live-pulse 2s infinite; }
    @keyframes an-live-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.3)} }
    .live-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .live-stat { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
    .live-stat .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .live-stat .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .live-stat .sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .live-esc-list { display: flex; flex-direction: column; gap: 8px; }
    .live-esc-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-input); border-radius: var(--radius-sm); font-size: 13px; }
    .live-esc-item .time { font-size: 11px; color: var(--text-muted); margin-left: auto; flex-shrink: 0; }
    .live-esc-item .badge { padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }

    @media (max-width: 768px) { .analytics-row { grid-template-columns: 1fr; } }
    `;
    document.head.appendChild(style);

    const CAT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#64748b'];
    const SENT_COLORS = { positive: '#22c55e', neutral: '#94a3b8', negative: '#f59e0b', frustrated: '#ef4444' };

    // ── Render ──
    function render() {
        const root = document.getElementById('section-analytics');
        root.innerHTML = `
        <div class="an-tabs">
            <button class="an-tab active" data-at="overview">Overview</button>
            <button class="an-tab" data-at="live">Live</button>
        </div>
        <div class="an-tab-content" id="anTabContent"></div>`;

        root.querySelectorAll('.an-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                root.querySelectorAll('.an-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentTab = tab.dataset.at;
                renderTab();
            });
        });
        renderTab();
    }

    function renderTab() {
        const content = document.getElementById('anTabContent');
        if (!content) return;
        if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
        if (currentTab === 'overview') renderOverview(content);
        else renderLive(content);
    }

    // ── Overview Tab ──
    function renderOverview(container) {
        container.innerHTML = `
        <div class="analytics-stats" id="anStats">
            <div class="analytics-stat"><div class="label">Total Requests</div><div class="value" id="anTotalReq">—</div><div class="sub" id="anTotalSub">Last 30 days</div></div>
            <div class="analytics-stat"><div class="label">Total Cost</div><div class="value" id="anTotalCost">—</div><div class="sub">Estimated LLM cost</div></div>
            <div class="analytics-stat"><div class="label">Tokens Used</div><div class="value" id="anTotalTokens">—</div><div class="sub">Prompt + completion</div></div>
            <div class="analytics-stat"><div class="label">Today's Requests</div><div class="value" id="anTodayReq">—</div><div class="sub" id="anTodaySub"></div></div>
        </div>
        <div class="analytics-stats" id="anPerfStats">
            <div class="analytics-stat"><div class="label">Avg AI Confidence</div><div class="value" id="anAvgConf">—</div><div class="sub" id="anConfSub"></div></div>
            <div class="analytics-stat"><div class="label">Resolution Rate</div><div class="value" id="anResRate">—</div><div class="sub" id="anResSub"></div></div>
            <div class="analytics-stat"><div class="label">Cost / Resolution</div><div class="value" id="anCostRes">—</div><div class="sub">30-day average</div></div>
            <div class="analytics-stat"><div class="label">Escalation Rate</div><div class="value" id="anEscRate">—</div><div class="sub">Auto-escalated</div></div>
        </div>
        <div class="analytics-row">
            <div class="analytics-chart-card">
                <h3>Daily Usage</h3>
                <div class="chart-container"><canvas id="anUsageChart"></canvas></div>
            </div>
            <div class="analytics-chart-card">
                <h3>Sentiment Trends (14 days)</h3>
                <div id="anSentTrend"><span class="loading-spinner"></span> Loading…</div>
            </div>
        </div>
        <div class="analytics-row">
            <div class="analytics-chart-card">
                <h3>Scenario Breakdown</h3>
                <div id="anScenarioBreak"><span class="loading-spinner"></span> Loading…</div>
            </div>
            <div class="analytics-chart-card">
                <h3>Top Escalation Reasons</h3>
                <div id="anEscReasons"><span class="loading-spinner"></span> Loading…</div>
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

        loadAllData();
    }

    async function loadAllData() {
        try {
            const [usageData, insightsData, analyticsData] = await Promise.all([
                CP.apiFetch('/ai/usage?days=30'),
                CP.apiFetch('/ai/insights'),
                CP.apiFetch('/ai/analytics')
            ]);
            renderUsageStats(usageData);
            renderUsageChart(usageData);
            renderInsights(insightsData);
            renderTopQuestions(insightsData);
            renderTicketCategories(insightsData);
            renderResolutionTimes(insightsData);
            renderPerformanceMetrics(analyticsData);
            renderSentimentTrends(analyticsData);
            renderScenarioBreakdown(analyticsData);
            renderEscalationReasons(analyticsData);
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

    function renderPerformanceMetrics(data) {
        const perf = data.aiPerformance || {};
        const avgConf = Math.round((perf.avgConfidence || 0) * 100);
        const confColor = avgConf >= 70 ? 'var(--success)' : avgConf >= 50 ? 'var(--warning)' : 'var(--danger)';
        document.getElementById('anAvgConf').textContent = `${avgConf}%`;
        document.getElementById('anAvgConf').style.color = confColor;
        document.getElementById('anConfSub').textContent = `${perf.classifiedCount || 0} tickets classified`;

        const resRate = Math.round(perf.resolutionRate || 0);
        document.getElementById('anResRate').textContent = `${resRate}%`;
        document.getElementById('anResRate').style.color = resRate >= 60 ? 'var(--success)' : 'var(--warning)';
        document.getElementById('anResSub').textContent = `${perf.resolvedCount || 0} / ${perf.totalTickets || 0} resolved`;

        const cpr = perf.costPerResolution || 0;
        document.getElementById('anCostRes').textContent = cpr > 0 ? `$${cpr.toFixed(3)}` : '—';

        // Escalation rate from quality-metrics (reuse)
        const escRate = perf.totalTickets > 0 ? Math.round((1 - perf.resolutionRate) * 100) : 0;
        document.getElementById('anEscRate').textContent = `${escRate}%`;
    }

    function renderSentimentTrends(data) {
        const container = document.getElementById('anSentTrend');
        if (!container) return;
        const trends = data.sentimentTrends || [];
        if (!trends.length) {
            container.innerHTML = '<div class="empty-state"><p>No sentiment data yet</p></div>';
            return;
        }
        const last14 = trends.slice(-14);
        let html = '<div class="sentiment-bar-wrap">';
        last14.forEach(day => {
            const total = (day.positive || 0) + (day.neutral || 0) + (day.negative || 0) + (day.frustrated || 0);
            if (!total) return;
            const d = new Date(day.day);
            const label = `${d.getDate()}/${d.getMonth() + 1}`;
            html += `<div class="sentiment-day-row">
                <span class="sentiment-day-label">${label}</span>
                <div class="sentiment-bar-inner">
                    <div style="width:${(day.positive / total) * 100}%;background:${SENT_COLORS.positive};" title="Positive: ${day.positive}"></div>
                    <div style="width:${(day.neutral / total) * 100}%;background:${SENT_COLORS.neutral};" title="Neutral: ${day.neutral}"></div>
                    <div style="width:${(day.negative / total) * 100}%;background:${SENT_COLORS.negative};" title="Negative: ${day.negative}"></div>
                    <div style="width:${(day.frustrated / total) * 100}%;background:${SENT_COLORS.frustrated};" title="Frustrated: ${day.frustrated}"></div>
                </div>
                <span style="width:28px;text-align:right;color:var(--text-muted);font-size:11px;">${total}</span>
            </div>`;
        });
        html += '</div>';
        html += '<div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap;">';
        Object.entries(SENT_COLORS).forEach(([k, v]) => {
            html += `<span style="display:flex;align-items:center;gap:4px;font-size:11px;"><span style="width:8px;height:8px;border-radius:2px;background:${v};"></span>${k}</span>`;
        });
        html += '</div>';
        container.innerHTML = html;
    }

    function renderScenarioBreakdown(data) {
        const container = document.getElementById('anScenarioBreak');
        if (!container) return;
        const dist = data.scenarioDistribution || [];
        if (!dist.length) {
            container.innerHTML = '<div class="empty-state"><p>No scenario data yet</p></div>';
            return;
        }
        const total = dist.reduce((s, d) => s + d.count, 0);
        let html = '<div class="category-bar">';
        dist.forEach((d, i) => {
            const pct = Math.max(5, (d.count / total) * 100);
            html += `<div style="width:${pct}%;background:${CAT_COLORS[i % CAT_COLORS.length]};" title="${d.ai_scenario}: ${d.count}">${pct > 12 ? d.count : ''}</div>`;
        });
        html += '</div><div class="category-legend">';
        dist.forEach((d, i) => {
            html += `<div class="category-legend-item"><div class="category-dot" style="background:${CAT_COLORS[i % CAT_COLORS.length]};"></div>${d.ai_scenario.replace(/_/g, ' ')}: ${d.count}</div>`;
        });
        html += '</div>';
        container.innerHTML = html;
    }

    function renderEscalationReasons(data) {
        const container = document.getElementById('anEscReasons');
        if (!container) return;
        const reasons = data.escalationReasons || [];
        if (!reasons.length) {
            container.innerHTML = '<div class="empty-state"><p>No escalations in the last 30 days</p></div>';
            return;
        }
        const maxCount = Math.max(...reasons.map(r => r.count));
        let html = '<div class="esc-bar-chart">';
        reasons.forEach((r, i) => {
            const pct = (r.count / maxCount) * 100;
            const confPct = Math.round((r.avg_confidence || 0) * 100);
            html += `<div class="esc-bar-row">
                <span class="esc-bar-label" title="${r.scenario}">${r.scenario.replace(/_/g, ' ')}</span>
                <div class="esc-bar-track"><div class="esc-bar-fill" style="width:${pct}%;background:${CAT_COLORS[i % CAT_COLORS.length]};">${pct > 20 ? r.count : ''}</div></div>
                <span class="esc-bar-count">${r.count}</span>
            </div>`;
        });
        html += '</div>';
        container.innerHTML = html;
    }

    function renderUsageChart(data) {
        const canvas = document.getElementById('anUsageChart');
        if (!canvas) return;
        const daily = (data.daily || []).slice().reverse();
        if (!daily.length) {
            canvas.parentElement.innerHTML = '<div class="empty-state"><p>No usage data yet</p></div>';
            return;
        }
        const ctx = canvas.getContext('2d');
        const w = canvas.parentElement.clientWidth;
        const h = 200;
        canvas.width = w;
        canvas.height = h;
        const maxVal = Math.max(...daily.map(d => d.requests || 0), 1);
        const barW = Math.max(4, (w - 40) / daily.length - 2);
        const padding = 30;

        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padding + (h - padding * 2) * (1 - i / 4);
            ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(w - 10, y); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '10px Inter';
            ctx.fillText(Math.round(maxVal * i / 4), 2, y + 3);
        }
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
                actionBtn.addEventListener('click', () => { location.hash = s.action.page; });
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

    // ── Live Tab ──
    function renderLive(container) {
        container.innerHTML = `
        <div class="live-header">
            <div class="live-dot"></div>
            <span style="font-size:14px;font-weight:600;">Live Monitoring</span>
            <span style="font-size:12px;color:var(--text-muted);">Auto-refreshes every 30s</span>
        </div>
        <div class="live-stats" id="liveStats">
            <div class="live-stat"><div class="label">Open Tickets</div><div class="value" id="liveOpenTickets">—</div><div class="sub">Currently active</div></div>
            <div class="live-stat"><div class="label">Today's AI Requests</div><div class="value" id="liveTodayReq">—</div><div class="sub" id="liveTodayCost"></div></div>
            <div class="live-stat"><div class="label">Escalations (1h)</div><div class="value" id="liveEsc1h">—</div><div class="sub">Recent auto-escalations</div></div>
            <div class="live-stat"><div class="label">Sentiment Alert</div><div class="value" id="liveFrustrated">—</div><div class="sub">Frustrated customers (open)</div></div>
        </div>
        <div class="analytics-chart-card">
            <h3>Recent Escalations (Last Hour)</h3>
            <div class="live-esc-list" id="liveEscList"><span class="loading-spinner"></span> Loading…</div>
        </div>`;

        loadLiveData();
        liveInterval = setInterval(loadLiveData, 30000);
    }

    async function loadLiveData() {
        try {
            const data = await CP.apiFetch('/ai/live');
            document.getElementById('liveOpenTickets').textContent = data.openTickets || 0;

            const usage = data.todayUsage || {};
            document.getElementById('liveTodayReq').textContent = usage.requests || 0;
            document.getElementById('liveTodayCost').textContent = usage.cost ? `$${parseFloat(usage.cost).toFixed(2)} cost` : '';

            const escalations = data.recentEscalations || [];
            document.getElementById('liveEsc1h').textContent = escalations.length;

            const sentBreak = data.sentimentBreakdown || [];
            const frustrated = sentBreak.find(s => s.sentiment === 'frustrated');
            const frCount = frustrated?.count || 0;
            const frEl = document.getElementById('liveFrustrated');
            frEl.textContent = frCount;
            frEl.style.color = frCount > 0 ? 'var(--danger)' : 'var(--success)';

            // Render escalation list
            const listEl = document.getElementById('liveEscList');
            if (!escalations.length) {
                listEl.innerHTML = '<div class="empty-state"><p>No escalations in the last hour</p></div>';
                return;
            }
            listEl.innerHTML = '';
            escalations.forEach(esc => {
                const item = document.createElement('div');
                item.className = 'live-esc-item';
                const name = esc.customer_name || esc.customer_phone || 'Customer';
                const scenario = (esc.ai_scenario || 'unknown').replace(/_/g, ' ');
                const sentClass = esc.sentiment ? `live-badge-${esc.sentiment}` : '';
                const sentBg = esc.sentiment === 'frustrated' ? 'rgba(239,68,68,.12);color:#ef4444' :
                               esc.sentiment === 'negative' ? 'rgba(245,158,11,.12);color:#f59e0b' :
                               'rgba(148,163,184,.12);color:#94a3b8';
                const confPct = esc.ai_confidence != null ? Math.round(parseFloat(esc.ai_confidence) * 100) : null;
                const time = timeAgo(esc.created_at);

                item.innerHTML = `
                    <span style="font-weight:600;">${escapeHtml(name)}</span>
                    <span style="font-size:12px;color:var(--text-muted);">${escapeHtml(esc.ticket_number || '')}</span>
                    <span class="badge" style="background:${sentBg};">${esc.sentiment || 'unknown'}</span>
                    <span style="font-size:12px;color:var(--text-secondary);">${scenario}</span>
                    ${confPct != null ? `<span style="font-size:11px;color:${confPct < 50 ? 'var(--danger)' : 'var(--text-muted)'};">${confPct}% conf</span>` : ''}
                    <span class="time">${time}</span>`;
                listEl.appendChild(item);
            });
        } catch (e) {
            console.error('Live data error:', e);
        }
    }

    // ── Helpers ──
    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function timeAgo(dateStr) {
        if (!dateStr) return '';
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return new Date(dateStr).toLocaleDateString();
    }

    // ── Lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
            else renderTab(); // refresh on revisit
        }
    });
})();
