/**
 * RE-SYNC order #45925 after the DH state-code fix (commit 6fd7553).
 * DB rows for this order were cleared, so we re-fetch the order from
 * Shopify and replay it through the deployed webhook endpoint exactly
 * as Shopify would (HMAC-signed).
 *
 * Usage: node tmp/resync_45925.js
 */
require('dotenv').config();
const crypto = require('crypto');
const shopifyService = require('../src/services/shopifyService');
const zohoService = require('../src/services/zohoService');

const BASE = 'https://whatsappbot-4l4b.onrender.com';
const SECRET = process.env.ZOHO_SHOPIFY_WEBHOOK_SECRET;
const ORDER_NUMBER = '45925';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    // 1. Health check — ensures new deploy is live
    const health = await fetch(`${BASE}/health`).then(r => r.json());
    console.log('🩺 health:', health.status || JSON.stringify(health).slice(0, 80));

    // 2. Fetch the order fresh from Shopify
    const order = await shopifyService.getOrderById('#' + ORDER_NUMBER);
    if (!order) throw new Error(`Order #${ORDER_NUMBER} not found in Shopify`);
    console.log(`📦 Fetched order #${order.order_number} (id=${order.id})`);
    const sa = order.shipping_address || {};
    console.log(`   ship-to: ${sa.city}, ${sa.province} (${sa.province_code}) ${sa.zip}`);

    // 3. Replay through the live webhook with a valid HMAC
    const body = Buffer.from(JSON.stringify(order));
    const hmac = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
    const res = await fetch(`${BASE}/webhooks/zoho/orders/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac },
        body
    });
    console.log(`📤 webhook: ${res.status} ${(await res.text()).slice(0, 120)}`);
    if (res.status !== 200) throw new Error('Webhook rejected');

    // 4. Wait for the invoice, then verify POS + tax split
    for (let i = 0; i < 15; i++) {
        const invs = await zohoService.searchInvoice({ reference_number: ORDER_NUMBER });
        if (invs.length > 0) {
            const inv = await zohoService.getInvoice(invs[0].invoice_id);
            console.log(`\n✅ Invoice ${inv.invoice_number} (${inv.status})  total=${inv.total}  tax=${inv.total_tax || inv.tax_total}`);
            console.log(`   place_of_supply: ${inv.place_of_supply}`);
            const taxSummary = {};
            for (const li of inv.line_items || []) {
                for (const t of li.line_item_taxes || []) {
                    const k = `${t.tax_name} ${t.tax_percentage}%`;
                    taxSummary[k] = (taxSummary[k] || 0) + parseFloat(t.tax_amount || 0);
                }
            }
            console.log('   taxes:', Object.entries(taxSummary).map(([k, v]) => `${k}=₹${v.toFixed(2)}`).join('  '));
            const igst = Object.keys(taxSummary).some(k => /igst/i.test(k));
            console.log(igst ? '✅ IGST applied (inter-state correct)' : '❌ NOT IGST — check place_of_supply');
            return;
        }
        await sleep(5000);
    }
    console.log('❌ No invoice appeared after 75s — check Render logs');
}

main().then(() => process.exit(0)).catch(e => { console.error('💥', e.message); process.exit(1); });
