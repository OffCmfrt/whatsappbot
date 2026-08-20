require('dotenv').config();
const shiprocketService = require('../src/services/shiprocketService');
const axios = require('axios');
const BASE = 'https://apiv2.shiprocket.in/v1/external';

(async () => {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}` };

    // search both spellings
    for (const term of ['42390', '#42390']) {
        const res = await axios.get(`${BASE}/orders`, { headers, params: { search: term, per_page: 20 }, timeout: 20000 });
        const orders = res.data?.data || [];
        console.log(`\nsearch "${term}": ${orders.length} rows`);
        for (const o of orders) {
            console.log(`  sr_id=${o.id} channel_id=${o.channel_id} channel_order_id=${o.channel_order_id} status=${o.status} awb=${o.awb_code || '—'}`);
        }
    }

    // full detail of the known row
    const d = await axios.get(`${BASE}/orders/show/1495761870`, { headers, timeout: 20000 });
    const det = d.data?.data || d.data;
    const interesting = {};
    for (const k of Object.keys(det || {})) {
        if (/channel|source|offline|platform|store|app/i.test(k)) interesting[k] = det[k];
    }
    console.log('\nchannel-ish fields on 1495761870:', JSON.stringify(interesting, null, 1));
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 300)); process.exit(1); });
