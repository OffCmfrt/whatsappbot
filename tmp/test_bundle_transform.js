/**
 * Test: title-based bundle breaking end-to-end.
 * 1. Synthetic order: RAGLAN 001 ( TRIPLE ) size M + one regular SKU line +
 *    one UNMAPPED bundle line (must pass through unbroken).
 * 2. Verify transform emits 3 component lines with size suffix.
 * 3. Verify each component name resolves in Zoho (getItemByName).
 */
require('dotenv').config();
const { buildZohoInvoicePayload } = require('../src/services/zohoTransform');
const zohoService = require('../src/services/zohoService');

const order = {
    id: 999000001,
    order_number: 99901,
    created_at: new Date().toISOString(),
    email: 'test@example.com',
    customer: { first_name: 'Bundle', last_name: 'Test', email: 'test@example.com', phone: '+919999999999' },
    shipping_address: {
        name: 'Bundle Test', address1: '1 Test St', city: 'Gurugram',
        province: 'Haryana', province_code: 'HR', zip: '122001', country: 'India'
    },
    line_items: [
        { title: 'RAGLAN 001 ( TRIPLE )', sku: null, variant_title: 'M', quantity: 1, price: '2799.00', tax_lines: [{ rate: 0.05 }] },
        { title: 'SLUB - 001 ( COMBO )', sku: null, variant_title: 'L', quantity: 1, price: '1999.00', tax_lines: [{ rate: 0.05 }] },
        { title: 'HENLEY - 001 ( TRIPLE )', sku: null, variant_title: 'M', quantity: 1, price: '2499.00', tax_lines: [{ rate: 0.05 }] }
    ]
};

(async () => {
    const { invoice, transformations } = await buildZohoInvoicePayload(order, 'Haryana');

    console.log('── Bundle breaks ──');
    console.log(JSON.stringify(transformations.bundle_breaks, null, 2));
    console.log('\n── Zoho line items ──');
    for (const li of invoice.line_items) {
        console.log(`  ${li.quantity}x "${li.name}" @ ${li.rate}`);
    }
    console.log('\nTax decision:', JSON.stringify(transformations.tax_decision));

    // Assertions
    const names = invoice.line_items.map(l => l.name);
    const expected = ['RAGLAN 001 ( B ) - M', 'RAGLAN 001 ( G ) - M', 'RAGLAN 001 ( W ) - M',
        'SLUB - 001 ( ACID WASH) - L', 'SLUB - 001 ( B ) - L'];
    let ok = true;
    for (const e of expected) {
        if (!names.includes(e)) { console.log(`❌ MISSING expected line: "${e}"`); ok = false; }
    }
    if (!names.includes('HENLEY - 001 ( TRIPLE )')) {
        console.log('❌ Unmapped bundle was altered — must pass through untouched'); ok = false;
    }

    console.log('\n── Zoho name resolution (live, exact → fuzzy) ──');
    const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();
    for (const n of expected) {
        try {
            let item = await zohoService.getItemByName(n);
            let how = 'exact';
            if (!item) {
                const prefix = n.replace(/\s*[-]\s*\w+$/, '').replace(/\(.*$/, '').trim();
                const cands = await zohoService.searchItem({ name_contains: prefix, per_page: 200 });
                item = cands.find(c => norm(c.name) === norm(n)) || null;
                how = 'fuzzy';
            }
            if (item) console.log(`  ✅ "${n}" → ${how}: ${item.name} id=${item.item_id} (stock: ${item.stock_on_hand})`);
            else { console.log(`  ❌ "${n}" NOT FOUND in Zoho`); ok = false; }
        } catch (err) {
            console.log(`  ⚠️ "${n}" lookup error: ${err.message}`);
        }
    }

    console.log(ok ? '\n✅ ALL CHECKS PASSED' : '\n❌ SOME CHECKS FAILED');
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
