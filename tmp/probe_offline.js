require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

(async () => {
    for (const name of ['42390', '41923', '41041']) {
        const r = await axios.get(`${base}/orders.json`, { headers, params: { name, status: 'any' }, timeout: 20000 });
        const o = r.data?.orders?.[0];
        if (!o) { console.log(`${name}: not found`); continue; }
        console.log(`\n=== ${o.name} ===`);
        console.log('fulfillment_status:', o.fulfillment_status, '| created:', o.created_at, '| source:', o.source_name, '| app_id:', o.app_id);
        console.log('client_details:', JSON.stringify(o.client_details || {}));
        const f = await axios.get(`${base}/orders/${o.id}/fulfillments.json`, { headers, timeout: 20000 });
        for (const ful of f.data?.fulfillments || []) {
            console.log(`fulfillment ${ful.id}: status=${ful.status} company=${ful.tracking_company} numbers=${JSON.stringify(ful.tracking_numbers)}`);
            console.log(`   service="${ful.fulfillment_service || ''}" origin=${ful.origin_location_id || '—'} created=${ful.created_at} updated=${ful.updated_at}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 300)); process.exit(1); });
