require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };

(async () => {
    const orderId = 7015760330996;
    const fo = await axios.get(`${base}/orders/${orderId}/fulfillment_orders.json`, { headers, timeout: 20000 });
    console.log('fulfillment_orders:', JSON.stringify((fo.data?.fulfillment_orders || []).map(f => ({ id: f.id, status: f.status, request_status: f.request_status, fulfillable: f.fulfillable_quantity })), null, 1));

    try {
        await axios.post(`${base}/orders/${orderId}/fulfillments.json`, {
            fulfillment: { tracking_number: 'LUAP0001402889', tracking_company: 'Ekart', notify_customer: false }
        }, { headers, timeout: 20000 });
        console.log('legacy create: OK');
    } catch (e) {
        console.log('legacy create failed:', e.response?.status, JSON.stringify(e.response?.data));
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 500)); process.exit(1); });
