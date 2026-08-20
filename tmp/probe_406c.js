require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };

(async () => {
    const orderId = 7015760330996; // 42390
    // Variant A: minimal tracking-only fulfillment (no line_items)
    try {
        const res = await axios.post(`${base}/orders/${orderId}/fulfillments.json`, {
            fulfillment: { tracking_number: 'LUAP0001402889', tracking_company: 'Ekart', notify_customer: false }
        }, { headers, timeout: 20000 });
        console.log('minimal create OK:', res.status, JSON.stringify(res.data?.fulfillment ? { id: res.data.fulfillment.id, status: res.data.fulfillment.status } : res.data));
    } catch (e) {
        console.log('minimal create failed:', e.response?.status, JSON.stringify(e.response?.data));
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 500)); process.exit(1); });
