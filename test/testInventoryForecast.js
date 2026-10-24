'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const assets = path.join(__dirname, '../public/shoppers/assets');
const E = require(path.join(assets, 'shoppers-forecast-engine.js'));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≠ ${expected}`);
function sku(overrides = {}) {
    return { variantId: 'p:v', productId: 'p', product: 'Henley ( Black )', variantTitle: 'S', sku: 'HENLEY-S', color: 'Black', size: 'S', abc: 'A', xyz: 'X', price: 100, currentStock: 100, exchangeOutgoing: 0, rtoIncoming: 0, returnIncoming: 0, exchangeIncoming: 0, inTransit: 0, weeklySales: Array(12).fill(70), ...overrides };
}
function plan(overrides = {}, settings = {}) { return E.plan(E.analyze(sku(overrides), settings.model || 'weighted'), settings); }

test('all models preserve constant weekly demand and use latest observations', () => {
    for (const model of Object.keys(E.MODELS)) close(E.predict(Array(12).fill(70), model), 70);
    assert.ok(E.predict([...Array(11).fill(0), 70]) > 0);
    close(E.predict([10]), 10);
    close(E.predict([]), 0);
    assert.ok(Number.isFinite(E.predict([NaN, 'bad', -9, 4])));
});
test('30-day demand uses exactly 30 days, not 5 whole weeks', () => {
    const r = plan();
    close(r.demand, 300);
    assert.deepEqual(r.periods.map((p) => p.days), [7, 7, 7, 7, 2]);
    close(r.periods.reduce((s, p) => s + p.demand, 0), r.demand);
    close(r.lost, 200);
    assert.equal(r.firstShortage, 11);
});
test('every supported horizon reconciles demand and daily stock', () => {
    for (const horizon of [7, 14, 30, 60, 90]) {
        const r = plan({}, { horizon });
        close(r.demand, horizon * 10);
        close(r.periods.reduce((s, p) => s + p.days, 0), horizon);
        close(r.lost, Math.max(0, horizon * 10 - 100));
    }
});
test('outbound shipments are neither inbound nor subtracted a second time', () => {
    const r = plan({ inTransit: 500, reserved: 500, incomingQty: 500, finalAvailable: 999 });
    close(r.available, 100); close(r.inbound, 0); close(r.demand, 300);
});
test('exchange reservations reduce sellable stock; inbound is opt-in', () => {
    const r = plan({ exchangeOutgoing: 20, rtoIncoming: 50, returnIncoming: 40, exchangeIncoming: 10 });
    close(r.available, 80); close(r.inbound, 0); close(r.lost, 220);
    const optimistic = plan({ exchangeOutgoing: 20, rtoIncoming: 50, returnIncoming: 40, exchangeIncoming: 10 }, { includeReturns: true, returnEta: 7 });
    close(optimistic.inbound, 100); close(optimistic.lost, 120);
    close(optimistic.periods[0].inbound, 100);
});
test('late inbound cannot retroactively cover earlier lost demand', () => {
    const r = plan({ currentStock: 0, returnIncoming: 100 }, { horizon: 14, includeReturns: true, returnEta: 10 });
    close(r.lost, 90); close(r.closing, 50); assert.equal(r.firstShortage, 1);
    const late = plan({ currentStock: 0, returnIncoming: 1000 }, { includeReturns: true, returnEta: 90, lead: 25, review: 30, buffer: 7 });
    close(late.recommended, 620);
});
test('zero-demand items do not invent demand, accuracy, or buys', () => {
    const r = plan({ weeklySales: Array(12).fill(0), currentStock: -4 });
    assert.equal(r.quality, 'No demand'); assert.equal(r.test.wmape, null);
    assert.equal(r.cover, null); assert.equal(r.firstShortage, null);
    close(r.demand, 0); close(r.low, 0); close(r.high, 0); close(r.recommended, 0);
});
test('limited histories and intermittent demand are labeled honestly', () => {
    assert.equal(E.analyze(sku({ weeklySales: [10, 0, 5] }), 'weighted').quality, 'Limited');
    assert.equal(E.analyze(sku({ weeklySales: Array(12).fill(70) }), 'weighted').quality, 'Established');
    assert.equal(E.analyze(sku({ weeklySales: [0, 0, 0, 150, 0, 0, 150, 0, 0, 150, 0, 150] }), 'weighted').quality, 'Variable');
});
test('rolling backtest has no look-ahead leakage and bias uses signed error', () => {
    const history = [...Array(11).fill(70), 700];
    const b = E.backtest(history, 'weighted');
    close(b.absoluteError, 630); close(b.signedError, -630); assert.equal(b.count, 7);
    close(E.backtest(Array(12).fill(70), 'average').wmape, 0);
});
test('scenario, buffers, and replenishment targets reconcile', () => {
    close(plan({}, { scenario: 'Upside' }).demand, 375);
    close(plan({}, { scenario: 'Custom', multiplier: 2 }).demand, 600);
    close(plan({}, { lead: 25, review: 30, buffer: 7 }).recommended, 520);
    close(plan({}, { lead: 25, review: 30, buffer: 0 }).recommended, 450);
    close(plan({}, { scenario: 'Downside' }).demand, 234);
});
test('SKU-level shortages are not hidden by stock in another variant', () => {
    const a = plan({ variantId: 'a', currentStock: 0 });
    const b = plan({ variantId: 'b', currentStock: 10000 });
    const total = E.summarize([a, b]);
    close(total.demand, 600); close(total.lost, 300); assert.equal(total.riskSkus, 1);
    close(E.group([a, b], 'size')[0].lost, 300);
    close(total.periods.reduce((s, p) => s + p.short, 0), total.lost);
});
test('range ordering, safety limits, and CSV formula escaping', () => {
    const r = plan({ weeklySales: [1, 3, 90, 4, 20, 0, 10, 50, 0, 0, 90, 10] });
    assert.ok(r.low >= 0 && r.low <= r.demand && r.demand <= r.high);
    assert.equal(E.settings({ horizon: 500, buffer: -50, lead: NaN }).horizon, 90);
    assert.equal(E.settings({ buffer: -50 }).buffer, 0);
    assert.equal(E.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(E.csvCell(-12), '"-12"');
});
function harness(saved = null) {
    const elements = new Map(), listeners = {}, storage = new Map(saved ? [['offcomfrt.forecast.preferences.v1', JSON.stringify(saved)]] : []);
    let calls = 0, downloads = [];
    const document = {
        getElementById: (id) => elements.get(id) || null,
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: (key, listener) => { (listeners[key] ||= []).push(listener); },
        body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }),
    };
    const context = vm.createContext({ window: {}, document, console, setTimeout, clearTimeout, Blob,
        URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
        localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
        apiCall: async () => { calls++; return payload; } });
    const payload = { generated_at: new Date().toISOString(), window_days: 90, products: [{ id: 'p', title: 'Henley ( Black )', variants: [{ id: 's', title: 'S', sku: 'S', on_hand: 100, price: 100, weekly_sales: Array(12).fill(70), velocity: 10, days_of_cover: 10, xyz: 'X', abc: 'A', sales30: 300, sales7: 70, delivered: 1, replenishment: {} }] }], summary: { counts: {} }, returns_server: { connected: true } };
    for (const file of ['shoppers-forecast-engine.js', 'shoppers-forecast-workspace.js', 'shoppers-inventory-tower.js']) vm.runInContext(fs.readFileSync(path.join(assets, file), 'utf8'), context, { filename: file });
    const ws = context.window.ForecastWorkspace;
    const render = (rows = [sku()], data = payload) => ws.render(rows, data, () => {});
    const action = (key, value) => ws.action('forecast-' + key, { dataset: { value } });
    const input = (key, value) => ws.input('forecast-' + key, { value }, 'change');
    return { context, ws, render, action, input, elements, listeners, payload, downloads, calls: () => calls };
}
test('all nine workspace views render with escaped catalog text', () => {
    const h = harness(), rows = [sku({ product: '<script>alert(1)</script>' })];
    for (const view of ['overview', 'sku', 'product', 'size', 'color', 'periods', 'scenarios', 'segmentation', 'quality']) {
        h.action('view', view);
        const html = h.render(rows);
        assert.ok(html.includes('fc-workspace'), view);
        assert.ok(!html.includes('<script>alert(1)</script>'), view);
        assert.ok(!html.includes('NaN'), view);
    }
    assert.equal(h.calls(), 0);
});
test('pagination, drilldown, search, scenario changes and CSV stay offline', () => {
    const h = harness();
    const rows = Array.from({ length: 60 }, (_, i) => sku({ variantId: String(i), sku: `SKU-${i}` }));
    h.action('view', 'sku');
    let html = h.render(rows);
    assert.equal((html.match(/data-ict="forecast-expand"/g) || []).length, 25);
    h.action('page', '1'); html = h.render(rows); assert.ok(html.includes('page 2 / 3'));
    h.input('q', 'SKU-59'); html = h.render(rows); assert.ok(html.includes('1 / 60 SKUs'));
    h.action('clear'); h.action('scenario', 'Upside'); h.action('expand', '0');
    html = h.render(rows); assert.ok(html.includes('All 12 historical weeks'));
    h.action('export'); assert.equal(h.downloads.length, 1); assert.equal(h.calls(), 0);
});
test('invalid saved preferences are clamped and empty snapshots render safely', () => {
    const h = harness({ model: 'malicious', horizon: 9000, scenario: 'invalid', view: 'invalid', lead: -9 });
    const html = h.render([], { generated_at: new Date().toISOString(), products: [] });
    assert.ok(html.includes('No SKUs match')); assert.ok(html.includes('90D')); assert.ok(!html.includes('NaN'));
});
test('changing views reuses math; snapshot identity invalidates cached analyses', () => {
    const h = harness(), engine = h.context.window.ShoppersForecast;
    let count = 0, planCount = 0;
    const original = engine.analyze, originalPlan = engine.plan;
    engine.analyze = (...args) => { count++; return original(...args); };
    engine.plan = (...args) => { planCount++; return originalPlan(...args); };
    const rows = [sku()]; h.render(rows); h.action('view', 'sku'); h.render(rows);
    assert.equal(count, 1); assert.equal(planCount, 1);
    h.render(rows, { ...h.payload }); assert.equal(count, 2); assert.equal(planCount, 2);
});
test('tower integration maps size-only options and fetches once across interactions', async () => {
    const h = harness();
    h.elements.set('ictMain', { innerHTML: '' }); h.elements.set('inventoryView', { style: {} });
    h.context.window.InventoryTower.open();
    await new Promise((resolve) => setImmediate(resolve));
    const handler = h.listeners.click[0];
    handler({ target: { closest: (selector) => selector === '#ictTabs .ict-tab' ? { dataset: { tab: 'forecast' } } : null } });
    assert.ok(h.elements.get('ictMain').innerHTML.includes('Forecast, understand, act.'));
    const click = (action, value) => handler({ target: { closest: (selector) => selector === '[data-ict]' ? { dataset: { ict: 'forecast-' + action, value } } : null } });
    click('view', 'size'); assert.ok(h.elements.get('ictMain').innerHTML.includes('<td class="">S</td>'));
    click('view', 'color'); assert.ok(h.elements.get('ictMain').innerHTML.includes('<td class="">Black</td>'));
    click('view', 'scenarios'); click('scenario', 'Upside'); click('horizon', '90');
    assert.equal(h.calls(), 1);
});
test('segmentation drilldown shares filters and clearing restores all SKUs', () => {
    const h = harness(), rows = [sku(), sku({ variantId: 'b', abc: 'C', xyz: 'Z' })];
    h.render(rows); h.action('view', 'segmentation');
    assert.ok(h.render(rows).includes('forecast-segment'));
    h.action('segment', 'AX'); assert.ok(h.render(rows).includes('1 / 2 SKUs'));
    h.action('clear'); assert.ok(h.render(rows).includes('2 / 2 SKUs'));
});
test('asset load order, scoped styles, and source contract are connected', () => {
    const html = fs.readFileSync(path.join(assets, '../index.html'), 'utf8');
    const order = ['shoppers-forecast-engine.js', 'shoppers-forecast-workspace.js', 'shoppers-inventory-tower.js'].map((file) => html.indexOf(file));
    assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2]);
    const css = fs.readFileSync(path.join(assets, 'shoppers-hub.css'), 'utf8');
    for (const cls of ['fc-workspace', 'fc-control-grid', 'fc-filter-grid', 'fc-view-nav', 'fc-method-grid', 'fc-segment', 'fc-detail', 'fc-stats']) assert.ok(css.includes('.' + cls), cls);
    const newCss = css.slice(css.indexOf('/* Forecast workspace'));
    assert.equal((newCss.match(/\{/g) || []).length, (newCss.match(/\}/g) || []).length);
    assert.ok(newCss.includes('max-width: 700px') && newCss.includes('overflow-x: auto'));
    const backend = fs.readFileSync(path.join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
    assert.ok(backend.includes('forecast_source: { ...forecastSource'));
    assert.ok(backend.includes('forecastSource.unmatched_units += qty'));
});
test('stock conservation and scenario monotonicity over varied inputs', () => {
    for (let i = 0; i < 50; i++) {
        const stock = i * 7, inbound = i * 3, horizon = (i % 90) + 1;
        const r = plan({ currentStock: stock, returnIncoming: inbound }, { horizon, includeReturns: true, returnEta: 3 });
        const arriving = horizon >= 3 ? inbound : 0;
        close(r.closing, stock + arriving - (r.demand - r.lost));
        assert.ok(r.lost >= -1e-8 && r.lost <= r.demand + 1e-8);
        assert.ok(plan({ currentStock: stock }, { scenario: 'Upside' }).lost >= plan({ currentStock: stock }, { scenario: 'Downside' }).lost);
    }
});
test('bounded synthetic benchmark: 1,000 SKUs × 90 days and cached view switches', () => {
    const h = harness(), rows = Array.from({ length: 1000 }, (_, i) => sku({ variantId: String(i), currentStock: i, productId: String(i % 50) }));
    h.action('horizon', '90');
    const start = performance.now(); h.render(rows); const cold = performance.now() - start;
    const warmStart = performance.now();
    for (let i = 0; i < 10; i++) { h.action('view', i % 2 ? 'sku' : 'product'); h.render(rows); }
    const warm = (performance.now() - warmStart) / 10;
    console.log(`Forecast synthetic benchmark: 1000 SKUs / 90d: cold ${cold.toFixed(1)}ms; cached views ${warm.toFixed(1)}ms average`);
    assert.ok(cold < 5000 && warm < 1000, 'unexpected algorithmic slowdown');
});
