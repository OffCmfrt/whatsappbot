// Probe 2: AWB assignment for shipment 1491316807 (order 42257) —
// explicit shipment_id, then with explicit courier_id from serviceability
require('dotenv').config();
const axios = require('axios');
const shiprocketService = require('../src/services/shiprocketService');

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const SHIPMENT_ID = Number(process.argv[2] || 1491316807);
const SR_ORDER_ID = Number(process.argv[3] || 1495093545);

async function main() {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };

    // 1. Auto-assign with shipment_id (exactly the hub's call shape)
    console.log('=== POST /courier/assign/awb {shipment_id} ===');
    try {
        const res = await axios.post(`${BASE}/courier/assign/awb`, { shipment_id: SHIPMENT_ID }, { headers, timeout: 30000 });
        console.log('HTTP', res.status, 'FULL BODY:', JSON.stringify(res.data));
    } catch (e) {
        console.log('failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 800));
    }

    // 2. Courier list → map the serviceability names to courier ids
    let courierId = null;
    try {
        const cl = await axios.get(`${BASE}/courier/company`, { headers, timeout: 20000 });
        const companies = cl.data?.data?.courier_company || cl.data?.data || [];
        console.log('\n=== COURIER COMPANIES ===');
        companies.forEach(c => console.log(`id=${c.id} name=${c.name} cod=${c.is_cod ?? c.cod}`));
        const delhivery = companies.find(c => /delhivery/i.test(c.name));
        courierId = delhivery?.id || companies[0]?.id || null;
    } catch (e) {
        console.log('courier/company failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 400));
    }

    // 3. Explicit courier assignment
    if (courierId) {
        console.log(`\n=== POST /courier/assign/awb {shipment_id, courier_id: ${courierId}} ===`);
        try {
            const res = await axios.post(`${BASE}/courier/assign/awb`, { shipment_id: SHIPMENT_ID, courier_id: Number(courierId) }, { headers, timeout: 30000 });
            console.log('HTTP', res.status, 'FULL BODY:', JSON.stringify(res.data));
        } catch (e) {
            console.log('failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 800));
        }
    }

    // 4. Re-read order detail for the AWB
    await new Promise(r => setTimeout(r, 8000));
    try {
        const d = await axios.get(`${BASE}/orders/show/${SR_ORDER_ID}`, { headers, timeout: 20000 });
        const det = d.data?.data || d.data;
        const ships = Array.isArray(det?.shipments) ? det.shipments : [];
        console.log('\n=== FINAL STATE ===');
        console.log('top-level awb_code:', det?.awb_code);
        ships.forEach((sh, i) => console.log(`shipment[${i}]: id=${sh.id} awb=${sh.awb} status=${sh.status} courier=${sh.courier || sh.courier_name}`));
    } catch (e) {
        console.log('re-read failed:', e.response?.status);
    }
    process.exit(0);
}

main().catch(err => { console.error('probe error:', err.message); process.exit(1); });
