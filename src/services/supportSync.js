const crypto = require('crypto');
const axios = require('axios');
const { dbAdapter } = require('../database/db');
const { getBreaker } = require('../utils/circuitBreaker');

// ============================================================
// SupportSync — keeps support_order_cache fresh from Shopify.
// Primary driver: the Shopify order webhooks the app already
// receives (/webhooks/shopify/orders/*). Also exposes manual
// sync (desk button) and a bulk backfill for whitelisted phones.
// ============================================================

const CACHE_COLS = [
    'order_id', 'customer_phone', 'customer_name', 'customer_email', 'order_json', 'stage',
    'payment', 'courier', 'awb', 'address', 'total', 'placed_at', 'delivered_at', 'synced_at', 'src_updated_at'
];

// How far back the cache is populated / kept. Eligibility windows never look
// further back than this, so older orders are pure storage cost.
const CACHE_MONTHS = Number(process.env.SUPPORT_CACHE_MONTHS || 12);

// ---------- Shopify Admin REST (same credentials + version the app already uses) ----------
function shopifyBase() {
    const shop = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE;
    if (!shop) throw new Error('Shopify credentials not configured');
    return `https://${shop.replace('.myshopify.com', '')}.myshopify.com/admin/api/2024-01`;
}

async function shopifyREST(path, options = {}) {
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!token) throw new Error('Shopify credentials not configured');
    const url = path.startsWith('http') ? path : `${shopifyBase()}/${path}`;
    const res = await axios({
        url,
        method: options.method || 'GET',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        data: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
        timeout: 20000
    });
    const data = res.data || {};
    // Shopify paginates through the Link header; expose it for list callers
    const nextMatch = /<([^>]+)>;\s*rel="next"/.exec(res.headers?.link || '');
    if (nextMatch) data.nextUrl = nextMatch[1];
    return data;
}

function verifyWebhookHmac(rawBody, header, secret) {
    if (!secret || !header) return false;
    try {
        const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
        const digest = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
        const a = Buffer.from(digest);
        const b = Buffer.from(String(header));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function normalizePhone(raw) {
    if (!raw) return '';
    let d = String(raw).replace(/\D/g, '');
    if (d.length === 10) d = '91' + d;
    if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1);
    if (d.length === 12 && d.startsWith('91')) return d;
    if (d.length > 12 && d.startsWith('0091')) return d.slice(4);
    return d;
}

function detectPayment(order) {
    const gateways = (order.payment_gateway_names || []).map(g => String(g).toLowerCase()).join(' ');
    if (/(cash on delivery|cod|collect on delivery)/.test(gateways)) return 'COD';
    if (order.financial_status === 'paid') return 'Prepaid';
    if (order.financial_status === 'pending' && /(cod|cash)/.test(gateways)) return 'COD';
    return 'Prepaid';
}

function extractCourier(order) {
    const f = (order.fulfillments || []).find(x => x.tracking_company || x.tracking_number) || {};
    return f.tracking_company || '';
}

function extractAWB(order) {
    const f = (order.fulfillments || []).find(x => x.tracking_number) || {};
    return f.tracking_number || '';
}

function formatAddress(addr) {
    if (!addr) return '';
    return [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country]
        .filter(Boolean).join(', ');
}

function orderHasRTO(order) {
    const tags = String(order.tags || '').toLowerCase();
    if (tags.includes('rto')) return true;
    return (order.fulfillments || []).some(f => f.shipment_status === 'returned' || f.status === 'returned');
}

// Cross-reference the exchange/return queue the team works out of
async function hasActiveRequest(orderNumber, type) {
    try {
        const bare = String(orderNumber || '').replace(/^#/, '');
        if (!bare) return false;
        const openStates = ['pending', 'pending_approval', 'approved', 'initiated', 'pickup_scheduled',
            'pickup_booked', 'scheduled', 'in_transit', 'shipped', 'processing', 'paid', 'waiting_payment'];
        const rows = await requestsQuery(`select=type,status&order_number=in.(${encodeURIComponent(bare)},%23${encodeURIComponent(bare)})`);
        return rows.some(r => (type ? r.type === type : true) && openStates.includes(String(r.status || '').toLowerCase()));
    } catch (e) {
        console.warn('[SupportSync] requests lookup failed:', e.message);
        return false;
    }
}

// ---------- the return/exchange queue ("requests") ----------
// That table is owned by the other Supabase project (SUPABASE_URL), which the
// return-exchange app writes through PostgREST. dbAdapter points at the pooler
// project, where the table does not exist, so the queue is reached over REST.
function reqHeaders(extra) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!process.env.SUPABASE_URL || !key) throw new Error('Supabase REST credentials not configured');
    return Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, extra || {});
}

