// Probe 5: real-data CMU create for order 42018 (exists at One as Pending AWB).
// Does Delhivery assign a waybill, or reject as duplicate? Cancel after test.
require('dotenv').config();
const axios = require('axios');
const { dbAdapter } = require('../src/database/db');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const BASE = a.baseURL;
const ORDER = process.argv[2] || '42018';

(async () => {
    const rows = await dbAdapter.query(`SELECT * FROM store_shoppers WHERE order_id = ? ORDER BY id DESC LIMIT 1`, [ORDER]);
    const s = rows[0];
    if (!s) { console.log('No shopper row for', ORDER); process.exit(1); }
    console.log('Shopper:', s.name, s.zip, s.payment_method, s.order_total);

    let items = [];
    try { items = JSON.parse(s.items_json || '[]'); } catch (e) {}
    const totalQty = items.reduce((n, i) => n + (parseInt(i.quantity) || 1), 0) || 1;

    const orderTotal = Number(s.order_total) || 0;
    const isCod = /cod|cash/i.test(s.payment_method || '');
    // Panel shows collectable ₹1,398 for a ₹1,299 cart — Delhivery adds the
    // ₹99 COD charge to the collectable amount; match that so COD validates
    const collectable = isCod ? Math.round((orderTotal + 99) * 100) / 100 : 0;

    const consignment = {
        name: s.name,
        add: s.address,
        pin: String(s.zip || '').replace(/\D/g, ''),
        city: s.city,
        state: s.province,
        country: s.country || 'India',
        phone: String(s.phone || '').replace(/\D/g, '').slice(-10),
        order: ORDER,
        payment_mode: isCod ? 'COD' : 'Prepaid',
        shipping_mode: 'Pickup',
        return_name: 'OFFCOMFRT APPARELS LLP',
        return_add: '1590 Narnaul Huda Sector 1 Narnaul Mahendergarh Road',
        return_pin: '123001',
        return_city: 'Narnaul',
        return_state: 'Haryana',
        return_country: 'India',
        return_phone: '9999000000',
        seller_tin_gst: process.env.EKART_SELLER_GST_TIN,
        seller_gst_cst_tin: process.env.EKART_SELLER_GST_TIN,
        total_amount: collectable || orderTotal,
        collectable_amount: collectable,
        cod_amount: collectable,
        weight: 0.5,
        quantity: totalQty,
        height: 2, breadth: 30, length: 40,
        products: (items.length ? items : [{ title: 'Product', price: 0, quantity: 1 }]).map(i => ({
            sku: i.sku || String(i.variant_id || 'SKU'),
            name: (i.title || i.name || 'Product').substring(0, 60),
            order: ORDER,
            price: Number(i.price) || 0,
            quantity: parseInt(i.quantity) || 1,
            hsn: '6109'
        }))
    };

    try {
        const r = await axios.post(`${BASE}/api/cmu/create.json`,
            `format=json&data=${encodeURIComponent(JSON.stringify({ shipments: [consignment] }))}`,
            { headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
        console.log('CMU response:', JSON.stringify(r.data, null, 1).substring(0, 1500));

        const pkgs = r.data?.packages || [];
        for (const p of pkgs) {
            const w = p?.waybill;
            if (w) {
                console.log(`\n✅ Waybill assigned: ${w} (status: ${p.status}) — cancelling now (test only)`);
                try {
                    const c = await axios.post(`${BASE}/api/p/edit`, { waybill: String(w), cancellation: 'true' },
                        { headers: { ...H, 'Content-Type': 'application/json' }, timeout: 20000 });
                    console.log('Cancel result:', JSON.stringify(c.data).substring(0, 300));
                } catch (e) {
                    console.log('Cancel ERR:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 200));
                }
            }
        }
    } catch (e) {
        console.log('CMU ERR:', e.response?.status, JSON.stringify(e.response?.data || e.message).substring(0, 800));
    }
    process.exit(0);
})();
