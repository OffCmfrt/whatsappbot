require('dotenv').config();
const shiprocketService = require('../src/services/shiprocketService');
const axios = require('axios');
const BASE = 'https://apiv2.shiprocket.in/v1/external';

(async () => {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}` };
    for (const id of [1495761870]) {
        const d = await axios.get(`${BASE}/orders/show/${id}`, { headers, timeout: 20000 });
        const det = d.data?.data || d.data;
        const pick = {};
        for (const k of Object.keys(det || {})) {
            if (/channel|source|origin|platform/i.test(k)) pick[k] = det[k];
        }
        console.log('channel/source fields:', JSON.stringify(pick, null, 2));
        console.log('order_id:', det?.order_id, '| channel_order_id:', det?.channel_order_id, '| status:', det?.status);
        console.log('shipments:', JSON.stringify((det?.shipments || []).map(s => ({ id: s.id, awb: s.awb, courier: s.courier, status: s.status })), null, 2));
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 400)); process.exit(1); });
