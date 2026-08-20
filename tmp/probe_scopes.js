require('dotenv').config();
const axios = require('axios');
const base2024 = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`;
const base2025 = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };

(async () => {
    const r = await axios.get(`${base2024}/orders.json`, { headers, params: { limit: 1 }, timeout: 20000 });
    console.log('token scopes:', r.headers['x-shopify-access-scopes']);

    // legacy create on 2024-01 for 42390
    try {
        const res = await axios.post(`${base2024}/orders/7015760330996/fulfillments.json`, {
            fulfillment: { tracking_number: 'LUAP0001402889', tracking_company: 'Ekart', notify_customer: false }
        }, { headers, timeout: 20000 });
        console.log('2024-01 legacy create OK:', JSON.stringify(res.data?.fulfillment ? { id: res.data.fulfillment.id } : res.data));
    } catch (e) {
        console.log('2024-01 legacy create failed:', e.response?.status, JSON.stringify(e.response?.data || ''));
    }

    // GraphQL fulfillmentOrders visibility
    try {
        const g = await axios.post(`${base2025}/graphql.json`, { query: `
            { order(id: "gid://shopify/Order/7015760330996") {
                name fulfillmentOrders(first: 5) { edges { node { id status requestStatus } } }
            } }` }, { headers, timeout: 20000 });
        console.log('GraphQL fulfillmentOrders:', JSON.stringify(g.data?.data?.order?.fulfillmentOrders || g.data?.errors));
    } catch (e) {
        console.log('GraphQL failed:', e.response?.status, JSON.stringify(e.response?.data || '').substring(0, 300));
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 400)); process.exit(1); });
