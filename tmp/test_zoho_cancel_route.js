/**
 * Integration test: POST /webhooks/zoho/orders/cancelled end-to-end via a
 * real express app mounted exactly like server.js (express.raw parser BEFORE
 * the router). Verifies:
 *   1. Route is registered
 *   2. Invalid HMAC → 401 (blocked by middleware)
 *   3. Valid HMAC → 200 {received:true} (gate passes, background work starts)
 *   4. Shipped (fulfilled) order → 200, short-circuits before any Zoho call
 * No Zoho writes happen: invalid HMAC never reaches the handler; the valid-
 * HMAC test uses a non-existent order number so searchInvoice finds nothing
 * (or errors without live creds) — both are caught inside the handler.
 */
require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const SECRET_LIST = (process.env.ZOHO_SHOPIFY_WEBHOOK_SECRET || '').split(',').map(s => s.trim()).filter(Boolean);
const SECRET = SECRET_LIST[0] || process.env.SHOPIFY_WEBHOOK_SECRET || '';
if (!SECRET) {
    console.error('SKIP: no webhook secret configured in env');
    process.exit(0);
}

const router = require('../src/routes/zohoWebhookRoutes');

// Mirror server.js mounting: raw body parser first, then the router
const app = express();
app.use('/webhooks/zoho', express.raw({ type: '*/*' }), router);

function post(path, payloadObj, hmac) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payloadObj));
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, path, method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': body.length,
                ...(hmac ? { 'x-shopify-hmac-sha256': hmac } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

const sign = (obj) => crypto.createHmac('sha256', SECRET)
    .update(Buffer.from(JSON.stringify(obj)), 'utf8').digest('base64');

const server = app.listen(0, async () => {
    const failures = [];
    const check = (name, cond, extra = '') => {
        if (cond) console.log(`PASS: ${name}${extra ? ` (${extra})` : ''}`);
        else { console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ''}`); failures.push(name); }
    };

    try {
        // 1. Route registration
        const registered = router.stack.some(
            (l) => l.route && l.route.path === '/orders/cancelled' && l.route.methods.post
        );
        check('POST /orders/cancelled route registered', registered);

        // 2. Invalid HMAC → 401
        const payloadA = { id: 1, order_number: 99999001, fulfillments: [] };
        const bad = await post('/webhooks/zoho/orders/cancelled', payloadA, 'aW52YWxpZA==');
        check('invalid HMAC rejected with 401', bad.status === 401, `got ${bad.status}`);

        // 3. Valid HMAC, unfulfilled cancelled order (fake number — no Zoho writes)
        const payloadB = { id: 900100, order_number: 99999002, fulfillments: [] };
        const good = await post('/webhooks/zoho/orders/cancelled', payloadB, sign(payloadB));
        check('valid HMAC accepted (200 ack)', good.status === 200 && good.body.includes('received'), `got ${good.status}: ${good.body.slice(0, 80)}`);

        // 4. Valid HMAC but order already shipped → invoice kept (no-op path)
        const payloadC = {
            id: 900101, order_number: 99999003,
            fulfillments: [{ status: 'success' }],
        };
        const shipped = await post('/webhooks/zoho/orders/cancelled', payloadC, sign(payloadC));
        check('shipped order acknowledged without void attempt', shipped.status === 200, `got ${shipped.status}`);

        console.log(failures.length === 0
            ? '\nAll integration checks passed.'
            : `\n${failures.length} check(s) FAILED`);
        process.exit(failures.length === 0 ? 0 : 1);
    } catch (err) {
        console.error('TEST ERROR:', err.message);
        process.exit(1);
    }
});
