/* Dependency-free forecast planning math, shared by the browser and Node tests. */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ShoppersForecast = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
    const positive = (v) => Math.max(0, finite(v));
    const sum = (a) => a.reduce((s, n) => s + n, 0);
    const MODELS = {
        weighted: 'Recent weighted demand',
        average: '4-week average',
        smoothing: 'Exponential smoothing',
    };
    const SCENARIOS = { Base: 1, Upside: 1.25, Downside: 0.78, Campaign: 1.3 };
    function predict(history, model = 'weighted') {
        if (!history.length) return 0;
        const clean = history.map(positive);
        if (model === 'average') {
            const recent = clean.slice(-4);
            return sum(recent) / recent.length;
        }
        if (model === 'smoothing') {
            return clean.slice(1).reduce((level, value) => 0.4 * value + 0.6 * level, clean[0]);
        }
        const recent = clean.slice(-5);
        const weights = [1, 1.2, 1.5, 1.8, 2.2].slice(-recent.length);
        return recent.reduce((s, value, i) => s + value * weights[i], 0) / sum(weights);
    }
    function backtest(history, model) {
        let absoluteError = 0, signedError = 0, actual = 0, predicted = 0, count = 0;
        for (let i = 5; i < history.length; i++) {
            const estimate = predict(history.slice(0, i), model);
            absoluteError += Math.abs(estimate - history[i]);
            signedError += estimate - history[i];
            predicted += estimate;
            actual += history[i];
            count++;
        }
        return { absoluteError, signedError, actual, predicted, count,
            mae: count ? absoluteError / count : null,
            wmape: actual > 0 ? absoluteError / actual * 100 : null,
            bias: actual > 0 ? signedError / actual * 100 : null };
    }
    function analyze(sku, model) {
        const history = Array.isArray(sku.weeklySales) ? sku.weeklySales.slice(-12).map(positive) : [];
        const total = sum(history), activeWeeks = history.filter((n) => n > 0).length;
        const mean = history.length ? total / history.length : 0;
        const sigma = history.length ? Math.sqrt(sum(history.map((v) => (v - mean) ** 2)) / history.length) : 0;
        const cv = mean ? sigma / mean : 0;
        const test = backtest(history, model);
        const weekly = predict(history, model);
        const previous = sum(history.slice(-8, -4)) / Math.max(1, history.slice(-8, -4).length);
        const recent = sum(history.slice(-4)) / Math.max(1, history.slice(-4).length);
        const trend = previous > 0 ? (recent - previous) / previous * 100 : null;
        const quality = total === 0 ? 'No demand' : history.length < 8 || activeWeeks < 4 || total < 20
            ? 'Limited' : cv >= 1 || (test.wmape !== null && test.wmape > 50) ? 'Variable' : 'Established';
        return { ...sku, history, weekly, daily: weekly / 7, total, activeWeeks, cv, trend, test, quality,
            spread: total ? Math.max(test.mae || 0, sigma) : 0 };
    }
    function settings(input = {}) {
        const limit = (v, def, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : def));
        return {
            horizon: Math.round(limit(input.horizon, 30, 1, 90)),
            model: MODELS[input.model] ? input.model : 'weighted',
            multiplier: input.scenario === 'Custom' ? limit(input.multiplier, 1, 0.1, 4) : (SCENARIOS[input.scenario] || 1),
            lead: Math.round(limit(input.lead, 25, 1, 120)),
            review: Math.round(limit(input.review, 30, 1, 90)),
            buffer: Math.round(limit(input.buffer, 7, 0, 30)),
            includeReturns: input.includeReturns === true,
            returnEta: Math.round(limit(input.returnEta, 7, 1, 90)),
        };
    }
    function plan(record, input) {
        const f = settings(input), daily = record.daily * f.multiplier;
        // Shopify stock already reflects customer shipments. Do NOT add in_circulation
        // as replenishment, or subtract it again. Exchange replacements remain reserved.
        const available = finite(record.currentStock) - positive(record.exchangeOutgoing);
        const inbound = f.includeReturns ? positive(record.rtoIncoming) + positive(record.returnIncoming) + positive(record.exchangeIncoming) : 0;
        const eligibleInbound = f.returnEta <= f.lead + f.review ? inbound : 0;
        const demand = daily * f.horizon;
        const spread = record.spread * 1.28 * Math.sqrt(f.horizon / 7) * f.multiplier;
        const low = Math.max(0, demand - spread), high = demand + spread;
        const safety = daily * f.buffer;
        const reorderPoint = daily * f.lead + safety;
        const recommended = daily > 0 ? Math.max(0, Math.ceil(daily * (f.lead + f.review) + safety - available - eligibleInbound)) : 0;
        let balance = available, lost = 0, firstShortage = null;
        const periods = [];
        for (let day = 1; day <= f.horizon; day++) {
            const opening = balance;
            const arriving = day === f.returnEta ? inbound : 0;
            balance += arriving;
            const served = Math.min(daily, Math.max(0, balance));
            const short = daily - served;
            if (short > 1e-9 && firstShortage === null) firstShortage = day;
            lost += short;
            balance -= served;
            if (day % 7 === 1) periods.push({ start: day, end: day, days: 0, opening, inbound: 0, demand: 0, short: 0, closing: 0 });
            const p = periods[periods.length - 1];
            p.end = day; p.days++; p.inbound += arriving; p.demand += daily; p.short += short; p.closing = balance;
        }
        const cover = daily > 0 ? Math.max(0, available) / daily : null;
        const orderIn = cover === null ? null : Math.floor(cover - f.lead - f.buffer);
        const action = daily === 0 ? 'Validate demand' : firstShortage !== null && firstShortage <= f.lead
            ? 'Expedite' : available + (f.returnEta <= f.lead ? inbound : 0) <= reorderPoint
                ? 'Reorder now' : recommended > 0 ? 'Plan buy' : 'Covered';
        return { ...record, available, inbound, daily, demand, low, high, safety, reorderPoint, recommended,
            closing: balance, lost, firstShortage, cover, orderIn, action, periods,
            revenue: demand * positive(record.price), riskValue: lost * positive(record.price) };
    }
    function summarize(rows) {
        const result = { demand: 0, low: 0, high: 0, available: 0, inbound: 0, recommended: 0, revenue: 0, riskValue: 0,
            lost: 0, riskSkus: 0, limited: 0, noDemand: 0, actual: 0, absoluteError: 0, signedError: 0, periods: [], history: [] };
        for (const row of rows) {
            for (const key of ['demand', 'low', 'high', 'available', 'inbound', 'recommended', 'revenue', 'riskValue', 'lost']) result[key] += row[key];
            result.riskSkus += row.firstShortage !== null ? 1 : 0;
            result.limited += row.quality === 'Limited' ? 1 : 0;
            result.noDemand += row.quality === 'No demand' ? 1 : 0;
            result.actual += row.test.actual;
            result.absoluteError += row.test.absoluteError;
            result.signedError += row.test.signedError;
            row.history.forEach((v, i) => { result.history[i] = (result.history[i] || 0) + v; });
            row.periods.forEach((p, i) => {
                if (!result.periods[i]) result.periods[i] = { start: p.start, end: p.end, days: p.days, opening: 0, inbound: 0, demand: 0, short: 0, closing: 0 };
                for (const key of ['opening', 'inbound', 'demand', 'short', 'closing']) result.periods[i][key] += p[key];
            });
        }
        result.wmape = result.actual > 0 ? result.absoluteError / result.actual * 100 : null;
        result.bias = result.actual > 0 ? result.signedError / result.actual * 100 : null;
        return result;
    }
    function group(rows, by) {
        const groups = new Map();
        for (const row of rows) {
            const key = by === 'product' ? row.productId : by === 'size' ? (row.size || 'Unspecified') : (row.color || 'Unspecified');
            if (!groups.has(key)) groups.set(key, { key, label: by === 'product' ? row.product : key, members: [] });
            groups.get(key).members.push(row);
        }
        return [...groups.values()].map((g) => ({ ...g, ...summarize(g.members), count: g.members.length }));
    }
    function csvCell(value) {
        let text = String(value ?? '');
        // Prevent spreadsheet formula injection in user-controlled catalog text.
        if (/^[\s]*[=+@-]/.test(text) && typeof value !== 'number') text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return { MODELS, SCENARIOS, predict, backtest, analyze, settings, plan, summarize, group, csvCell };
});