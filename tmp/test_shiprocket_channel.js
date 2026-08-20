// Temporary diagnostic: authenticate to Shiprocket and inspect channels + pickup
// locations to confirm the Shoppers Hub ships under the Shopify channel (not Custom).
require('dotenv').config();
const axios = require('axios');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

(async () => {
    try {
        console.log('🔐 Authenticating to Shiprocket as', process.env.SHIPROCKET_EMAIL);
        const auth = await axios.post(`${BASE}/auth/login`, {
            email: process.env.SHIPROCKET_EMAIL,
            password: process.env.SHIPROCKET_PASSWORD
        });
        const token = auth.data.token;
        console.log('✅ Auth OK\n');
        const headers = { Authorization: `Bearer ${token}` };

        // --- Channels ---
        const chRes = await axios.get(`${BASE}/channels`, { headers, timeout: 20000 });
        const channels = chRes.data?.data || [];
        console.log(`📡 Channels (${channels.length}):`);
        channels.forEach(c => console.log(
            `   • id=${c.id}  name="${c.name}"  code=${c.base_channel_code || '?'}  status=${c.status ?? '?'}`
        ));

        const isCustom = c => (c.base_channel_code || '').toUpperCase() === 'CS' || /custom/i.test(c.name || '');
        const resolved = channels.find(c =>
            (c.base_channel_code || '').toUpperCase() === 'SH' ||
            /shopify/i.test(c.name || '') ||
            /shopify/i.test(c.base_channel_code || '')
        ) || channels.find(c => !isCustom(c));

        console.log('\n👉 Adapter would file orders under:',
            resolved ? `"${resolved.name}" (id ${resolved.id}, code ${resolved.base_channel_code})` : 'NONE → falls back to Custom/adhoc');

        // --- Pickup locations ---
        const puRes = await axios.get(`${BASE}/settings/company/pickup`, { headers, timeout: 20000 });
        const addresses = puRes.data?.data?.shipping_address || [];
        console.log(`\n🏷️  Pickup locations (${addresses.length}):`);
        addresses.forEach(a => console.log(`   • "${a.pickup_location}"  pin=${a.pin_code}  city=${a.city}`));

        const wanted = (process.env.SHIPROCKET_PICKUP_LOCATION || '').trim().toLowerCase();
        const match = addresses.find(a => (a.pickup_location || '').trim().toLowerCase() === wanted);
        console.log(`\n👉 SHIPROCKET_PICKUP_LOCATION="${process.env.SHIPROCKET_PICKUP_LOCATION}" →`,
            match ? `MATCH (pin ${match.pin_code})` : '❌ NO MATCH — createShipment will throw!');
    } catch (err) {
        console.error('❌ Test failed:', err.response?.status, JSON.stringify(err.response?.data || err.message));
    }
})();
