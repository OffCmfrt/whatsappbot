const axios = require('axios');

class ShiprocketService {
    constructor() {
        this.baseURL = 'https://apiv2.shiprocket.in/v1/external';
        this.token = null;
        this.tokenExpiry = null;
        // In-memory cache for order lookups (5 min TTL)
        this.orderCache = new Map();
        this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    }

    // Authenticate and get token
    async authenticate() {
        try {
            const response = await axios.post(`${this.baseURL}/auth/login`, {
                email: process.env.SHIPROCKET_EMAIL,
                password: process.env.SHIPROCKET_PASSWORD
            });

            this.token = response.data.token;
            this.tokenExpiry = Date.now() + (24 * 60 * 60 * 1000); // Token valid for 24 hours
            console.log('✅ Shiprocket authentication successful');
            return this.token;
        } catch (error) {
            console.error('❌ Shiprocket authentication failed:', error.response?.data || error.message);
            throw error;
        }
    }

    // Ensure we have a valid token
    async ensureAuthenticated() {
        if (!this.token || Date.now() >= this.tokenExpiry) {
            console.log('🔄 Refreshing Shiprocket token...');
            await this.authenticate();
        }
        return this.token;
    }

    // Cache helper methods
    getCachedOrder(orderId) {
        const cached = this.orderCache.get(orderId);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.data;
        }
        this.orderCache.delete(orderId); // Expired
        return null;
    }

    setCachedOrder(orderId, data) {
        this.orderCache.set(orderId, {
            data,
            timestamp: Date.now()
        });
        // Keep cache size manageable
        if (this.orderCache.size > 100) {
            const firstKey = this.orderCache.keys().next().value;
            this.orderCache.delete(firstKey);
        }
    }

    // Sync all customers from recent orders
    async syncAllCustomers() {
        try {
            await this.ensureAuthenticated();
            const { dbAdapter } = require('../database/db');
            
            let currentPage = 1;
            const perPage = 100;
            const maxPages = 500; // Increased safety limit for 50,000+ orders
            let totalSynced = 0;
            const batchCustomers = new Map(); // phone -> {name, count, lastOrder}

            while (currentPage <= maxPages) {
                console.log(`🔄 Syncing Shiprocket orders page ${currentPage}...`);
                const response = await axios.get(`${this.baseURL}/orders`, {
                    headers: { 'Authorization': `Bearer ${this.token}` },
                    params: { per_page: perPage, page: currentPage }
                });

                const orders = response.data.data || [];
                if (orders.length === 0) {
                    console.log(`ℹ️ No more orders found on page ${currentPage}.`);
                    break;
                }

                console.log(`📦 Found ${orders.length} orders on page ${currentPage}`);

                const pageCustomers = new Map(); // phone -> {name, lastOrder}

                for (let i = 0; i < orders.length; i++) {
                    const order = orders[i];
                    
                    if (currentPage === 1 && i < 3) {
                        console.log(`[DEBUG] Sample Order ${i} ID:`, order.id || order.order_id);
                        console.log(`[DEBUG] Order Keys:`, Object.keys(order));
                    }

                    const rawPhone = 
                        order.customer_phone || 
                        order.phone_number || // Added common Shiprocket field
                        order.billing_customer_phone || 
                        order.billing_phone ||
                        order.customer?.phone ||
                        order.customer?.phone_number || // Added
                        order.shipping_address?.phone ||
                        order.billing_address?.phone ||
                        order.billing_address?.phone_number || // Added
                        order.customer_address?.phone;

                    if (!rawPhone) {
                        if (currentPage === 1 && totalSynced === 0 && i === 0) {
                             console.log('[DEBUG] First order missing phone. Keys:', Object.keys(order));
                             if (order.customer) console.log('[DEBUG] Customer keys:', Object.keys(order.customer));
                             if (order.billing_address) console.log('[DEBUG] Billing keys:', Object.keys(order.billing_address));
                             if (order.shipping_address) console.log('[DEBUG] Shipping keys:', Object.keys(order.shipping_address));
                        }
                        continue;
                    }

                    const digits = rawPhone.toString().replace(/\D/g, '');
                    
                    if (currentPage === 1 && i < 10) {
                        console.log(`[DEBUG] Order ${order.id || order.order_id} rawPhone: ${rawPhone}, cleaned: ${digits}`);
                    }

                    if (!digits || digits.length < 10) continue;

                    // Standardize to 91XXXXXXXXXX
                    let cleanPhone = digits;
                    if (digits.length === 10) cleanPhone = '91' + digits;
                    else if (digits.length > 10) cleanPhone = digits.slice(-10).padStart(12, '91');
                    const name = order.billing_customer_name || 
                                 order.customer_name || 
                                 (order.customer && (order.customer.first_name || order.customer.name)) ||
                                 order.shipping_customer_name ||
                                 'Customer';
                    const orderDate = order.created_at;

                    if (!pageCustomers.has(cleanPhone) || orderDate > pageCustomers.get(cleanPhone).lastOrder) {
                        pageCustomers.set(cleanPhone, { name, lastOrder: orderDate });
                    }
                }

                // Batch upsert for this page
                for (const [phone, data] of pageCustomers) {
                    try {
                        // Using explicit SELECT + INSERT/UPDATE for maximum compatibility/control, 
                        // but grouped per customer in this page to avoid redundant writes.
                        const existing = await dbAdapter.query('SELECT phone, order_count, updated_at FROM customers WHERE phone = ?', [phone]);
                        
                        if (existing && existing.length > 0) {
                            const lastUpdate = existing[0].updated_at;
                            // Only update name and timestamp, don't blindly increment order_count on every sync
                            await dbAdapter.query(
                                'UPDATE customers SET name=?, updated_at=? WHERE phone = ?',
                                [data.name, data.lastOrder > lastUpdate ? data.lastOrder : lastUpdate, phone]
                            );
                        } else {
                            await dbAdapter.query(
                                'INSERT INTO customers (phone, name, order_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                                [phone, data.name, 1, data.lastOrder, data.lastOrder]
                            );
                        }
                        totalSynced++;
                    } catch (err) {
                        console.error(`Error saving customer ${phone}:`, err.message);
                    }
                }

                if (orders.length < perPage) break;
                currentPage++;
            }

            console.log(`✅ Shiprocket sync finished. Processed ${totalSynced} customer entries.`);
            return totalSynced;
        } catch (error) {
            console.error('Shiprocket sync error:', error);
            throw error;
        }
    }

    // Get order status by order ID
    async getOrderStatus(orderId, phone = null) {
        try {
            await this.ensureAuthenticated();
            
            // Check cache first
            const cached = this.getCachedOrder(orderId);
            if (cached) {
                return cached;
            }
            
            // Try fetching by exact/fuzzy search (handles id, channel_order_id, etc.)
            let response = await axios.get(`${this.baseURL}/orders`, {
                headers: { 'Authorization': `Bearer ${this.token}` },
                params: { search: orderId }
            });

            let orderData = response.data?.data?.[0];

            if (!orderData) {
                // Try fetching by shiprocket order ID
                try {
                    response = await axios.get(`${this.baseURL}/orders/show/${orderId}`, {
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });
                    orderData = response.data?.data;
                } catch(err) {
                    // Ignore and let orderData be null
                }
            }

            if (!orderData) {
                return null;
            }

            const formatted = this.formatOrderStatus(orderData);
            
            // Cache the result
            if (formatted) {
                this.setCachedOrder(orderId, formatted);
            }
            
            return formatted;
        } catch (error) {
            console.error('Shiprocket API error (getOrderStatus):', error.response?.data || error.message);
            return null;
        }
    }

    // Get tracking by AWB
    async getTrackingByAWB(awb) {
        try {
            await this.ensureAuthenticated();
            
            const response = await axios.get(`${this.baseURL}/courier/track/awb/${awb}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            return response.data;
        } catch (error) {
            console.error('Shiprocket API error (getTrackingByAWB):', error.response?.data || error.message);
            return null;
        }
    }

    // Format order status as an object (needed for message templates)
    formatOrderStatus(orderData) {
        if (!orderData) return null;

        // Extract tags from various possible fields
        let tags = null;
        if (orderData.tags) {
            if (typeof orderData.tags === 'string') {
                tags = orderData.tags;
            } else if (Array.isArray(orderData.tags)) {
                tags = orderData.tags.join(',');
            } else if (typeof orderData.tags === 'object') {
                tags = JSON.stringify(orderData.tags);
            }
        } else if (orderData.order_tags) {
            if (typeof orderData.order_tags === 'string') {
                tags = orderData.order_tags;
            } else if (Array.isArray(orderData.order_tags)) {
                tags = orderData.order_tags.join(',');
            }
        } else if (orderData.label) {
            tags = orderData.label;
        }

        return {
            orderId: orderData.id,
            channelOrderId: orderData.channel_order_id,
            awb: orderData.awb_code,
            courierName: orderData.courier_name,
            status: orderData.status || orderData.status_code || 'Processing',
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
            shipments: orderData.shipments || [],
            tags: tags
        };
    }

    // Get orders by customer phone number (optimized: uses search API instead of full pagination)
    async getOrdersByPhone(phone) {
        try {
            await this.ensureAuthenticated();
            
            console.log(`📱 Fetching orders for phone: ${phone}`);
            
            // Normalize phone number for comparison
            const cleanPhone = phone.toString().replace(/\D/g, '');
            const targetPhone = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;
            // Also keep the last 10 digits for matching (Shiprocket may store with/without country code)
            const last10 = targetPhone.slice(-10);
            
            // FAST PATH: Use Shiprocket's search parameter to filter server-side
            // This returns only matching orders in 1-2 API calls instead of paginating all 50+ pages
            const searchQueries = [targetPhone, last10];
            let allOrders = [];
            const seenOrderIds = new Set();
            
            for (const searchQuery of searchQueries) {
                let currentPage = 1;
                const perPage = 100;
                const maxPages = 5; // With search filter, results are small
                
                while (currentPage <= maxPages) {
                    console.log(`🔄 Searching Shiprocket orders (query="${searchQuery}", page ${currentPage})...`);
                    
                    let response;
                    try {
                        response = await axios.get(`${this.baseURL}/orders`, {
                            headers: { 'Authorization': `Bearer ${this.token}` },
                            params: { per_page: perPage, page: currentPage, search: searchQuery }
                        });
                    } catch (apiErr) {
                        // If search param not supported, fall back gracefully
                        if (apiErr.response?.status === 400 || apiErr.response?.status === 422) {
                            console.log(`⚠️ Search param not supported, falling back to phone filter...`);
                            return await this._getOrdersByPhoneFallback(phone);
                        }
                        throw apiErr;
                    }

                    const orders = response.data.data || [];
                    if (orders.length === 0) {
                        console.log(`ℹ️ No more orders found on page ${currentPage}.`);
                        break;
                    }

                    console.log(`📦 Found ${orders.length} orders on page ${currentPage}`);
                    
                    // Filter orders matching the phone number (verify server-side search results)
                    const matchingOrders = orders.filter(order => {
                        const rawPhone = 
                            order.customer_phone || 
                            order.phone_number || 
                            order.billing_customer_phone || 
                            order.billing_phone ||
                            order.customer?.phone ||
                            order.customer?.phone_number ||
                            order.shipping_address?.phone ||
                            order.billing_address?.phone ||
                            order.billing_address?.phone_number ||
                            order.customer_address?.phone;
                        
                        if (!rawPhone) return false;
                        
                        const digits = rawPhone.toString().replace(/\D/g, '');
                        const orderPhone = digits.length === 10 ? '91' + digits : digits;
                        
                        return orderPhone === targetPhone || digits.endsWith(last10);
                    });
                    
                    for (const order of matchingOrders) {
                        const orderId = order.channel_order_id || order.id?.toString();
                        if (!seenOrderIds.has(orderId)) {
                            seenOrderIds.add(orderId);
                            allOrders.push(order);
                        }
                    }
                    
                    // Stop if we've processed all results
                    if (orders.length < perPage) break;
                    currentPage++;
                }
            }
            
            console.log(`✅ Found ${allOrders.length} orders for phone ${phone}`);
            return allOrders;
        } catch (error) {
            console.error('Shiprocket API error (getOrdersByPhone):', error.response?.data || error.message);
            return [];
        }
    }

    // Fallback: full pagination scan (used only if search API doesn't work)
    async _getOrdersByPhoneFallback(phone) {
        try {
            const cleanPhone = phone.toString().replace(/\D/g, '');
            const targetPhone = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;
            const last10 = targetPhone.slice(-10);
            
            let currentPage = 1;
            const perPage = 100;
            const maxPages = 50;
            let allOrders = [];
            
            while (currentPage <= maxPages) {
                console.log(`🔄 [Fallback] Fetching Shiprocket orders page ${currentPage}...`);
                
                const response = await axios.get(`${this.baseURL}/orders`, {
                    headers: { 'Authorization': `Bearer ${this.token}` },
                    params: { per_page: perPage, page: currentPage }
                });

                const orders = response.data.data || [];
                if (orders.length === 0) break;

                const matchingOrders = orders.filter(order => {
                    const rawPhone = 
                        order.customer_phone || 
                        order.phone_number || 
                        order.billing_customer_phone || 
                        order.billing_phone ||
                        order.customer?.phone ||
                        order.customer?.phone_number ||
                        order.shipping_address?.phone ||
                        order.billing_address?.phone ||
                        order.billing_address?.phone_number ||
                        order.customer_address?.phone;
                    
                    if (!rawPhone) return false;
                    const digits = rawPhone.toString().replace(/\D/g, '');
                    const orderPhone = digits.length === 10 ? '91' + digits : digits;
                    return orderPhone === targetPhone || digits.endsWith(last10);
                });
                
                allOrders = allOrders.concat(matchingOrders);
                if (orders.length < perPage) break;
                currentPage++;
            }
            
            return allOrders;
        } catch (error) {
            console.error('Shiprocket fallback error:', error.response?.data || error.message);
            return [];
        }
    }

    // Get tracking timeline as an array
    async getTrackingTimeline(awb) {
        if (!awb) return [];

        try {
            const trackingData = await this.getTrackingByAWB(awb);
            if (!trackingData || !trackingData.tracking_data || !trackingData.tracking_data.shipment_track_activities) {
                return [];
            }

            return trackingData.tracking_data.shipment_track_activities.map(activity => ({
                date: activity.date,
                time: String(activity.date).includes(' ') ? activity.date.split(' ')[1] : '', // Extract time if present
                location: activity.location,
                activity: activity.activity,
                status: activity.sr_status_label
            }));
        } catch (error) {
            console.error('Error fetching tracking timeline:', error);
            return [];
        }
    }
}

// Export singleton instance
module.exports = new ShiprocketService();
