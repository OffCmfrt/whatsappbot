const cron = require('node-cron');
const abandonedCartService = require('./abandonedCartService');

class AbandonedCartCron {
    init() {
        console.log('⏰ Initializing Abandoned Cart Cron Jobs...');

        // Run every 30 minutes (reduced from 15 to save database reads)
        cron.schedule('*/30 * * * *', async () => {
            console.log('🏗️ Running Abandoned Cart Reminder Check...');
            try {
                await abandonedCartService.processReminders();
                
                // Log memory usage for monitoring
                const used = process.memoryUsage();
                console.log(`[MEMORY] After abandoned cart cron - RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
            } catch (error) {
                console.error('❌ Error in abandoned cart cron:', error);
            }
        });

        console.log('✅ Abandoned Cart Cron Jobs Scheduled (Every 30 mins)');
    }
}

module.exports = new AbandonedCartCron();
