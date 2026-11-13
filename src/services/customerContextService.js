const axios = require('axios');
const { dbAdapter } = require('../database/db');
const { cachedQuery } = require('../utils/cache');
const { getBreaker } = require('../utils/circuitBreaker');

// ============================================================
// customerContextService — the Shoppers Hub "customer context"
// aggregation (orders from store_shoppers + tracking from orders,
// local and portal returns/exchanges, RTO summary) extracted from
// the admin chat-sidebar endpoint so the support desk and the
// storefront Help & Tickets read exactly the same data the team
// already works out of.
//
// build(phone) results ride the 'shoppers' cache namespace (90s
// TTL), which shopper/order writes already invalidate.
// ============================================================

// Fetch open return/exchange requests from the external returns server —
// Shopify portal submissions live there, not in the local returns/exchanges
// tables. Graceful: returns { connected: false } when unconfigured or down.
async function fetchReturnsServerPipeline(windowDays) {
    const baseUrl = process.env.RETURNS_SERVER_URL;
    const token = process.env.WHATSAPP_INTERNAL_TOKEN;
    if (!baseUrl) return { connected: false, reason: 'RETURNS_SERVER_URL not configured', requests: [] };
    try {
        const res = await getBreaker('internal', 'READ', 'returnsPipeline', request => request()).fire(() =>
            axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/inventory-open-requests`, {
                params: { window: windowDays },
                headers: { 'x-internal-token': token || '' },
                timeout: 15000
            })
        );
        if (!res.data?.success) return { connected: false, reason: res.data?.error || 'unexpected response', requests: [] };
        return { connected: true, requests: Array.isArray(res.data.requests) ? res.data.requests : [] };
    } catch (err) {
        console.warn(`⚠️ Returns server pipeline fetch failed: ${err.message}`);
        return { connected: false, reason: err.message, requests: [] };
    }
}

async function build(rawPhone) {
    const phone = String(rawPhone || '').replace(/\D/g, '');
    if (phone.length < 10) throw new Error('phone required');

    // 1) All orders from store_shoppers (authoritative order source)
    //    Enriched with AWB/tracking from orders table.
    // Runs concurrently with the returns/exchanges scans below — the three
    // are independent, and one cold rebuild of this context sits on the
    // storefront Help tab's critical path.
    // The phone match is isolated in a MATERIALIZED CTE on the digits-only
    // functional index (idx_ss_phone_digits): with ORDER BY in the same
    // block the planner prefers a full created_at walk and regexp-filters
    // all ~52k rows (2-6s); this shape runs in single-digit ms.
    const [ordersRows, localReturns, localExchanges] = await Promise.all([
        dbAdapter.query(`
        WITH matched AS MATERIALIZED (
            SELECT id FROM store_shoppers s
            WHERE REGEXP_REPLACE(COALESCE(s.phone,''),'[^0-9]','','g') IN ($1, $2, $3)
        )
        SELECT
            s.order_id, s.name, s.phone, s.email, s.status AS shopper_status,
            s.items_json, s.order_total, s.payment_method, s.delivery_type,
            s.created_at, s.address, s.city, s.province, s.zip,
            o.awb, o.tracking_url, o.courier_name,
            o.status AS order_status, o.delivered_at
        FROM store_shoppers s
        JOIN matched m ON m.id = s.id
        LEFT JOIN orders o ON o.order_id = s.order_id
        ORDER BY s.created_at DESC
        LIMIT 50
    `, [phone, `91${phone}`, phone.replace(/^91/, '')]).catch(() => null),

    // 2) Local returns
    dbAdapter.query(`
        SELECT return_id, order_id, items, reason, status, refund_amount, refund_status, created_at, updated_at
        FROM returns
        WHERE REGEXP_REPLACE(COALESCE(customer_phone,''),'[^0-9]','','g') IN ($1, $2, $3)
        ORDER BY created_at DESC LIMIT 30
    `, [phone, `91${phone}`, phone.replace(/^91/, '')]),

    // 3) Local exchanges
    dbAdapter.query(`
        SELECT exchange_id, order_id, old_items, new_items, reason, status, price_difference, payment_status, created_at, updated_at
        FROM exchanges
        WHERE REGEXP_REPLACE(COALESCE(customer_phone,''),'[^0-9]','','g') IN ($1, $2, $3)
        ORDER BY created_at DESC LIMIT 30
    `, [phone, `91${phone}`, phone.replace(/^91/, '')])
    ]);
    if (!ordersRows) throw new Error('customer context order scan failed');

    // 4) External returns server pipeline (Shopify portal submissions)
    let rsRequests = [];
    try {
        const rsData = await fetchReturnsServerPipeline(90);
        rsRequests = rsData.requests || [];
    } catch (rsErr) {
        console.warn('[customer-context] Returns server unavailable, skipping portal data:', rsErr.message);
    }

    // Filter returns-server requests to this customer's orders.
    // Normalize by stripping '#' — the returns server stores Shopify format
    // ("#55197") while store_shoppers stores bare order ids ("55197").
    const normOrderId = v => String(v || '').replace(/^#/, '');
    const customerOrderIds = new Set(ordersRows.map(r => normOrderId(r.order_id)));
    const portalReturns = [];
    const portalExchanges = [];
    for (const req of rsRequests) {
        if (!customerOrderIds.has(normOrderId(req.order_number))) continue;
        const target = req.type === 'exchange' ? portalExchanges : portalReturns;
        target.push({
            request_id: req.request_id,
            order_number: req.order_number,
            type: req.type,
            status: req.status,
            reason: req.reason || null,
            items: req.items || [],
            created_at: req.created_at
        });
    }

    // 4b) Targeted per-order lookup via the returns server's ai-data search.
    // The global pipeline list above is capped at 1000 rows (newest first),
    // so a specific customer's request can be truncated out of it entirely.
    // The per-order search always finds that customer's own records.
    const seenRsIds = new Set([...portalReturns, ...portalExchanges].map(r => r.request_id));
    const lookupOrderIds = ordersRows.slice(0, 8).map(r => normOrderId(r.order_id)).filter(Boolean);
    if (lookupOrderIds.length && process.env.RETURNS_SERVER_URL) {
        try {
            const rsBase = process.env.RETURNS_SERVER_URL.replace(/\/$/, '');
            const rsToken = process.env.WHATSAPP_INTERNAL_TOKEN || '';
            const lookups = await Promise.all(lookupOrderIds.map(id =>
                getBreaker('internal', 'READ', 'returnsOrderLookup', request => request()).fire(() =>
                    axios.get(`${rsBase}/api/internal/ai-data`, {
                        params: { resource: 'requests', query: id, limit: 10 },
                        headers: { 'x-internal-token': rsToken },
                        timeout: 8000
                    })
                ).catch(() => null)
            ));
            for (const lk of lookups) {
                const reqs = Array.isArray(lk?.data?.requests) ? lk.data.requests : [];
                for (const r of reqs) {
                    // ai-data returns camelCase; the pipeline returns snake_case
                    const requestId = r.requestId || r.request_id;
                    if (!requestId || seenRsIds.has(requestId)) continue;
                    // The returns server's ai-data search uses substring/ILIKE
                    // matching, so it can surface requests belonging to OTHER
                    // customers whose order numbers share digits with ours.
                    // Only keep requests whose order_number actually belongs
                    // to this customer — otherwise the sidebar falsely shows
                    // R&E for customers who have none.
                    const rn = normOrderId(r.orderNumber || r.order_number);
                    if (!rn || !customerOrderIds.has(rn)) continue;
                    seenRsIds.add(requestId);
                    const entry = {
                        request_id: requestId,
                        order_number: r.orderNumber || r.order_number,
                        type: r.type,
                        status: r.status,
                        reason: r.reason || r.customerReason || null,
                        items: r.items || [],
                        created_at: r.createdAt || r.created_at
                    };
                    (entry.type === 'exchange' ? portalExchanges : portalReturns).push(entry);
                }
            }
        } catch (lkErr) {
            console.warn('[customer-context] Targeted RNX lookup failed:', lkErr.message);
        }
    }

    // 5) Compute RTO summary from orders
    const rtoOrders = ordersRows.filter(r =>
        r.shopper_status === 'rto' || r.order_status === 'rto'
    );

    // 6) Extract customer-level info from first order row
    const firstRow = ordersRows[0] || {};
    const customer = {
        name: firstRow.name || null,
        phone,
        email: firstRow.email || null,
        city: firstRow.city || null,
        province: firstRow.province || null,
        totalOrders: ordersRows.length
    };

    return {
        phone,
        customer,
        orders: ordersRows.map(r => ({
            order_id: r.order_id,
            status: r.shopper_status || r.order_status || 'unknown',
            shopper_status: r.shopper_status,
            order_status: r.order_status,
            phone: r.phone,
            items_json: r.items_json,
            order_total: r.order_total,
            payment_method: r.payment_method,
            delivery_type: r.delivery_type,
            created_at: r.created_at,
            awb: r.awb,
            courier_name: r.courier_name,
            tracking_url: r.tracking_url,
            delivered_at: r.delivered_at,
            city: r.city,
            address: r.address
        })),
        rto: rtoOrders.map(r => ({
            order_id: r.order_id,
            awb: r.awb,
            courier_name: r.courier_name,
            status: r.shopper_status || r.order_status,
            created_at: r.created_at,
            delivered_at: r.delivered_at
        })),
        returns: [
            ...localReturns.map(r => ({ ...r, source: 'local' })),
            ...portalReturns.map(r => ({ ...r, source: 'portal' }))
        ],
        exchanges: [
            ...localExchanges.map(r => ({ ...r, source: 'local' })),
            ...portalExchanges.map(r => ({ ...r, source: 'portal' }))
        ]
    };
}

// Cached wrapper. 'shoppers' is the namespace shopper/order writes already
// clear, so a confirmation or status edit here takes effect immediately;
// getOrLoad also collapses concurrent builds for the same phone into one.
async function buildCached(rawPhone) {
    const phone = String(rawPhone || '').replace(/\D/g, '');
    return await cachedQuery('shoppers', `ctx:${phone}`, () => build(phone));
}

module.exports = { build, buildCached, fetchReturnsServerPipeline };
