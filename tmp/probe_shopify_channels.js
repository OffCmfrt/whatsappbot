require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

(async () => {
    // Publication/sales channel list
    try {
        const p = await axios.get(`${base}/publications.json`, { headers, timeout: 20000 });
        console.log('Publications (sales channels):');
        for (const pub of p.data?.publications || []) console.log(`  id=${pub.id} name="${pub.name}" app_id=${pub.app_id}`);
    } catch (e) { console.log('publications failed:', e.response?.status); }

    // GraphQL: order.publications + publication names for 42390
    const g = await axios.post(`${base}/graphql.json`, { query: `
        { orders(first: 1, query: "name:42390") { edges { node {
            name
            sourceDisplayName
            channelInformation { handle displayName }
        } } } }` }, { headers, timeout: 20000 });
    console.log('\nGraphQL order channel info:', JSON.stringify(g.data?.data?.orders?.edges?.[0]?.node || g.data?.errors, null, 1));
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 300)); process.exit(1); });
