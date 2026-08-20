require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };

(async () => {
    const name = '42390';
    const r = await axios.get(`${base}/orders.json`, { headers, params: { name, status: 'any' }, timeout: 20000 });
    const order = r.data?.orders?.[0];
    console.log('order id:', order.id, 'name:', order.name);

    // fulfillment orders for this order
    const fo = await axios.get(`${base}/fulfillment_orders.json`, { headers, params: { order_id: order.id }, timeout: 20000 });
    console.log('fulfillment_orders:', JSON.stringify((fo.data?.fulfillment_orders || []).map(f => ({ id: f.id, status: f.status, request_status: f.request_status })), null, 1));

    // attempt legacy create to capture 406 body
    try {
        await axios.post(`${base}/orders/${order.id}/fulfillments.json`, {
            fulfillment: { tracking_number: 'LUAP0001402889', tracking_company: 'Ekart', notify_customer: false }
        }, { headers, timeout: 20000 });
        console.log('legacy create: OK');
    } catch (e) {
        console.log('legacy create failed:', e.response?.status, JSON.stringify(e.response?.data));
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 500)); process.exit(1); });
