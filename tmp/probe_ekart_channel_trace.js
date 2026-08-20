// Diagnostic: recent local shipments shipped via Shiprocket with Ekart courier,
// then check each order's channel at Shiprocket.
require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');
const shiprocketService = require('../src/services/shiprocketService');
const axios = require('axios');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

async function main() {
    await initializeDatabase();

    const rows = await dbAdapter.query(`
        SELECT id, order_id, carrier, awb, courier_name, status, created_at
        FROM shipments
        WHERE created_at >= NOW() - INTERVAL '10 days'
          AND courier_name ILIKE '%ekart%'
        ORDER BY created_at DESC
        LIMIT 15
    `);
    console.log(`\nLocal shipments w/ Ekart courier (last 10d): ${rows.length}`);
    for (const r of rows) {
        console.log(`   #${r.id} order=${r.order_id} carrier=${r.carrier} awb=${r.awb} courier="${r.courier_name}" status=${r.status} ${String(r.created_at).substring(0, 16)}`);
    }

    // For shiprocket-carrier ones, check the channel at Shiprocket
    const srRows = rows.filter(r => r.carrier === 'shiprocket');
    if (srRows.length === 0) { console.log('\n(no shiprocket-carrier Ekart shipments to trace)'); process.exit(0); }

    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };

    const ch = await axios.get(`${BASE}/channels`, { headers, timeout: 20000 });
    const channelMap = {};
    for (const c of ch.data?.data || []) channelMap[String(c.id)] = c.name;

    console.log('\n=== Shiprocket-side channel for these orders ===');
    for (const r of srRows) {
        try {
            const res = await axios.get(`${BASE}/orders`, { headers, params: { search: r.order_id, per_page: 10 }, timeout: 20000 });
            const orders = res.data?.data || [];
            if (orders.length === 0) { console.log(`   order ${r.order_id}: NOT FOUND at Shiprocket`); continue; }
            for (const o of orders) {
                console.log(`   order ${r.order_id}: sr_id=${o.id} channel=${channelMap[String(o.channel_id)] || o.channel_id} awb=${o.awb_code || '—'} courier=${o.courier_name || '—'} status=${o.status} created=${String(o.created_at).substring(0, 16)}`);
            }
        } catch (e) {
            console.log(`   order ${r.order_id}: lookup failed ${e.response?.status}`);
        }
    }
    process.exit(0);
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
