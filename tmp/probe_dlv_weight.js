// Probe 7: find which weight/GST field Delhivery One actually stores.
// Creates throwaway packages with different field placements, dumps FULL raw
// read-back for each, then cancels all.
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;

async function create(ref, extraConsignment, extraProduct) {
    const consignment = {
        name: 'Parth Probe',
        add: 'Probe Address Line, Bagru',
        pin: '303007',
        city: 'Jaipur',
        state: 'Rajasthan',
        country: 'India',
        phone: '9876500000',
        order: ref,
        payment_mode: 'Prepaid',
        shipping_mode: 'Pickup',
        products_desc: 'PROBE ITEM (M) x1',
        return_name: 'OFFCOMFRT APPARELS LLP',
        return_add: '1590 Narnaul Huda Sector 1',
        return_pin: '123001', return_city: 'Narnaul', return_state: 'Haryana', return_country: 'India', return_phone: '9999000000',
        seller_tin_gst: process.env.EKART_SELLER_GST_TIN,
        seller_gst_cst_tin: process.env.EKART_SELLER_GST_TIN,
        total_amount: '100', collectable_amount: '0', cod_amount: '0',
        weight: '0.5', quantity: '1',
        shipment_length: '30', shipment_width: '40', shipment_height: '2',
        products: [{
            sku: 'PROBE', name: 'PROBE ITEM (M)', order: ref, price: 100, quantity: 1, hsn: '6109',
            ...extraProduct
        }],
        ...extraConsignment
    };
    const body = new URLSearchParams({ format: 'json', data: JSON.stringify({ shipments: [consignment], pickup_location: { name: process.env.DELHIVERY_PICKUP_LOCATION } }) });
    const r = await axios.post(`${BASE}/api/cmu/create.json`, body.toString(), {
        headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000
    });
    const pkg = r.data?.packages?.[0];
    if (!/success/i.test(String(pkg?.status || ''))) {
        console.log(`${ref}: CREATE FAILED`, JSON.stringify(pkg).substring(0, 300));
        return null;
    }
    return String(pkg.waybill);
}

(async () => {
    const variants = [
        ['PROBE-WT-A', {}, { weight: '350' }],                          // per-product weight in grams (string)
        ['PROBE-WT-B', { package_weight: '0.5', gross_weight: '0.5' }, {}], // alt consignment keys
        ['PROBE-WT-C', {}, { weight: '0.35', product_weight: '0.35' }]  // per-product kg
    ];
    const wbns = [];
    for (const [ref, extraC, extraP] of variants) {
        const w = await create(ref, extraC, extraP);
        console.log(`${ref} → AWB ${w || 'FAILED'}`);
        if (w) wbns.push([ref, w]);
    }

    // Full raw read-back per variant — dump EVERYTHING, grep for weight-ish keys
    for (const [ref, w] of wbns) {
        try {
            const r = await axios.get(`${BASE}/api/v1/packages/json/`, { headers: H, params: { waybill: w }, timeout: 20000 });
            const raw = JSON.stringify(r.data);
            const hits = raw.match(/"[^"]*(weight|wt|dimension|length|width|height|volume)[^"]*"\s*:\s*("[^"]*"|\d+|null)/gi) || [];
            console.log(`\n${ref} (${w}) weight-ish fields:`, hits.length ? hits.join(' | ') : 'NONE');
        } catch (e) { console.log(ref, 'read ERR', e.response?.status); }
    }

    // Cleanup
    for (const [ref, w] of wbns) {
        try {
            const c = await axios.post(`${BASE}/api/p/edit`, { waybill: w, cancellation: 'true' }, { headers: { ...H, 'Content-Type': 'application/json' }, timeout: 20000 });
            console.log(`CANCEL ${ref} ${w}:`, c.data?.status);
        } catch (e) { console.log(`CANCEL ${ref} ERR`, e.response?.status); }
    }
    process.exit(0);
})();
