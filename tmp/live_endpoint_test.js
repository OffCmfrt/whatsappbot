/**
 * LIVE ENDPOINT TEST — exercises the deployed Render service end-to-end:
 *
 *   1. Bad HMAC  → must be rejected 401 (verifier working, no crash)
 *   2. Valid HMAC synthetic order → 200, invoice appears in Zoho
 *   3. Duplicate delivery → still ONE invoice
 *   4. Valid HMAC refund → credit note appears in Zoho
 *   5. Cleanup: delete credit note + invoice from Zoho, DB rows
 *
 * Usage: node tmp/live_endpoint_test.js [--cleanup-only]
 */
require('dotenv').config();
const crypto = require('crypto');
const zohoService = require('../src/services/zohoService');
const { dbAdapter } = require('../src/database/db');

const BASE = 'https://whatsappbot-4l4b.onrender.com';
const SECRET = process.env.ZOHO_SHOPIFY_WEBHOOK_SECRET;
const IDS_FILE = __dirname + '/live_test_ids.json';
const fs = require('fs');

const results = [];
function check(label, ok, detail = '') {
    results.push({ label, ok });
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
}
const sign = (buf) => crypto.createHmac('sha256', SECRET).update(buf).digest('base64');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function post(path, body, hmac) {
    const buf = Buffer.from(JSON.stringify(body));
    const headers = { 'Content-Type': 'application/json' };
    if (hmac !== null) headers['X-Shopify-Hmac-Sha256'] = hmac;
    const t0 = Date.now();
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: buf });
    let text = '';
    try { text = await res.text(); } catch (e) { /* ignore */ }
    return { status: res.status, body: text, ms: Date.now() - t0 };
}

async function waitForInvoice(orderId, tries = 12) {
    for (let i = 0; i < tries; i++) {
        const invs = await zohoService.searchInvoice({ reference_number: orderId });
        if (invs.length > 0) return invs;
        await sleep(5000);
    }
    return [];
}

