// One-off: detailed status of the 31 unfulfilled orders in Shoppers Hub DB
// (store_shoppers + orders tables)
require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');

const orderIds = [
    42323, 42293, 42156, 42077, 41699, 41690, 41642, 41627, 41603, 41595,
    41542, 41519, 41518, 41505, 41490, 41459, 41447, 41433, 41426, 41414,
    41409, 41399, 41382, 41294, 41224, 41197, 41184, 41179, 41153, 41144,
    40945,
];

(async () => {
    await initializeDatabase();

    console.log(`\n=== SHOPPERS HUB STATUS (store_shoppers + orders) ===\n`);
    for (const num of orderIds) {
        // order_id may be stored as "#42323" or "42323"
        const shoppers = await dbAdapter.query(`
            SELECT s.id, s.phone, s.name, s.order_id, s.status, s.payment_method, s.source,
                   s.delivery_type, s.created_at, s.updated_at,
                   o.awb, o.status AS o_status, o.courier_name, o.total, o.payment_method AS o_payment,
                   o.delivered_at, o.shiprocket_order_id
            FROM store_shoppers s
            LEFT JOIN orders o ON o.order_id = s.order_id
            WHERE s.order_id = $1 OR s.order_id = $2
            ORDER BY s.created_at ASC
        `, [`#${num}`, `${num}`]);

        const rows = Array.isArray(shoppers) ? shoppers : (shoppers?.rows || []);
        if (!rows.length) {
            console.log(`#${num}: ❌ NOT in store_shoppers`);
            continue;
        }
        for (const r of rows) {
            console.log(
                `#${num}: shopper#${r.id} | ${r.name || '-'} | ${r.phone} | shopper_status=${r.status} | ` +
                `payment=${r.payment_method || r.o_payment || '-'} | src=${r.source} | ` +
                `created=${String(r.created_at).slice(0, 16)} | ` +
                `order_tbl: awb=${r.awb || 'NONE'} courier=${r.courier_name || 'NONE'} status=${r.o_status || 'NONE'} delivered=${r.delivered_at ? String(r.delivered_at).slice(0, 10) : '-'} | total=${r.total || '-'}`
            );
        }
    }

    // Also check shipments table (if any shipment record exists for these)
    try {
        const ships = await dbAdapter.query(`
            SELECT order_id, awb, courier, status FROM shipments
            WHERE order_id = ANY($1)
        `, [orderIds.map(String)]);
        const srows = Array.isArray(ships) ? ships : (ships?.rows || []);
        if (srows.length) {
            console.log(`\n=== shipments table matches ===`);
            for (const r of srows) console.log(`${r.order_id}: awb=${r.awb} courier=${r.courier} status=${r.status}`);
        }
    } catch (e) {
        // shipments table may not exist / different columns — ignore
    }

    process.exit(0);
})();
