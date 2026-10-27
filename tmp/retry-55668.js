/**
 * Retry the failed return for order #55668 (zoho_returns id 5605) after the
 * discount double-count fix. Sets the stale row back to 'failed' so the
 * refund-id idempotency check doesn't self-match, then replays the handler.
 */
require('dotenv').config();
const { dbAdapter } = require('../src/database/db');
const zohoReturnService = require('../src/services/zohoReturnService');

(async () => {
    await dbAdapter.run(
        "UPDATE zoho_returns SET status = 'failed', updated_at = NOW() WHERE id = 5605",
        []
    );
    const rows = await dbAdapter.query('SELECT original_items FROM zoho_returns WHERE id = 5605', []);
    const items = typeof rows[0].original_items === 'string' ? JSON.parse(rows[0].original_items) : rows[0].original_items;

    const r = await zohoReturnService.handleShopifyRefund(
        { order_number: '55668', id: '55668' },
        { id: '999625392372', line_items: items }
    );
    console.log('result:', JSON.stringify(r, null, 2));
    if (r.success) {
        await dbAdapter.run(
            "UPDATE zoho_returns SET status = 'superseded', updated_at = NOW() WHERE id = 5605 AND status = 'failed'",
            []
        );
        console.log('old row 5605 marked superseded');
    }
    process.exit(r.success ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
