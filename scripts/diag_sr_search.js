/**
 * Diagnostic: Test Shiprocket search API behavior for order ID lookup.
 *
 * Directly queries the Shiprocket API to understand why findSyncedOrder
 * can't find orders that clearly exist in the panel.
 *
 * Usage: node scripts/diag_sr_search.js [order_id]
 * Example: node scripts/diag_sr_search.js 48809
 */

require('dotenv').config();
const axios = require('axios');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

async function getToken() {
    const res = await axios.post(`${BASE}/auth/login`, {
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD
    });
    return res.data.token;
}

async function main() {
    const orderId = process.argv[2] || '48809';
    console.log(`🔍 Diagnosing Shiprocket search for order "${orderId}"\n`);

    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Search by bare order ID
    console.log(`━━━ 1. Search: "${orderId}" ━━`);
    try {
        const res = await axios.get(`${BASE}/orders`, {
            headers,
            params: { search: orderId, per_page: 20 }
        });
        const orders = res.data?.data || [];
        console.log(`Found ${orders.length} orders`);
        orders.slice(0, 5).forEach(o => {
            console.log(`  id=${o.id} | channel_order_id="${o.channel_order_id}" | order_id="${o.order_id}" | ch=${o.channel_id} | awb=${o.awb_code || 'none'} | name="${o.billing_customer_name} ${o.billing_last_name || ''}" | total=${o.total}`);
        });
    } catch (e) {
        console.log(`Error: ${e.response?.status} ${JSON.stringify(e.response?.data).substring(0, 200)}`);
    }

    // 2. Search by #order ID
    console.log(`\n━━━ 2. Search: "#${orderId}" ━━━`);
    try {
        const res = await axios.get(`${BASE}/orders`, {
            headers,
            params: { search: `#${orderId}`, per_page: 20 }
        });
        const orders = res.data?.data || [];
        console.log(`Found ${orders.length} orders`);
        orders.slice(0, 5).forEach(o => {
            console.log(`  id=${o.id} | channel_order_id="${o.channel_order_id}" | order_id="${o.order_id}" | ch=${o.channel_id} | awb=${o.awb_code || 'none'} | name="${o.billing_customer_name} ${o.billing_last_name || ''}" | total=${o.total}`);
        });
    } catch (e) {
        console.log(`Error: ${e.response?.status} ${JSON.stringify(e.response?.data).substring(0, 200)}`);
    }

    // 3. Try creating the order (to see the exact 422 response)
    console.log(`\n━━━ 3. POST /orders/create with order_id="${orderId}" ━━━`);
    try {
        const res = await axios.post(`${BASE}/orders/create`, {
            order_id: orderId,
            order_date: new Date().toISOString().slice(0, 16).replace('T', ' '),
            pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION,
            billing_customer_name: 'Test',
            billing_last_name: 'User',
            billing_address: '123 Test St',
            billing_city: 'Mumbai',
            billing_pincode: '400001',
            billing_state: 'Maharashtra',
            billing_country: 'India',
            billing_email: 'test@test.com',
            billing_phone: '9876543210',
            shipping_is_billing: true,
            order_items: [{ name: 'Test', sku: 'T-1', units: 1, selling_price: 100 }],
            payment_method: 'COD',
            sub_total: 100,
            length: 30, breadth: 40, height: 2, weight: 0.5,
            channel_id: process.env.SHIPROCKET_CHANNEL_ID || '10272426'
        }, { headers });
        console.log(`Success: ${JSON.stringify(res.data).substring(0, 200)}`);
    } catch (e) {
        console.log(`Status: ${e.response?.status}`);
        console.log(`Response: ${JSON.stringify(e.response?.data, null, 2).substring(0, 500)}`);
    }

    // 4. List recent orders (no search) — check if our order appears
    console.log(`\n━━━ 4. Recent orders (page 1, per_page=20) ━━━`);
    try {
        const res = await axios.get(`${BASE}/orders`, {
            headers,
            params: { per_page: 20, page: 1 }
        });
        const orders = res.data?.data || [];
        console.log(`Found ${orders.length} orders`);
        const match = orders.find(o =>
            String(o.channel_order_id || '').replace(/^#/, '').trim() === orderId ||
            String(o.order_id || '').replace(/^#/, '').trim() === orderId
        );
        if (match) {
            console.log(`✅ FOUND in recent orders: id=${match.id} channel_order_id="${match.channel_order_id}"`);
        } else {
            console.log(`❌ NOT found in first ${orders.length} recent orders`);
            console.log('Sample order IDs:', orders.slice(0, 5).map(o => o.channel_order_id).join(', '));
        }
    } catch (e) {
        console.log(`Error: ${e.response?.status}`);
    }

    // 5. Channels check
    console.log(`\n━━━ 5. Channels ━━━`);
    try {
        const res = await axios.get(`${BASE}/channels`, { headers });
        const channels = res.data?.data || [];
        channels.forEach(c => {
            console.log(`  id=${c.id} | name="${c.name}" | code="${c.base_channel_code}"`);
        });
    } catch (e) {
        console.log(`Error: ${e.response?.status}`);
    }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
