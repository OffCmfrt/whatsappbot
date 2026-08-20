require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

(async () => {
    // 42043 = shiprocket/Delhivery shipped; 42390 = ekart; 41011 = ekart
    const g = await axios.post(`${base}/graphql.json`, { query: `
        { orders(first: 5, query: "name:42390 OR name:41011 OR name:42043 OR name:38464 OR name:40608") { edges { node {
            name
            channelInformation { displayName }
            fulfilments: fulfillments(first: 1) { edges { node { id } } }
        } } } }` }, { headers, timeout: 20000 });
    const rows = g.data?.data?.orders?.edges?.map(e => e.node) || g.data?.errors;
    if (Array.isArray(rows)) {
        for (const o of rows) console.log(`${o.name}: channel=${o.channelInformation?.displayName || '(null → Shopify shows "Offline")'} fulfilled=${o.fulfilments.edges.length > 0}`);
    } else console.log(JSON.stringify(rows, null, 1));
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 300)); process.exit(1); });