async function run() {
    const orderId = '9' + Date.now().toString().slice(-6);
    console.log(`\n🌐 LIVE TEST against ${BASE} — synthetic order #${orderId}\n`);

    // ---- 1. Bad HMAC must be rejected ----
    const fakeOrder = {
        id: 778899001122,
        order_number: orderId,
        created_at: new Date().toISOString(),
        email: 'livetest@example.com',
        phone: '+91 9000000001',
        customer: { first_name: 'Live', last_name: 'Test', email: 'livetest@example.com', phone: '+91 9000000001' },
        shipping_address: {
            address1: '456 Live Lane', city: 'Gurugram', province: 'Haryana',
            zip: '122002', country: 'IN', name: 'Live Test'
        },
        payment_gateway_names: ['cash on delivery'],
        line_items: [
            { title: 'HENLEY - 001 ( ACID WASH ) - S', sku: 'HENLEY - 001 ( ACID WASH ) - S', quantity: 1, price: '499.00', tax_lines: [{ rate: 0.05 }] }
        ],
        total_price: '523.95'
    };

    console.log('1️⃣ Bad HMAC...');
    const r1 = await post('/webhooks/zoho/orders/create', fakeOrder, 'definitely-wrong-hmac');
    check('Bad HMAC rejected with 401', r1.status === 401, `status=${r1.status} (${r1.ms}ms)`);

    // ---- 2. Valid HMAC → invoice in Zoho ----
    console.log('2️⃣ Valid HMAC order...');
    const r2 = await post('/webhooks/zoho/orders/create', fakeOrder, sign(Buffer.from(JSON.stringify(fakeOrder))));
    check('Webhook accepted (200)', r2.status === 200, `status=${r2.status} body=${r2.body.slice(0, 80)} (${r2.ms}ms)`);

    const invoices = await waitForInvoice(orderId);
    check('Invoice created in Zoho', invoices.length === 1, `found ${invoices.length}`);
    const invoiceId = invoices[0]?.invoice_id;
    const invoiceNumber = invoices[0]?.invoice_number;

    let creditNoteIds = [];
    if (invoiceId) {
        const inv = await zohoService.getInvoice(invoiceId);
        const taxOf = (li, type) => (li.line_item_taxes || [])
            .filter(t => t.tax_specific_type === type)
            .reduce((s, t) => s + (parseFloat(t.tax_percentage) || 0), 0);
        const lines = inv.line_items || [];
        check('GST split correct (CGST 2.5 + SGST 2.5)', lines.length > 0 && lines.every(li => taxOf(li, 'cgst') === 2.5 && taxOf(li, 'sgst') === 2.5));
        check('Invoice marked sent', ['sent', 'overdue', 'partially_paid', 'paid'].includes(inv.status), inv.status);

        // ---- 3. Duplicate delivery ----
        console.log('3️⃣ Duplicate delivery...');
        await post('/webhooks/zoho/orders/create', fakeOrder, sign(Buffer.from(JSON.stringify(fakeOrder))));
        await sleep(15000);
        const afterDup = await zohoService.searchInvoice({ reference_number: orderId });
        check('Duplicate delivery did NOT create 2nd invoice', afterDup.length === 1, `found ${afterDup.length}`);

        // ---- 4. Refund → credit note ----
        console.log('4️⃣ Refund webhook...');
        const refund = {
            id: 556677889,
            order_id: orderId,
            created_at: new Date().toISOString(),
            refund_line_items: [
                {
                    quantity: 1,
                    line_item: {
                        title: 'HENLEY - 001 ( ACID WASH ) - S',
                        sku: 'HENLEY - 001 ( ACID WASH ) - S',
                        quantity: 1, price: '499.00', tax_lines: [{ rate: 0.05 }]
                    }
                }
            ]
        };
        const r4 = await post('/webhooks/zoho/refunds/create', refund, sign(Buffer.from(JSON.stringify(refund))));
        check('Refund webhook accepted (200)', r4.status === 200, `status=${r4.status}`);
        await sleep(20000);
        // credit note search via reference of the order
        const returns = await dbAdapter.query('SELECT zoho_credit_note_id, status FROM zoho_returns WHERE shopify_order_id = ?', [orderId]);
        const cnId = returns[0]?.zoho_credit_note_id;
        if (cnId) creditNoteIds.push(cnId);
        check('Credit note created for refund', !!cnId, cnId || `returns rows=${returns.length} status=${returns[0]?.status || 'none'}`);
    }

    fs.writeFileSync(IDS_FILE, JSON.stringify({ orderId, invoiceId, creditNoteIds }, null, 2));

    const failed = results.filter(r => !r.ok);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`LIVE RESULT: ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) failed.forEach(f => console.log('  ❌ ' + f.label));
    console.log(`\nClean up with: node tmp/live_endpoint_test.js --cleanup-only\n`);
}

async function cleanup() {
    let ids = {};
    if (fs.existsSync(IDS_FILE)) ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
    for (const cn of ids.creditNoteIds || []) {
        try { await zohoService.deleteCreditNote(cn); console.log(`🗑 credit note ${cn}`); }
        catch (e) { console.log(`⚠️ credit note ${cn}: ${e.message}`); }
    }
    if (ids.invoiceId) {
        try { await zohoService.deleteInvoice(ids.invoiceId); console.log(`🗑 invoice ${ids.invoiceId}`); }
        catch (e) { console.log(`⚠️ invoice ${ids.invoiceId}: ${e.message}`); }
    }
    if (ids.orderId) {
        for (const t of ['zoho_sync_log', 'zoho_tax_corrections', 'zoho_cod_payments', 'zoho_returns']) {
            await dbAdapter.run(`DELETE FROM ${t} WHERE shopify_order_id = ?`, [ids.orderId]);
        }
        console.log(`🗑 DB rows for #${ids.orderId}`);
        fs.unlinkSync(IDS_FILE);
    }
    console.log('✅ Cleanup complete.');
}

const mode = process.argv[2];
(mode === '--cleanup-only' ? cleanup() : run())
    .then(() => process.exit(0))
    .catch(e => { console.error('💥 LIVE TEST ERROR:', e); process.exit(1); });
