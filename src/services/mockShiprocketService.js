/**
 * Mock Shiprocket Service for Development/Testing
 * Returns realistic fake data without requiring real Shiprocket credentials
 * Replace with real shiprocketService.js when you have actual credentials
 */

class MockShiprocketService {
    constructor() {
        this.baseURL = 'https://apiv2.shiprocket.in/v1/external';
        this.token = 'MOCK_TOKEN_FOR_TESTING';
        this.tokenExpiry = Date.now() + (10 * 24 * 60 * 60 * 1000);

        // Mock order database
        this.mockOrders = {
            'ORD-2024-001': {
                id: 12345,
                channel_order_id: 'ORD-2024-001',
                awb_code: '1234567890',
                courier_name: 'Delhivery',
                status: 'DELIVERED',
                status_code: 6,
                customer_name: 'John Doe',
                customer_phone: '919876543210',
                customer_email: 'john@example.com',
                shipping_address: '123 MG Road, Mumbai, Maharashtra - 400001',
                products: [
                    {
                        name: 'Premium T-Shirt - Black',
                        sku: 'TSH-BLK-M',
                        quantity: 2,
                        price: 599
                    }
                ],
                created_at: '2024-02-01T10:30:00Z',
                pickup_scheduled_date: '2024-02-02T14:00:00Z',
                delivered_date: '2024-02-05T16:45:00Z',
                etd: '2024-02-06',
                payment_method: 'Prepaid',
                total: 1198,
                weight: 0.5,
                shipments: []
            },
            'ORD-2024-002': {
                id: 12346,
                channel_order_id: 'ORD-2024-002',
                awb_code: '0987654321',
                courier_name: 'BlueDart',
                status: 'IN TRANSIT',
                status_code: 5,
                customer_name: 'Jane Smith',
                customer_phone: '919123456789',
                customer_email: 'jane@example.com',
                shipping_address: '456 Park Street, Delhi, Delhi - 110001',
                products: [
                    {
                        name: 'Hoodie - Grey',
                        sku: 'HOD-GRY-L',
                        quantity: 1,
                        price: 899
                    }
                ],
                created_at: '2024-02-03T09:15:00Z',
                pickup_scheduled_date: '2024-02-04T11:00:00Z',
                delivered_date: null,
                etd: '2024-02-07',
                payment_method: 'COD',
                total: 899,
                weight: 0.7,
                shipments: []
            },
            'ORD-2024-003': {
                id: 12347,
                channel_order_id: 'ORD-2024-003',
                awb_code: '5555666677',
                courier_name: 'DTDC',
                status: 'PICKED UP',
                status_code: 4,
                customer_name: 'Raj Kumar',
                customer_phone: '919988776655',
                customer_email: 'raj@example.com',
                shipping_address: '789 Brigade Road, Bangalore, Karnataka - 560001',
                products: [
                    {
                        name: 'Jeans - Blue',
                        sku: 'JNS-BLU-32',
                        quantity: 1,
                        price: 1299
                    }
                ],
                created_at: '2024-02-05T14:20:00Z',
                pickup_scheduled_date: '2024-02-06T10:00:00Z',
                delivered_date: null,
                etd: '2024-02-09',
                payment_method: 'Prepaid',
                total: 1299,
                weight: 0.6,
                shipments: []
            }
        };

        // Mock tracking data
        this.mockTracking = {
            '1234567890': {
                awb_code: '1234567890',
                current_status: 'Delivered',
                courier_name: 'Delhivery',
                shipped_date: '2024-02-02',
                delivered_date: '2024-02-05',
                edd: '2024-02-06',
                shipment_track: [
                    {
                        date: '2024-02-05',
                        time: '16:45',
                        location: 'Mumbai',
                        activity: 'Delivered',
                        sr_status_label: 'Delivered'
                    },
                    {
                        date: '2024-02-05',
                        time: '09:30',
                        location: 'Mumbai',
                        activity: 'Out for delivery',
                        sr_status_label: 'Out For Delivery'
                    },
                    {
                        date: '2024-02-04',
                        time: '18:20',
                        location: 'Mumbai Hub',
                        activity: 'Reached destination hub',
                        sr_status_label: 'In Transit'
                    },
                    {
                        date: '2024-02-03',
                        time: '14:15',
                        location: 'Delhi Hub',
                        activity: 'In transit',
                        sr_status_label: 'In Transit'
                    },
                    {
                        date: '2024-02-02',
                        time: '14:00',
                        location: 'Delhi',
                        activity: 'Picked up',
                        sr_status_label: 'Picked Up'
                    }
                ]
            },
            '0987654321': {
                awb_code: '0987654321',
                current_status: 'In Transit',
                courier_name: 'BlueDart',
                shipped_date: '2024-02-04',
                delivered_date: null,
                edd: '2024-02-07',
                shipment_track: [
                    {
                        date: '2024-02-05',
                        time: '12:30',
                        location: 'Delhi Hub',
                        activity: 'In transit to destination',
                        sr_status_label: 'In Transit'
                    },
                    {
                        date: '2024-02-04',
                        time: '11:00',
                        location: 'Delhi',
                        activity: 'Picked up',
                        sr_status_label: 'Picked Up'
                    }
                ]
            }
        };

        console.log('⚠️  Using MOCK Shiprocket Service (for testing only)');
    }

