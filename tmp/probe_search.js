// Probe carrier order-search capabilities for panel-created shipments.
// Delhivery: try ref param variants. Ekart: try known/speculated fetch endpoints.
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const dlv = getAdapter('delhivery');
const ekt = getAdapter('ekart');

async function get(label, url, headers, params) {
    try {
        const r = await axios.get(url, { headers, params, timeout: 20000 });
        console.log(`✅ ${label}: ${JSON.stringify(r.data).substring(0, 350)}`);
        return r.data;
    } catch (e) {
        console.log(`❌ ${label}: ${e.response?.status} ${JSON.stringify(e.response?.data || e.message).substring(0, 200)}`);
        return null;
    }
}
async function post(label, url, headers, body, params) {
    try {
        const r = await axios.post(url, body, { headers, params, timeout: 20000 });
        console.log(`✅ ${label}: ${JSON.stringify(r.data).substring(0, 350)}`);
        return r.data;
    } catch (e) {
        console.log(`❌ ${label}: ${e.response?.status} ${JSON.stringify(e.response?.data || e.message).substring(0, 200)}`);
        return null;
    }
}

(async () => {
    const id = '39628'; // confirmed order, pending at Shiprocket

    console.log('===== DELHIVERY =====');
    for (const ref of [id, `#${id}`, `OFF${id}`, `OFFCOMFRT-${id}`]) {
        await get(`ref_ids=${ref}`, `${dlv.baseURL}/api/v1/packages/json/`, dlv.authHeaders(), { ref_ids: ref });
    }
    await get('ref_nos', `${dlv.baseURL}/api/v1/packages/json/`, dlv.authHeaders(), { ref_nos: id });
    // client name param sometimes needed alongside ref
    await get('ref_ids+client', `${dlv.baseURL}/api/v1/packages/json/`, dlv.authHeaders(), { ref_ids: id, client: 'Offcomfrt' });

    console.log('\n===== EKART =====');
    const token = await ekt.ensureToken();
    const h = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = ekt.baseURL;

    await get('GET package by order_number', `${base}/api/v1/package`, h, { order_number: id });
    await get('GET package/details', `${base}/api/v1/package/details`, h, { order_number: id });
    await post('POST package/search', `${base}/api/v1/package/search`, h, { order_number: id });
    await post('POST package/fetch', `${base}/api/v1/package/fetch`, h, { order_number: id });
    await get('GET orders search', `${base}/api/v1/orders`, h, { search: id });
    await get('GET v2 shipments', `${base}/api/v2/shipments`, h, { orderNumber: id });
})();
