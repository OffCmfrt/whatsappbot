/**
 * Zoho Middleware — End-to-End Flow Test
 * --------------------------------------
 * Runs the FULL pipeline against your LIVE Zoho org using a SYNTHETIC order
 * (never touches Shopify, so the native integration cannot interfere):
 *
 *   1. Order → Zoho invoice with correct GST split (Haryana → CGST+SGST)
 *   2. Bundle break (Triple → single ×3) on invoice lines
 *   3. Bundle stock deduction in Zoho Inventory (−3 singles)
 *   4. Duplicate webhook delivery → skipped, still ONE invoice
 *   5. COD delivery → payment recorded, invoice becomes paid
 *   6. RTO → credit note created
 *
 * Usage:
 *   node scripts/zoho_flow_test.js             run the test (leaves records)
 *   node scripts/zoho_flow_test.js --cleanup   delete every test record from Zoho + DB
 *
 * Created Zoho/DB record IDs are saved to tmp/zoho_flow_test_ids.json.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const zohoService = require('../src/services/zohoService');
const zohoSyncService = require('../src/services/zohoSyncService');
const zohoCodService = require('../src/services/zohoCodService');
const zohoReturnService = require('../src/services/zohoReturnService');
const { dbAdapter } = require('../src/database/db');

const IDS_FILE = path.join(__dirname, '../tmp/zoho_flow_test_ids.json');
const BUNDLE_SKU = 'FLOWTEST-TRIPLE';

const results = [];
function check(label, ok, detail = '') {
    results.push({ label, ok });
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
}

async function findSingleItem() {
    // Must be a SELLABLE item — purchase-only items cannot appear on invoices
    let item = await zohoService.getItemByName('HENLEY - 001 ( ACID WASH ) - S');
    if (!item) {
        const items = await zohoService.searchItem({});
        item = (items || []).find(i => (i.name || '').includes('HENLEY - 001'))
            || (items || []).find(i => (i.name || '').toUpperCase().includes('HENLEY') && parseFloat(i.rate) > 0)
            || null;
    }
    return item;
}

async function run() {
    const orderId = '9' + Date.now().toString().slice(-6); // synthetic, won't clash with real orders
    console.log(`\n🧪 FLOW TEST — synthetic order #${orderId}\n`);

    // ---- Seed bundle map: FLOWTEST-TRIPLE → single ×3 @5% ----
    const single = await findSingleItem();
    const componentSku = single?.sku || single?.name || 'FLOWTEST-SINGLE';
    console.log(`📦 Component item: ${single ? `${single.name} (${single.sku || 'no sku'})` : 'NOT FOUND — using synthetic sku'}\n`);

    await dbAdapter.run('DELETE FROM zoho_bundle_map WHERE bundle_sku = ?', [BUNDLE_SKU]);
    await dbAdapter.run(
        'INSERT INTO zoho_bundle_map (bundle_sku, component_sku, component_qty, gst_rate) VALUES (?, ?, ?, ?)',
        [BUNDLE_SKU, componentSku, 3, 5]
    );

    // ---- Stock before ----
    let stockBefore = null;
    if (single?.item_id) {
        const it = await zohoService.getStockOnHand(single.item_id);
        stockBefore = parseFloat(it?.actual_available_stock ?? it?.available_stock ?? NaN);
        console.log(`📉 Stock before: ${componentSku} = ${stockBefore}\n`);
    }

    // ---- Synthetic Shopify order (Haryana customer, COD) ----
    const fakeOrder = {
        id: 889900112233,
        order_number: orderId,
        created_at: new Date().toISOString(),
        email: 'flowtest@example.com',
        phone: '+91 9000000000',
        customer: { first_name: 'Flow', last_name: 'Test', email: 'flowtest@example.com', phone: '+91 9000000000' },
        shipping_address: {
            address1: '123 Test Lane', city: 'Gurugram', province: 'Haryana',
            zip: '122001', country: 'IN', name: 'Flow Test'
        },
        payment_gateway_names: ['cash on delivery'],
        line_items: [
            { title: 'Triple Combo (Flow Test)', sku: BUNDLE_SKU, quantity: 1, price: '1497.00', tax_lines: [{ rate: 0.05 }] },
            { title: single?.name || 'Single (Flow Test)', sku: componentSku, quantity: 1, price: '499.00', tax_lines: [{ rate: 0.05 }] }
        ],
        total_price: '1996.00'
    };

    // ---- 1. Sync order → invoice ----
    const syncRes = await zohoSyncService.syncOrderToZoho(fakeOrder);
    check('Order synced to Zoho', syncRes.success === true && !syncRes.alreadySynced, JSON.stringify(syncRes));

    const invoices = await zohoService.searchInvoice({ reference_number: orderId });
    check('Exactly ONE invoice in Zoho', invoices.length === 1, `found ${invoices.length}`);
    const invoiceId = invoices[0]?.invoice_id;

    let paymentIds = [];
    let creditNoteIds = [];

    if (invoiceId) {
        const inv = await zohoService.getInvoice(invoiceId);
        console.log('\n── Zoho invoice lines ──');
        for (const li of inv.line_items || []) {
            console.log(`   ${li.name} | qty ${li.quantity} | rate ${li.rate} | cgst ${li.cgst_rate ?? 0}% | sgst ${li.sgst_rate ?? 0}% | igst ${li.igst_rate ?? 0}%`);
        }
        console.log(`   sub_total ${inv.sub_total} | tax_total ${inv.tax_total} | total ${inv.total} | status ${inv.status}\n`);

        const lines = inv.line_items || [];
        // Zoho reports the GST split in line_item_taxes[] (tax_specific_type
        // 'cgst'/'sgst'/'igst'), not in top-level cgst_rate/sgst_rate fields
        const taxOf = (li, type) => (li.line_item_taxes || [])
            .filter(t => t.tax_specific_type === type)
            .reduce((s, t) => s + (parseFloat(t.tax_percentage) || 0), 0);
        console.log('── Per-line GST (from line_item_taxes) ──');
        for (const li of lines) {
            console.log(`   ${li.name} | cgst ${taxOf(li, 'cgst')}% | sgst ${taxOf(li, 'sgst')}% | igst ${taxOf(li, 'igst')}%`);
        }
        check('Bundle broken into 3 singles', lines.some(li => (li.name || '').includes(componentSku) && parseFloat(li.quantity) === 3));
        check('Intra-state → CGST 2.5% on every line', lines.length > 0 && lines.every(li => taxOf(li, 'cgst') === 2.5));
        check('Intra-state → SGST 2.5% on every line', lines.length > 0 && lines.every(li => taxOf(li, 'sgst') === 2.5));
        check('No IGST on intra-state order', lines.every(li => taxOf(li, 'igst') === 0));
        check('Tax total > 0 (GST reached Zoho)', parseFloat(inv.tax_total) > 0, `tax_total=${inv.tax_total}`);
        // sent + due-on-receipt ⇒ Zoho reports 'overdue' once past due date;
        // both are healthy "active" states (stock deducted, payments allowed)
        check('Invoice active (sent/overdue — stock + payments active)', ['sent', 'overdue', 'paid'].includes(inv.status), inv.status);

        // ---- 2. Duplicate delivery → skipped ----
        const dupRes = await zohoSyncService.syncOrderToZoho(fakeOrder);
        const invoicesAfterDup = await zohoService.searchInvoice({ reference_number: orderId });
        check('Duplicate webhook skipped', dupRes.alreadySynced === true && invoicesAfterDup.length === 1, JSON.stringify(dupRes));

        // ---- 3. Stock deduction (3 bundle singles + 1 single line = 4) ----
        if (single?.item_id && !isNaN(stockBefore)) {
            const it = await zohoService.getStockOnHand(single.item_id);
            const stockAfter = parseFloat(it?.actual_available_stock ?? it?.available_stock ?? NaN);
            check('Stock deducted for linked singles (−4)', stockAfter === stockBefore - 4, `${stockBefore} → ${stockAfter}`);
        } else {
            check('Stock deducted for linked singles (−4)', false, 'skipped: no real Zoho item to measure');
        }

        // ---- 4. COD delivery → payment recorded ----
        const codRes = await zohoCodService.handleCodDelivery(orderId, { carrier: 'delhivery', awb: 'FLOWTEST123' });
        const invAfterCod = await zohoService.getInvoice(invoiceId);
        const payments = await zohoService.getPayments(invoiceId, inv.invoice_number);
        paymentIds = payments.map(p => p.payment_id);
        check('COD payment recorded', codRes.success === true && payments.length === 1, `status=${invAfterCod.status}, payments=${payments.length}`);
        check('Invoice marked PAID', invAfterCod.status === 'paid', invAfterCod.status);

        // COD again → must not double-record (either the DB reconciled flag
        // or the Zoho-side existing-payment guard may short-circuit)
        const codRes2 = await zohoCodService.handleCodDelivery(orderId, { carrier: 'delhivery', awb: 'FLOWTEST123', force: true });
        const payments2 = await zohoService.getPayments(invoiceId, inv.invoice_number);
        check('COD re-run does NOT double-record', (codRes2.alreadyReconciled === true || codRes2.alreadyPaid === true) && payments2.length === 1, `payments=${payments2.length}, res=${JSON.stringify(codRes2)}`);

        // ---- 5. RTO → credit note ----
        const rtoRes = await zohoReturnService.handleRTOByOrderId(orderId, { carrier: 'delhivery' });
        if (rtoRes.creditNoteId) creditNoteIds.push(rtoRes.creditNoteId);
        check('RTO credit note created', rtoRes.success === true && !!rtoRes.creditNoteId, rtoRes.creditNoteId || rtoRes.error);
    }

    fs.writeFileSync(IDS_FILE, JSON.stringify({ orderId, invoiceId, paymentIds, creditNoteIds, bundleSku: BUNDLE_SKU }, null, 2));

    const failed = results.filter(r => !r.ok);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`RESULT: ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log('FAILED:');
        failed.forEach(f => console.log('  ❌ ' + f.label));
    } else {
        console.log('🎉 FULL FLOW VERIFIED — safe to cut over from the native integration.');
    }
    console.log(`\nRecords kept for your inspection in Zoho Books (order #${orderId}).`);
    console.log(`Clean up with: node scripts/zoho_flow_test.js --cleanup\n`);
}

async function cleanup() {
    if (!fs.existsSync(IDS_FILE)) { console.log('Nothing to clean up (no ids file).'); return; }
    const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
    console.log(`🧹 Cleaning up test order #${ids.orderId}...`);

    for (const pid of ids.paymentIds || []) {
        try { await zohoService.deletePayment(pid); console.log(`🗑 payment ${pid}`); }
        catch (e) { console.log(`⚠️ payment ${pid}: ${e.message}`); }
    }
    for (const cn of ids.creditNoteIds || []) {
        try { await zohoService.deleteCreditNote(cn); console.log(`🗑 credit note ${cn}`); }
        catch (e) { console.log(`⚠️ credit note ${cn}: ${e.message}`); }
    }
    if (ids.invoiceId) {
        try { await zohoService.deleteInvoice(ids.invoiceId); console.log(`🗑 invoice ${ids.invoiceId}`); }
        catch (e) {
            try { await zohoService.voidInvoice(ids.invoiceId); console.log(`🚫 invoice ${ids.invoiceId} voided (not deletable)`); }
            catch (e2) { console.log(`⚠️ invoice ${ids.invoiceId}: ${e2.message}`); }
        }
    }

    for (const [table] of [['zoho_sync_log'], ['zoho_tax_corrections'], ['zoho_cod_payments'], ['zoho_returns']]) {
        await dbAdapter.run(`DELETE FROM ${table} WHERE shopify_order_id = ?`, [ids.orderId]);
    }
    await dbAdapter.run('DELETE FROM zoho_bundle_map WHERE bundle_sku = ?', [ids.bundleSku]);
    fs.unlinkSync(IDS_FILE);
    console.log('✅ Cleanup complete — Zoho and DB restored.');
}

const mode = process.argv[2];
(mode === '--cleanup' ? cleanup() : run())
    .then(() => process.exit(0))
    .catch(e => { console.error('💥 FLOW TEST ERROR:', e.message); process.exit(1); });
