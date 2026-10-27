require('dotenv').config();
const { dbAdapter } = require('../src/database/db');
(async () => {
    const rows = await dbAdapter.query(
        "SELECT id, shopify_order_id, return_type, error_message, updated_at FROM zoho_returns WHERE status = 'failed' ORDER BY updated_at DESC",
        []
    );
    console.log('failed rows:', rows.length);
    for (const r of rows) {
        console.log(`  id=${r.id} order=#${r.shopify_order_id} type=${r.return_type} err="${String(r.error_message || '').slice(0, 90)}" @ ${r.updated_at}`);
    }
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