    // Mock authentication
    async authenticate() {
        console.log('✅ Mock Shiprocket authentication successful');
        return this.token;
    }

    // Ensure authenticated (mock)
    async ensureAuthenticated() {
        // Always authenticated in mock mode
        return true;
    }

    // Get order status by order ID
    async getOrderStatus(orderId) {
        try {
            console.log(`📦 Mock: Fetching order ${orderId}`);

            const orderData = this.mockOrders[orderId];

            if (!orderData) {
                console.log(`❌ Mock: Order ${orderId} not found`);
                return null;
            }

            return this.formatOrderStatus(orderData);
        } catch (error) {
            console.error('Mock error:', error.message);
            return null;
        }
    }

    // Get tracking by AWB
    async getTrackingByAWB(awb) {
        try {
            console.log(`📍 Mock: Fetching tracking for AWB ${awb}`);

            const trackingData = this.mockTracking[awb];

            if (!trackingData) {
                console.log(`❌ Mock: AWB ${awb} not found`);
                return null;
            }

            return { tracking_data: trackingData };
        } catch (error) {
            console.error('Mock error:', error.message);
            return null;
        }
    }

    // Get orders by phone
    async getOrdersByPhone(phone) {
        try {
            console.log(`📱 Mock: Fetching orders for ${phone}`);

            // Return orders matching phone
            const orders = Object.values(this.mockOrders).filter(
                order => order.customer_phone === phone
            );

            return orders;
        } catch (error) {
            console.error('Mock error:', error.message);
            return [];
        }
    }

    // Format order status
    formatOrderStatus(orderData) {
        if (!orderData) return null;

        return {
            orderId: orderData.id,
            channelOrderId: orderData.channel_order_id,
            awb: orderData.awb_code,
            courierName: orderData.courier_name,
            status: orderData.status,
            statusCode: orderData.status_code,
            customerName: orderData.customer_name,
            customerPhone: orderData.customer_phone,
            shippingAddress: orderData.shipping_address,
            products: orderData.products,
            orderDate: orderData.created_at,
            pickupDate: orderData.pickup_scheduled_date,
            deliveredDate: orderData.delivered_date,
            expectedDelivery: orderData.etd,
            paymentMethod: orderData.payment_method,
            total: orderData.total,
            weight: orderData.weight,
            shipments: orderData.shipments || []
        };
    }

    // Get tracking timeline
    async getTrackingTimeline(awb) {
        const tracking = await this.getTrackingByAWB(awb);

        if (!tracking || !tracking.tracking_data) {
            return [];
        }

        const timeline = tracking.tracking_data.shipment_track || [];

        return timeline.map(event => ({
            date: event.date,
            time: event.time,
            location: event.location,
            activity: event.activity,
            status: event.sr_status_label
        })); // Mock data is already recent-first, no need to reverse
    }

    // Add a mock order (for testing)
    addMockOrder(orderData) {
        this.mockOrders[orderData.channel_order_id] = orderData;
        console.log(`✅ Mock: Added order ${orderData.channel_order_id}`);
    }
}

// Export singleton instance
module.exports = new MockShiprocketService();
