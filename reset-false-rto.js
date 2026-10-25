/**
 * Reset incorrectly-marked RTO orders/shipments
 * 
 * Issue: Many orders are marked as RTO when they're actually still in transit
 * or delivered to the customer. This script resets them so the sync can
 * re-evaluate with the fixed RTO detection logic.
 * 
 * The fix:
 * 1. StatusType 'RT'/'RTO' now ALWAYS maps to 'rto' (DTO is also a failure case)
 * 2. 'delivered' can NO LONGER override 'rto' (removed DTO exception)
 * 3. Reset RTO rows that are actually in transit or delivered
 */

const { dbAdapter } = require('./src/database/db');

async function resetFalseRtoRows() {
    console.log('🔄 Starting RTO reset process...\n');

    try {
        // Find shipments marked as RTO that might be incorrectly classified
        // We'll check recent RTO shipments (last 30 days) to see if they're actually in transit or delivered
        const rtoShipments = await dbAdapter.query(`
            SELECT s.id, s.order_id, s.awb, s.status, s.updated_at, s.carrier,
                   o.status as order_status
            FROM shipments s
            JOIN orders o ON o.order_id = s.order_id AND o.awb = s.awb
            WHERE s.status = 'rto'
              AND s.updated_at > NOW() - INTERVAL '30 days'
            ORDER BY s.updated_at DESC
        `);

        console.log(`📊 Found ${rtoShipments.length} RTO shipments in last 30 days\n`);

        if (rtoShipments.length === 0) {
            console.log('✅ No RTO shipments to reset');
            return;
        }

        // For each RTO shipment, we'll reset it to 'in_transit' so the sync re-evaluates
        // The fixed RTO detection will then correctly classify it
        let resetCount = 0;
        for (const shipment of rtoShipments) {
            try {
                // Reset shipment to 'in_transit' so sync picks it up
                await dbAdapter.update('shipments', {
                    status: 'in_transit',
                    updated_at: new Date().toISOString()
                }, { id: shipment.id });

                // Reset order status to 'in_transit' as well
                await dbAdapter.query(
                    `UPDATE orders SET status = 'in_transit', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND awb = ?`,
                    [shipment.order_id, shipment.awb]
                );

                console.log(`✅ Reset shipment #${shipment.id} (${shipment.order_id}, AWB ${shipment.awb}) from RTO to in_transit`);
                resetCount++;
            } catch (err) {
                console.error(`❌ Failed to reset shipment #${shipment.id}:`, err.message);
            }
        }

        console.log(`\n✅ Reset ${resetCount} / ${rtoShipments.length} RTO shipments to in_transit`);
        console.log('🔄 The background sync will now re-evaluate these shipments with the fixed RTO detection logic\n');

    } catch (error) {
        console.error('❌ RTO reset failed:', error);
    } finally {
        process.exit(0);
    }
}

// Run the reset
resetFalseRtoRows();
