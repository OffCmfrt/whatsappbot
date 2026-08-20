// Probe: how is order 42018 stored at Delhivery? (visible in panel, not via ref_ids)
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;
const ORDER = process.argv[2] || '42018';

async function get(label, url, params) {
    try {
        const r = await axios.get(url, { headers: H, params, timeout: 25000 });
        const s = JSON.stringify(r.data);
        console.log(`OK ${label} (${s.length} chars): ${s.substring(0, 500)}`);
        return r.data;
    } catch (e) {
        const st = e.response ? e.response.status : 'net';
        const body = e.response ? JSON.stringify(e.response.data).substring(0, 200) : e.message;
        console.log(`ERR ${label}: ${st} ${body}`);
        return null;
    }
}

(async () => {
    // 1. Current behaviour: ref_ids lookups
    await get('ref_ids bare', `${BASE}/api/v1/packages/json/`, { ref_ids: ORDER, size: 10 });
    await get('ref_ids hash', `${BASE}/api/v1/packages/json/`, { ref_ids: `#${ORDER}`, size: 10 });

    // 2. Delhivery One "orders" endpoints (panel-imported orders live here, not packages)
    await get('orders v1', `${BASE}/api/v1/orders`, { search: ORDER, size: 10 });
    await get('orders search param', `${BASE}/api/v1/orders/`, { q: ORDER });
    await get('order by ref', `${BASE}/api/v1/order/fetch`, { ref_id: ORDER });

    // 3. Waybill search
    await get('waybill search', `${BASE}/api/v1/waybill_codes`, { search: ORDER });

    // 4. Bulk data exports around today — grep for our order id in any ref field
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const fs = await get('fetch-shipment-data', `${BASE}/api/p2b/b2b/v1/fetch-shipment-data/`, { start_date: yesterday, end_date: today, size: 500 });
    if (fs) {
        const s = JSON.stringify(fs);
        const idx = s.indexOf(ORDER);
        console.log(`→ fetch-shipment-data contains "${ORDER}":`, idx >= 0 ? `YES @${idx}: ${s.substring(Math.max(0, idx - 200), idx + 200)}` : 'NO');
    }
    const pd = await get('package data v2', `${BASE}/api/v2/package/data/`, { start_date: yesterday, end_date: today, size: 500 });
    if (pd) {
        const s = JSON.stringify(pd);
        const idx = s.indexOf(ORDER);
        console.log(`→ package data v2 contains "${ORDER}":`, idx >= 0 ? `YES @${idx}: ${s.substring(Math.max(0, idx - 200), idx + 200)}` : 'NO');
    }
})();
