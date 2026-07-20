const cron = require('node-cron');
const reengagementService = require('./reengagementService');

class ReengagementCron {
    init() {
        console.log('⏰ Initializing Support Ticket Re-engagement Cron Job...');

        // Run every 30 minutes to check for tickets needing re-engagement
        cron.schedule('*/30 * * * *', async () => {
            console.log('🔄 Checking for support tickets needing re-engagement...');
            try {
                await reengagementService.checkAndSendReengagement();
                            
                // Log memory usage for monitoring
                const used = process.memoryUsage();
                console.log(`[MEMORY] After reengagement cron - RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
            } catch (error) {
                console.error('❌ Error in re-engagement cron:', error);
            }
        });

        console.log('✅ Re-engagement Cron Job Scheduled (Every 30 mins)');
    }
}

module.exports = new ReengagementCron();
