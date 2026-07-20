const cron = require('node-cron');
const shiprocketService = require('../services/shiprocketService');
const Order = require('../models/Order');
const Customer = require('../models/Customer');

class OrderSyncService {
    constructor() {
        this.isRunning = false;
        this.lastSyncTime = null;
    }

    // Start automatic sync (runs every hour)
    startAutoSync() {
        console.log('🔄 Starting automatic order sync...');

        // Run every hour
        cron.schedule('0 * * * *', async () => {
            console.log('⏰ Running scheduled order sync...');
            await this.syncRecentOrders();
        });

        // Also run immediately on startup
        this.syncRecentOrders();
    }

    // Sync orders from last 7 days
    async syncRecentOrders() {
        if (this.isRunning) {
            console.log('⏭️  Sync already running, skipping...');
            return;
        }

        this.isRunning = true;

        try {
            console.log('🔄 Fetching recent orders from Shiprocket...');

            // Authenticate with Shiprocket
            await shiprocketService.ensureAuthenticated();

            // Get orders from last 7 days
            const orders = await this.fetchRecentShiprocketOrders(7);

            console.log(`📦 Found ${orders.length} orders from Shiprocket`);

            let stats = {
                new: 0,
                updated: 0,
                skipped: 0,
                errors: 0
            };

            // Process each order
            for (const shiprocketOrder of orders) {
                try {
                    await this.processOrder(shiprocketOrder, stats);
                } catch (error) {
                    console.error(`❌ Error processing order ${shiprocketOrder.id}:`, error.message);
                    stats.errors++;
                }
            }

            this.lastSyncTime = new Date();

            console.log('\n✅ Order sync completed!');
            console.log(`   New: ${stats.new} | Updated: ${stats.updated} | Skipped: ${stats.skipped} | Errors: ${stats.errors}`);

        } catch (error) {
            console.error('❌ Order sync failed:', error.message);
        } finally {
            this.isRunning = false;
        }
    }

    // Fetch orders from Shiprocket
    async fetchRecentShiprocketOrders(days = 7) {
        try {
            const axios = require('axios');

            // Calculate date range
            const toDate = new Date();
            const fromDate = new Date();
            fromDate.setDate(fromDate.getDate() - days);

            const response = await axios.get(
                `${shiprocketService.baseURL}/orders`,
                {
                    headers: {
                        'Authorization': `Bearer ${shiprocketService.token}`,
                        'Content-Type': 'application/json'
                    },
                    params: {
                        filter_by_date: `${fromDate.toISOString().split('T')[0]} to ${toDate.toISOString().split('T')[0]}`
                    }
                }
            );

            return response.data.data || [];
        } catch (error) {
            console.error('Error fetching Shiprocket orders:', error.message);
            return [];
        }
    }

    // Process individual order
    async processOrder(shiprocketOrder, stats) {
        const orderId = shiprocketOrder.channel_order_id || shiprocketOrder.id.toString();
        const customerPhone = this.formatPhone(shiprocketOrder.customer_phone);

        // Check if order already exists
        const existingOrder = await Order.findByOrderId(orderId);

        if (existingOrder) {
            // Update existing order if status changed
            if (existingOrder.status !== shiprocketOrder.status) {
                await Order.updateStatus(orderId, shiprocketOrder.status, {
                    awb: shiprocketOrder.awb_code,
                    courier_name: shiprocketOrder.courier_name,
                    expected_delivery: shiprocketOrder.etd
                });

                console.log(`🔄 Updated order: ${orderId} (${shiprocketOrder.status})`);
                stats.updated++;
            } else {
                stats.skipped++;
            }
            return;
        }

        // Create or get customer
        const customer = await Customer.getOrCreate(
            customerPhone,
            shiprocketOrder.customer_name
        );

        if (!customer) {
            console.log(`⚠️  Could not create customer for order ${orderId}`);
            stats.errors++;
            return;
        }

        // Extract tags from Shiprocket order data
        // Tags can be in various formats: string, array, or object
        let tags = null;
        if (shiprocketOrder.tags) {
            if (typeof shiprocketOrder.tags === 'string') {
                tags = shiprocketOrder.tags;
            } else if (Array.isArray(shiprocketOrder.tags)) {
                tags = shiprocketOrder.tags.join(',');
            } else if (typeof shiprocketOrder.tags === 'object') {
                tags = JSON.stringify(shiprocketOrder.tags);
            }
        } else if (shiprocketOrder.order_tags) {
            if (typeof shiprocketOrder.order_tags === 'string') {
                tags = shiprocketOrder.order_tags;
            } else if (Array.isArray(shiprocketOrder.order_tags)) {
                tags = shiprocketOrder.order_tags.join(',');
            }
        } else if (shiprocketOrder.label) {
            tags = shiprocketOrder.label;
        }

        // Create new order
        const newOrder = await Order.create({
            order_id: orderId,
            customer_phone: customerPhone,
            shiprocket_order_id: shiprocketOrder.id.toString(),
            awb: shiprocketOrder.awb_code,
            status: shiprocketOrder.status,
            courier_name: shiprocketOrder.courier_name,
            product_name: shiprocketOrder.products?.[0]?.name,
            order_date: shiprocketOrder.created_at,
            expected_delivery: shiprocketOrder.etd,
            tags: tags
        });

        if (newOrder) {
            console.log(`✅ Created new order: ${orderId} for ${customerPhone}`);
            stats.new++;
        } else {
            stats.errors++;
        }
    }

    // Format phone number
    formatPhone(phone) {
        if (!phone) return null;

        // Remove all non-digit characters
        let cleaned = phone.toString().replace(/\D/g, '');

        // Standardize to 91XXXXXXXXXX
        let cleanPhone = cleaned;
        if (cleaned.length === 10) cleanPhone = '91' + cleaned;
        else if (cleaned.length > 10) cleanPhone = cleaned.slice(-10).padStart(12, '91');

        return cleanPhone;
    }

    // Manual sync trigger (for admin dashboard)
    async triggerManualSync() {
        console.log('🔄 Manual sync triggered');
        await this.syncRecentOrders();
        return {
            success: true,
            lastSyncTime: this.lastSyncTime
        };
    }

    // Get sync status
    getSyncStatus() {
        return {
            isRunning: this.isRunning,
            lastSyncTime: this.lastSyncTime
        };
    }
}

// Export singleton instance
module.exports = new OrderSyncService();
