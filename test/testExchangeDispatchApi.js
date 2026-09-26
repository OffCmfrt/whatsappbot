// Run: node --test test/testExchangeDispatchApi.js
// Test the actual route handlers using stubbed responses, DNS, and HTTPS. No server or database is started.
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const dns = require('node:dns').promises;
const https = require('node:https');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const api = require('../../exchange-return-tracking-main/config/exchange-dispatches');
const auth = require('../src/middleware/auth');
function response() {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: {}, writableEnded: false,
        status(code) { this.statusCode = code; return this; },
        set(headers) { Object.assign(this.headers, headers); return this; },
        json(body) { this.body = body; this.writableEnded = true; return this; },
        send(body) { this.body = body; this.writableEnded = true; return this; }
    });
    return res;
}
function router() {
    return { routes: [], get(url, ...handlers) { this.routes.push({ method: 'GET', url, handlers }); }, post(url, ...handlers) { this.routes.push({ method: 'POST', url, handlers }); } };
}
async function invoke(route, req = {}) {
    const res = response();
    Object.assign(req, { headers: req.headers || {}, query: req.query || {}, params: req.params || {}, body: req.body || {} });
    for (const handler of route.handlers) {
        let next = false; await handler(req, res, () => { next = true; }); if (!next) break;
    }
    return res;
}
const requestRow = (n = 1, extra = {}) => ({ request_id: `EX-${String(n).padStart(4, '0')}`, type: 'exchange', status: 'received', forward_status: 'scheduled', forward_carrier: 'delhivery', forward_shipment_id: `shipment-${n}`, forward_awb_number: `FORWARD-${n}`, items: [], ...extra });
function supabase(rows) {
    return { from(table) {
        assert.equal(table, 'requests'); let selected = rows.slice(), limit = Infinity, single = false;
        const q = { select() { return q; }, or(value) { assert.equal(value, 'type.eq.exchange,resolution.eq.exchange'); selected = selected.filter(r => r.type === 'exchange' || r.resolution === 'exchange'); return q; }, order() { selected.sort((a, b) => a.request_id.localeCompare(b.request_id)); return q; }, limit(n) { limit = n; return q; }, gt(key, value) { selected = selected.filter(r => r[key] > value); return q; }, in(key, values) { selected = selected.filter(r => values.includes(r[key])); return q; }, eq(key, value) { selected = selected.filter(r => r[key] === value); return q; }, maybeSingle() { single = true; return q; }, then(resolve) { return Promise.resolve({ data: single ? selected[0] || null : selected.slice(0, limit), error: null }).then(resolve); } };
        return q;
    } };
}
function mount(rows) { const r = router(); api.mount(r, { supabase: supabase(rows), getEkartToken: async () => 'ekart-test', getShiprocketToken: async () => 'sr-test' }); return r.routes; }
function mockCarrier(t, handler, address = '8.8.8.8') {
    t.mock.method(dns, 'lookup', async () => [{ address, family: 4 }]);
    t.mock.method(https, 'request', (url, config, callback) => {
        const req = new EventEmitter(); let body = '';
        req.setTimeout = () => req;
        req.write = bytes => { body += bytes; };
        req.destroy = err => { queueMicrotask(() => req.emit('error', err)); return req; };
        req.end = () => queueMicrotask(() => {
            try {
                config.lookup(url.hostname, { all: true }, (err, addresses) => { assert.ifError(err); assert.equal(addresses[0].address, address); });
                const value = handler(url, config, body);
                const res = Readable.from([value.bytes || Buffer.from('%PDF-1.7 test')]);
                res.statusCode = value.status || 200; res.headers = value.headers || {}; callback(res);
            } catch (err) { req.emit('error', err); }
        });
        return req;
    });
}
beforeEach(() => {
    process.env.WHATSAPP_INTERNAL_TOKEN = 'test-internal'; process.env.DELHIVERY_API_KEY = 'delhivery-test';
    delete process.env.EKART_BASE_URL;
});

test('all internal endpoints fail closed without a token and reject invalid credentials', async () => {
    const routes = mount([]); assert.equal(routes.length, 3);
    for (const route of routes) {
        assert.equal((await invoke(route)).statusCode, 401);
        assert.equal((await invoke(route, { headers: { 'x-internal-token': 'wrong' } })).statusCode, 401);
        delete process.env.WHATSAPP_INTERNAL_TOKEN;
        assert.equal((await invoke(route)).statusCode, 503);
        process.env.WHATSAPP_INTERNAL_TOKEN = 'test-internal';
    }
});

