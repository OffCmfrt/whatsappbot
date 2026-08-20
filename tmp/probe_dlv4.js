// Discover what Delhivery shipments look like for this account.
// Try date-based listing endpoints and inspect the order/ref fields.
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;

async function get(label, url, params) {
    try {
        const r = await axios.get(url, { headers: H, params, timeout: 25000 });
        console.log(`OK ${label}: ${JSON.stringify(r.data).substring(0, 300)}`);
        return r.data;
    } catch (e) {
        const st = e.response ? e.response.status : 'net';
        const body = e.response ? JSON.stringify(e.response.data).substring(0, 120) : e.message;
        console.log(`ERR ${label}: ${st} ${body}`);
        return null;
    }
}

(async () => {
    // 1. shipments listing (panel-style)
    await get('shipments listing', `${BASE}/api/v1/shipments`, { page: 1, size: 5 });
    // 2. packages listing without ref filter (maybe paginated all)
    await get('packages no-filter', `${BASE}/api/v1/packages/json/`, { size: 5, page: 1 });
    // 3. waybill codes listing
    await get('waybill list', `${BASE}/api/v1/waybill_codes`, { size: 5 });
    // 4. known data-fetch variants
    await get('fetch-shipment-data GET', `${BASE}/api/p2b/b2b/v1/fetch-shipment-data/`, { start_date: '2026-08-02', end_date: '2026-08-03' });
    await get('package data v2', `${BASE}/api/v2/package/data/`, { start_date: '2026-08-02', end_date: '2026-08-03' });
    // 5. client info — confirms account & client name used in panel
    await get('client details', `${BASE}/api/v1/client/details`);
})();
