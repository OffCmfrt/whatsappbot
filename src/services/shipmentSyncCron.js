const cron = require('node-cron');
const shipmentSyncService = require('./shipmentSyncService');

class ShipmentSyncCron {
    init() {
        console.log('⏰ Initializing Shipment Status Sync Cron...');

        // Every 30 minutes: poll carriers for active shipments and advance
        // statuses (pickup_scheduled → in_transit → delivered / rto) smartly
        cron.schedule('*/30 * * * *', async () => {
            console.log('🚚 Running Shipment Status Sync...');
            try {
                const result = await shipmentSyncService.syncActiveShipments({ limit: 100 });
                if (!result.skipped) {
                    console.log(`✅ Shipment sync done: ${result.checked} checked, ${result.updated} updated`);
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
