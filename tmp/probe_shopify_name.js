// Probe: Shopify's actual order name for 41408, then retry Delhivery ref_ids with it
require('dotenv').config();
const axios = require('axios');

const shop = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ACCESS_TOKEN;
const dToken = process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_API_KEY;
const dBase = (process.env.DELHIVERY_ENV || 'production') === 'staging'
    ? 'https://staging-express.delhivery.com'
    : 'https://track.delhivery.com';

(async () => {
    const orderId = process.argv[2] || '41408';

    // 1. Shopify: get the real order name/number
    let name = null;
    try {
        const r = await axios.get(`https://${shop}/admin/api/2024-01/orders.json`, {
            headers: { 'X-Shopify-Access-Token': token },
            params: { name: orderId, status: 'any', fields: 'id,name,order_number,created_at,fulfillment_status,financial_status' },
            timeout: 20000
        });
        const order = r.data?.orders?.[0];
        if (!order) console.log(`Shopify: no order with name=${orderId}`);
        else {
            console.log('Shopify order:', JSON.stringify(order, null, 2));
            name = order.name;
        }
    } catch (e) {
        console.log('Shopify ERR:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 300));
    }

    // 2. Delhivery: try ref_ids with the Shopify name + numeric Shopify order id
    const candidates = [...new Set([orderId, `#${orderId}`, name, name?.replace(/^#/, ''), String(name || '').replace(/^#?0*/, '')].filter(Boolean))];
    for (const id of candidates) {
        try {
            const r = await axios.get(`${dBase}/api/v1/packages/json/`, {
                headers: { Authorization: `Token ${dToken}`, Accept: 'application/json' },
                params: { ref_ids: id, size: 10 },
                timeout: 20000
            });
            console.log(`\nref_ids=${id}:`, JSON.stringify(r.data).substring(0, 600));
        } catch (e) {
            console.log(`\nref_ids=${id} ERR:`, e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 300));
        }
    }
})();
