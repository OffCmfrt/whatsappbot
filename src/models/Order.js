const { dbAdapter } = require('../database/db');
const { caches, cachedQuery, generateQueryKey, invalidateCache } = require('../utils/cache');

class Order {
    // Find order by order ID
    static async findByOrderId(orderId) {
        try {
            // Check cache first
            const cacheKey = `order:${orderId}`;
            const cached = caches.orders.get(cacheKey);
            if (cached) {
                return cached;
            }

            const orders = await dbAdapter.select('orders', { order_id: orderId }, { limit: 1 });
            const order = orders[0] || null;
            
            // Cache the result
            if (order) {
                caches.orders.set(cacheKey, order);
            }
            
            return order;
        } catch (error) {
            console.error('Error finding order:', error);
            return null;
        }
    }

    // Find orders by customer phone
    static async findByCustomerPhone(phone) {
        try {
            return await dbAdapter.select('orders', { customer_phone: phone }, { orderBy: 'created_at DESC' });
        } catch (error) {
            console.error('Error finding orders by phone:', error);
            return [];
        }
    }

    // Create new order
    static async create(orderData) {
        try {
            return await dbAdapter.insert('orders', {
                order_id: orderData.order_id,
                customer_phone: orderData.customer_phone,
                shiprocket_order_id: orderData.shiprocket_order_id || null,
                awb: orderData.awb || null,
                status: orderData.status || 'pending',
                courier_name: orderData.courier_name || null,
                product_name: orderData.product_name || null,
                order_date: orderData.order_date || new Date(),
                expected_delivery: orderData.expected_delivery || null,
                total: orderData.total || null,
                payment_method: orderData.payment_method || null,
                tracking_url: orderData.tracking_url || null,
                tags: orderData.tags || null
            });
        } catch (error) {
            console.error('Error creating order:', error);
            return null;
        }
    }

    // Update order status
    static async updateStatus(orderId, status, additionalData = {}) {
        try {
            // Guard against stale order-level RTO. Shiprocket's ORDER-level
            // status feed (used by orderSyncService / order handlers) can show
            // "rto_initiated" from a transient NDR even while the parcel is
            // still moving. The shipments row is driven by live AWB tracking
            // and is authoritative, so never let an order-level RTO overwrite
            // an order whose shipment is still in an active (non-terminal)
            // state. Legitimate RTO still flows through syncOrderRowStatus,
            // which mirrors only after the shipment itself goes terminal.
            const normStatus = String(status || '').toLowerCase().replace(/[\s-]+/g, '_');
            if (normStatus.startsWith('rto')) {
                const ACTIVE = ['created', 'awb_assigned', 'pickup_scheduled', 'shipped', 'in_transit', 'out_for_delivery'];
                const shipRows = await dbAdapter.query(
                    `SELECT status FROM shipments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
                    [orderId]
                );
                const shipStatus = shipRows[0] && String(shipRows[0].status || '').toLowerCase();
                if (shipStatus && ACTIVE.includes(shipStatus)) {
                    console.log(`🛡️ Blocked stale order-level RTO (${status}) for order ${orderId}: shipment is "${shipStatus}" (still moving)`);
                    return await this.findByOrderId(orderId);
                }
            }

            const updateData = {
                status,
                updated_at: new Date(),
                ...additionalData
            };

            await dbAdapter.update('orders', updateData, { order_id: orderId });
            return await this.findByOrderId(orderId);
        } catch (error) {
            console.error('Error updating order:', error);
            return null;
        }
    }

    // Get order count
    static async getCount() {
        try {
            return await cachedQuery(
                'stats',
                'order_count',
                async () => {
                    const result = await dbAdapter.query('SELECT COUNT(*) as count FROM orders');
                    return result[0]?.count || 0;
                },
                5 * 60 * 1000 // 5 minutes TTL
            );
        } catch (error) {
            console.error('Error getting order count:', error);
            return 0;
        }
    }

    // Get all orders (for admin dashboard)
    static async getAll(limit = 100, offset = 0) {
        try {
            const sql = `SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            return await dbAdapter.query(sql, [limit, offset]);
        } catch (error) {
            console.error('Error getting all orders:', error);
            return [];
        }
    }
}

module.exports = Order;
