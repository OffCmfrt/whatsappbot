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
        WHERE created_at >= NOW() - INTERVAL '6 days'
          AND carrier IN ('shiprocket','delhivery')
          AND status NOT IN ('failed','cancelled')
        ORDER BY created_at DESC LIMIT 20
    `);
    console.log(`\nRecent shiprocket/delhivery shipments: ${rows.length}`);
    for (const r of rows) console.log(`   #${r.id} order=${r.order_id} carrier=${r.carrier} awb=${r.awb} courier="${r.courier_name}" status=${r.status} ${String(r.created_at).substring(0,16)}`);

    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };
    const ch = await axios.get(`${BASE}/channels`, { headers, timeout: 20000 });
    const channelMap = {};
    for (const c of ch.data?.data || []) channelMap[String(c.id)] = c.name;

    console.log('\n=== Shiprocket-side channels ===');
    for (const r of rows) {
        try {
            const res = await axios.get(`${BASE}/orders`, { headers, params: { search: r.order_id, per_page: 10 }, timeout: 20000 });
            const orders = res.data?.data || [];
            if (!orders.length) { console.log(`   order ${r.order_id}: NOT FOUND`); continue; }
            for (const o of orders) console.log(`   order ${r.order_id}: sr_id=${o.id} channel=${channelMap[String(o.channel_id)] || o.channel_id} awb=${o.awb_code || '—'} courier=${o.courier_name || '—'} status=${o.status}`);
        } catch (e) { console.log(`   order ${r.order_id}: failed ${e.response?.status}`); }
    }
    process.exit(0);
}
main().catch(e => { console.error('💥', e.message); process.exit(1); });
