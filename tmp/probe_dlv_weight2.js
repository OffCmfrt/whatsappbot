// Probe 8: create 3 packages left ACTIVE for panel inspection.
//   WT-GRAMS : products[].weight = '350'  (grams)
//   WT-KG    : products[].weight = '0.35' (kg)
//   GST-VAR  : extra GST field spellings
// After user checks the panel, cancel the losers via /api/p/edit.
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;

async function create(ref, extraConsignment, extraProduct) {
    const consignment = {
        name: 'Weight Probe',
        add: 'Weight Probe Address, Bagru',
        pin: '303007',
        city: 'Jaipur',
        state: 'Rajasthan',
        country: 'India',
        phone: '9876500001',
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
        products: [{ sku: 'PROBE', name: 'PROBE ITEM (M)', order: ref, price: 100, quantity: 1, hsn: '6109', ...extraProduct }],
        ...extraConsignment
    };
    const body = new URLSearchParams({ format: 'json', data: JSON.stringify({ shipments: [consignment], pickup_location: { name: process.env.DELHIVERY_PICKUP_LOCATION } }) });
    const r = await axios.post(`${BASE}/api/cmu/create.json`, body.toString(), {
        headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000
    });
    const pkg = r.data?.packages?.[0];
    console.log(ref, '→', pkg?.waybill || 'FAILED', pkg?.status, JSON.stringify(pkg?.remarks || ''));
    return pkg?.waybill ? String(pkg.waybill) : null;
}

(async () => {
    await create('PROBE-WT-GRAMS', {}, { weight: '350' });
    await create('PROBE-WT-KG', {}, { weight: '0.35' });
    await create('PROBE-GST-VAR', {
        gstin: process.env.EKART_SELLER_GST_TIN,
        seller_gstin: process.env.EKART_SELLER_GST_TIN,
        seller_gst_number: process.env.EKART_SELLER_GST_TIN,
        gst_number: process.env.EKART_SELLER_GST_TIN
    }, {});
    console.log('\nLeft active for panel inspection — do NOT ship these.');
})();
