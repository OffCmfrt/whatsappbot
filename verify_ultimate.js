const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const API_BASE = 'http://localhost:3000/api/admin'; // Assuming local dev server
const token = 'YOUR_TEST_TOKEN'; // For real test, I'd need a valid token or skip auth in dev

async function testEndpoints() {
    console.log('--- Testing Broadcast Preview ---');
    try {
        const preview = await axios.get(`${API_BASE}/broadcast/preview?segment=all`, {
           headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('Preview Result:', preview.data.success ? `Found ${preview.data.customers.length} customers` : 'Failed');
    } catch (e) {
        console.log('Preview Error:', e.response?.data || e.message);
    }

    console.log('\n--- Testing Chat Start ---');
    try {
        const chat = await axios.post(`${API_BASE}/chat/start`, {
            phone: '919000000000',
            message: 'Hello from test'
        }, {
           headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('Chat Result:', chat.data.success ? 'Success' : 'Failed');
    } catch (e) {
        console.log('Chat Error:', e.response?.data || e.message);
    }
}

// testEndpoints(); // Cannot run without server
console.log('Verification script created. Manually review logic in adminRoutes.js and broadcastService.js.');
