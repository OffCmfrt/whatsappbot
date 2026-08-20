require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');
(async () => {
    await initializeDatabase();
    const ids = ['40547','40551','40608','40651','41468','41489','41686','33467','37900','34809'];
    const rows = await dbAdapter.query(
        `SELECT order_id, carrier, awb, courier_name, status, created_at FROM shipments WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY order_id, id DESC`,
        ids
    );
    console.log(`\nLocal shipments for Custom-channel SR orders:`);
    for (const r of rows) console.log(`   order=${r.order_id} carrier=${r.carrier} awb=${r.awb} courier="${r.courier_name}" status=${r.status} ${String(r.created_at).substring(0,16)}`);
    process.exit(0);
})().catch(e => { console.error('💥', e.message); process.exit(1); });
