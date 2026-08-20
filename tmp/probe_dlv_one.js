// Probe 4: Delhivery One API — find the Pending-AWB order 42018 and see if an
// AWB can be assigned via API (the panel's "Get AWB Number" button equivalent).
require('dotenv').config();
const axios = require('axios');

const token = process.env.DELHIVERY_API_KEY || process.env.DELHIVERY_API_TOKEN;
const ORDER = process.argv[2] || '42018';

const BASES = [
    'https://one.delhivery.com',
    'https://track.delhivery.com'
];

async function tryReq(method, label, url, opts = {}) {
    try {
        const r = await axios({ method, url, timeout: 20000, maxRedirects: 0, ...opts });
        const isHtml = typeof r.data === 'string' && r.data.trim().startsWith('<');
        console.log(`${isHtml ? 'HTML' : 'OK'} ${label}: ${isHtml ? '(html)' : JSON.stringify(r.data).substring(0, 400)}`);
        return r.data;
    } catch (e) {
        const st = e.response ? e.response.status : 'net';
        const d = e.response?.data;
        const body = (typeof d === 'string' && d.trim().startsWith('<')) ? '(html)' : JSON.stringify(d || e.message).substring(0, 200);
        console.log(`ERR ${label}: ${st} ${body}`);
        return null;
    }
}

(async () => {
    const H = { Authorization: `Token ${token}`, Accept: 'application/json' };

    // Candidate One-API order routes
    await tryReq('GET', 'one /api/v1/orders search', `${BASES[0]}/api/v1/orders`, { headers: H, params: { search: ORDER } });
    await tryReq('GET', 'one /api/v1/order/fetch', `${BASES[0]}/api/v1/order/fetch`, { headers: H, params: { ref_id: ORDER } });
    await tryReq('GET', 'one /api/v2/orders', `${BASES[0]}/api/v2/orders`, { headers: H, params: { order_id: ORDER } });
    await tryReq('GET', 'one /api/v1/forward-orders', `${BASES[0]}/api/v1/forward-orders`, { headers: H, params: { search: ORDER } });
    await tryReq('GET', 'one /api/v1/shipment/fetch', `${BASES[0]}/api/v1/shipment/fetch`, { headers: H, params: { client_reference_number: ORDER } });

    // Legacy host, One-style routes
    await tryReq('GET', 'track /api/v1/orders search', `${BASES[1]}/api/v1/orders`, { headers: H, params: { search: ORDER } });

    // The panel search endpoint style (client ref number)
    await tryReq('GET', 'track packages client ref', `${BASES[1]}/api/v1/packages/json/`, { headers: H, params: { client_reference_number: ORDER } });
})();
