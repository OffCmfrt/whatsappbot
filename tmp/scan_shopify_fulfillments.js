// Full scan: every confirmed-no-AWB shopper → check Shopify fulfillments.
// Writes results to tmp/shopify_fulfilled.json for the sync step.
require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const { initializeDatabase, dbAdapter } = require('../src/database/db');

const store = process.env.SHOPIFY_STORE.replace('.myshopify.com', '');
const base = `https://${store}.myshopify.com/admin/api/2025-01`;
const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    await initializeDatabase();
    const confirmed = await dbAdapter.query(`
        SELECT s.id, s.order_id, s.name
        FROM store_shoppers s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.status = 'confirmed'
          AND NOT COALESCE((o.awb IS NOT NULL OR o.status = 'shipped'), false)
          AND s.created_at >= '2026-07-25'
        ORDER BY s.created_at ASC
    `);
    console.log(`Scanning ${confirmed.length} pending orders against Shopify fulfillments…\n`);

    const fulfilled = [];
    const unfulfilled = [];
    const missing = [];
    let errors = 0;

    for (let i = 0; i < confirmed.length; i++) {
        const { order_id } = confirmed[i];
        try {
            const r = await axios.get(`${base}/orders.json`, { headers, params: { name: order_id, status: 'any' }, timeout: 20000 });
            const order = r.data?.orders?.[0];
            if (!order) { missing.push(order_id); console.log(`${i + 1}/${confirmed.length} ${order_id}: not on Shopify`); await sleep(300); continue; }

            const f = await axios.get(`${base}/orders/${order.id}/fulfillments.json`, { headers, timeout: 20000 });
            const fuls = (f.data?.fulfillments || []).filter(x => x.status !== 'cancelled' && (x.tracking_numbers || []).length > 0);
            if (fuls.length === 0) {
                unfulfilled.push(order_id);
            } else {
                // newest fulfillment first
                const ful = fuls.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
                const awb = ful.tracking_numbers[0];
                fulfilled.push({ order_id, shopper_id: confirmed[i].id, awb, company: ful.tracking_company || null, status: ful.status, fulfilled_at: ful.created_at });
                console.log(`${i + 1}/${confirmed.length} ${order_id}: ✅ ${ful.tracking_company} ${awb}`);
            }
        } catch (e) {
            errors++;
            console.log(`${i + 1}/${confirmed.length} ${order_id}: ERR ${e.response?.status || e.message}`);
        }
        await sleep(300);
        if ((i + 1) % 50 === 0) process.stderr.write(`… ${i + 1} done\n`);
    }

    fs.writeFileSync('tmp/shopify_fulfilled.json', JSON.stringify({ fulfilled, unfulfilled, missing, errors }, null, 2));
    console.log(`\n📊 Fulfilled with AWB: ${fulfilled.length} | Unfulfilled: ${unfulfilled.length} | Not on Shopify: ${missing.length} | Errors: ${errors}`);
    console.log('Results → tmp/shopify_fulfilled.json');
})();
