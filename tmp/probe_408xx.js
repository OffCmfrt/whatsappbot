require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');
(async () => {
    await initializeDatabase();
    const rows = await dbAdapter.query(`
        SELECT DISTINCT ON (order_id) order_id, carrier, awb, courier_name, status
        FROM shipments
        WHERE order_id ~ '^(40826|40830|40831|40832|40843|40845|40850|40868|40892|40904|40953|40992|41006)$'
          AND status NOT IN ('failed','cancelled')
        ORDER BY order_id, id DESC
    `);
    for (const r of rows) console.log(`   order=${r.order_id} carrier=${r.carrier} awb=${r.awb} courier="${r.courier_name}" status=${r.status}`);
    process.exit(0);
})().catch(e => { console.error('💥', e.message); process.exit(1); });
