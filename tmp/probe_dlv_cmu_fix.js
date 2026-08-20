// Probe 6: verify corrected CMU payload — products_desc, string weight (kg),
// shipment_* dimension keys, pickup_location. Throwaway ref, cancelled after.
require('dotenv').config();
const axios = require('axios');
const { dbAdapter } = require('../src/database/db');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;

(async () => {
    const rows = await dbAdapter.query(`SELECT * FROM store_shoppers WHERE order_id = '42018' ORDER BY id DESC LIMIT 1`);
    const s = rows[0];
    let items = [];
    try { items = JSON.parse(s.items_json || '[]'); } catch (e) {}

    const productsDesc = items.map(i => {
        const size = i.variant_title && i.variant_title !== 'Default Title' ? i.variant_title : null;
        return `${i.title || i.name}${size ? ` (${size})` : ''} x${i.quantity || 1}`;
    }).join(', ') || 'Apparel';

    const consignment = {
        name: s.name,
        add: s.address,
        pin: String(s.zip).replace(/\D/g, ''),
        city: s.city,
        state: s.province,
        country: s.country || 'India',
        phone: String(s.phone).replace(/\D/g, '').slice(-10),
        order: 'PROBE-FIX-001',
        payment_mode: 'COD',
        shipping_mode: 'Pickup',
        products_desc: productsDesc,
        return_name: 'OFFCOMFRT APPARELS LLP',
        return_add: '1590 Narnaul Huda Sector 1 Narnaul Mahendergarh Road',
        return_pin: '123001',
        return_city: 'Narnaul',
        return_state: 'Haryana',
        return_country: 'India',
        return_phone: '9999000000',
        seller_tin_gst: process.env.EKART_SELLER_GST_TIN,
        seller_gst_cst_tin: process.env.EKART_SELLER_GST_TIN,
        total_amount: '1398',
        collectable_amount: '1398',
        cod_amount: '1398',
        weight: '0.5',
        quantity: '1',
        shipment_length: '30',
        shipment_width: '40',
        shipment_height: '2',
        products: items.map(i => ({
            sku: i.sku || String(i.variant_id || 'SKU'),
            name: `${i.title || i.name} (${i.variant_title || ''})`.substring(0, 100),
            order: 'PROBE-FIX-001',
            price: Number(i.price) || 0,
            quantity: parseInt(i.quantity) || 1,
            hsn: '6109'
        }))
    };

    const payload = {
        shipments: [consignment],
        pickup_location: { name: process.env.DELHIVERY_PICKUP_LOCATION }
    };
    console.log('products_desc:', productsDesc);

    try {
        const body = new URLSearchParams({ format: 'json', data: JSON.stringify(payload) });
        const r = await axios.post(`${BASE}/api/cmu/create.json`, body.toString(), {
            headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000
        });
        console.log('CMU response:', JSON.stringify(r.data, null, 1).substring(0, 900));
        const w = r.data?.packages?.[0]?.waybill;
        if (w) {
            const c = await axios.post(`${BASE}/api/p/edit`, { waybill: String(w), cancellation: 'true' },
                { headers: { ...H, 'Content-Type': 'application/json' }, timeout: 20000 });
            console.log(`CANCEL ${w}:`, JSON.stringify(c.data).substring(0, 200));
        }
    } catch (e) {
        console.log('ERR:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 600));
    }
    process.exit(0);
})();
