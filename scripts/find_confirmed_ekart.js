/**
 * Find all "confirmed" shoppers since July 25 (no AWB) and sync with Ekart
 */
require('dotenv').config();
const { dbAdapter, initializeDatabase } = require('../src/database/db');

async function main() {
    await initializeDatabase();

    const shippedExpr = `(o.awb IS NOT NULL OR o.status = 'shipped')`;

    // 1. Find all confirmed shoppers since July 25 with NO shipment
    const confirmedShoppers = await dbAdapter.query(`
        SELECT s.id, s.phone, s.order_id, s.status, s.created_at,
               o.awb, o.status AS order_status, o.courier_name, o.total
        FROM store_shoppers s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.status = 'confirmed'
          AND NOT COALESCE(${shippedExpr}, false)
          AND s.created_at >= '2026-07-25'
        ORDER BY s.created_at ASC
    `) || [];

    console.log(`\n🔴 CONFIRMED shoppers (no AWB) since July 25: ${confirmedShoppers.length}\n`);
    for (const r of confirmedShoppers) {
        console.log(`  shopper#${r.id} | order: ${r.order_id} | phone: ${r.phone} | order_awb: ${r.awb || 'NONE'} | courier: ${r.courier_name || 'NONE'} | date: ${r.created_at}`);
    }

    // 2. Group by date
    const byDate = await dbAdapter.query(`
        SELECT TO_CHAR(DATE(s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') as date,
               COUNT(*) as cnt
        FROM store_shoppers s
        LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.status = 'confirmed'
          AND NOT COALESCE(${shippedExpr}, false)
          AND s.created_at >= '2026-07-25'
        GROUP BY DATE(s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')
        ORDER BY date ASC
    `) || [];

    console.log(`\n📊 Confirmed (no AWB) by date:\n`);
    for (const r of byDate) {
        console.log(`  ${r.date}: ${r.cnt} confirmed`);
    }

    // 3. Check Ekart shipments for these orders
    if (confirmedShoppers.length > 0) {
        const orderIds = confirmedShoppers.map(s => s.order_id);
        const placeholders = orderIds.map((_, i) => `$${i + 1}`).join(',');
        const ekartShipments = await dbAdapter.query(`
            SELECT sh.order_id, sh.awb, sh.status, sh.error_message, sh.created_at
            FROM shipments sh
            WHERE sh.carrier = 'ekart'
              AND sh.order_id IN (${placeholders})
            ORDER BY sh.created_at DESC
        `, orderIds) || [];

        console.log(`\n📦 Ekart shipments for these orders: ${ekartShipments.length}\n`);
        for (const s of ekartShipments) {
            console.log(`  ${s.order_id} | AWB: ${s.awb || 'NONE'} | status: ${s.status} | error: ${s.error_message || 'none'}`);
        }
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
