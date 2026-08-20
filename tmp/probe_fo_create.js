require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };

(async () => {
    // A) POST /fulfillments.json without fulfillment_order_id — read the error
    try {
        const res = await axios.post(`${base}/fulfillments.json`, {
            fulfillment: { tracking_number: 'LUAP0001402889', tracking_company: 'Ekart', notify_customer: false }
        }, { headers, timeout: 20000 });
        console.log('A OK:', JSON.stringify(res.data).substring(0, 200));
    } catch (e) {
        console.log('A failed:', e.response?.status, JSON.stringify(e.response?.data || ''));
    }

    // B) GraphQL fulfillmentCreateV2 attempt (scope check) — needs FO gid; try mutation w/ order line items shape
    // First try to read scopes header from any request
    const r = await axios.get(`${base}/shop.json`, { headers, timeout: 20000 });
    console.log('shop.json scopes header:', r.headers['x-shopify-access-scopes'] || '(none)');
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 300)); process.exit(1); });
