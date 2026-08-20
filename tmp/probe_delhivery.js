// Probe Delhivery packages API: how do we find panel-created shipments by order id?
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
    const testIds = ['39624', '39628', '39643'];
    const base = adapter.baseURL;

    // 1. ref_ids lookup (what the sync script currently does)
    for (const id of testIds) {
        const r = await tryGet(`${base}/api/v1/packages/json/`, { ref_ids: id, size: 10 });
        console.log(`ref_ids=${id}:`, r.ok ? JSON.stringify(r.data).substring(0, 400) : `ERR ${r.status} ${r.msg}`);
    }

    // 2. Recent package listing — inspect the shape and ref field names
    const list = await tryGet(`${base}/api/v1/packages/json/`, { size: 25 });
    if (!list.ok) {
        console.log('listing ERR:', list.status, list.msg);
        return;
    }
    const shp = list.data?.ShipmentData || list.data?.shipments || [];
    console.log(`\nlisting returned ${shp.length} package(s)`);
    if (shp[0]) {
        console.log('keys:', Object.keys(shp[0]).join(', '));
        for (const p of shp.slice(0, 8)) {
            console.log(` waybill=${p.waybill || p.Waybill} ref=${p.ref_id ?? p.ref ?? p.client_ref ?? '?'} client=${p.client || p.client_name || '?'} status=${p.status || p.current_status || '?'}`);
        }
    } else {
        console.log('raw:', JSON.stringify(list.data).substring(0, 500));
    }
})();