function requestsQuery(params) {
    return getBreaker('internal', 'READ', 'requestsQuery', request => request()).fire(() =>
        axios.get(`${process.env.SUPABASE_URL}/rest/v1/requests?${params}`,
            { headers: reqHeaders(), timeout: 15000 })
    ).then(r => r.data || []);
}

// jsonb columns take real arrays/objects here, not stringified JSON
function requestsInsert(row) {
    return getBreaker('internal', 'MUTATE_IDEMPOTENT', 'requestsInsert', request => request(), {
        timeout: 10000,
        maxConcurrency: 5
    }).fire(() => axios.post(`${process.env.SUPABASE_URL}/rest/v1/requests`, row,
        { headers: reqHeaders({ Prefer: 'return=minimal' }), timeout: 20000 }));
}

// ---------- stage computation ----------
async function computeOrderStage(order) {
    if (order.cancelled_at || order.cancelled) return 'cancelled';
    const fulfillment = (order.fulfillments || [])[0];
    if (!fulfillment) return 'unshipped';
    if (orderHasRTO(order)) return 'rto';
    if (fulfillment.shipment_status === 'delivered' || fulfillment.delivered_at || order.delivered_at) {
        return 'delivered';
    }
    if (fulfillment.shipment_status === 'out_for_delivery') return 'out_for_delivery';
    return 'shipped';
}

// ---------- cache row builder ----------
// The raw Shopify order payload is ~9 KB; this app only ever reads a handful of
// fields back out of it (line items for the picker, the numeric Shopify id for
// tag/fulfilment calls, and two display fallbacks). Storing that projection —
// ~0.6 KB, 15x smaller — is what keeps the cache cheap in disk and in every
// read that touches it, since order_json travels with each row either way.
function slimOrderJson(order) {
    const addr = order.shipping_address || null;
    return {
        id: order.id,
        name: order.name || null,
        confirmed: order.confirmed !== false,
        isNew: !!order.is_new,
        gateway: order.payment_gateway_names || null,
        paid_via: (order.payment_gateway_names && order.payment_gateway_names[0]) || null,
        line_items: (order.line_items || []).map(i => ({
            name: i.name, title: i.title, variant_title: i.variant_title,
            quantity: i.quantity, price: i.price,
            // CDN URL only — the storefront picker shows product thumbnails
            image: i.image || null
        })),
        shipping_address: addr ? {
            address1: addr.address1, address2: addr.address2, city: addr.city,
            province: addr.province, zip: addr.zip
        } : null
    };
}

async function buildCacheRow(order, phone) {
    let stage = await computeOrderStage(order);
    if (stage === 'shipped' || stage === 'out_for_delivery') {
        if (await hasActiveRequest(order.name || order.order_number, 'exchange')) stage = 'exchange';
        else if (await hasActiveRequest(order.name || order.order_number, 'return')) stage = 'return';
    }
    return {
        order_id: String(order.name || order.order_number || order.id),
        customer_phone: phone,
        customer_name: [order.customer && order.customer.first_name, order.customer && order.customer.last_name]
            .filter(Boolean).join(' ')
            || (order.shipping_address && [order.shipping_address.first_name, order.shipping_address.last_name].filter(Boolean).join(' '))
            || '',
        customer_email: (order.customer && order.customer.email) || order.email || order.contact_email || null,
        order_json: slimOrderJson(order),
        stage,
        payment: detectPayment(order),
        courier: extractCourier(order),
        awb: extractAWB(order),
        address: formatAddress(order.shipping_address),
        total: Number(order.total_price || 0),
        placed_at: order.created_at || null,
        delivered_at: (order.fulfillments || []).map(f => f.delivered_at).find(Boolean) || order.delivered_at || null,
        synced_at: new Date().toISOString(),
        src_updated_at: order.updated_at || order.created_at || null
    };
}

