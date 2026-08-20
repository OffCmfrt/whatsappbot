/**
 * Diagnostic: Show ALL Ekart shipments from July 25 - Aug 1 with their statuses
 */
require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');

async function main() {
    await initializeDatabase();

    // 1. All Ekart shipments in the date range
    const { rows: ekartShipments } = await dbAdapter.query(`
        SELECT s.id, s.order_id, s.awb, s.status, s.created_at, s.updated_at,
               o.status AS order_status
        FROM shipments s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.carrier = 'ekart'
          AND s.created_at >= '2026-07-25'
        ORDER BY s.created_at ASC
    `);

    console.log(`\n📦 ALL Ekart shipments since July 25: ${ekartShipments.length}\n`);
    if (ekartShipments.length > 0) {
        console.log(
            '#'.padEnd(5), 'Order ID'.padEnd(24), 'AWB'.padEnd(18),
            'Ship Status'.padEnd(18), 'Order Status'.padEnd(18), 'Created'
        );
        console.log('─'.repeat(100));
        for (const r of ekartShipments) {
            console.log(
                String(r.id).padEnd(5),
                String(r.order_id).padEnd(24),
                String(r.awb || 'NO-AWB').padEnd(18),
                String(r.status).padEnd(18),
                String(r.order_status || '—').padEnd(18),
                String(r.created_at).substring(0, 16)
            );
        }
    }

    // 2. Orders that are still "confirmed" with Ekart AWB
    const { rows: confirmedOrders } = await dbAdapter.query(`
        SELECT o.order_id, o.status, o.awb, o.courier_name, o.order_date,
               s.id AS shipment_id, s.status AS ship_status
        FROM orders o
        LEFT JOIN shipments s ON s.order_id = o.order_id AND s.carrier = 'ekart'
        WHERE o.status = 'confirmed'
          AND o.courier_name ILIKE '%ekart%'
          AND o.order_date >= '2026-07-25'
        ORDER BY o.order_date ASC
    `);

    console.log(`\n\n🔴 Orders still "confirmed" with Ekart courier: ${confirmedOrders.length}\n`);
    if (confirmedOrders.length > 0) {
        console.log(
            'Order ID'.padEnd(24), 'Order Status'.padEnd(14), 'AWB'.padEnd(18),
            'Courier'.padEnd(14), 'Ship Status'.padEnd(14), 'Order Date'
        );
        console.log('─'.repeat(100));
        for (const r of confirmedOrders) {
            console.log(
                String(r.order_id).padEnd(24),
                String(r.status).padEnd(14),
                String(r.awb || 'NO-AWB').padEnd(18),
                String(r.courier_name || '—').padEnd(14),
                String(r.ship_status || 'NO-SHIP').padEnd(14),
                String(r.order_date || '—').substring(0, 10)
            );
        }
    }

    // 3. Also check orders with status 'confirmed' that have a shipment but no courier match
    const { rows: confirmedNoCourier } = await dbAdapter.query(`
        SELECT o.order_id, o.status, o.awb, o.courier_name, o.order_date,
               s.id AS shipment_id, s.carrier, s.awb AS ship_awb, s.status AS ship_status
        FROM orders o
        LEFT JOIN shipments s ON s.order_id = o.order_id
        WHERE o.status = 'confirmed'
          AND o.order_date >= '2026-07-25'
          AND s.id IS NOT NULL
        ORDER BY o.order_date ASC
    `);

    console.log(`\n\n🟡 All "confirmed" orders with ANY shipment since July 25: ${confirmedNoCourier.length}\n`);
    if (confirmedNoCourier.length > 0) {
        console.log(
            'Order ID'.padEnd(24), 'AWB'.padEnd(18), 'Courier'.padEnd(14),
            'Ship Carrier'.padEnd(14), 'Ship AWB'.padEnd(18), 'Ship Status'.padEnd(14)
        );
        console.log('─'.repeat(100));
        for (const r of confirmedNoCourier) {
            console.log(
                String(r.order_id).padEnd(24),
                String(r.awb || 'NO-AWB').padEnd(18),
                String(r.courier_name || '—').padEnd(14),
                String(r.carrier || '—').padEnd(14),
                String(r.ship_awb || 'NO-AWB').padEnd(18),
                String(r.ship_status || '—').padEnd(14)
            );
        }
    }

    process.exit(0);
}

main().catch(err => { console.error('💥', err); process.exit(1); });