test('source listing includes completed exchanges and returns resolved as exchanges, with reliable cursors', async () => {
    const rows = Array.from({ length: 103 }, (_, i) => requestRow(i));
    rows[1].type = 'return'; rows[1].resolution = 'exchange'; rows[1].status = 'completed';
    rows[2].type = 'return'; rows[2].resolution = 'refund';
    const [route] = mount(rows); const headers = { 'x-internal-token': 'test-internal' };
    const first = await invoke(route, { headers }); assert.equal(first.body.dispatches.length, 100);
    assert.ok(first.body.dispatches.some(r => r.request_id === rows[1].request_id));
    assert.ok(!first.body.dispatches.some(r => r.request_id === rows[2].request_id));
    const second = await invoke(route, { headers, query: { cursor: first.body.next_cursor } });
    assert.equal(second.body.dispatches.length, 2); assert.equal(second.body.next_cursor, null);
    assert.equal((await invoke(route, { headers, query: { cursor: ['invalid'] } })).statusCode, 400);
});

test('lookup exposes cleared references and label route refuses stale identities', async () => {
    const old = requestRow(); const cleared = { ...old, forward_shipment_id: null, forward_awb_number: null };
    const routes = mount([cleared]); const headers = { 'x-internal-token': 'test-internal' };
    const result = await invoke(routes[1], { headers, body: { requestIds: [old.request_id] } });
    assert.equal(result.body.dispatches[0].booked, false);
    assert.equal((await invoke(routes[1], { headers, body: { requestIds: [null] } })).statusCode, 400);
    const label = await invoke(routes[2], { headers, params: { requestId: old.request_id }, query: { identity: api.normalizeRequest(old).identity } });
    assert.equal(label.statusCode, 409);
});

test('Delhivery requests forward thermal packing slips and follows JSON PDF links without credentials', async t => {
    const seen = [];
    mockCarrier(t, (url, config) => {
        seen.push(url.href);
        if (seen.length === 1) {
            assert.equal(url.searchParams.get('wbns'), 'FORWARD-1'); assert.equal(url.searchParams.get('pdf_size'), '4R');
            assert.equal(config.headers.Authorization, 'Token delhivery-test');
            return { bytes: Buffer.from(JSON.stringify({ packages: [{ wbn: 'FORWARD-1', pdf_download_link: 'https://labels.s3.amazonaws.com/label.pdf' }] })) };
        }
        assert.equal(config.headers.Authorization, undefined); return {};
    });
    const bytes = await api.retrieveLabel(api.normalizeRequest(requestRow()), {});
    assert.ok(bytes.includes(Buffer.from('%PDF-'))); assert.equal(seen.length, 2);
});

test('Ekart uses binary forward-AWB labels and Shiprocket uses the canonical forward shipment ID', async t => {
    let carrier = 'ekart';
    mockCarrier(t, (url, config, body) => {
        if (carrier === 'ekart') {
            assert.equal(url.pathname, '/api/v1/package/label'); assert.equal(url.searchParams.get('json_only'), 'false');
            assert.equal(config.headers.Authorization, 'Bearer ekart-test'); assert.deepEqual(JSON.parse(body), { ids: ['FORWARD-1'] }); return {};
        }
        if (url.pathname.includes('generate/label')) {
            assert.deepEqual(JSON.parse(body), { shipment_id: [12345] }); assert.equal(config.headers.Authorization, 'Bearer sr-test');
            return { bytes: Buffer.from(JSON.stringify({ label_url: 'https://labels.s3.amazonaws.com/forward.pdf' })) };
        }
        assert.equal(config.headers.Authorization, undefined); return {};
    });
    const tokens = { getEkartToken: async () => 'ekart-test', getShiprocketToken: async () => 'sr-test' };
    await api.retrieveLabel(api.normalizeRequest(requestRow(1, { forward_carrier: carrier })), tokens);
    carrier = 'shiprocket';
    await api.retrieveLabel(api.normalizeRequest(requestRow(1, { forward_carrier: carrier, forward_shipment_id: '12345' })), tokens);
});

test('carrier redirects drop authorization across origins and reject untrusted destinations', async t => {
    let count = 0;
    mockCarrier(t, (_url, config) => ++count === 1 ? { status: 302, headers: { location: 'https://labels.s3.amazonaws.com/test.pdf' } } : (assert.equal(config.headers.Authorization, undefined), {}));
    await api.carrierRequest('https://track.delhivery.com/label', { headers: { Authorization: 'carrier-only' } });
    assert.equal(count, 2);
    for (const url of ['http://track.delhivery.com/x', 'https://track.delhivery.com.evil.test/x', 'https://user:pass@track.delhivery.com/x', 'https://track.delhivery.com:8443/x', 'https://127.0.0.1/x']) await assert.rejects(api.carrierRequest(url), /Untrusted/);
});

