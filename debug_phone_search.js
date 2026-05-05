require('dotenv').config();
const shiprocketService = require('./src/services/shiprocketService');

async function debugPhoneSearch() {
    const testPhone = '918986685396';
    
    console.log('🔍 DEBUGGING PHONE NUMBER SEARCH');
    console.log('================================');
    console.log(`Test phone: ${testPhone}`);
    console.log('');
    
    try {
        // First, let's authenticate
        await shiprocketService.ensureAuthenticated();
        console.log('✅ Authenticated with Shiprocket');
        console.log('');
        
        // Test 1: Try searching with the full number
        console.log('📋 TEST 1: Search with full number (918986685396)');
        await testSearch('918986685396');
        
        // Test 2: Try searching with last 10 digits
        console.log('\n📋 TEST 2: Search with last 10 digits (8986685396)');
        await testSearch('8986685396');
        
        // Test 3: Fetch a few orders without search to see structure
        console.log('\n📋 TEST 3: Fetch first 5 orders without search (to see phone fields)');
        await fetchSampleOrders(5);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

async function testSearch(query) {
    try {
        const axios = require('axios');
        const response = await axios.get(`${shiprocketService.baseURL}/orders`, {
            headers: { 'Authorization': `Bearer ${shiprocketService.token}` },
            params: { per_page: 10, page: 1, search: query }
        });
        
        const orders = response.data.data || [];
        console.log(`   Found ${orders.length} orders`);
        
        if (orders.length > 0) {
            console.log('   Sample order phone fields:');
            const sample = orders[0];
            console.log('   - customer_phone:', sample.customer_phone);
            console.log('   - phone_number:', sample.phone_number);
            console.log('   - billing_customer_phone:', sample.billing_customer_phone);
            console.log('   - billing_phone:', sample.billing_phone);
            console.log('   - customer?.phone:', sample.customer?.phone);
            console.log('   - shipping_address?.phone:', sample.shipping_address?.phone);
        }
    } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
        if (error.response) {
            console.log(`   Status: ${error.response.status}`);
            console.log(`   Data:`, error.response.data);
        }
    }
}

async function fetchSampleOrders(count) {
    try {
        const axios = require('axios');
        const response = await axios.get(`${shiprocketService.baseURL}/orders`, {
            headers: { 'Authorization': `Bearer ${shiprocketService.token}` },
            params: { per_page: count, page: 1 }
        });
        
        const orders = response.data.data || [];
        console.log(`   Fetched ${orders.length} orders`);
        
        if (orders.length > 0) {
            console.log('\n   Full structure of first order (keys only):');
            const order = orders[0];
            console.log('   Top-level keys:', Object.keys(order));
            
            if (order.customer) {
                console.log('   customer keys:', Object.keys(order.customer));
                console.log('   customer.phone:', order.customer.phone);
                console.log('   customer.phone_number:', order.customer.phone_number);
            }
            
            if (order.shipping_address) {
                console.log('   shipping_address keys:', Object.keys(order.shipping_address));
                console.log('   shipping_address.phone:', order.shipping_address.phone);
            }
            
            if (order.billing_address) {
                console.log('   billing_address keys:', Object.keys(order.billing_address));
                console.log('   billing_address.phone:', order.billing_address.phone);
            }
            
            console.log('\n   Detailed phone fields for first 3 orders:');
            orders.slice(0, 3).forEach((order, idx) => {
                console.log(`\n   Order ${idx + 1} (${order.channel_order_id || order.id}):`);
                console.log(`     customer_phone: ${order.customer_phone}`);
                console.log(`     customer_alternate_phone: ${order.customer_alternate_phone}`);
                console.log(`     pickup_boy_contact_no: ${order.pickup_boy_contact_no}`);
                
                // Check if there's any unmasked phone
                const allPhoneFields = {
                    customer_phone: order.customer_phone,
                    customer_alternate_phone: order.customer_alternate_phone,
                    'customer_address.phone': order.customer_address?.phone,
                    'shipping_address.phone': order.shipping_address?.phone,
                };
                
                const unmasked = Object.entries(allPhoneFields).filter(([k, v]) => v && v !== 'xxxxxxxxxx');
                if (unmasked.length > 0) {
                    console.log(`     ✅ Unmasked phones:`, unmasked);
                } else {
                    console.log(`     ❌ All phone fields are masked`);
                }
            });
        }
    } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
    }
}

debugPhoneSearch();
