// Probe 2: find where order 42018 lives at Delhivery + Shopify order naming
require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');

const a = getAdapter('delhivery');
const H = a.authHeaders();
const ORDER = process.argv[2] || '42018';

async function get(label, url, params) {
    try {
        const r = await axios.get(url, { headers: H, params, timeout: 25000, maxRedirects: 0 });
        const s = JSON.stringify(r.data);
        const isHtml = typeof r.data === 'string' && r.data.trim().startsWith('<');
        console.log(`${isHtml ? 'HTML' : 'OK'} ${label}: ${isHtml ? '(html page, not an API route)' : s.substring(0, 400)}`);
        return r.data;
    } catch (e) {
        const st = e.response ? e.response.status : 'net';
        const d = e.response?.data;
        const body = (typeof d === 'string' && d.trim().startsWith('<')) ? '(html page)' : JSON.stringify(d || e.message).substring(0, 200);
        console.log(`ERR ${label}: ${st} ${body}`);
        return null;
    }
}

(async () => {
    const BASES = ['https://track.delhivery.com', 'https://express.delhivery.com'];
    for (const B of BASES) {
        console.log(`\n===== ${B} =====`);
        await get('packages json ref_ids', `${B}/api/v1/packages/json/`, { ref_ids: ORDER });
        await get('order fetch ref_id', `${B}/api/v1/order/fetch`, { ref_id: ORDER });
        await get('order fetch client', `${B}/api/v1/order/fetch`, { client: 'OFFCOMFRT', reference: ORDER });
        await get('orders list', `${B}/api/v1/orders`, { size: 5 });
        await get('b2b order fetch', `${B}/api/p2b/b2b/v1/order/fetch/`, { ref_id: ORDER });
        await get('client details', `${B}/api/v1/client/details`);
    }

    // Shopify side: what is this order's name/number/channel?
    const shop = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (shop && token) {
        try {
            const r = await axios.get(`https://${shop}/admin/api/2024-01/orders.json`, {
                headers: { 'X-Shopify-Access-Token': token },
                params: { name: ORDER, status: 'any', fields: 'id,name,order_number,source_name,fulfillment_status,created_at' },
                timeout: 20000
            });
            console.log('\nShopify order:', JSON.stringify(r.data?.orders || [], null, 1).substring(0, 600));
        } catch (e) {
            console.log('\nShopify ERR:', e.response?.status, JSON.stringify(e.response?.data || {}).substring(0, 200));
        }
    }
})();
