// Probe 3: order 42257 — Delhivery SURFACE rejected the COD waybill (RTO risk).
// Fetch serviceability courier ids, then try explicit AWB assignment with each.
require('dotenv').config();
const axios = require('axios');
const shiprocketService = require('../src/services/shiprocketService');

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const SHIPMENT_ID = Number(process.argv[2] || 1491316807);
const SR_ORDER_ID = Number(process.argv[3] || 1495093545);

async function main() {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };

    const svc = await axios.get(`${BASE}/courier/serviceability/`, {
        headers,
        params: { pickup_postcode: '123028', delivery_postcode: '500084', weight: 0.5, cod: 1 },
        timeout: 20000
    });
    const couriers = svc.data?.data?.available_courier_companies || [];
    console.log('serviceable couriers:');
    couriers.forEach(c => console.log(`  id=${c.courier_company_id} name="${c.courier_name}" rate=${c.rate} cod=${c.cod_charges}`));

    for (const c of couriers) {
        console.log(`\n=== assign AWB with courier_id=${c.courier_company_id} (${c.courier_name}) ===`);
        try {
            const res = await axios.post(`${BASE}/courier/assign/awb`,
                { shipment_id: SHIPMENT_ID, courier_id: Number(c.courier_company_id) },
                { headers, timeout: 30000 });
            const pkg = res.data?.response?.data?.packages?.[0];
            const awb = res.data?.response?.data?.awb_code || pkg?.waybill || res.data?.awb_code;
            console.log('HTTP', res.status, '| awb_assign_status:', res.data?.awb_assign_status, '| AWB:', awb || 'none');
            if (pkg) console.log('package status:', pkg.status, '| remarks:', JSON.stringify(pkg.remarks || []));
            if (awb) { console.log(`\n✅ SUCCESS via ${c.courier_name}: AWB ${awb}`); break; }
        } catch (e) {
            console.log('failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 500));
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    // Final state
    await new Promise(r => setTimeout(r, 8000));
    const d = await axios.get(`${BASE}/orders/show/${SR_ORDER_ID}`, { headers, timeout: 20000 });
    const det = d.data?.data || d.data;
    console.log('\n=== FINAL STATE ===');
    console.log('top-level awb_code:', det?.awb_code);
    (Array.isArray(det?.shipments) ? det.shipments : []).forEach((sh, i) =>
        console.log(`shipment[${i}]: id=${sh.id} awb=${sh.awb} status=${sh.status} courier=${sh.courier || sh.courier_name || ''}`));
    process.exit(0);
}

main().catch(err => { console.error('probe error:', err.message); process.exit(1); });
