// Diagnostic: what orders are filed under the CUSTOM channel (10215536),
// and search specific orders for Ekart-courier shipments + their channel.
require('dotenv').config();
const axios = require('axios');
const shiprocketService = require('../src/services/shiprocketService');

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const CUSTOM_CHANNEL = '10215536';

async function main() {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };

    // 1. Orders on the Custom channel
    console.log('=== Orders filed under CUSTOM channel ===');
    for (const status of ['NEW', 'CONFIRMED', 'PICKUP_SCHEDULED', 'SHIPPED']) {
        try {
            const res = await axios.get(`${BASE}/orders`, {
                headers,
                params: { channel_id: CUSTOM_CHANNEL, status, per_page: 25 },
                timeout: 20000
            });
            const orders = res.data?.data || [];
            if (orders.length === 0) continue;
            console.log(`\nstatus=${status}: ${orders.length}`);
            for (const o of orders.slice(0, 25)) {
                console.log(`   ${String(o.channel_order_id || o.order_id).padEnd(12)} sr_id=${o.id} awb=${o.awb_code || '—'} courier=${o.courier_name || '—'} created=${String(o.created_at).substring(0, 16)}`);
            }
        } catch (e) {
            console.log(`status=${status} failed:`, e.response?.status);
        }
    }

    // 2. Specific order detail — check all shipments incl. history
    const probeId = process.argv[2];
    if (probeId) {
        console.log(`\n=== Search order ${probeId} ===`);
        try {
            const res = await axios.get(`${BASE}/orders`, {
                headers,
                params: { search: probeId, per_page: 20 },
                timeout: 20000
            });
            const orders = res.data?.data || [];
            if (orders.length === 0) console.log('no matches');
            for (const o of orders) {
                console.log(`   channel_order_id=${o.channel_order_id} sr_id=${o.id} channel_id=${o.channel_id} awb=${o.awb_code || '—'} courier=${o.courier_name || '—'} status=${o.status}`);
                try {
                    const d = await axios.get(`${BASE}/orders/show/${o.id}`, { headers, timeout: 20000 });
                    const det = d.data?.data || d.data;
                    const ships = Array.isArray(det?.shipments) ? det.shipments : [];
                    for (const s of ships) {
                        console.log(`      shipment id=${s.id} awb=${s.awb || '—'} courier=${s.courier || s.courier_name || '—'} status=${s.status} created=${String(s.created_at).substring(0, 16)}`);
                    }
                } catch (e) {
                    console.log('      detail failed:', e.response?.status);
                }
            }
        } catch (e) {
            console.log('search failed:', e.response?.status);
        }
    }
    process.exit(0);
}

main().catch(err => { console.error('probe error:', err.response?.status, JSON.stringify(err.response?.data || err.message).substring(0, 500)); process.exit(1); });
