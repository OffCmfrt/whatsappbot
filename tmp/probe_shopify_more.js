// Sample more pending orders from Shopify: do they all carry fulfillments with AWBs?
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const store = process.env.SHOPIFY_STORE.replace('.myshopify.com', '');
const base = `https://${store}.myshopify.com/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const sample = ['39643', '39657', '39663', '39740', '39777'];
    for (const name of sample) {
        try {
            const r = await axios.get(`${base}/orders.json`, { headers, params: { name, status: 'any' }, timeout: 20000 });
            const order = r.data?.orders?.[0];
            if (!order) { console.log(`${name}: no shopify order`); continue; }
            const f = await axios.get(`${base}/orders/${order.id}/fulfillments.json`, { headers, timeout: 20000 });
            const fuls = f.data?.fulfillments || [];
            if (fuls.length === 0) { console.log(`${name}: UNFULFILLED (${order.fulfillment_status})`); continue; }
            for (const ful of fuls) {
                console.log(`${name}: ${ful.status} | ${ful.tracking_company} | ${JSON.stringify(ful.tracking_numbers)}`);
            }
        } catch (e) {
            console.log(`${name}: ERR ${e.response?.status || e.message}`);
        }
        await sleep(500);
    }

    // Track the AWB found for 39628 at Ekart
    const ekt = getAdapter('ekart');
    const t = await ekt.track('LUAP0001376744');
    console.log('\ntrack LUAP0001376744:', t.success, '→', JSON.stringify(t.data?.currentStatus || t.data?.status || t.error || '').substring(0, 200));
})();
