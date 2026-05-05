const { dbAdapter } = require('../database/db');

class AbandonedCart {
    // Create new abandoned cart (with upsert to handle duplicate webhooks)
    static async create(cartData) {
        try {
            // First, try to find existing cart
            const existing = await this.findByCheckoutId(cartData.checkout_id);
            
            if (existing) {
                // Update existing cart instead of inserting
                await this.updateStatus(cartData.checkout_id, existing.status, {
                    customer_phone: cartData.customer_phone,
                    customer_name: cartData.customer_name || existing.customer_name,
                    customer_email: cartData.customer_email || existing.customer_email,
                    cart_items: JSON.stringify(cartData.cart_items),
                    total_amount: cartData.total_amount,
                    currency: cartData.currency || existing.currency,
                    cart_url: cartData.cart_url || existing.cart_url,
                    updated_at: new Date().toISOString()
                });
                console.log(`🔄 Updated existing abandoned cart for ${cartData.customer_phone} (checkout: ${cartData.checkout_id})`);
                return existing;
            }
            
            // Insert new cart
            return await dbAdapter.insert('abandoned_carts', {
                checkout_id: cartData.checkout_id,
                customer_phone: cartData.customer_phone,
                customer_name: cartData.customer_name || null,
                customer_email: cartData.customer_email || null,
                cart_items: JSON.stringify(cartData.cart_items),
                total_amount: cartData.total_amount,
                currency: cartData.currency || 'INR',
                cart_url: cartData.cart_url,
                status: 'pending',
                created_at: new Date().toISOString()
            });
        } catch (error) {
            // Handle race condition: another webhook already inserted
            if (error.code === 'SQLITE_CONSTRAINT' || (error.message && error.message.includes('UNIQUE constraint'))) {
                console.log(`⚡ Race condition detected for checkout ${cartData.checkout_id} - updating instead`);
                try {
                    await this.updateStatus(cartData.checkout_id, 'pending', {
                        customer_phone: cartData.customer_phone,
                        cart_items: JSON.stringify(cartData.cart_items),
                        total_amount: cartData.total_amount,
                        updated_at: new Date().toISOString()
                    });
                    return { checkout_id: cartData.checkout_id, status: 'pending' };
                } catch (updateError) {
                    console.error('Error updating abandoned cart after constraint:', updateError);
                    throw updateError;
                }
            }
            console.error('Error creating abandoned cart:', error);
            throw error;
        }
    }

    // Find by checkout ID
    static async findByCheckoutId(checkoutId) {
        try {
            const carts = await dbAdapter.select('abandoned_carts', { checkout_id: checkoutId }, { limit: 1 });
            return carts[0] || null;
        } catch (error) {
            console.error('Error finding abandoned cart:', error);
            return null;
        }
    }

    // Find recent cart by phone number (Fallback for Order Recovery)
    static async findRecentByPhone(phone, hoursAgo = 48) {
        try {
            const timeAgo = new Date(Date.now() - (hoursAgo * 60 * 60 * 1000)).toISOString();

            const sql = `
                SELECT * FROM abandoned_carts 
                WHERE customer_phone = ? 
                AND status IN ('pending', 'sent_first', 'sent_second') 
                AND created_at >= ?
                ORDER BY created_at DESC LIMIT 1
            `;
            const carts = await dbAdapter.query(sql, [phone, timeAgo]);
            return carts[0] || null;
        } catch (error) {
            console.error('Error finding recent cart by phone:', error);
            return null;
        }
    }

    // Find recent cart by email (Alternative Fallback for Order Recovery)
    static async findRecentByEmail(email, hoursAgo = 48) {
        try {
            if (!email) return null;
            const timeAgo = new Date(Date.now() - (hoursAgo * 60 * 60 * 1000)).toISOString();

            const sql = `
                SELECT * FROM abandoned_carts 
                WHERE customer_email = ? 
                AND status IN ('pending', 'sent_first', 'sent_second') 
                AND created_at >= ?
                ORDER BY created_at DESC LIMIT 1
            `;
            const carts = await dbAdapter.query(sql, [email, timeAgo]);
            return carts[0] || null;
        } catch (error) {
            console.error('Error finding recent cart by email:', error);
            return null;
        }
    }

    static async updateStatus(checkoutId, status, additionalData = {}) {
        try {
            const updateData = {
                status,
                updated_at: new Date().toISOString(),
                ...additionalData
            };
            await dbAdapter.update('abandoned_carts', updateData, { checkout_id: checkoutId });
            return true;
        } catch (error) {
            console.error('Error updating abandoned cart status:', error);
            return false;
        }
    }

    // Get pending carts for reminder
    static async getPendingFirstReminders(hoursAgo = 1) {
        try {
            const targetTime = new Date(Date.now() - (hoursAgo * 60 * 60 * 1000)).toISOString();
            const lookbackTime = new Date(Date.now() - ((hoursAgo + 24) * 60 * 60 * 1000)).toISOString();

            const sql = `
                SELECT * FROM abandoned_carts 
                WHERE status = 'pending' 
                AND created_at <= ? 
                AND created_at > ?
            `;
            return await dbAdapter.query(sql, [targetTime, lookbackTime]);
        } catch (error) {
            console.error('Error getting pending first reminders:', error);
            return [];
        }
    }

    // Get pending second reminders
    static async getPendingSecondReminders(hoursAgo = 24) {
        try {
            const targetTime = new Date(Date.now() - (hoursAgo * 60 * 60 * 1000)).toISOString();
            const lookbackTime = new Date(Date.now() - ((hoursAgo + 48) * 60 * 60 * 1000)).toISOString();

            const sql = `
                SELECT * FROM abandoned_carts 
                WHERE status = 'sent_first' 
                AND created_at <= ?
                AND created_at > ?
            `;
            return await dbAdapter.query(sql, [targetTime, lookbackTime]);
        } catch (error) {
            console.error('Error getting pending second reminders:', error);
            return [];
        }
    }

    // Expire old carts
    static async expireOldCarts(days = 7) {
        try {
            const daysAgo = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();

            const sql = `
                UPDATE abandoned_carts 
                SET status = 'expired', expired_at = CURRENT_TIMESTAMP 
                WHERE status IN ('pending', 'sent_first', 'sent_second') 
                AND created_at < ?
            `;
            await dbAdapter.query(sql, [daysAgo]);
        } catch (error) {
            console.error('Error expiring old carts:', error);
        }
    }
}

module.exports = AbandonedCart;