test('private DNS, oversized responses, expired URLs, and redirect loops fail safely', async t => {
    mockCarrier(t, () => { throw new Error('Must not connect to private DNS'); }, '127.0.0.1');
    await assert.rejects(api.carrierRequest('https://track.delhivery.com/label'), /Unsafe/);
    t.mock.restoreAll();
    let mode = 'expired';
    mockCarrier(t, () => mode === 'expired' ? { status: 403 } : mode === 'large' ? { bytes: Buffer.alloc(10 * 1024 * 1024 + 1) } : { status: 302, headers: { location: '/loop' } });
    await assert.rejects(api.carrierRequest('https://track.delhivery.com/label'), /403/);
    mode = 'large'; await assert.rejects(api.carrierRequest('https://track.delhivery.com/label'), e => e.status === 413);
    mode = 'loop'; await assert.rejects(api.carrierRequest('https://track.delhivery.com/label'), /redirect limit/);
    for (const ip of ['::1', '::ffff:127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.0.1', 'fc00::1']) assert.equal(api.publicAddress(ip), false);
});

test('label endpoint returns only PDF bytes with no caching or signed URLs', async t => {
    const pdf = await PDFDocument.create(); pdf.addPage([288, 432]).drawText('Fixture'); const bytes = Buffer.from(await pdf.save());
    mockCarrier(t, () => ({ bytes }));
    const row = requestRow(); const routes = mount([row]);
    const res = await invoke(routes[2], { headers: { 'x-internal-token': 'test-internal' }, params: { requestId: row.request_id }, query: { identity: api.normalizeRequest(row).identity } });
    assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'no-store'); assert.equal(res.headers['Content-Type'], 'application/pdf'); assert.deepEqual(res.body, bytes);
});

function hubRoutes(overrides = {}, timers = {}) {
    // Execute the actual isolated route-registration block, without importing unrelated startup services.
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/adminRoutes.js'), 'utf8');
    const block = source.slice(source.indexOf('// Exchange dispatches are'), source.indexOf('// Get dashboard statistics'));
    const r = router(); const calls = [];
    const service = Object.fromEntries(['list', 'detail', 'sync', 'mutate', 'download', 'manifest'].map(name => [name, async () => { calls.push(name); return name === 'download' || name === 'manifest' ? { pdfBuffer: Buffer.from('test'), fileName: 'test.pdf', contentType: 'application/pdf', labelCount: 1 } : {}; }]));
    vm.runInNewContext(block, { router: r, require: () => ({ ...service, ...overrides }), requirePermission: auth.requirePermission, logOperatorActivity: () => {}, AbortController, setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout });
    return { routes: r.routes, calls };
}
test('every Hub route requires shipped; mutations and downloads also require ship_orders', async () => {
    for (const permissions of [[], ['ship_orders'], ['shipped'], ['shipped', 'ship_orders']]) {
        const { routes, calls } = hubRoutes();
        for (const route of routes) {
            const res = await invoke(route, { admin: { role: 'operator', permissions, username: 'test' } });
            const allowed = permissions.includes('shipped') && (route.method === 'GET' || permissions.includes('ship_orders'));
            assert.equal(res.statusCode, allowed ? 200 : 403);
        }
        assert.equal(calls.length, permissions.length === 2 ? 6 : permissions[0] === 'shipped' ? 2 : 0);
    }
    for (const route of hubRoutes().routes) assert.equal((await invoke(route, { admin: { role: 'admin' } })).statusCode, 200);
});

test('download deadline responds instead of leaving a timed-out request open', async () => {
    let expire;
    const { routes } = hubRoutes({ download: async () => { expire(); return { pdfBuffer: Buffer.from('late') }; } }, { setTimeout: fn => { expire = fn; return 1; }, clearTimeout: () => {} });
    const res = await invoke(routes.find(r => r.url.endsWith('/labels/download')), { admin: { role: 'admin' } });
    assert.equal(res.statusCode, 504); assert.equal(res.writableEnded, true);
});

test('source label route honors cancellation even if token retrieval finishes late', async t => {
    let calls = 0;
    mockCarrier(t, () => { calls++; return {}; });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.retrieveLabel(api.normalizeRequest(requestRow()), {}, controller.signal));
    assert.equal(calls, 0);
});
