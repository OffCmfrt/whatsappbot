const { dbAdapter } = require('../database/db');
const { caches, cachedQuery, generateQueryKey, invalidateCache } = require('../utils/cache');

class Customer {
    // Find customer by phone number
    static async findByPhone(phone) {
        try {
            // Check cache first
            const cacheKey = `customer:${phone}`;
            const cached = caches.customers.get(cacheKey);
            if (cached) {
                return cached;
            }

            const customers = await dbAdapter.select('customers', { phone }, { limit: 1 });
            const customer = customers[0] || null;
            
            // Cache the result
            if (customer) {
                caches.customers.set(cacheKey, customer);
            }
            
            return customer;
        } catch (error) {
            console.error('Error finding customer:', error);
            return null;
        }
    }


    // Create new customer
    static async create(customerData) {
        try {
            return await dbAdapter.insert('customers', {
                phone: customerData.phone,
                name: customerData.name || null,
                email: customerData.email || null,
                preferred_language: customerData.preferred_language || null
            });
        } catch (error) {
            console.error('Error creating customer:', error);
            return null;
        }
    }

    // Get or create customer
    static async getOrCreate(phone, name = null) {
        let customer = await this.findByPhone(phone);

        // If customer exists but name is provided and different/missing, update it
        const isGeneric = customer && (!customer.name || customer.name === 'Customer' || customer.name === 'Unknown');
        if (customer && name && (isGeneric || name !== customer.name) && name !== 'Customer') {
            await dbAdapter.update('customers', { name }, { phone });
            customer.name = name;
        }

        if (!customer) {
            try {
                customer = await this.create({ phone, name });
                // Handle race condition: if create returned null, try to find again
                if (!customer) {
                    customer = await this.findByPhone(phone);
                }
                if (customer) {
                    customer.isNew = true;
                }
            } catch (error) {
                // Race condition: customer was created between find and create
                customer = await this.findByPhone(phone);
                if (customer) {
                    customer.isNew = false;
                }
            }
        } else {
            customer.isNew = false;
        }

        return customer || { phone, name: name || 'Customer', isNew: false };
    }

    // Get customer's orders
    static async getOrders(phone) {
        try {
            return await dbAdapter.select('orders', { customer_phone: phone }, { orderBy: 'created_at DESC' });
        } catch (error) {
            console.error('Error getting customer orders:', error);
            return [];
        }
    }

    // Get all customers (for admin dashboard)
    static async getAll(limit = 100, offset = 0) {
        try {
            // Does not support offset in basic select adapter yet, using query
            // Turso/SQLite supports LIMIT offset, count
            const sql = `SELECT * FROM customers ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            return await dbAdapter.query(sql, [limit, offset]);
        } catch (error) {
            console.error('Error getting all customers:', error);
            return [];
        }
    }

    // Get customer count
    static async getCount() {
        try {
            return await cachedQuery(
                'stats',
                'customer_count',
                async () => {
                    const result = await dbAdapter.query('SELECT COUNT(*) as count FROM customers');
                    return result[0]?.count || 0;
                },
                5 * 60 * 1000 // 5 minutes TTL
            );
        } catch (error) {
            console.error('Error getting customer count:', error);
            return 0;
        }
    }
}

module.exports = Customer;
