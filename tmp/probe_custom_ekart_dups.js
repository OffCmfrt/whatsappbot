// Cross-check every Custom-channel order at Shiprocket against local Ekart
// shipments and Shopify-channel duplicates.
require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');
const shiprocketService = require('../src/services/shiprocketService');
const axios = require('axios');
const BASE = 'https://apiv2.shiprocket.in/v1/external';
const CUSTOM_CHANNEL = '10215536';

(async () => {
    await initializeDatabase();
    const ekart = await dbAdapter.query(`
        SELECT DISTINCT ON (order_id) order_id, awb, status FROM shipments
        WHERE carrier = 'ekart' AND awb IS NOT NULL AND status NOT IN ('failed','cancelled')
        ORDER BY order_id, id DESC
    `);
    const ekartMap = new Map(ekart.map(r => [String(r.order_id), r]));
    console.log(`Local Ekart shipments (with AWB): ${ekartMap.size}`);

    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}` };

    // Walk every Custom-channel order (all statuses via no status filter)
    const custom = [];
    for (let page = 1; page <= 20; page++) {
        const res = await axios.get(`${BASE}/orders`, { headers, params: { channel_id: CUSTOM_CHANNEL, per_page: 100, page }, timeout: 20000 });
        const rows = res.data?.data || [];
        custom.push(...rows);
        if (rows.length < 100) break;
    }
    console.log(`Custom-channel orders at Shiprocket: ${custom.length}\n`);

    const ekartDups = custom.filter(o => ekartMap.has(String(o.channel_order_id).replace(/^#/, '')));
    console.log(`Custom-channel rows that duplicate EKART orders: ${ekartDups.length}`);
    for (const o of ekartDups) {
        console.log(`   ${String(o.channel_order_id).padEnd(10)} sr_id=${o.id} awb=${o.awb_code || '—'} status=${o.status} created=${String(o.created_at).substring(0,16)}`);
    }

    // Also: how many Custom rows are returns/REQ vs plain vs -C
    const req = custom.filter(o => /^REQ-/i.test(o.channel_order_id || ''));
    const dashC = custom.filter(o => /-C$/i.test(o.channel_order_id || ''));
    const plain = custom.filter(o => !/^REQ-/i.test(o.channel_order_id || '') && !/-C$/i.test(o.channel_order_id || ''));
    console.log(`\nBreakdown: REQ-* returns=${req.length}, *-C exchanges=${dashC.length}, plain=${plain.length}`);
    console.log('Plain ids:', plain.map(o => `${o.channel_order_id}(${o.id},${o.status},${o.awb_code || '—'})`).join(' '));
    process.exit(0);
})().catch(e => { console.error('💥', e.response?.status || '', JSON.stringify(e.response?.data || e.message).substring(0, 300)); process.exit(1); });
