/**
 * Diagnose Zoho return failure for order #55668:
 * "credit notes balance isn't negative" (400).
 *
 * Usage: node tmp/diag-55668.js [orderNumber]
 */
require('dotenv').config();
const zohoService = require('../src/services/zohoService');
const { dbAdapter } = require('../src/database/db');

const ORDER = (process.argv[2] || '55668').replace(/^#/, '');

async function main() {
    console.log(`\n===== Order #${ORDER} =====\n`);

    // 1. DB: zoho_returns rows
    const returns = await dbAdapter.query(
        `SELECT id, shopify_order_id, shopify_return_id, return_type, status, error_message, zoho_credit_note_id, original_items, corrected_items, created_at, updated_at
         FROM zoho_returns WHERE shopify_order_id = ? ORDER BY created_at DESC`,
        [ORDER]
    );
    console.log(`📋 zoho_returns rows: ${returns.length}`);
    for (const r of returns) {
        console.log(`  - id=${r.id} type=${r.return_type} status=${r.status} ref=${r.shopify_return_id} cn=${r.zoho_credit_note_id} err="${r.error_message}" updated=${r.updated_at}`);
        try {
            const items = typeof r.original_items === 'string' ? JSON.parse(r.original_items) : r.original_items;
            console.log(`    items: ${JSON.stringify(items)}`);
        } catch (e) { /* ignore */ }
    }

    // 2. Zoho: invoice lookup by reference number
    const invoices = await zohoService.searchInvoice({ reference_number: ORDER });
    console.log(`\n🧾 Zoho invoices matching reference #${ORDER}: ${invoices.length}`);
    for (const inv of invoices) {
        console.log(`  - invoice_id=${inv.invoice_id} number=${inv.invoice_number} status=${inv.status} total=${inv.total} balance=${inv.balance} ref="${inv.reference_number}" date=${inv.date}`);
    }
    const invoice = invoices.find(i => i.status !== 'void' && i.status !== 'deleted') || invoices[0];
    if (!invoice) {
        console.log('❌ No invoice found in Zoho for this order.');
        process.exit(0);
    }

    // 3. Full invoice detail (credits_applied only exists on detail endpoint)
    const full = await zohoService.getInvoice(invoice.invoice_id);
    console.log(`\n🔎 Invoice detail:`);
    console.log(`  total=${full.total} balance=${full.balance} credits_applied=${full.credits_applied} payments_applied=${full.payments_applied} discount=${full.discount} shipping_charge=${full.shipping_charge} status=${full.status}`);
    console.log(`  line_items:`);
    for (const l of full.line_items || []) {
        console.log(`    - "${l.name}" qty=${l.quantity} rate=${l.rate} amount=${l.amount} tax=${JSON.stringify(l.taxes || [])}`);
    }

    // 4. Credit notes tied to this invoice (list has no invoice_id — match reference candidates)
    const candidates = new Set([
        `#${ORDER}`, ORDER,
        ...(invoices.map(i => i.reference_number).filter(Boolean)),
    ]);
    console.log(`\n💳 Scanning credit notes for reference candidates: ${[...candidates].join(', ')}`);
    let matched = [];
    for (let page = 1; page <= 10; page++) {
        const result = await zohoService.zohoRequest('get', `${(process.env.ZOHO_BOOKS_DOMAIN || 'zoho.in').length ? 'https://www.zohoapis.' + ((process.env.ZOHO_BOOKS_DOMAIN || 'zoho.in').split('.').slice(1).join('.') || 'in') : 'zoho.in'}/books/v3/creditnotes`, null, { page, per_page: 200 });
        const notes = result.creditnotes || [];
        if (notes.length === 0) break;
        for (const cn of notes) {
            const ref = String(cn.reference_number || '');
            const digits = ref.replace(/\D/g, '');
            if ([...candidates].some(c => ref === c || ref.includes(c)) || digits === ORDER) {
                matched.push(cn);
            }
        }
        if (notes.length < 200) break;
    }
    console.log(`  matched credit notes: ${matched.length}`);
    for (const cn of matched) {
        console.log(`  - creditnote_id=${cn.creditnote_id} number=${cn.creditnote_number} status=${cn.status} total=${cn.total} ref="${cn.reference_number}" date=${cn.date}`);
    }
    // Detail for each matched note to see per-line amounts
    for (const cn of matched) {
        try {
            const d = await zohoService.getCreditNote(cn.creditnote_id);
            console.log(`\n  📄 ${cn.creditnote_number} detail (total=${d.total}):`);
            for (const l of d.line_items || []) {
                console.log(`    - "${l.name}" qty=${l.quantity} rate=${l.rate} amount=${l.amount}`);
            }
        } catch (e) {
            console.warn(`  ⚠️ detail fetch failed for ${cn.creditnote_id}: ${e.message}`);
        }
    }

    // 5. Verdict math
    const total = parseFloat(full.total) || 0;
    const alreadyCredited = parseFloat(full.credits_applied) || 0;
    const remaining = total - alreadyCredited;
    console.log(`\n⚖️  Creditable remaining on invoice: ₹${remaining.toFixed(2)} (total ₹${total.toFixed(2)} - credited ₹${alreadyCredited.toFixed(2)})`);

    process.exit(0);
}

main().catch(e => { console.error('💥 probe failed:', e.message); process.exit(1); });
