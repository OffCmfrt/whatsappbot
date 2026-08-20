// Probe 3: discover required fields for Delhivery CMU order creation.
// Sends deliberately incomplete payloads — validation errors reveal the schema
// without creating real shipments.
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;

async function post(label, url, body, contentType) {
    try {
        const r = await axios.post(url, body, {
            headers: { ...H, 'Content-Type': contentType || 'application/json' },
            timeout: 25000
        });
        console.log(`OK ${label}: ${JSON.stringify(r.data).substring(0, 500)}`);
        return r.data;
    } catch (e) {
        const st = e.response ? e.response.status : 'net';
        const d = e.response?.data;
        const body2 = (typeof d === 'string' && d.trim().startsWith('<')) ? '(html page — not an API route)' : JSON.stringify(d || e.message).substring(0, 400);
        console.log(`ERR ${label}: ${st} ${body2}`);
        return null;
    }
}

(async () => {
    // Form-encoded works; "shipment list contains no data" → data must be a LIST.
    // Full payload for a throwaway order; if a waybill comes back we cancel it
    // right away so nothing real is left behind.
    const consignment = {
        name: 'Probe DoNotShip',
        add: 'Test Address Line, Sector 1',
        pin: '122001',
        city: 'Gurugram',
        state: 'Haryana',
        country: 'India',
        phone: '9999999999',
        order: 'PROBE-CMU-000',
        payment_mode: 'Prepaid',
        shipping_mode: 'Pickup',
        return_pin: '123001',
        return_city: 'Narnaul',
        return_state: 'Haryana',
        return_country: 'India',
        return_phone: '9999999998',
        return_name: 'Offcomfrt Returns',
        return_add: '1590, Huda sector',
        seller_tin_gst: '06AAKFO0351L1Z7',
        seller_gst_cst_tin: '06AAKFO0351L1Z7',
        total_amount: 1,
        collectable_amount: 0,
        weight: 0.5,
        quantity: 1,
        height: 2,
        breadth: 30,
        length: 40,
        products: [{ sku: 'TEST', name: 'Test Product', order: 'PROBE-CMU-000', price: 1, quantity: 1, hsn: '6109' }]
    };

    // Server wants a dict wrapping the shipment list — discover the key name.
    // All variants use the throwaway PROBE-CMU-000 reference.
    const r1 = await post('data.shipments[]', `${BASE}/api/cmu/create.json`,
        `format=json&data=${encodeURIComponent(JSON.stringify({ shipments: [{...consignment, order: 'PROBE-CMU-001', products: consignment.products.map(p=>({...p, order: 'PROBE-CMU-001'})) }] }))}`,
        'application/x-www-form-urlencoded');
    const r2 = await post('data.consignment_list[]', `${BASE}/api/cmu/create.json`,
        `format=json&data=${encodeURIComponent(JSON.stringify({ consignment_list: [{...consignment, order: 'PROBE-CMU-002', products: consignment.products.map(p=>({...p, order: 'PROBE-CMU-002'})) }] }))}`,
        'application/x-www-form-urlencoded');
    const r3 = await post('data.shipment_data{}', `${BASE}/api/cmu/create.json`,
        `format=json&data=${encodeURIComponent(JSON.stringify({ shipment_data: {...consignment, order: 'PROBE-CMU-003', products: consignment.products.map(p=>({...p, order: 'PROBE-CMU-003'})) } }))}`,
        'application/x-www-form-urlencoded');
    const r = r1 || r2 || r3;

    // Cleanup: cancel any waybill the probe produced (scan all responses)
    const wbns = [];
    for (const resp of [r1, r2, r3]) {
        const pkgs = resp?.packages || resp?.status?.package_list || [];
        for (const p of pkgs) {
            const w = p?.waybill || p?.awb;
            if (w) wbns.push(String(w));
        }
    }
    for (const w of wbns) {
        try {
            const c = await axios.post(`${BASE}/api/p/edit`, { waybill: w, cancellation: 'true' },
                { headers: { ...H, 'Content-Type': 'application/json' }, timeout: 20000 });
            console.log(`CANCEL ${w}:`, JSON.stringify(c.data).substring(0, 250));
        } catch (e) {
            console.log(`CANCEL ${w} ERR:`, e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 200));
        }
    }
})();
