/* Forecast workspace: lazy views, bounded memoization, delegated events, no API calls. */
(function () {
    'use strict';
    const E = window.ShoppersForecast;
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const n = (v, digits = 0) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: digits });
    const money = (v) => '₹' + n(v);
    const pct = (v) => v === null ? 'Not measurable' : n(v, 1) + '%';
    const pill = (value, tone = 'neutral') => `<span class="ict-pill ict-tone-${tone}">${esc(value)}</span>`;
    const tones = { Expedite: 'critical', 'Reorder now': 'attention', 'Plan buy': 'info', Covered: 'healthy', 'Validate demand': 'neutral', Limited: 'attention', Variable: 'attention', Established: 'healthy', 'No demand': 'neutral' };
    const VIEWS = { overview: 'Overview', sku: 'SKU planner', product: 'Products', size: 'Size mix', color: 'Color mix', periods: 'Weekly plan', scenarios: 'Scenarios', segmentation: 'ABC × XYZ', quality: 'Quality & method' };
    const defaults = { productId: '__all', horizon: 30, scenario: 'Base', model: 'weighted', multiplier: 1.15, lead: 25, review: 30, buffer: 7, includeReturns: false, returnEta: 7, view: 'overview', metric: 'units', risk: 'All', quality: 'All', abc: 'All', xyz: 'All', q: '', page: 0, expanded: null, assumptionsOpen: false, sort: 'riskValue', dir: 'desc' };
    const state = { ...defaults };
    const STORAGE = 'offcomfrt.forecast.preferences.v1';
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE) || '{}');
        for (const key of ['horizon', 'model', 'scenario', 'multiplier', 'lead', 'review', 'buffer', 'returnEta', 'includeReturns', 'view', 'metric']) {
            if (typeof saved[key] === typeof defaults[key]) state[key] = saved[key];
        }
    } catch (_) { /* Storage may be unavailable in restricted environments. */ }
    Object.assign(state, E.settings(state));
    if (!VIEWS[state.view]) state.view = 'overview';
    if (!['Base', 'Upside', 'Downside', 'Campaign', 'Custom'].includes(state.scenario)) state.scenario = 'Base';
    if (!['units', 'value'].includes(state.metric)) state.metric = 'units';
    let snapshot = null, skus = [], onChange = null, searchTimer;
    const analyses = new Map(), plans = new Map();
    function remember() {
        const saved = {};
        for (const key of ['horizon', 'model', 'scenario', 'multiplier', 'lead', 'review', 'buffer', 'returnEta', 'includeReturns', 'view', 'metric']) saved[key] = state[key];
        try { localStorage.setItem(STORAGE, JSON.stringify(saved)); } catch (_) { /* Optional preferences only. */ }
    }
    function records(model) {
        if (!analyses.has(model)) analyses.set(model, skus.map((s) => E.analyze(s, model)));
        return analyses.get(model);
    }
    function planned(input = state) {
        const key = JSON.stringify(E.settings(input));
        if (plans.has(key)) return plans.get(key);
        const rows = records(input.model).map((r) => E.plan(r, input));
        if (plans.size >= 6) plans.delete(plans.keys().next().value);
        plans.set(key, rows);
        return rows;
    }
    function selected(rows = planned()) {
        const q = state.q.trim().toLowerCase();
        return rows.filter((r) => (state.productId === '__all' || r.productId === state.productId)
            && (!q || `${r.product} ${r.sku} ${r.variantTitle} ${r.size} ${r.color}`.toLowerCase().includes(q))
            && (state.risk === 'All' || (state.risk === 'Shortage' ? r.firstShortage !== null : r.action === state.risk))
            && (state.quality === 'All' || r.quality === state.quality)
            && (state.abc === 'All' || r.abc === state.abc)
            && (state.xyz === 'All' || r.xyz === state.xyz));
    }
    const card = (title, subtitle, body) => `<section class="ict-card fc-card"><header class="ict-card-head"><div><h3>${title}</h3><p>${subtitle}</p></div></header><div class="ict-card-body">${body}</div></section>`;
    const stat = (label, value, note, tone = 'neutral') => `<div class="ict-stat ict-tone-${tone}"><div class="ict-stat-label">${label}</div><div class="ict-stat-value">${value}</div><div class="ict-stat-sub">${note}</div></div>`;
    const btn = (action, value, label, active = false) => `<button type="button" class="ict-chip ${active ? 'active' : ''}" data-ict="forecast-${action}" data-value="${esc(value)}" aria-pressed="${active}">${label}</button>`;
    function select(key, label, entries, value) {
        return `<label class="fc-field"><span>${label}</span><select class="ict-input" data-ict-input="forecast-${key}">${entries.map(([id, title]) => `<option value="${esc(id)}" ${String(value) === String(id) ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`;
    }
    function numeric(key, label, min, max) {
        return `<label class="fc-field"><span>${label}</span><input class="ict-input" type="number" min="${min}" max="${max}" step="${key === 'multiplier' ? '0.05' : '1'}" value="${state[key]}" data-ict-input="forecast-${key}"></label>`;
    }
    function controls() {
        const products = [...new Map(skus.map((s) => [s.productId, s.product])).entries()];
        if (!products.some(([id]) => id === state.productId)) state.productId = '__all';
        return `<div class="fc-controls">
            <div class="fc-control-grid">
                ${select('productId', 'Catalog scope', [['__all', 'All products'], ...products], state.productId)}
                ${select('model', 'Demand model', Object.entries(E.MODELS), state.model)}
                ${select('scenario', 'Demand scenario', [['Base', 'Base · unchanged'], ['Upside', 'Upside · +25%'], ['Downside', 'Downside · −22%'], ['Campaign', 'Campaign · +30% assumption'], ['Custom', 'Custom multiplier']], state.scenario)}
                <label class="fc-field"><span>Planning horizon</span><span class="ict-chip-row">${[7, 14, 30, 60, 90].map((h) => btn('horizon', h, `${h}D`, state.horizon === h)).join('')}</span></label>
            </div>
            <details class="fc-assumptions" ${state.assumptionsOpen ? 'open' : ''}><summary>Planning assumptions <span>${state.lead}d lead · ${state.review}d review · ${state.buffer}d buffer · returns ${state.includeReturns ? 'included' : 'excluded'}</span></summary>
                <div class="fc-control-grid">
                    ${numeric('lead', 'Supplier lead time (days)', 1, 120)}${numeric('review', 'Stock cover after arrival (days)', 1, 90)}${numeric('buffer', 'Extra safety cover (days)', 0, 30)}
                    ${state.scenario === 'Custom' ? numeric('multiplier', 'Demand multiplier (× base)', 0.1, 4) : ''}
                    ${select('includeReturns', 'Expected RTO / return / exchange inbound', [['false', 'Exclude · conservative'], ['true', 'Include · assumed saleable on arrival']], String(state.includeReturns))}
                    ${state.includeReturns ? numeric('returnEta', 'Assumed inbound arrival (days)', 1, 90) : ''}
                </div>
                <p class="ict-foot-note">These are planning inputs, not confirmed supplier dates. Customer-bound shipments are never counted as inbound. Open returns may fail QC; including them is a what-if, not a stock guarantee. No purchase order is created.</p>
            </details>
        </div>`;
    }
    function filters() {
        return `<div class="fc-filter-grid">
            <label class="fc-field fc-search"><span>Search within scope</span><input class="ict-input" type="search" id="fcSearch" placeholder="Product, SKU, variant, size…" value="${esc(state.q)}" data-ict-input="forecast-q"></label>
            ${select('risk', 'Stock / buying view', ['All', 'Shortage', 'Expedite', 'Reorder now', 'Plan buy', 'Covered', 'Validate demand'].map((v) => [v, v === 'All' ? 'All actions' : v]), state.risk)}
            ${select('quality', 'Demand evidence', ['All', 'Established', 'Variable', 'Limited', 'No demand'].map((v) => [v, v]), state.quality)}
            ${select('abc', 'Revenue class', ['All', 'A', 'B', 'C'].map((v) => [v, v]), state.abc)}
            ${select('xyz', 'Predictability', [['All', 'All classes'], ['X', 'X · stable'], ['Y', 'Y · variable'], ['Z', 'Z · erratic']], state.xyz)}
            <button class="ict-btn-ghost" type="button" data-ict="forecast-clear">Clear filters</button>
        </div>`;
    }
    function stats(rows, a) {
        return `<div class="ict-stats-grid fc-stats">
            ${stat(`${state.horizon}-day expected demand`, n(a.demand), `Planning range ${n(a.low)}–${n(a.high)} units`, 'brand')}
            ${stat('Sellable now', n(a.available), 'Shopify on hand − exchange replacements', 'info')}
            ${stat('Demand shortage', n(a.lost), `${a.riskSkus} of ${rows.length} SKUs short within horizon`, a.riskSkus ? 'critical' : 'healthy')}
            ${stat('Suggested replenishment', n(a.recommended), `${state.lead}d lead + ${state.review}d cover + ${state.buffer}d safety`, 'attention')}
            ${stat('Demand value', money(a.revenue), 'At current selling price · not booked revenue', 'info')}
            ${stat('Value exposed to shortage', money(a.riskValue), 'Unserved forecast units × current price', a.riskSkus ? 'critical' : 'neutral')}
        </div>`;
    }
    function table(headers, body) {
        return `<div class="ict-table-wrap"><table class="ict-table"><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
    const cell = (v, cls = 'ict-num') => `<td class="${cls}">${v}</td>`;
    function pageRows(rows) {
        const size = 25, pages = Math.max(1, Math.ceil(rows.length / size));
        state.page = Math.min(state.page, pages - 1);
        return { items: rows.slice(state.page * size, (state.page + 1) * size), footer: `<div class="ict-pagination"><span>${n(rows.length)} rows · page ${state.page + 1} / ${pages}</span><span class="ict-page-btns"><button class="ict-btn-ghost" data-ict="forecast-page" data-value="-1" ${state.page === 0 ? 'disabled' : ''}>Previous</button><button class="ict-btn-ghost" data-ict="forecast-page" data-value="1" ${state.page >= pages - 1 ? 'disabled' : ''}>Next</button></span></div>` };
    }
    function sortRows(rows, fallback = 'riskValue') {
        const key = rows.length && state.sort in rows[0] ? state.sort : fallback;
        return [...rows].sort((a, b) => {
            const av = a[key], bv = b[key];
            if (av == null) return bv == null ? 0 : 1;
            if (bv == null) return -1;
            return (typeof av === 'string' ? av.localeCompare(String(bv)) : av - bv) * (state.dir === 'asc' ? 1 : -1);
        });
    }
    const sortHead = (label, key) => `<button class="fc-sort" data-ict="forecast-sort" data-value="${key}">${label} ${state.sort === key ? (state.dir === 'asc' ? '↑' : '↓') : '↕'}</button>`;
    function periodsTable(periods) {
        const anchor = new Date(snapshot?.generated_at || Date.now()).getTime();
        const date = (day) => new Date(anchor + day * 86400000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        return table(['Period · snapshot-relative', 'Opening units', 'Assumed inbound', 'Demand units', 'Unserved units', 'Closing units'], periods.map((p) => `<tr>${cell(`Days ${p.start}–${p.end} · ${p.days}d<small>${esc(date(p.start))}–${esc(date(p.end))}</small>`, '')}${cell(n(p.opening, 1))}${cell(n(p.inbound))}${cell(n(p.demand, 1))}${cell(n(p.short, 1), 'ict-num ict-critical-text')}${cell(n(p.closing, 1))}</tr>`).join(''));
    }
    function chart(rows, a) {
        const value = state.metric === 'value';
        const history = a.history.map((units, i) => ({ label: `W−${11 - i}`, actual: value ? rows.reduce((s, r) => s + (r.history[i] || 0) * (Number(r.price) || 0), 0) : units }));
        const weekly = rows.reduce((s, r) => s + r.daily * 7 * (value ? (Number(r.price) || 0) : 1), 0);
        // Future chart points are weekly-equivalent rates; partial weeks are shown in the table.
        const series = [...history, { label: 'Next', forecast: weekly }, ...a.periods.map((p, i) => ({ label: `+${i + 1}w`, forecast: weekly }))];
        const W = 860, H = 245, left = 65, bottom = 28, top = 20;
        const max = Math.max(1, ...series.map((p) => p.actual || p.forecast || 0));
        const x = (i) => left + i / Math.max(1, series.length - 1) * (W - left - 16);
        const y = (v) => top + (1 - v / max) * (H - bottom - top);
        const path = (key) => series.map((p, i) => p[key] == null ? '' : `${i && series[i - 1][key] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
        return `<div class="fc-chart-controls">${btn('metric', 'units', 'Units / week', !value)}${btn('metric', 'value', 'Selling value / week', value)}<span class="ict-quiet-note">Historical actuals ━ · future scenario ┄</span></div>
            <svg class="ict-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Historical weekly demand and projected weekly demand"><title>Demand by rolling week; exact horizon totals appear in the weekly plan</title>
                ${[0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${left}" x2="${W - 16}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="rgba(255,255,255,.08)"/><text x="${left - 8}" y="${y(max * f) + 3}" text-anchor="end" fill="#92929c" font-size="10">${value ? money(max * f) : n(max * f)}</text>`).join('')}
                <line x1="${x(history.length - 0.5)}" x2="${x(history.length - 0.5)}" y1="${top}" y2="${H - bottom}" stroke="#666" stroke-dasharray="4 4"/>
                <path d="${path('actual')}" fill="none" stroke="#e5e5eb" stroke-width="2.5"/><path d="${path('forecast')}" fill="none" stroke="#9d9dff" stroke-width="2.5" stroke-dasharray="6 4"/>
                ${series.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.actual ?? p.forecast)}" r="3" fill="${p.actual != null ? '#e5e5eb' : '#9d9dff'}"><title>${esc(p.label)} · ${value ? money(p.actual ?? p.forecast) : n(p.actual ?? p.forecast, 1)} / week</title></circle>${i % 2 === 0 ? `<text x="${x(i)}" y="${H - 7}" text-anchor="middle" fill="#92929c" font-size="10">${esc(p.label)}</text>` : ''}`).join('')}
            </svg><p class="ict-foot-note">Each historical bucket is a rolling 7-day period, not a calendar week. Future points show weekly-equivalent demand. The ${state.horizon}-day total uses exactly ${state.horizon} days, including a partial final week.</p>`;
    }
    function overview(rows, a) {
        const urgent = sortRows(rows.filter((r) => r.firstShortage !== null), 'riskValue').slice(0, 5);
        return card('Demand outlook', `${E.MODELS[state.model]} · ${state.scenario} scenario · not an AI or seasonal forecast`, chart(rows, a))
            + `<div class="ict-grid-2">${card('What needs a decision?', 'SKU-level shortages cannot be offset by stock in a different size or product.', urgent.length ? `<div class="fc-decisions">${urgent.map((r) => `<button class="fc-decision" data-ict="forecast-open-sku" data-value="${esc(r.variantId)}"><span><b>${esc(r.product)}</b><small>${esc(r.variantTitle)} · ${esc(r.sku)}</small></span><span>${pill(r.action, tones[r.action])}<small>First short: day ${r.firstShortage} · ${n(r.lost)}u at risk</small></span></button>`).join('')}</div>` : '<div class="ict-empty">No modeled shortage in this scope. Review limited-evidence variants before committing a buy.</div>')}
            ${card('How much trust should I place in this?', 'Historical backtest, not a guarantee of future accuracy.', `<div class="fc-facts"><div><span>Weighted forecast error (WMAPE)</span><b>${pct(a.wmape)}</b></div><div><span>Forecast bias</span><b>${a.bias === null ? 'Not measurable' : `${a.bias > 0 ? '+' : ''}${pct(a.bias)}`}</b></div><div><span>Limited evidence / no sales</span><b>${a.limited} / ${a.noDemand} SKUs</b></div><div><span>Expected inbound included</span><b>${n(a.inbound)} units</b></div></div><p class="ict-foot-note">Lower WMAPE is better. Positive bias means historical over-forecasting. Planning ranges are heuristic buffers derived from variability and backtest error, not calibrated confidence intervals.</p>${btn('view', 'quality', 'Inspect quality & formulas →')}`)}</div>`;
    }
    function detail(r) {
        return `<div class="fc-detail"><div class="fc-detail-head"><h4>${esc(r.product)} · ${esc(r.variantTitle)}</h4>${pill(r.quality, tones[r.quality])}</div><div class="fc-facts"><div><span>Baseline demand</span><b>${n(r.weekly, 2)} units/week</b></div><div><span>Scenario daily demand</span><b>${n(r.daily, 2)} units/day</b></div><div><span>Rolling 84-day actuals</span><b>${n(r.total)} units · ${r.activeWeeks} active weeks</b></div><div><span>Trend: last 4 vs prior 4 weeks</span><b>${r.trend === null ? 'No prior baseline' : `${r.trend > 0 ? '+' : ''}${pct(r.trend)}`}</b></div><div><span>Reorder point / safety stock</span><b>${n(r.reorderPoint)} / ${n(r.safety)} units</b></div><div><span>Order by (on-hand-only guide)</span><b>${r.orderIn === null ? 'No demand signal' : r.orderIn <= 0 ? 'Now / overdue' : `Within ${r.orderIn} days`}</b></div></div>
            <p class="ict-foot-note">Suggested buy = max(0, daily demand × (lead + review + buffer) − sellable now − eligible assumed inbound), rounded up. A buy arriving after a stockout cannot fix an earlier shortage; expedite or transfer stock first.</p>
            ${periodsTable(r.periods)}<details><summary>All 12 historical weeks & backtest</summary>${table(['Rolling week', 'Actual units', 'Prediction from earlier weeks', 'Absolute error'], r.history.map((v, i) => { const predicted = i >= 5 ? E.predict(r.history.slice(0, i), state.model) : null; return `<tr>${cell(`W−${11 - i}`, '')}${cell(n(v))}${cell(predicted === null ? 'Training period' : n(predicted, 1))}${cell(predicted === null ? '—' : n(Math.abs(v - predicted), 1))}</tr>`; }).join(''))}</details></div>`;
    }
    function skuTable(rows) {
        const page = pageRows(sortRows(rows));
        const heads = [sortHead('Product / SKU', 'product'), 'Evidence / action', sortHead('Daily units', 'daily'), sortHead('Demand units', 'demand'), 'Planning range', sortHead('Sellable now', 'available'), 'Cover / first short', sortHead('Unserved units', 'lost'), sortHead('Suggested buy', 'recommended'), sortHead('Value at risk', 'riskValue')];
        return card('SKU demand & replenishment planner', 'Click a product row for the exact inputs, all historical weeks, backtest, and weekly stock plan.', table(heads, page.items.map((r) => `<tr>${cell(`<button class="fc-row-link" data-ict="forecast-expand" data-value="${esc(r.variantId)}" aria-expanded="${state.expanded === r.variantId}"><b>${esc(r.product)}</b><small>${esc(r.variantTitle)} · ${esc(r.sku)}</small></button>`, '')}${cell(`${pill(r.quality, tones[r.quality])}<br>${pill(r.action, tones[r.action])}`, '')}${cell(n(r.daily, 2))}${cell(n(r.demand))}${cell(`${n(r.low)}–${n(r.high)}`)}${cell(n(r.available))}${cell(`${r.cover === null ? 'No demand' : n(r.cover, 1) + 'd'}<small>${r.firstShortage === null ? 'No shortage in horizon' : 'Short: day ' + r.firstShortage}</small>`)}${cell(n(r.lost), 'ict-num ict-critical-text')}${cell(n(r.recommended))}${cell(money(r.riskValue))}</tr>${state.expanded === r.variantId ? `<tr><td colspan="10">${detail(r)}</td></tr>` : ''}`).join('')) + page.footer);
    }
    function grouped(rows, by) {
        const groups = sortRows(E.group(rows, by), 'demand'), page = pageRows(groups);
        const totalDemand = rows.reduce((s, r) => s + r.demand, 0), stock = rows.reduce((s, r) => s + Math.max(0, r.available), 0);
        return card(by === 'product' ? 'Product-level plan' : `${by === 'size' ? 'Size' : 'Color'} demand vs stock mix`, 'Totals sum SKU plans. Shortages remain SKU-specific; a surplus in another variant is not usable substitution.', table([sortHead('Group', 'label'), 'SKUs', 'Actual units · 7d / 30d', sortHead('Demand', 'demand'), 'Demand share', 'Stock share / mix gap', 'Sellable now', 'Short SKUs / units', sortHead('Suggested buy', 'recommended'), 'Demand selling value'], page.items.map((g) => {
            const demandShare = totalDemand > 0 ? g.demand / totalDemand * 100 : 0;
            const stockShare = stock > 0 ? g.members.reduce((s, r) => s + Math.max(0, r.available), 0) / stock * 100 : 0;
            const gap = demandShare - stockShare;
            return `<tr>${cell(`${by === 'product' ? `<button class="fc-row-link" data-ict="forecast-drill" data-value="${esc(g.key)}">${esc(g.label)} →</button>` : esc(g.label)}`, '')}${cell(g.count)}${cell(`${n(g.members.reduce((s, r) => s + (Number(r.sales7) || 0), 0))} / ${n(g.members.reduce((s, r) => s + (Number(r.sales30) || 0), 0))}`)}${cell(n(g.demand))}${cell(pct(demandShare))}${cell(`${pct(stockShare)}<small>${totalDemand > 0 && stock > 0 ? `${gap > 0 ? '+' : ''}${n(gap, 1)} pp demand − stock` : 'No mix baseline'}</small>`)}${cell(n(g.available))}${cell(`${g.riskSkus} / ${n(g.lost)}`)}${cell(n(g.recommended))}${cell(money(g.revenue))}</tr>`;
        }).join('')) + page.footer + '<p class="ict-foot-note">A positive mix gap indicates demand share exceeds stock share, not proof of under-buying. Validate at SKU level. Size-only variants use the color in the product title when available.</p>');
    }
    function scenarioView(rows) {
        // Freeze SKU membership so scenario comparisons do not change the filter cohort.
        const ids = new Set(rows.map((r) => r.variantId));
        const options = ['Downside', 'Base', 'Upside', 'Campaign', ...(state.scenario === 'Custom' ? ['Custom'] : [])];
        return card('Scenario comparison', 'Same SKU cohort, model, horizon, and stock assumptions. Multipliers are what-if inputs, not campaign performance predictions.', table(['Scenario', 'Multiplier', 'Demand units', 'Unserved units', 'Short SKUs', 'Suggested buy', 'Demand value', 'Value at risk'], options.map((scenario) => {
            const input = { ...state, scenario }, a = E.summarize(planned(input).filter((r) => ids.has(r.variantId)));
            return `<tr>${cell(btn('scenario', scenario, esc(scenario), state.scenario === scenario), '')}${cell(n(E.settings(input).multiplier, 2) + '×')}${cell(n(a.demand))}${cell(n(a.lost))}${cell(a.riskSkus)}${cell(n(a.recommended))}${cell(money(a.revenue))}${cell(money(a.riskValue))}</tr>`;
        }).join('')));
    }
    function segmentationView(rows) {
        const policies = { AX: 'Prioritize availability; review replenishment frequently.', AY: 'Protect high-value demand; watch weekly swings.', AZ: 'High-value but erratic: validate the forecast before large buys.', BX: 'Standard replenishment with a regular review.', BY: 'Review demand changes before adjusting safety cover.', BZ: 'Use smaller, more frequent buys when feasible.', CX: 'Simple replenishment; avoid over-managing low-value stock.', CY: 'Light-touch review; keep capital exposure low.', CZ: 'Buy cautiously; investigate intermittent or missing demand.' };
        const cells = new Map();
        rows.forEach((r) => { const key = r.abc + r.xyz; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(r); });
        return card('Value contribution × demand predictability', 'A/B/C: 30-day selling revenue contribution. X/Y/Z: variability across 12 rolling weeks. Click a cell to inspect its SKUs.', `<div class="ict-matrix">${['A', 'B', 'C'].map((abc) => ['X', 'Y', 'Z'].map((xyz) => {
            const key = abc + xyz, members = cells.get(key) || [], a = E.summarize(members);
            return `<button class="ict-matrix-cell fc-segment" data-ict="forecast-segment" data-value="${key}" ${!members.length ? 'disabled' : ''}><span class="ict-matrix-key">${key}</span><span class="ict-matrix-count">${members.length} <small>SKUs</small></span><span class="ict-matrix-value">${n(a.demand)}u demand · ${a.riskSkus} short</span><span class="ict-matrix-count">${money(members.reduce((s, r) => s + Math.max(0, Number(r.currentStock) || 0) * (Number(r.price) || 0), 0))} on hand at selling price</span><span class="ict-matrix-strategy">${policies[key]}</span></button>`;
        }).join('')).join('')}</div><p class="ict-foot-note">X: CV &lt; 0.5 · Y: CV &lt; 1 · Z: CV ≥ 1. Zero observed demand may have CV = 0; X alone does not prove an item is predictable. Always cross-check demand evidence.</p>`);
    }
    function qualityView(rows, a) {
        const ids = new Set(rows.map((r) => r.variantId));
        const modelRows = Object.entries(E.MODELS).map(([key, label]) => {
            const cohort = records(key).filter((r) => ids.has(r.variantId));
            const actual = cohort.reduce((s, r) => s + r.test.actual, 0), error = cohort.reduce((s, r) => s + r.test.absoluteError, 0), bias = cohort.reduce((s, r) => s + r.test.signedError, 0);
            return `<tr>${cell(btn('model', key, esc(label), state.model === key), '')}${cell(pct(actual > 0 ? error / actual * 100 : null))}${cell(pct(actual > 0 ? bias / actual * 100 : null))}${cell(n(error, 1))}</tr>`;
        }).join('');
        const source = snapshot.forecast_source;
        const page = pageRows(sortRows(rows.map((r) => ({ ...r, wmape: r.test.wmape })), 'wmape'));
        return card('Model validation', 'Up to 7 rolling one-week holdouts per SKU. Each prediction uses only weeks before the evaluated week. Scenarios are excluded from backtest.', table(['Demand model', 'WMAPE · lower is better', 'Signed bias', 'Total absolute error (units)'], modelRows))
            + card('Evidence by SKU', 'Zero actual demand has no percentage accuracy score. Established means enough observed evidence, not a promised accuracy level.', table(['Product / variant', 'Evidence', 'Active weeks / units', 'Variability (CV)', 'Trend', sortHead('WMAPE', 'wmape')], page.items.map((r) => `<tr>${cell(`${esc(r.product)}<small>${esc(r.variantTitle)} · ${esc(r.sku)}</small>`, '')}${cell(pill(r.quality, tones[r.quality]), '')}${cell(`${r.activeWeeks} / ${n(r.total)}`)}${cell(n(r.cv, 2))}${cell(r.trend === null ? 'No prior baseline' : pct(r.trend))}${cell(pct(r.test.wmape))}</tr>`).join('')) + page.footer)
            + card('Data lineage & plain-English formulas', 'Know what is observed, what is assumed, and what this model cannot tell you.', `<div class="fc-method-grid">
                <div><h4>Observed sources</h4><p>Shopify catalog stock and current selling prices. Trailing 84-day shipped/delivered order units, dated by order creation. Bundles are expanded and mapped to real variants; canceled and RTO orders are excluded from demand.</p><p>${source ? `${n(source.matched_units)} matched units · ${n(source.unmatched_units)} unmatched units · ${n(source.order_rows)} order rows. ${source.matched_units + source.unmatched_units > 0 ? pct(source.matched_units / (source.matched_units + source.unmatched_units) * 100) + ' unit attribution coverage.' : 'No source units in window.'}` : 'Attribution coverage is unavailable in this snapshot; refresh after the updated backend is running.'}</p><p>Forecast uses a fixed 84-day history, independent of the header pipeline window. Returns / exchanges use that selected pipeline window. Manual Stock Room counts are separate and not combined.</p></div>
                <div><h4>Forecast & range</h4><p>Weighted: latest 5 rolling weeks × weights 1, 1.2, 1.5, 1.8, 2.2 ÷ 7.7. Average: latest 4 weeks ÷ 4. Smoothing: each week updates the prior level with α = 0.4. Daily demand = model weekly units ÷ 7 × scenario multiplier.</p><p>Exact horizon demand = daily demand × selected days. Heuristic range = demand ± 1.28 × max(weekly standard deviation, backtest mean absolute error) × √(days ÷ 7) × scenario multiplier, lower bounded at 0. Portfolio ranges sum SKU bounds conservatively; they are not statistical confidence levels.</p></div>
                <div><h4>Stock & buying math</h4><p>Sellable now = Shopify on hand − exchange replacements. RTO / return / exchange inbound is optional, assumed saleable on the entered arrival day. Customer-bound shipments are not warehouse inbound. Each SKU consumes stock separately; unserved demand is not a backorder or a negative inventory transaction.</p><p>Buy target covers lead + review + buffer days. Suggested quantities deduct only inbound expected within lead + review. Recommendations do not simulate purchase receipts, supplier capacity, minimum order quantities, or automatically place orders.</p></div>
                <div><h4>Quality & boundaries</h4><p>WMAPE = sum absolute errors ÷ sum actual units × 100. Bias = sum(prediction − actual) ÷ sum actual × 100. Limited = fewer than 8 history buckets, 4 active weeks, or 20 total units. Variable = CV ≥ 1 or WMAPE &gt; 50%. No demand ≠ no market demand.</p><p>No stock-availability history, seasonality, ad spend, discounts, margins, confirmed supplier POs, QC results, or delivery-date demand is available. Stockouts and recent undelivered orders can suppress observed sales. Current prices give value estimates, not profit or guaranteed revenue. Master-tab velocity still uses its existing prior-five-week method; this planner includes the latest rolling week.</p></div>
            </div><p class="ict-foot-note">Current scope: ${rows.length} SKUs · error ${pct(a.wmape)} · bias ${pct(a.bias)}. Low-data items should be reviewed manually before purchasing.</p>`);
    }
    function render(inputSkus, data, redraw) {
        if (snapshot !== data || skus !== inputSkus) { snapshot = data; skus = inputSkus; analyses.clear(); plans.clear(); }
        onChange = redraw;
        const controlHtml = controls(), rows = selected(), a = E.summarize(rows);
        const sourceDate = new Date(data.generated_at);
        const ageMinutes = Math.max(0, Math.floor((Date.now() - sourceDate.getTime()) / 60000));
        const warnings = [];
        if (ageMinutes >= 60) warnings.push(`Snapshot is ${n(ageMinutes)} minutes old. Use Refresh for a newer inventory snapshot.`);
        if (data.returns_server && !data.returns_server.connected) warnings.push('Returns portal is offline: exchange reservations / inbound may be incomplete. Treat stock availability cautiously.');
        if (a.limited || a.noDemand) warnings.push(`${a.limited} limited-evidence and ${a.noDemand} no-demand SKUs in scope. Forecasts may understate true demand.`);
        if (state.includeReturns) warnings.push('Included returns are assumed saleable and on time. Validate arrival and QC before depending on them.');
        let body = '<div class="ict-empty">No SKUs match these filters. Clear filters or select another product.</div>';
        if (rows.length) {
            if (state.view === 'overview') body = overview(rows, a);
            else if (state.view === 'sku') body = skuTable(rows);
            else if (['product', 'size', 'color'].includes(state.view)) body = grouped(rows, state.view);
            else if (state.view === 'periods') body = card('Weekly demand & stock plan', 'Exact period lengths. Closing stock sums SKU balances; aggregate stock cannot cover demand in a different SKU. No modeled purchase receipts.', periodsTable(a.periods));
            else if (state.view === 'scenarios') body = scenarioView(rows);
            else if (state.view === 'segmentation') body = segmentationView(rows);
            else body = qualityView(rows, a);
        }
        return `<div class="fc-workspace"><div class="ict-page-head fc-page-head"><div><span class="fc-eyebrow">INVENTORY INTELLIGENCE / PLANNING</span><h2>Forecast, understand, act.</h2><p>Expected demand → stock exposure → buying decisions. All views use the same selected SKU scope.</p></div><button class="ict-btn-ghost" data-ict="forecast-export" ${!rows.length ? 'disabled' : ''}>Export forecast CSV ↓</button></div>
            ${controlHtml}${filters()}<div class="fc-snapshot">${n(rows.length)} / ${n(skus.length)} SKUs · ${esc(sourceDate.toLocaleString('en-IN'))} snapshot · no new API calls when changing views${state.productId !== '__all' ? ` · ${btn('drill', '__all', 'All products ←')}` : ''}</div>
            ${stats(rows, a)}${warnings.length ? `<details class="fc-warnings" open><summary>Planning cautions (${warnings.length})</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
            <nav class="fc-view-nav" aria-label="Forecast data views">${Object.entries(VIEWS).map(([key, label]) => btn('view', key, label, state.view === key)).join('')}</nav>${body}</div>`;
    }
    function exportCsv() {
        const rows = selected(), f = E.settings(state);
        const headers = ['Snapshot', 'Model', 'Scenario', 'Multiplier', 'Horizon days', 'Lead days', 'Review days', 'Buffer days', 'Include returns', 'Return ETA days', 'Product', 'Variant', 'SKU', 'Evidence', 'Action', 'Daily demand', 'Demand units', 'Range low', 'Range high', 'Sellable now', 'Assumed inbound', 'Days cover', 'First shortage day', 'Unserved units', 'Suggested buy', 'Demand selling value', 'Shortage selling value', 'Backtest WMAPE %', 'Backtest bias %'];
        const lines = [headers.map(E.csvCell).join(','), ...rows.map((r) => [snapshot.generated_at, E.MODELS[state.model], state.scenario, f.multiplier, f.horizon, f.lead, f.review, f.buffer, f.includeReturns, f.returnEta, r.product, r.variantTitle, r.sku, r.quality, r.action, r.daily, r.demand, r.low, r.high, r.available, r.inbound, r.cover, r.firstShortage, r.lost, r.recommended, r.revenue, r.riskValue, r.test.wmape, r.test.bias].map(E.csvCell).join(','))];
        const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
        const link = document.createElement('a'); link.href = url; link.download = `inventory-forecast-${state.horizon}d-${state.scenario}-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function action(name, el) {
        if (!name.startsWith('forecast-')) return false;
        clearTimeout(searchTimer);
        const key = name.slice(9), value = el.dataset.value;
        state.assumptionsOpen = document.querySelector('.fc-assumptions')?.open || false;
        if (key === 'export') { exportCsv(); return true; }
        if (key === 'clear') Object.assign(state, { q: '', risk: 'All', quality: 'All', abc: 'All', xyz: 'All', page: 0 });
        else if (key === 'page') state.page = Math.max(0, state.page + Number(value));
        else if (key === 'sort') { state.dir = state.sort === value && state.dir === 'desc' ? 'asc' : 'desc'; state.sort = value; state.page = 0; }
        else if (key === 'expand') state.expanded = state.expanded === value ? null : value;
        else if (key === 'open-sku') { state.view = 'sku'; state.expanded = value; const index = sortRows(selected()).findIndex((r) => r.variantId === value); state.page = Math.max(0, Math.floor(index / 25)); }
        else if (key === 'segment') { state.abc = value[0]; state.xyz = value[1]; state.view = 'sku'; state.page = 0; }
        else if (key === 'drill') { state.productId = value; state.view = value === '__all' ? 'product' : 'sku'; state.page = 0; }
        else if (['view', 'scenario', 'model', 'metric', 'horizon'].includes(key)) { state[key] = key === 'horizon' ? Number(value) : value; state.page = 0; }
        else return false;
        remember(); onChange?.(); return true;
    }
    function input(key, el, eventType) {
        if (!key.startsWith('forecast-')) return false;
        key = key.slice(9);
        if (key === 'q') {
            state.q = el.value; state.page = 0; clearTimeout(searchTimer);
            if (eventType === 'input') searchTimer = setTimeout(() => {
                const start = el.selectionStart, end = el.selectionEnd;
                onChange?.(); const next = document.getElementById('fcSearch');
                if (next) { next.focus(); if (start !== null) next.setSelectionRange(start, end); }
            }, 150);
            return true;
        }
        if (eventType !== 'change') return true;
        clearTimeout(searchTimer);
        state.assumptionsOpen = document.querySelector('.fc-assumptions')?.open || false;
        if (['lead', 'review', 'buffer', 'returnEta', 'multiplier'].includes(key)) { state[key] = el.value === '' ? defaults[key] : Number(el.value); Object.assign(state, E.settings(state)); }
        else if (key === 'includeReturns') state.includeReturns = el.value === 'true';
        else if (['productId', 'model', 'scenario', 'risk', 'quality', 'abc', 'xyz'].includes(key)) state[key] = el.value;
        else return false;
        state.page = 0; remember(); onChange?.(); return true;
    }
    window.ForecastWorkspace = { render, action, input };
})();