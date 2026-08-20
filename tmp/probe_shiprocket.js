// Probe Shiprocket API shape for one order: does the listing carry AWB? What about /orders/show?
require('dotenv').config();
const axios = require('axios');
const shiprocketService = require('../src/services/shiprocketService');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

async function main() {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };

    // Order 40984 → Shiprocket order #1486304875 from the dry-run log
    const search = await axios.get(`${BASE}/orders`, { headers, params: { search: '40984', per_page: 5 }, timeout: 20000 });
    const orders = search.data?.data || [];
    console.log(`--- /orders search: ${orders.length} rows ---`);
    if (orders[0]) {
        const o = orders[0];
        console.log('listing keys:', Object.keys(o).join(', '));
        console.log('awb_code:', o.awb_code, '| courier_name:', o.courier_name, '| shipment_id:', o.shipment_id, '| shipments:', JSON.stringify(o.shipments || null).substring(0, 300), '| status:', o.status, '| current_status:', o.current_status);
    }

    // Detail endpoint
    if (orders[0]?.id) {
        try {
            const detail = await axios.get(`${BASE}/orders/show/${orders[0].id}`, { headers, timeout: 20000 });
            const d = detail.data?.data || detail.data;
            console.log('--- /orders/show keys:', Object.keys(d || {}).join(', '));
            console.log('detail awb:', JSON.stringify(d?.shipments || d?.shipment || null).substring(0, 600));
        } catch (e) {
            console.log('orders/show failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 300));
        }
    }

    // Shipments-by-order endpoint
    if (orders[0]?.id) {
        try {
            const ships = await axios.get(`${BASE}/shipment/show`, { headers, params: { order_id: orders[0].id }, timeout: 20000 });
            console.log('--- /shipment/show?order_id:', JSON.stringify(ships.data).substring(0, 800));
        } catch (e) {
            console.log('shipment/show failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 300));
        }
    }
    process.exit(0);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
