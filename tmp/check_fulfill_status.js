// One-off: check a list of order IDs on Shopify — fulfilled? which carrier? which AWB?
require('dotenv').config();
const axios = require('axios');

const store = process.env.SHOPIFY_STORE.replace('.myshopify.com', '');
const base = `https://${store}.myshopify.com/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const orderIds = [
    42323, 42293, 42156, 42077, 41699, 41690, 41642, 41638, 41627, 41603,
    41595, 41567, 41542, 41519, 41518, 41505, 41490, 41488, 41459, 41447,
    41433, 41428, 41426, 41425, 41414, 41409, 41404, 41403, 41402, 41399,
    41389, 41382, 41381, 41365, 41361, 41359, 41357, 41353, 41311, 41294,
    41288, 41224, 41223, 40945, 41011, 41197, 41184, 41179, 41153, 41144,
    41142, 41138, 41137, 41129,
];

(async () => {
    const fulfilled = [], unfulfilled = [], missing = [], errors = [];

    for (let i = 0; i < orderIds.length; i++) {
        const id = orderIds[i];
        const name = `#${id}`;
        try {
            const r = await axios.get(`${base}/orders.json`, { headers, params: { name, status: 'any' }, timeout: 20000 });
            const order = r.data?.orders?.[0];
            if (!order) {
                missing.push(id);
                console.log(`${i + 1}/${orderIds.length} ${id}: ❌ not found on Shopify`);
            } else {
                const f = await axios.get(`${base}/orders/${order.id}/fulfillments.json`, { headers, timeout: 20000 });
                const fuls = (f.data?.fulfillments || []).filter(x => x.status !== 'cancelled');
                if (fuls.length === 0) {
                    unfulfilled.push({ id, fulfillment_status: order.fulfillment_status });
                    console.log(`${i + 1}/${orderIds.length} ${id}: ⏳ NOT fulfilled (order status: ${order.fulfillment_status || 'pending'})`);
                } else {
                    for (const ful of fuls) {
                        const awbs = (ful.tracking_numbers || []).join(', ') || '(no tracking)';
                        fulfilled.push({ id, carrier: ful.tracking_company || 'unknown', awb: awbs, status: ful.status, created_at: ful.created_at });
                        console.log(`${i + 1}/${orderIds.length} ${id}: ✅ ${ful.tracking_company || 'unknown carrier'} | AWB ${awbs} | ${ful.status} | ${ful.created_at}`);
                    }
                }
            }
        } catch (e) {
            errors.push({ id, err: e.response?.status || e.message });
            console.log(`${i + 1}/${orderIds.length} ${id}: ⚠️ ERR ${e.response?.status || e.message}`);
        }
        await sleep(350);
    }

    console.log(`\n📊 Fulfilled: ${fulfilled.length} | Unfulfilled: ${unfulfilled.length} | Not found: ${missing.length} | Errors: ${errors.length}`);
    if (unfulfilled.length) console.log('Unfulfilled IDs:', unfulfilled.map(x => x.id).join(', '));
    if (missing.length) console.log('Not found IDs:', missing.join(', '));
    if (errors.length) console.log('Errors:', JSON.stringify(errors));
})();
