const cron = require('node-cron');
const shipmentSyncService = require('./shipmentSyncService');

class ShipmentSyncCron {
    init() {
        console.log('⏰ Initializing Shipment Status Sync Cron...');

        // Every 30 minutes: poll carriers for active shipments and advance
        // statuses (pickup_scheduled → in_transit → delivered / rto) smartly.
        //
        // rtoLimit is a SEPARATE budget from limit so the in-window RTO
        // self-heal set can never be starved by the active backlog. Sizing:
        // the in-window RTO population is currently ~270 rows, so 100 per
        // cycle gives every one of them a recheck every ~2.7 cycles — i.e. a
        // false RTO clears within ~80 min instead of waiting behind ~1,870
        // active rows for ~10.7 h. Raising it to 200 would halve that latency
        // again but double the carrier calls spent on settled returns (only
        // ~22 of the ~270 are under a week old), so 100 is the balance point.
        cron.schedule('*/30 * * * *', async () => {
            console.log('🚚 Running Shipment Status Sync...');
            try {
                const result = await shipmentSyncService.syncActiveShipments({ limit: 100, rtoLimit: 100 });
                if (!result.skipped) {
                    console.log(`✅ Shipment sync done: ${result.checked} checked (${result.activeChecked} active + ${result.rtoChecked} RTO recheck), ${result.updated} updated`);
                }

                // Log memory usage for monitoring
                const used = process.memoryUsage();
                console.log(`[MEMORY] After shipment sync cron - RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
            } catch (error) {
                console.error('❌ Error in shipment sync cron:', error);
            }
        });

        console.log('✅ Shipment Status Sync Cron Scheduled (Every 30 mins)');
    }
}

module.exports = new ShipmentSyncCron();
