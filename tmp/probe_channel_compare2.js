require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

(async () => {
    const g = await axios.post(`${base}/graphql.json`, { query: `
        { orders(first: 5, query: "name:42390 OR name:41011 OR name:42043 OR name:38464 OR name:40608") { edges { node {
            name
            channelInformation { displayName }
            displayFulfillmentStatus
        } } } }` }, { headers, timeout: 20000 });
    if (g.data?.errors) { console.log('errors:', JSON.stringify(g.data.errors, null, 1)); process.exit(0); }
    for (const e of g.data?.data?.orders?.edges || []) {
        const o = e.node;
        console.log(`${o.name}: channel=${o.channelInformation?.displayName || '(null → "Offline")'} fulfillment=${o.displayFulfillmentStatus}`);
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 400)); process.exit(1); });
