// Diagnostic: list recent Shiprocket orders with their channel_id/name to see
// which ones landed under Custom vs Shopify.
require('dotenv').config();
const axios = require('axios');
const shiprocketService = require('../src/services/shiprocketService');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

async function main() {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };

    // Channel map
    const ch = await axios.get(`${BASE}/channels`, { headers, timeout: 20000 });
    const channelMap = {};
    for (const c of ch.data?.data || []) channelMap[String(c.id)] = `${c.name} (${c.base_channel_code})`;

    // Recent orders (newest first)
    const res = await axios.get(`${BASE}/orders`, {
        headers,
        params: { per_page: 30, page: 1 },
        timeout: 20000
    });
    const orders = res.data?.data || [];
    console.log(`Recent Shiprocket orders: ${orders.length}\n`);
    console.log(
        'Order'.padEnd(14), 'ChannelID'.padEnd(11), 'Channel'.padEnd(18),
        'AWB'.padEnd(16), 'Courier'.padEnd(16), 'Status'.padEnd(10), 'Created'
    );
    console.log('─'.repeat(110));
    for (const o of orders) {
        console.log(
            String(o.channel_order_id || o.order_id).padEnd(14),
            String(o.channel_id).padEnd(11),
            String(channelMap[String(o.channel_id)] || '?').padEnd(18),
            String(o.awb_code || '—').padEnd(16),
            String(o.courier_name || '—').padEnd(16),
            String(o.status || '').padEnd(10),
            String(o.created_at || '').substring(0, 16)
        );
    }
    process.exit(0);
}

main().catch(err => { console.error('probe error:', err.response?.status, JSON.stringify(err.response?.data || err.message).substring(0, 500)); process.exit(1); });
