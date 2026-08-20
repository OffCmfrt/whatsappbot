// Probe Shiprocket live state for order 42257: why does AWB assignment stay pending?
require('dotenv').config();
const axios = require('axios');
const shiprocketService = require('../src/services/shiprocketService');

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const ORDER = process.argv[2] || '42257';

async function main() {
    await shiprocketService.ensureAuthenticated();
    const headers = { Authorization: `Bearer ${shiprocketService.token}`, 'Content-Type': 'application/json' };

    // 1. Find the order
    const search = await axios.get(`${BASE}/orders`, { headers, params: { search: ORDER, per_page: 20 }, timeout: 20000 });
    const orders = search.data?.data || [];
    const match = orders.find(o => String(o.channel_order_id).replace('#', '') === ORDER) || orders[0];
    if (!match) { console.log(`order ${ORDER} not found at Shiprocket`); process.exit(0); }

    console.log('=== LISTING ROW ===');
    console.log('id:', match.id, '| channel_id:', match.channel_id, '| status:', match.status, '| current_status:', match.current_status);
    console.log('awb_code:', match.awb_code, '| courier:', match.courier_name, '| shipment_id:', match.shipment_id);
    console.log('shipments:', JSON.stringify(match.shipments || null));
    console.log('weight (others):', match.others?.weight, '| dims:', match.others?.dimensions);
    console.log('ndr flags:', JSON.stringify({ ndr_status: match.ndr_status, ndr_date: match.ndr_date, ndr_remarks: match.ndr_remarks, is_rto: match.is_rto, cancelled: match.cancelled }));

    // 2. Detail endpoint — full picture of every shipment
    let srOrderId = match.id;
    let detail = null;
    try {
        const d = await axios.get(`${BASE}/orders/show/${srOrderId}`, { headers, timeout: 20000 });
        detail = d.data?.data || d.data;
        console.log('\n=== /orders/show ===');
        console.log('status:', detail?.status, '| current_status:', detail?.current_status);
        const ships = Array.isArray(detail?.shipments) ? detail.shipments : (detail?.shipments ? [detail.shipments] : []);
        ships.forEach((sh, i) => console.log(`shipment[${i}]: id=${sh.id || sh.shipment_id} awb=${sh.awb} status=${sh.status} courier=${sh.courier_name || sh.courier_company_name} weight=${sh.weight} created=${sh.created_at}`));
        console.log('full detail (truncated):', JSON.stringify(detail).substring(0, 1500));
    } catch (e) {
        console.log('orders/show failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 300));
    }

    // 3. Attempt AWB assignment with shipment_id (as the hub does) — capture FULL raw response
    const shipmentId = detail?.shipments?.[0]?.id || detail?.shipments?.[0]?.shipment_id || match.shipment_id;
    const awbBody = { shipment_id: Number(shipmentId) };
    console.log('\n=== POST /courier/assign/awb', JSON.stringify(awbBody), '===');
    try {
        const res = await axios.post(`${BASE}/courier/assign/awb`, awbBody, { headers, timeout: 30000 });
        console.log('HTTP', res.status, 'FULL BODY:', JSON.stringify(res.data));
    } catch (e) {
        console.log('assign failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 800));
    }

    // 3b. Courier recommendation — does Shiprocket even have a courier for this order?
    if (shipmentId) {
        try {
            const rec = await axios.get(`${BASE}/courier/recommend/shipment`, { headers, params: { shipment_id: Number(shipmentId) }, timeout: 30000 });
            console.log('\n=== /courier/recommend/shipment ===');
            console.log(JSON.stringify(rec.data).substring(0, 1200));
        } catch (e) {
            console.log('\nrecommend failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 800));
        }
    }

    // 3c. Serviceability for this pincode pair (COD)
    try {
        const svc = await axios.get(`${BASE}/courier/serviceability/`, {
            headers,
            params: { pickup_postcode: '123028', delivery_postcode: detail?.customer_pincode || '500084', weight: 0.5, cod: 1 },
            timeout: 20000
        });
        const couriers = svc.data?.data?.available_courier_companies || [];
        console.log('\n=== SERVICEABILITY ===');
        console.log('available couriers:', couriers.length, couriers.map(c => c.name || c.courier_name).join(', '));
        console.log('recommended:', svc.data?.data?.recommended_courier_company_id);
    } catch (e) {
        console.log('serviceability failed:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 400));
    }

    // 4. Wait 10s, re-read detail: did the AWB land?
    await new Promise(r => setTimeout(r, 10000));
    try {
        const d2 = await axios.get(`${BASE}/orders/show/${srOrderId}`, { headers, timeout: 20000 });
        const det2 = d2.data?.data || d2.data;
        const ships2 = Array.isArray(det2?.shipments) ? det2.shipments : [];
        console.log('\n=== AFTER 10s ===');
        console.log('top-level awb_code:', det2?.awb_code);
        ships2.forEach((sh, i) => console.log(`shipment[${i}]: awb=${sh.awb} status=${sh.status}`));
    } catch (e) {
        console.log('re-read failed:', e.response?.status);
    }

    process.exit(0);
}

main().catch(err => { console.error('probe error:', err.message); process.exit(1); });
