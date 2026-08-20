require('dotenv').config();
const axios = require('axios');
const base = `https://${process.env.SHOPIFY_STORE}/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };

(async () => {
    for (const name of ['42390', '40608']) {
        const r = await axios.get(`${base}/orders.json`, { headers, params: { name, status: 'any' }, timeout: 20000 });
        const order = r.data?.orders?.[0];
        if (!order) { console.log(`${name}: not found`); continue; }
        console.log(`\n=== Shopify ${order.name} ===`);
        console.log('fulfillment_status:', order.fulfillment_status, '| financial:', order.financial_status);
        console.log('source_name:', order.source_name, '| app_id:', order.app_id, '| tags:', order.tags);
        const f = await axios.get(`${base}/orders/${order.id}/fulfillments.json`, { headers, timeout: 20000 });
        for (const ful of f.data?.fulfillments || []) {
            console.log(`fulfillment ${ful.id}: status=${ful.status} company=${ful.tracking_company} numbers=${JSON.stringify(ful.tracking_numbers)} service=${ful.fulfillment_service || ''} origin=${ful.origin_location_id || ''} created=${ful.created_at}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('failed:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 400)); process.exit(1); });