// Upsert one order into the cache. Returns 'written' | 'unchanged' | 'error'.
// Idempotent by design so Shopify webhook retries never surface as errors.
async function upsertOrder(order, phone, force = false) {
    try {
        const row = await buildCacheRow(order, phone);
        if (!force && row.src_updated_at) {
            // Shopify re-sends orders/updated constantly with nothing changed. An
            // UPDATE rewrites the whole row (plus TOAST churn for the JSONB), so
            // compare the source timestamp first on one tiny indexed read instead.
            // Column is VARCHAR: a timestamp would come back shifted by the
            // server's zone and never match.
            const prev = await dbAdapter.query(
                'SELECT src_updated_at FROM support_order_cache WHERE order_id = ?', [row.order_id]
            );
            if (prev.length && String(prev[0].src_updated_at || '') === String(row.src_updated_at)) {
                return 'unchanged';
            }
        }
        const updates = CACHE_COLS.filter(c => c !== 'order_id')
            .map(c => `${c} = EXCLUDED.${c}`).join(', ');
        await dbAdapter.run(
            `INSERT INTO support_order_cache (${CACHE_COLS.join(', ')})
             VALUES (${CACHE_COLS.map(c => `?${c === 'order_json' ? '::jsonb' : ''}`).join(', ')})
             ON CONFLICT (order_id) DO UPDATE SET ${updates}`,
            CACHE_COLS.map(c => (c === 'order_json' ? JSON.stringify(row.order_json ?? null) : row[c]))
        );
        return 'written';
    } catch (e) {
        console.error('[SupportSync] upsert error:', e.message);
        return 'error';
    }
}

// ---------- whitelist gate for the webhook firehose ----------
// orders/updated fires for every order in the shop while the whitelist holds a
// handful of phones, so the list is kept in memory (60s) to keep non-whitelisted
// webhooks at zero database reads.
let wlCache = null;
async function isWhitelistedCached(phone) {
    if (!wlCache || Date.now() - wlCache.ts > 60 * 1000) {
        const rows = await dbAdapter.query('SELECT phone FROM support_whitelist');
        wlCache = { set: new Set(rows.map(r => r.phone)), ts: Date.now() };
    }
    return wlCache.set.has(phone);
}

// ---------- webhook entry ----------
// Called with the parsed Shopify order payload after HMAC verification.
// Never throws: a support-cache problem must not break abandoned-cart recovery.
async function handleOrderWebhook(topic, order) {
    try {
        const phone = normalizePhone(
            (order.customer && order.customer.phone) || order.phone || (order.shipping_address && order.shipping_address.phone)
        );
        if (!phone || phone.length < 10) return { ok: true, skip: 'no phone' };

        const orderId = String(order.name || order.order_number || order.id);

        if (topic === 'orders/cancelled' || topic === 'orders/delete') {
            await dbAdapter.run(
                "UPDATE support_order_cache SET stage = 'cancelled', synced_at = CURRENT_TIMESTAMP WHERE order_id = ?",
                [orderId]
            );
            return { ok: true, cancelled: true };
        }

        // Only cache orders belonging to whitelisted customers
        if (!(await isWhitelistedCached(phone))) return { ok: true, skip: 'not whitelisted' };

        const result = await upsertOrder(order, phone);
        return { ok: true, synced: result === 'written', unchanged: result === 'unchanged' };
    } catch (e) {
        console.error('[SupportSync] webhook handler error:', e.message);
        return { ok: false, error: e.message };
    }
}

