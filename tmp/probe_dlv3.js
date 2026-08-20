// Probe Delhivery for panel shipments of these orders.
// Try: waybill search, fetch-shipment-data bulk export, package search variants.
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;

async function get(label, url, params) {
    try {
        const r = await axios.get(url, { headers: H, params, timeout: 25000 });
        const s = JSON.stringify(r.data);
        console.log(`OK ${label}: ${s.substring(0, 400)}`);
        return r.data;
    } catch (e) {
        console.log(`ERR ${label}: ${e.response ? e.response.status : ''} ${JSON.stringify((e.response && e.response.data) || e.message).substring(0, 200)}`);
        return null;
    }
}
async function post(label, url, body, params) {
    try {
        const r = await axios.post(url, body, { headers: H, params, timeout: 25000 });
        const s = JSON.stringify(r.data);
        console.log(`OK ${label}: ${s.substring(0, 400)}`);
        return r.data;
    } catch (e) {
        console.log(`ERR ${label}: ${e.response ? e.response.status : ''} ${JSON.stringify((e.response && e.response.data) || e.message).substring(0, 200)}`);
        return null;
    }
}

(async () => {
    const testIds = ['39624', '39643', '39657'];

    // 1. Waybill search by text
    await get('waybill search', `${BASE}/api/v1/waybill_codes`, { search: testIds[0] });

    // 2. fetch-shipment-data by date range (bulk export of ALL shipments)
    const bulk = await post('fetch-shipment-data date range', `${BASE}/api/p2b/b2b/v1/fetch-shipment-data/`, {
        start_date: '2026-07-25',
        end_date: '2026-07-26'
    });
    if (bulk) {
        const arr = bulk.shipment_data || bulk.data || bulk;
        const count = Array.isArray(arr) ? arr.length : 'not-array';
        console.log(`   bulk rows: ${count}`);
        if (Array.isArray(arr) && arr[0]) {
            console.log('   row keys:', Object.keys(arr[0]).slice(0, 25).join(', '));
            console.log('   sample row ref fields:', JSON.stringify({
                order: arr[0].order, waybill: arr[0].waybill, ref_id: arr[0].ref_id,
                client_order_id: arr[0].client_order_id
            }).substring(0, 300));
        }
    }

    // 3. packages with search param
    await get('packages search', `${BASE}/api/v1/packages/json/`, { search: testIds[0], size: 10 });

    // 4. ref_ids comma variant
    await get('packages ref_ids comma', `${BASE}/api/v1/packages/json/`, { ref_ids: testIds.join(',') });
})();
