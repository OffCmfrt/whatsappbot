// Does Shopify know these orders are fulfilled? Fulfillments carry the AWB.
require('dotenv').config();
const axios = require('axios');

const store = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ACCESS_TOKEN;
const base = `https://${store}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': token };

(async () => {
    const name = '39628';
    const r = await axios.get(`${base}/orders.json`, { headers, params: { name, status: 'any' }, timeout: 20000 });
    const order = r.data?.orders?.[0];
    if (!order) { console.log('no shopify order', name); return; }
    console.log(`shopify order id=${order.id} name=${order.name} fulfillment_status=${order.fulfillment_status}`);
    const f = await axios.get(`${base}/orders/${order.id}/fulfillments.json`, { headers, timeout: 20000 });
    for (const ful of f.data?.fulfillments || []) {
        console.log(`  fulfillment ${ful.id}: ${ful.status} | tracking_company=${ful.tracking_company} | numbers=${JSON.stringify(ful.tracking_numbers)} | url=${ful.tracking_urls?.[0] || ''}`);
    }
})();
