/**
 * Replay the 9 failed customer returns with the FIXED flow.
 * Fetches real refund + order data from Shopify, then calls
 * handleShopifyRefund. Old failed rows are marked 'superseded'.
 */
require('dotenv').config();
const axios = require('axios');
const { dbAdapter } = require('../src/database/db');
const zohoReturnService = require('../src/services/zohoReturnService');

const shop = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ACCESS_TOKEN;

(async () => {
    const failed = await dbAdapter.query(
        `SELECT id, shopify_order_id, shopify_return_id FROM zoho_returns
         WHERE status = 'failed' AND return_type = 'return' ORDER BY id`, []);
    console.log(`Replaying ${failed.length} failed returns...\n`);

    let ok = 0, bad = 0;
    for (const row of failed) {
        const internalOrderId = row.shopify_order_id;
        const refundId = row.shopify_return_id;
        try {
            // Real refund (with nested line_item details)
            const rRes = await axios.get(
                `https://${shop}/admin/api/2024-01/orders/${internalOrderId}/refunds/${refundId}.json`,
                { headers: { 'X-Shopify-Access-Token': token }, timeout: 20000 });
            const refund = rRes.data.refund;

            // Real order (order_number, customer, addresses)
            const oRes = await axios.get(
                `https://${shop}/admin/api/2024-01/orders/${internalOrderId}.json`,
                { headers: { 'X-Shopify-Access-Token': token }, timeout: 20000 });
            const order = oRes.data.order;

            const result = await zohoReturnService.handleShopifyRefund(order, refund);
            if (result.success) {
                await dbAdapter.run(`UPDATE zoho_returns SET status = 'superseded', updated_at = NOW() WHERE id = ?`, [row.id]);
                console.log(`✅ ${internalOrderId} → order #${order.order_number}: credit note ${result.creditNoteId || '(created)'}`);
                ok++;
            } else {
                console.log(`❌ ${internalOrderId} → order #${order.order_number}: ${result.error}`);
                bad++;
            }
        } catch (e) {
            console.log(`❌ ${internalOrderId} replay error: ${e.message}`);
            bad++;
        }
    }
    console.log(`\nDone: ${ok} succeeded, ${bad} failed`);
    process.exit(bad > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