// ---------- manual / backfill sync ----------
async function shopifyOrdersForCustomer(customerId) {
    const out = [];
    // Only recent orders matter (eligibility windows are short), which also bounds
    // how many rows a long-standing customer can ever add to the cache.
    const since = new Date(Date.now() - CACHE_MONTHS * 30 * 24 * 3600 * 1000).toISOString();
    let url = `orders.json?customer_id=${customerId}&status=any&limit=250&created_at_at_least=${encodeURIComponent(since)}`;
    while (url) {
        const data = await shopifyREST(url);
        out.push(...(data.orders || []));
        url = data.nextUrl || null;
        if (out.length >= 750) break; // safety cap
    }
    return out;
}

async function syncOrdersForPhone(rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new Error('Phone required');
    // Shopify phone search wants E.164; try both spellings
    let customers = [];
    for (const variant of ['+' + phone, phone]) {
        try {
            const data = await shopifyREST(`customers.json?phone=${encodeURIComponent(variant)}&limit=5`);
            customers = data.customers || [];
            if (customers.length) break;
        } catch { /* try the next format */ }
    }
    if (!customers.length) return { phone, orders: 0, note: 'customer not found in Shopify' };

    let synced = 0;
    for (const c of customers) {
        const orders = await shopifyOrdersForCustomer(c.id);
        for (const order of orders) {
            if (await upsertOrder(order, phone, true) !== 'error') synced++;
        }
    }
    return { phone, orders: synced };
}

async function syncAllWhitelisted() {
    const rows = await dbAdapter.query('SELECT phone FROM support_whitelist');
    const results = [];
    for (const r of rows) {
        try {
            results.push(await syncOrdersForPhone(r.phone));
        } catch (e) {
            results.push({ phone: r.phone, error: e.message });
        }
    }
    return { customers: rows.length, results };
}

// Pull one order live from Shopify and refresh its cache row.
// `ref` is either the shopify order id or the cached order number (#1234).
async function refreshOrder(ref) {
    const key = String(ref || '').trim();
    if (!key) throw new Error('Order required');
    let order = null;
    // Numeric refs may be a Shopify order id — try that first, then order name
    if (/^\d+$/.test(key)) {
        try {
            const byId = await shopifyREST(`orders/${key}.json`);
            order = byId.order || null;
        } catch { order = null; }
    }
    if (!order) {
        const data = await shopifyREST(`orders.json?name=${encodeURIComponent(key.replace(/^#/, ''))}&status=any&limit=1`);
        order = (data.orders || [])[0] || null;
    }
    if (!order) return null;
    const phone = normalizePhone(
        (order.customer && order.customer.phone) || (order.shipping_address && order.shipping_address.phone)
    );
    const result = await upsertOrder(order, phone, true);
    if (result === 'error') return null;
    const rows = await dbAdapter.query('SELECT * FROM support_order_cache WHERE order_id = ?', [String(order.name || order.order_number)]);
    return rows[0] || null;
}

// Read one order straight from Shopify and return a cache-row-shaped object
// WITHOUT touching the database. This is what lets the customer catalog and the
// desk work when support_order_cache is empty or not yet migrated — the order
// list itself now comes from native customer.orders in the theme, so nothing on
// the customer path depends on the webhook cache any more.
async function fetchLiveOrder(ref) {
    const key = String(ref || '').trim();
    if (!key) throw new Error('Order required');
    let order = null;
    if (/^\d+$/.test(key)) {
        try { const byId = await shopifyREST(`orders/${key}.json`); order = byId.order || null; } catch { order = null; }
    }
    if (!order) {
        const data = await shopifyREST(`orders.json?name=${encodeURIComponent(key.replace(/^#/, ''))}&status=any&limit=1`);
        order = (data.orders || [])[0] || null;
    }
    if (!order) return null;
    const phone = normalizePhone(
        (order.customer && order.customer.phone) || (order.shipping_address && order.shipping_address.phone) || ''
    );
    return await buildCacheRow(order, phone);
}

module.exports = {
    shopifyREST, verifyWebhookHmac, normalizePhone, detectPayment, extractCourier, extractAWB,
    formatAddress, computeOrderStage, buildCacheRow, slimOrderJson, upsertOrder, handleOrderWebhook,
    syncOrdersForPhone, syncAllWhitelisted, refreshOrder, fetchLiveOrder, hasActiveRequest, isWhitelistedCached,
    requestsQuery, requestsInsert, CACHE_MONTHS
};
