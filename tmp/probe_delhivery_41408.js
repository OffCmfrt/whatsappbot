// Probe: why does Delhivery lookup fail for order 41408 (synced via Shopify)?
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const adapter = getAdapter('delhivery');

async function tryGet(url, params) {
    try {
        const r = await axios.get(url, { headers: adapter.authHeaders(), params, timeout: 20000 });
        return { ok: true, data: r.data };
    } catch (e) {
        return { ok: false, status: e.response?.status, msg: e.response?.data ? JSON.stringify(e.response.data).substring(0, 300) : e.message };
    }
}

(async () => {
    const base = adapter.baseURL;
    const orderId = process.argv[2] || '41408';

    // 1. ref_ids lookups with several candidate spellings
    for (const id of [orderId, `#${orderId}`]) {
        const r = await tryGet(`${base}/api/v1/packages/json/`, { ref_ids: id, size: 10 });
        console.log(`\nref_ids=${id}:`, r.ok ? JSON.stringify(r.data).substring(0, 800) : `ERR ${r.status} ${r.msg}`);
    }

    // 2. Recent packages — inspect ref/client fields for Shopify-synced orders
    const list = await tryGet(`${base}/api/v1/packages/json/`, { size: 40 });
    if (!list.ok) {
        console.log('\nlisting ERR:', list.status, list.msg);
        return;
    }
    const shp = list.data?.ShipmentData || list.data?.shipments || [];
    console.log(`\nlisting returned ${shp.length} package(s)`);
    const arr = Array.isArray(shp) ? shp : [shp];
    for (const p of arr.slice(0, 15)) {
        const inner = p?.Shipment || p;
        console.log('-', JSON.stringify({
            keys: Object.keys(p || {}).slice(0, 12),
            waybill: p?.waybill || p?.Waybill || inner?.Waybill,
            refnum: inner?.refnum ?? inner?.RefNum ?? p?.refnum,
            client: inner?.client ?? inner?.Client,
            status: inner?.Status?.Status ?? p?.status
        }).substring(0, 400));
    }
    if (!arr.length) console.log('raw:', JSON.stringify(list.data).substring(0, 800));
})();
