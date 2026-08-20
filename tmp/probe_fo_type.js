require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

(async () => {
    // which of these orders have fulfillments already, and any fulfillment_order hint
    for (const name of ['39725', '41041', '38464']) {
        const r = await axios.get(`${base}/orders.json`, { headers, params: { name, status: 'any' }, timeout: 20000 });
        const o = r.data?.orders?.[0];
        if (!o) { console.log(`${name}: not found`); continue; }
        console.log(`\n${name}: id=${o.id} fulfillment_status=${o.fulfillment_status} created=${o.created_at} source=${o.source_name}`);
        const f = await axios.get(`${base}/orders/${o.id}/fulfillments.json`, { headers, timeout: 20000 });
        for (const ful of f.data?.fulfillments || []) {
            console.log(`  ful ${ful.id}: ${ful.status} ${ful.tracking_company} ${JSON.stringify(ful.tracking_numbers)} fo=${ful.fulfillment_order || '—'}`);
        }
    }
    // try GraphQL order display to spot app-linked fulfillment hints
    const g = await axios.post(`${base}/graphql.json`, { query: `
        { orders(first: 1, query: "name:42390") { edges { node { name fulfilmentOrders: id } } } }` }, { headers, timeout: 20000 });
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 300)); process.exit(1); });
