const shiprocketService = require('./shiprocketService');
const { dbAdapter } = require('../database/db');

class ReturnService {    /**
     * Create a return request (Pending Approval)
     * Used by Website/Portal
     */
    async createReturnRequest(orderId, items, reason, customerDetails) {
        try {
            // Generate unique return ID
            const returnId = `RET-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

            // Calculate refund amount
            const refundAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

            // Save return in database with pending status
            await dbAdapter.insert('returns', {
                return_id: returnId,
                order_id: orderId,
                customer_phone: customerDetails.phone,
                items: JSON.stringify(items),
                reason: reason,
                status: 'pending_approval', // Pending Admin Approval
                shiprocket_return_id: null,
                refund_amount: refundAmount,
                refund_status: 'pending'
            });

            return {
                success: true,
                returnId: returnId,
                message: 'Return request submitted successfully. We will review and confirm shortly.'
            };
        } catch (error) {
            console.error('Create return request error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Approve Return Request (Admin Dashboard)
     * Triggers Shiprocket creation
     */
    async approveReturn(returnId) {
        try {
            // Get return request
            const returns = await dbAdapter.select('returns', { return_id: returnId }, { limit: 1 });
            const returnRequest = returns[0];

            if (!returnRequest) throw new Error('Return request not found');
            if (returnRequest.status !== 'pending_approval') {
                return { success: false, message: `Return is already ${returnRequest.status}` };
            }

            const items = JSON.parse(returnRequest.items);

            // Get order details from Shiprocket (or DB if we stored full address)
            // We need address for pickup, which Shiprocket API needs
            const orderDetails = await shiprocketService.getOrderDetails(returnRequest.order_id);
            if (!orderDetails.success) throw new Error('Original order not found in Shiprocket');

            // Create return in Shiprocket
            const shiprocketReturn = await this.createShiprocketReturn(
                orderDetails.order,
                items,
                returnRequest.reason
            );

            if (!shiprocketReturn.success) throw new Error('Failed to create return in Shiprocket: ' + shiprocketReturn.error);

            // Schedule pickup
            const pickup = await this.schedulePickup(
                shiprocketReturn.returnId,
                orderDetails.order.pickup_location, // Use configured pickup location
                this.getNextPickupDate()
            );

            // Update status to initiated/approved
            await dbAdapter.update('returns', {
                status: 'approved',
                shiprocket_return_id: shiprocketReturn.returnId,
                pickup_scheduled_date: pickup.pickupDate,
                updated_at: new Date().toISOString()
            }, { return_id: returnId });

            return {
                success: true,
                message: `Return approved and scheduled for pickup on ${pickup.pickupDate}`
            };

        } catch (error) {
            console.error('Approve return error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Reject Return Request
     */
    async rejectReturn(returnId, rejectionReason) {
        try {
            await dbAdapter.update('returns', {
                status: 'rejected',
                // We might want a 'rejection_reason' column, or append to notes. For now, just status.
                // reason: rejectionReason, // schema doesn't have rejection_reason, maybe update reason field?
                updated_at: new Date().toISOString()
            }, { return_id: returnId });

            return { success: true, message: 'Return request rejected' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Create an exchange request (Pending Approval)
     */
    async createExchangeRequest(orderId, oldItems, newItems, reason, customerDetails) {
        try {
            // Generate unique exchange ID
            const exchangeId = `EXC-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

            // Calculate price difference
            const oldTotal = oldItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const newTotal = newItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const priceDifference = newTotal - oldTotal;

            // Save exchange in database
            await dbAdapter.insert('exchanges', {
                exchange_id: exchangeId,
                order_id: orderId,
                customer_phone: customerDetails.phone,
                old_items: JSON.stringify(oldItems),
                new_items: JSON.stringify(newItems),
                reason: reason,
                price_difference: priceDifference,
                payment_status: priceDifference > 0 ? 'pending' : 'not_required',
                status: 'pending_approval' // Pending Admin Approval
            });

            return {
                success: true,
                exchangeId: exchangeId,
                message: 'Exchange request submitted. We will review shortly.'
            };
        } catch (error) {
            console.error('Create exchange request error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Approve Exchange Request
     */
    async approveExchange(exchangeId) {
        try {
            const exchanges = await dbAdapter.select('exchanges', { exchange_id: exchangeId }, { limit: 1 });
            const exchange = exchanges[0];

            if (!exchange) throw new Error('Exchange not found');
            if (exchange.status !== 'pending_approval') return { success: false, message: 'Already processed' };

            // Logic:
            // 1. If payment needed, send link? Or just mark as 'payment_pending' and let user pay?
            // 2. If no payment, schedule pickup for OLD items.

            // For now, let's assume we approve implies "Proceed".
            // If payment required, we might just update status to 'approved_payment_pending'
            // If no payment, we trigger return of old items?

            // Let's stick to: Approve -> If no payment, initiate return. If payment, wait for payment.
            // Actually, keep it simple: Update status to 'approved'.
            // Then the user completes payment (if needed) separately, or we trigger logic.

            let newStatus = 'approved';
            let message = 'Exchange approved.';

            if (exchange.payment_status === 'not_required' || exchange.payment_status === 'completed') {
                // Trigger Shiprocket Return for Old Items immediately?
                // Or wait for "Complete Exchange" flow?
                // Current completeExchange does the work.
                // So Approve just means "Admin said okay".
            }

            await dbAdapter.update('exchanges', {
                status: newStatus,
                updated_at: new Date().toISOString()
            }, { exchange_id: exchangeId });

            return { success: true, message };

        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Reject Exchange Request
     */
    async rejectExchange(exchangeId, reason) {
        try {
            await dbAdapter.update('exchanges', {
                status: 'rejected',
                updated_at: new Date().toISOString()
            }, { exchange_id: exchangeId });
            return { success: true, message: 'Exchange rejected' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Keep existing createReturn for backward compatibility or WhatsApp auto-flow
    // But modify it to use createReturnRequest + approveReturn if we want unified logic?
    // For now, simpler to leave createReturn as "Direct Mode" used by WhatsApp if desired,
    // Or users can switch WhatsApp to use createReturnRequest if they want approval there too.

    /**
     * Create a return request (Direct - Legacy/WhatsApp)
     */
    async createReturn(orderId, items, reason, customerDetails) {
        try {
            // Generate unique return ID
            const returnId = `RET-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

            // Get order details from Shiprocket
            const orderDetails = await shiprocketService.getOrderDetails(orderId);
            if (!orderDetails.success) {
                throw new Error('Order not found in Shiprocket');
            }

            // Create return in Shiprocket
            const shiprocketReturn = await this.createShiprocketReturn(
                orderDetails.order,
                items,
                reason
            );

            if (!shiprocketReturn.success) {
                throw new Error('Failed to create return in Shiprocket');
            }

            // Calculate refund amount
            const refundAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

            // Save return in database
            await dbAdapter.insert('returns', {
                return_id: returnId,
                order_id: orderId,
                customer_phone: customerDetails.phone,
                items: JSON.stringify(items), // Store as JSON string for SQLite/text column
                reason: reason,
                status: 'initiated',
                shiprocket_return_id: shiprocketReturn.returnId,
                refund_amount: refundAmount,
                refund_status: 'pending'
            });

            // Schedule pickup
            const pickup = await this.schedulePickup(
                shiprocketReturn.returnId,
                customerDetails.address,
                this.getNextPickupDate()
            );

            return {
                success: true,
                returnId: returnId,
                shiprocketReturnId: shiprocketReturn.returnId,
                pickupDate: pickup.pickupDate,
                refundAmount: refundAmount,
                message: `Return request created successfully. Pickup scheduled for ${pickup.pickupDate}.`
            };
        } catch (error) {
            console.error('Create return error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Create an exchange request (Direct - Legacy/WhatsApp)
     */
    async createExchange(orderId, oldItems, newItems, reason, customerDetails) {
        try {
            // Generate unique exchange ID
            const exchangeId = `EXC-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

            // Calculate price difference
            const oldTotal = oldItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const newTotal = newItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const priceDifference = newTotal - oldTotal;

            // Save exchange in database
            await dbAdapter.insert('exchanges', {
                exchange_id: exchangeId,
                order_id: orderId,
                customer_phone: customerDetails.phone,
                old_items: JSON.stringify(oldItems),
                new_items: JSON.stringify(newItems),
                reason: reason,
                price_difference: priceDifference,
                payment_status: priceDifference > 0 ? 'pending' : 'not_required',
                status: 'initiated'
            });

            return {
                success: true,
                exchangeId: exchangeId,
                priceDifference: priceDifference,
                paymentRequired: priceDifference > 0,
                refundDue: priceDifference < 0,
                message: priceDifference > 0
                    ? `Exchange initiated. Please pay ₹${priceDifference} to proceed.`
                    : priceDifference < 0
                        ? `Exchange initiated. You'll receive ₹${Math.abs(priceDifference)} refund.`
                        : 'Exchange initiated. No payment required.'
            };
        } catch (error) {
            console.error('Create exchange error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Complete exchange after payment
     */
    async completeExchange(exchangeId, paymentLinkId) {
        try {
            // Get exchange details
            const exchanges = await dbAdapter.select('exchanges', { exchange_id: exchangeId }, { limit: 1 });
            const exchange = exchanges[0];

            if (!exchange) {
                throw new Error('Exchange not found');
            }

            // Get order details
            const orderDetails = await shiprocketService.getOrderDetails(exchange.order_id);
            if (!orderDetails.success) {
                throw new Error('Order not found');
            }

            // Parse existing items if they are strings (SQLite)
            const oldItems = typeof exchange.old_items === 'string' ? JSON.parse(exchange.old_items) : exchange.old_items;

            // Create return for old items in Shiprocket
            const shiprocketReturn = await this.createShiprocketReturn(
                orderDetails.order,
                oldItems,
                exchange.reason
            );

            // Schedule pickup for old items
            const pickup = await this.schedulePickup(
                shiprocketReturn.returnId,
                orderDetails.order.pickup_location,
                this.getNextPickupDate()
            );

            // Update exchange record
            await dbAdapter.update('exchanges', {
                payment_link_id: paymentLinkId,
                payment_status: 'completed',
                status: 'pickup_scheduled',
                shiprocket_exchange_id: shiprocketReturn.returnId,
                pickup_scheduled_date: pickup.pickupDate,
                updated_at: new Date().toISOString()
            }, { exchange_id: exchangeId });

            return {
                success: true,
                pickupDate: pickup.pickupDate,
                message: 'Exchange confirmed! Pickup scheduled for old items. New items will ship after quality check.'
            };
        } catch (error) {
            console.error('Complete exchange error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Create return in Shiprocket
     */
    async createShiprocketReturn(order, items, reason) {
        try {
            const token = await shiprocketService.getToken();

            const returnData = {
                order_id: order.id,
                order_date: order.created_at,
                channel_id: order.channel_id,
                pickup_customer_name: order.customer_name,
                pickup_customer_phone: order.customer_phone,
                pickup_address: order.customer_address,
                pickup_city: order.customer_city,
                pickup_state: order.customer_state,
                pickup_pincode: order.customer_pincode,
                return_items: items.map(item => ({
                    sku: item.sku,
                    name: item.name,
                    units: item.quantity,
                    selling_price: item.price
                })),
                return_reason: reason
            };

            let response;
            let result;
            const maxRetries = 3;

            for (let i = 0; i < maxRetries; i++) {
                try {
                    response = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/return', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(returnData)
                    });

                    result = await response.json();

                    if (!response.ok) {
                        throw new Error(result.message || 'Shiprocket return creation failed');
                    }
                    break; // Success! exit loop
                } catch (error) {
                    if (i === maxRetries - 1) throw error; // Failed all retries
                    const delay = 1000 * Math.pow(2, i);
                    console.warn(`⚠️ Shiprocket Return Creation failed. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            return {
                success: true,
                returnId: result.order_id,
                awb: result.awb_code
            };
        } catch (error) {
            console.error('Shiprocket return creation error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Schedule pickup
     */
    async schedulePickup(returnId, address, pickupDate) {
        try {
            const token = await shiprocketService.getToken();

            const pickupData = {
                order_id: returnId,
                pickup_date: pickupDate
            };

            let response;
            let result;
            const maxRetries = 3;

            for (let i = 0; i < maxRetries; i++) {
                try {
                    response = await fetch('https://apiv2.shiprocket.in/v1/external/courier/assign/awb', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(pickupData)
                    });

                    result = await response.json();

                    if (!response.ok) {
                        // Shiprocket often returns non-ok status for pickup scheduling if it's already scheduled, or generic errors
                        if (result.message && result.message.toLowerCase().includes('already')) {
                            break; // Consider it a success if already scheduled
                        }
                        throw new Error(result.message || 'Failed to schedule pickup');
                    }
                    break; // Success
                } catch (error) {
                    if (i === maxRetries - 1) {
                        // Fallback: If scheduling fails, don't crash the whole return process
                        // We can complete the return in our DB and admin can schedule pickup manually
                        console.error('❌ Failed to schedule pickup after retries:', error.message);
                        return {
                            success: true,
                            pickupDate: pickupDate,
                            awb: 'PENDING_MANUAL_SCHEDULING',
                            warning: 'Pickup scheduling timed out. Please schedule manually via Shiprocket panel.'
                        };
                    }
                    const delay = 1000 * Math.pow(2, i);
                    console.warn(`⚠️ Pickup Scheduling failed. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            return {
                success: true,
                pickupDate: pickupDate,
                awb: result.awb_code
            };
        } catch (error) {
            console.error('Pickup scheduling error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get return status
     */
    async getReturnStatus(returnId) {
        try {
            const returns = await dbAdapter.select('returns', { return_id: returnId }, { limit: 1 });
            const returnRecord = returns[0];

            if (!returnRecord) {
                throw new Error('Return not found');
            }

            // Parse JSON fields if necessary
            if (returnRecord.items && typeof returnRecord.items === 'string') {
                returnRecord.items = JSON.parse(returnRecord.items);
            }

            return {
                success: true,
                return: returnRecord
            };
        } catch (error) {
            console.error('Get return status error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get exchange status
     */
    async getExchangeStatus(exchangeId) {
        try {
            const exchanges = await dbAdapter.select('exchanges', { exchange_id: exchangeId }, { limit: 1 });
            const exchangeRecord = exchanges[0];

            if (!exchangeRecord) {
                throw new Error('Exchange not found');
            }

            // Parse JSON fields
            if (exchangeRecord.old_items && typeof exchangeRecord.old_items === 'string') {
                exchangeRecord.old_items = JSON.parse(exchangeRecord.old_items);
            }
            if (exchangeRecord.new_items && typeof exchangeRecord.new_items === 'string') {
                exchangeRecord.new_items = JSON.parse(exchangeRecord.new_items);
            }

            return {
                success: true,
                exchange: exchangeRecord
            };
        } catch (error) {
            console.error('Get exchange status error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Check if order is eligible for return/exchange
     */
    async checkEligibility(orderId) {
        try {
            const orders = await dbAdapter.select('orders', { order_id: orderId }, { limit: 1 });
            const order = orders[0];

            if (!order) {
                return {
                    eligible: false,
                    reason: 'Order not found'
                };
            }

            if (order.status !== 'delivered') {
                return {
                    eligible: false,
                    reason: 'Order must be delivered to initiate return/exchange'
                };
            }

            // Check if within 7-day window
            const deliveredDate = new Date(order.order_date); // Using order_date as proxy if delivered_at missing
            // Ideally we should have a delivered_at column, checking if it exists or using updated_at
            const today = new Date();
            const daysSinceDelivery = Math.floor((today - deliveredDate) / (1000 * 60 * 60 * 24));

            if (daysSinceDelivery > 7) {
                return {
                    eligible: false,
                    reason: 'Return/exchange window has expired (7 days from delivery)'
                };
            }

            return {
                eligible: true,
                daysRemaining: 7 - daysSinceDelivery,
                order: order
            };
        } catch (error) {
            console.error('Eligibility check error:', error);
            return {
                eligible: false,
                reason: 'Error checking eligibility'
            };
        }
    }

    /**
     * Get next available pickup date
     */
    getNextPickupDate() {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
    }

    /**
     * Update return status
     */
    async updateReturnStatus(returnId, status, notes = {}) {
        try {
            await dbAdapter.update('returns', {
                status: status,
                updated_at: new Date().toISOString(),
                ...notes
            }, { return_id: returnId });

            return { success: true };
        } catch (error) {
            console.error('Update return status error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Update exchange status
     */
    async updateExchangeStatus(exchangeId, status, notes = {}) {
        try {
            await dbAdapter.update('exchanges', {
                status: status,
                updated_at: new Date().toISOString(),
                ...notes
            }, { exchange_id: exchangeId });

            return { success: true };
        } catch (error) {
            console.error('Update exchange status error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = new ReturnService();
