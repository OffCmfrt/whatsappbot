/**
 * Deep-dive on audit findings:
 * 1. Failed customer returns — timestamps + resolve REAL order numbers
 * 2. Bundle orders in last 48h (did any bundle line items arrive?)
 * 3. Zoho-side: CGST/SGST on a Haryana invoice + COD invoice paid status
 */
require('dotenv').config();
const { dbAdapter } = require('../src/database/db');
const zoho = require('../src/services/zohoService');
const p = (s) => console.log(s);

(async () => {
    // 1. Failed returns with timestamps
    const failed = await dbAdapter.query(
        `SELECT id, shopify_order_id, shopify_return_id, created_at, error_message
         FROM zoho_returns WHERE status = 'failed' ORDER BY created_at DESC`, []);
    p(`═══ FAILED RETURNS: ${failed.length} ═══`);
    for (const r of failed) p(`  id=${r.id} key=${r.shopify_order_id} refund=${r.shopify_return_id} at=${String(r.created_at).slice(0, 19)}`);

    // Resolve real order numbers: sync log stores order_number in shopify_order_id
    // but original_payload.id = Shopify internal id
    for (const r of failed) {
        const m = await dbAdapter.query(
            `SELECT shopify_order_id FROM zoho_sync_log
             WHERE shopify_order_id = ? OR original_payload->>'id' = ?
             ORDER BY created_at DESC LIMIT 1`, [r.shopify_order_id, r.shopify_order_id]);
        p(`    ${r.shopify_order_id} → real order: ${m.length ? '#' + m[0].shopify_order_id : 'NOT IN SYNC LOG'}`);
    }

    // 2. Bundle line items arriving? Search original payloads for bundle keywords
    const bundles = await dbAdapter.query(
        `SELECT shopify_order_id, created_at,
                (transformation->'bundle_breaks') AS breaks
         FROM zoho_sync_log
         WHERE created_at > NOW() - INTERVAL '48 hours'
           AND (original_payload::text ILIKE '%TRIPLE%' OR original_payload::text ILIKE '%COMBO%' OR original_payload::text ILIKE '%BUNDLE%')
         ORDER BY created_at DESC LIMIT 20`, []);
    p(`\n═══ ORDERS WITH BUNDLE KEYWORDS (48h): ${bundles.length} ═══`);
    for (const r of bundles) {
        const nb = Array.isArray(r.breaks) ? r.breaks.length : 0;
        p(`  #${r.shopify_order_id} | bundleBreaks=${nb} | ${String(r.created_at).slice(0, 19)}`);
    }

    // 3a. Haryana intra-state invoice — verify CGST+SGST on Zoho side (#46070)
    const hr = await dbAdapter.query(`SELECT zoho_invoice_id FROM zoho_sync_log WHERE shopify_order_id = '46070' LIMIT 1`, []);
    if (hr.length) {
        const inv = await zoho.getInvoice(hr[0].zoho_invoice_id);
        const li = inv.line_items[0];
        const taxes = (li.line_item_taxes || []).map(t => `${t.tax_name} ₹${t.tax_amount} (${t.tax_specific_type})`);
        p(`\n═══ #46070 (Haryana customer) ${inv.invoice_number} ═══`);
        p(`  pos=${inv.place_of_supply} | line taxes: ${taxes.join(' + ') || 'NONE'}`);
        p(`  invoice taxes: ${(inv.taxes || []).map(t => `${t.tax_name}=₹${t.tax_amount}`).join(', ')}`);
    }

    // 3b. COD invoice paid status — #45040
    const cod = await dbAdapter.query(`SELECT zoho_invoice_id FROM zoho_sync_log WHERE shopify_order_id = '45040' LIMIT 1`, []);
    if (cod.length) {
        const inv = await zoho.getInvoice(cod[0].zoho_invoice_id);
        p(`\n═══ #45040 (COD) ${inv.invoice_number} ═══`);
        p(`  status=${inv.status} | total=₹${inv.total} | balance=₹${inv.balance}`);
        const pays = await zoho.getPayments(inv.invoice_id, inv.invoice_number);
        for (const pay of pays) p(`  payment ${pay.payment_id}: ₹${pay.amount} on ${pay.date} (${pay.payment_mode})`);
    }

    p('\n✅ DEEP-DIVE COMPLETE');
    process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
