// Probe: verify seller_gst_tin / seller_name / seller_add fix on a LIVE
// throwaway package. Runs the REAL adapter createDirectShipment() code path
// (no payload copy) so what lands in the panel is exactly what production
// sends. Left ACTIVE for panel inspection — cancel via /api/p/edit after
// checking, do NOT ship it.
require('dotenv').config();
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');

const ctx = {
    orderId: 'PROBE-GST-FIX-2',
    consignee: {
        name: 'GST Probe',
        phone: '9876500002',
        address: 'GST Probe Address, Bagru',
        city: 'Jaipur',
        state: 'Rajasthan',
        pincode: '303007',
        country: 'India'
    },
    payment: { mode: 'Prepaid', codAmount: 0, declaredValue: 100 },
    items: [{ name: 'PROBE ITEM', size: 'M', quantity: 1, price: 100, sku: 'PROBE' }],
    package: { weightGrams: 500, lengthCm: 30, breadthCm: 40, heightCm: 2 },
    meta: {}
};

(async () => {
    console.log('seller_gst_tin →', a.sellerGstin || '(empty!)');
    console.log('seller_name    →', a.sellerName);
    console.log('seller_add     →', a.sellerAddress || '(empty!)');
    if (!a.sellerGstin) {
        console.log('\n❌ GSTIN not configured — set DELHIVERY_SELLER_GSTIN or EKART_SELLER_GST_TIN');
        process.exit(1);
    }

    const result = await a.createDirectShipment(ctx);
    if (!result.success) {
        console.log('\n❌ create failed:', result.error);
        console.log(JSON.stringify(result.raw || {}).substring(0, 800));
        process.exit(1);
    }

    console.log('\n✅ AWB', result.data.awb);
    console.log('Sent payload:', JSON.stringify(result.data.requestPayload.consignment, null, 1)
        .split('\n').filter(l => /seller_|hsn_code|gst/.test(l)).join('\n'));
    console.log('\nCheck the Delhivery One panel for this AWB:');
    console.log('  - GST line should show', a.sellerGstin);
    console.log('  - Seller name/address should show', a.sellerName);
    console.log('Then cancel it: POST /api/p/edit { waybill: "' + result.data.awb + '", cancellation: "true" }');
})();
