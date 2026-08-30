/**
 * LIVE AUDIT — 24-36h of Zoho middleware activity.
 * A) DB: sync logs, tax corrections, returns, COD payments, bundle map
 * B) Zoho API: verify recent invoices (tax split, item linkage, status)
 */
require('dotenv').config();
const { dbAdapter } = require('../src/database/db');
const zoho = require('../src/services/zohoService');

const p = (s) => console.log(s);

(async () => {
    // ── A1. Sync log (last 36h) ──────────────────────────────
    const logs = await dbAdapter.query(
        `SELECT shopify_order_id, zoho_invoice_id, status, transformation, error_message, created_at
         FROM zoho_sync_log WHERE created_at > NOW() - INTERVAL '36 hours'
         ORDER BY created_at DESC`, []);
    p(`\n═══ SYNC LOG (last 36h): ${logs.length} rows ═══`);
    const byStatus = {};
    for (const r of logs) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    p('Status counts: ' + JSON.stringify(byStatus));
    for (const r of logs.slice(0, 25)) {
        const t = r.transformation || {};
        const breaks = (t.bundle_breaks || []).length;
        const taxc = (t.tax_corrections || []).length;
        const taxd = t.tax_decision ? `${t.tax_decision.taxType}/${t.tax_decision.isInterState ? 'inter' : 'intra'}` : '-';
        p(`  #${r.shopify_order_id} | ${r.status} | inv=${r.zoho_invoice_id || '-'} | bundleBreaks=${breaks} taxCorr=${taxc} tax=${taxd} | ${String(r.created_at).slice(0, 16)}${r.error_message ? ' | ERR: ' + String(r.error_message).slice(0, 120) : ''}`);
    }

    // ── A2. Tax corrections ──────────────────────────────────
    const taxRows = await dbAdapter.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE correction_type ILIKE '%state%')::int AS state_fixes,
                COUNT(*) FILTER (WHERE correction_type ILIKE '%rate%')::int AS rate_fixes
         FROM zoho_tax_corrections WHERE created_at > NOW() - INTERVAL '36 hours'`, []);
    p(`\n═══ TAX CORRECTIONS (36h) ═══\n  ${JSON.stringify(taxRows[0])}`);

    // ── A3. Returns / RTO ────────────────────────────────────
    const rets = await dbAdapter.query(
        `SELECT shopify_order_id, return_type, zoho_credit_note_id, status, error_message, created_at
         FROM zoho_returns ORDER BY created_at DESC LIMIT 15`, []);
    p(`\n═══ RETURNS/RTO: ${rets.length} rows ═══`);
    for (const r of rets) p(`  #${r.shopify_order_id} | ${r.return_type} | ${r.status} | cn=${r.zoho_credit_note_id || '-'}${r.error_message ? ' | ERR: ' + String(r.error_message).slice(0, 100) : ''}`);

    // ── A4. COD payments ─────────────────────────────────────
    const cods = await dbAdapter.query(
        `SELECT shopify_order_id, zoho_invoice_id, zoho_payment_id, amount, payment_status, carrier, awb, reconciled_at, created_at
         FROM zoho_cod_payments ORDER BY created_at DESC LIMIT 15`, []);
    p(`\n═══ COD PAYMENTS: ${cods.length} rows ═══`);
    for (const r of cods) p(`  #${r.shopify_order_id} | ₹${r.amount} | ${r.payment_status} | pay=${r.zoho_payment_id || '-'} | ${r.carrier || '-'} ${r.awb || ''} | reconciled=${r.reconciled_at ? 'YES' : 'no'}`);

    // ── A5. Bundle map ───────────────────────────────────────
    const bm = await dbAdapter.query(`SELECT bundle_sku, COUNT(*)::int AS parts FROM zoho_bundle_map GROUP BY bundle_sku ORDER BY bundle_sku`, []);
    p(`\n═══ BUNDLE MAP: ${bm.length} bundles ═══`);
    for (const r of bm) p(`  ${r.bundle_sku} → ${r.parts} components`);

    // ── B. Zoho-side verification of recent invoices ─────────
    const ok = logs.filter(r => r.status === 'synced' && r.zoho_invoice_id).slice(0, 6);
    p(`\n═══ ZOHO-SIDE VERIFICATION (${ok.length} invoices) ═══`);
    for (const r of ok) {
        try {
            const inv = await zoho.getInvoice(r.zoho_invoice_id);
            const taxes = new Set();
            let linked = 0, unlinked = 0;
            for (const li of inv.line_items || []) {
                if ((li.cgst_rate || 0) > 0 || (li.sgst_rate || 0) > 0) taxes.add(`CGST${li.cgst_rate}+SGST${li.sgst_rate}`);
                else if ((li.igst_rate || 0) > 0) taxes.add(`IGST${li.igst_rate}`);
                else taxes.add('0%');
                if (li.item_id && String(li.item_id).length > 5) linked++; else unlinked++;
            }
            const pays = await zoho.getPayments(r.zoho_invoice_id);
            const paid = (pays || []).reduce((s, x) => s + parseFloat(x.amount || 0), 0);
            p(`  #${r.shopify_order_id} ${inv.invoice_number} | total=₹${inv.total} | tax=[${[...taxes].join(', ')}] | itemsLinked=${linked}/${linked + unlinked} | status=${inv.status} | paid=₹${paid} | pos=${inv.place_of_supply || '-'}`);
        } catch (e) {
            p(`  #${r.shopify_order_id} FETCH FAIL: ${e.message}`);
        }
    }

    p('\n✅ AUDIT COMPLETE');
    process.exit(0);
})().catch(e => { console.error('AUDIT FAILED:', e); process.exit(1); });
