/**
 * Sanity checks for the Zoho transform overhaul (no live APIs):
 *  - discount allocation (per-line + prorated order-level)
 *  - bundle break discount proration
 *  - credit note mirrors invoice tax basis / discount / item linkage
 *  - Haryana same-state POS guard
 */
// Mock the DB module before anything requires it
const Module = require('module');
const origResolve = Module._resolveFilename;
const dbPath = require.resolve('../src/database/db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { dbAdapter: { query: async () => [] }, pool: { query: async () => {} } }
};

const {
    allocateOrderDiscounts,
    breakBundleLineItems,
    buildCreditNoteFromInvoice,
    buildCreditNotePayload,
    creditNoteReference,
    determineTaxType,
    stateCodeOf
} = require('../src/services/zohoTransform');

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
    if (cond) { pass++; console.log(`✅ ${label}`); }
    else { fail++; console.log(`❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
    // ---- 1. Discount allocation: per-line allocations win ----
    const items1 = [
        { price: 1000, quantity: 1, discount_allocations: [{ amount: '100.00' }] },
        { price: 500, quantity: 2, discount_allocations: [] }
    ];
    const alloc1 = allocateOrderDiscounts({ total_discounts: '999' }, items1);
    check('per-line discount_allocations used', alloc1[0] === 100 && alloc1[1] === 0, JSON.stringify(alloc1));

    // ---- 2. Discount allocation: prorate order-level by gross ----
    const items2 = [
        { price: 1000, quantity: 1 },
        { price: 500, quantity: 1 }
    ];
    const alloc2 = allocateOrderDiscounts({ total_discounts: '150' }, items2);
    check('order-level proration sums to total', Math.round((alloc2[0] + alloc2[1]) * 100) / 100 === 150, JSON.stringify(alloc2));
    check('order-level proration proportional', alloc2[0] === 100 && alloc2[1] === 50, JSON.stringify(alloc2));

    // ---- 3. Bundle break propagates parent discount ----
    const bundleMap = { 'HENLEY TRIPLE': [{ component_sku: 'HENLEY - 001 ( ACID WASH )', component_qty: 3, gst_rate: 5 }] };
    const bundleItems = [{ title: 'HENLEY TRIPLE', sku: 'HENLEY TRIPLE', quantity: 1, price: 3000, discount: 300, variant: 'M' }];
    const { lineItems: broken } = breakBundleLineItems(bundleItems, bundleMap);
    check('bundle expanded to singles', broken.length === 1 && broken[0].quantity === 3 && broken[0].name.endsWith('- M'), JSON.stringify(broken.map(b => b.name)));
    check('bundle discount prorated to components', broken[0].discount === 300, JSON.stringify(broken.map(b => b.discount)));
    check('bundle rate per unit', broken[0].rate === 1000);

    // ---- 4. Credit note mirrors the original invoice ----
    const fakeInvoice = {
        invoice_id: 'inv1',
        is_inclusive_tax: true,
        line_items: [
            {
                name: 'HENLEY - 001 ( ACID WASH ) - XS', sku: 'HENLEY - 001 ( ACID WASH ) - XS',
                item_id: '111', quantity: 1, rate: 1000, item_total: 900,
                discounts: [{ discount_amount: 100 }],
                taxes: [{ tax_name: 'CGST', rate: 2.5 }, { tax_name: 'SGST', rate: 2.5 }]
            },
            {
                name: 'RAGLAN - 002 ( G ) - M', sku: 'RAGLAN - 002 ( G ) - M',
                item_id: '222', quantity: 1, rate: 800, item_total: 800,
                discounts: [],
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            }
        ]
    };
    const shopifyOrder = {
        order_number: 46001,
        customer: { first_name: 'Test', last_name: 'Buyer' },
        shipping_address: { province: 'Haryana' }
    };
    const returned = [{ title: 'HENLEY - 001 ( ACID WASH ) - XS', sku: 'HENLEY - 001 ( ACID WASH ) - XS', quantity: 1, price: 1000 }];
    const cn = await buildCreditNoteFromInvoice({
        shopifyOrder, returnItems: returned, returnType: 'return',
        originalInvoice: fakeInvoice, referenceNumber: 'RET-46001-r1'
    });
    check('credit line matched invoice line', cn.line_items.length === 1, JSON.stringify(cn.line_items));
    const cl = cn.line_items[0];
    check('credit copies rate', cl.rate === 1000);
    check('credit copies discount share', cl.discount === 100, `discount=${cl.discount}`);
    check('credit copies CGST+SGST basis', cl.cgst_rate === 2.5 && cl.sgst_rate === 2.5 && !cl.igst_rate, JSON.stringify(cl));
    check('credit links item_id (stock reversal)', cl.item_id === '111');
    check('credit copies is_inclusive_tax', cn.is_inclusive_tax === true);
    check('credit reference convention', cn.reference_number === 'RET-46001-r1');

    // IGST line mirrored as IGST
    const cn2 = await buildCreditNoteFromInvoice({
        shopifyOrder,
        returnItems: [{ title: 'RAGLAN - 002 ( G ) - M', sku: 'RAGLAN - 002 ( G ) - M', quantity: 1, price: 800 }],
        returnType: 'rto', originalInvoice: fakeInvoice, referenceNumber: 'RTO-46001'
    });
    check('interstate credit keeps IGST basis', cn2.line_items[0].igst_rate === 5 && !cn2.line_items[0].cgst_rate, JSON.stringify(cn2.line_items[0]));

    // Returned bundle expands and matches component invoice lines
    const bundleInvoice = {
        invoice_id: 'inv2', is_inclusive_tax: false,
        line_items: [{
            name: 'HENLEY - 001 ( ACID WASH ) - S', sku: 'HENLEY - 001 ( ACID WASH ) - S',
            item_id: '333', quantity: 3, rate: 1000, item_total: 3000, discounts: [],
            taxes: [{ tax_name: 'CGST', rate: 2.5 }, { tax_name: 'SGST', rate: 2.5 }]
        }]
    };
    // Seed the bundle map through the mocked adapter for this call
    require.cache[dbPath].exports.dbAdapter.query = async () => [
        { bundle_sku: 'HENLEY TRIPLE', component_sku: 'HENLEY - 001 ( ACID WASH )', component_qty: 3, gst_rate: 5 }
    ];
    const cn3 = await buildCreditNoteFromInvoice({
        shopifyOrder,
        returnItems: [{ title: 'HENLEY TRIPLE', sku: 'HENLEY TRIPLE', quantity: 1, price: 3000, variant: 'S' }],
        returnType: 'rto', originalInvoice: bundleInvoice, referenceNumber: 'RTO-46002'
    });
    check('returned bundle credited as size-wise singles', cn3.line_items.length === 1 && cn3.line_items[0].name.includes('- S') && cn3.line_items[0].quantity === 3 && cn3.line_items[0].item_id === '333', JSON.stringify(cn3.line_items));

    // ---- 5. Legacy fallback derives tax from decision (not hardcoded) ----
    const legacy = buildCreditNotePayload(shopifyOrder, [{ title: 'X', quantity: 1, price: 100 }], 'rto', '', { taxType: 'igst' });
    check('legacy fallback honors IGST decision', legacy.line_items[0].igst_rate === 5 && !legacy.line_items[0].cgst_rate, JSON.stringify(legacy.line_items[0]));

    // ---- 6. Haryana same-state decision + POS guard inputs ----
    const tax = determineTaxType('Haryana', 'Haryana');
    check('Haryana↔Haryana is intra-state', tax.taxType === 'cgst_sgst');
    check('state code HR resolvable', stateCodeOf('Haryana') === 'HR');
    check('reference convention RTO', creditNoteReference('#46010', 'rto') === 'RTO-46010');
    check('reference convention exchange', creditNoteReference('46010', 'exchange') === 'EXCH-46010');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Test crash:', e); process.exit(1); });
