// Isolated performance regressions. Never load .env, start the server, or use live APIs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadModule(relative, stubs = {}, globals = {}, extra = '') {
    const filename = path.resolve(__dirname, '..', relative);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const context = vm.createContext({
        module, exports: module.exports,
        require: name => {
            if (Object.hasOwn(stubs, name)) return stubs[name];
            // Only explicitly permitted dependencies may be loaded by isolated tests.
            if (name.startsWith('node:') || ['crypto', 'jsonwebtoken'].includes(name)) return localRequire(name);
            throw new Error(`Unstubbed dependency: ${name}`);
        },
        console: { log() {}, warn() {}, error() {} },
        process: { env: {}, memoryUsage: () => ({ heapUsed: 0 }) },
        Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
        ...globals
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8') + extra, context, { filename });
    return module.exports;
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const freshCache = globals => loadModule('src/utils/cache.js', {}, globals);

test('20 simultaneous cold reads share one execution, retaining namespace isolation', async () => {
    const { cachedQuery } = freshCache();
    const gate = deferred();
    let calls = 0;
    const reads = Array.from({ length: 20 }, () => cachedQuery('stats', 'same', async () => { calls++; return gate.promise; }));
    await tick();
    assert.equal(calls, 1);
    assert.equal(await cachedQuery('orders', 'same', async () => 'order'), 'order');
    gate.resolve('result');
    assert.ok((await Promise.all(reads)).every(value => value === 'result'));
    assert.equal(await cachedQuery('stats', 'same', () => { throw new Error('cache miss'); }), 'result');
});

test('delete, clear, and direct writes prevent stale pending reads repopulating caches', async () => {
    for (const operation of ['delete', 'clear', 'set']) {
        const { cachedQuery, caches } = freshCache();
        const old = deferred();
        const pending = cachedQuery('stats', 'key', () => old.promise);
        await tick();
        if (operation === 'clear') caches.stats.clear();
        else if (operation === 'delete') caches.stats.delete('key');
        else caches.stats.set('key', 'new');
        assert.equal(await cachedQuery('stats', 'key', async () => 'new'), 'new');
        old.resolve('old');
        assert.equal(await pending, 'old');
        assert.equal(caches.stats.get('key'), 'new');
    }
});

test('failed shared reads are removed and can be retried', async () => {
    const { cachedQuery } = freshCache();
    const gate = deferred();
    const reads = [cachedQuery('stats', 'key', () => gate.promise), cachedQuery('stats', 'key', () => gate.promise)];
    const result = Promise.allSettled(reads);
    gate.reject(new Error('offline'));
    assert.ok((await result).every(r => r.status === 'rejected'));
    assert.equal(await cachedQuery('stats', 'key', async () => 'recovered'), 'recovered');
});

test('forced refreshes join a fresh generation and cannot be overwritten by old reads', async () => {
    const { cachedQuery, caches } = freshCache();
    const old = deferred(), fresh = deferred();
    const before = cachedQuery('stats', 'key', () => old.promise);
    let calls = 0;
    const refresh = () => cachedQuery('stats', 'key', () => { calls++; return fresh.promise; }, 1000, { refresh: true });
    const after = [refresh(), refresh()];
    await tick();
    assert.equal(calls, 1);
    fresh.resolve('new');
    await Promise.all(after);
    old.resolve('old');
    await before;
    assert.equal(caches.stats.get('key'), 'new');
});

test('pending bookkeeping is bounded; overflow executes without caching', async () => {
    const { cachedQuery, caches } = freshCache();
    const gate = deferred();
    const reads = Array.from({ length: 100 }, (_, i) => cachedQuery('stats', `key${i}`, () => gate.promise));
    await tick();
    assert.equal(await cachedQuery('orders', 'overflow', async () => 'ok'), 'ok');
    assert.equal(caches.orders.get('overflow'), null);
    gate.resolve('done');
    await Promise.all(reads);
    assert.equal(await cachedQuery('orders', 'overflow', async () => 'cached'), 'cached');
    assert.equal(caches.orders.get('overflow'), 'cached');
});

test('TTL and LRU bounds are unchanged; unknown cache falls back safely', async () => {
    let now = 100;
    class Clock extends Date { static now() { return now; } }
    const { LRUCache, setCache, caches } = freshCache({ Date: Clock });
    const cache = new LRUCache(2, 10);
    cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
    assert.equal(cache.get('b'), null);
    now = 111;
    assert.equal(cache.get('a'), null);
    setCache('fallback', 4, 'missing');
    assert.equal(caches.stats.get('fallback'), 4);
});

function authFixture() {
    let calls = 0, session = 'current';
    const auth = loadModule('src/middleware/auth.js', {
        jsonwebtoken: { verify: token => ({ role: 'operator', operatorId: 1, sid: token, permissions: ['shoppers'] }) },
        '../database/db': { dbAdapter: { query: async () => { calls++; return [{ is_active: true, active_session_id: session }]; } } }
    });
    return { auth, calls: () => calls, revoke: () => { session = 'revoked'; } };
}
function response() {
    return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('operator verification is shared within a request, never across requests', async () => {
    const fixture = authFixture();
    const req = { headers: { authorization: 'Bearer current' }, path: '/shoppers' };
    const res = response();
    let next = 0;
    await fixture.auth.permissionGate(req, res, () => next++);
    await fixture.auth.verifyToken(req, res, () => next++);
    assert.equal(next, 2);
    assert.equal(fixture.calls(), 1);
    fixture.revoke();
    await fixture.auth.verifyToken({ headers: req.headers }, res, () => next++);
    assert.equal(next, 2);
    assert.equal(res.statusCode, 401);
    assert.equal(fixture.calls(), 2);
});

test('arbitrary req.admin cannot bypass permissions and changed tokens are reverified', async () => {
    const { auth, calls } = authFixture();
    const req = { headers: { authorization: 'Bearer current' }, path: '/settings', admin: { role: 'admin' } };
    const res = response();
    await auth.permissionGate(req, res, () => assert.fail('operator may not enter settings'));
    assert.equal(res.statusCode, 403);
    req.headers.authorization = 'Bearer old';
    await auth.verifyToken(req, res, () => assert.fail('changed token must be checked'));
    assert.equal(res.statusCode, 401);
    assert.equal(calls(), 2);
});
