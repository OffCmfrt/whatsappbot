/**
 * Unit test: verify buildZohoInvoicePayload produces ZERO price mismatch
 * against Shopify for various order shapes.
 *
 * Run: node tmp/test_zero_mismatch.js
 */

const { buildZohoInvoicePayload, allocateOrderDiscounts } = require('../src/services/zohoTransform');

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

// Mock DB adapter for bundle map query
const origQuery = require('../src/database/db').dbAdapter.query;
require('../src/database/db').dbAdapter.query = async (sql) => {
    if (typeof sql === 'string' && sql.includes('zoho_bundle_map')) return [];
    return origQuery(sql);
};

function shopifyNet(order) {
    const itemsGross = round2((order.line_items || [])
        .reduce((s, li) => s + (parseFloat(li.price) || 0) * (parseInt(li.quantity) || 1), 0));
    const shipping = round2((order.shipping_lines || [])
        .reduce((s, sl) => s + (parseFloat(sl.price) || 0), 0));
    const discounts = round2(parseFloat(order.total_discounts || 0));
    return round2(itemsGross - discounts + shipping);
}

function zohoNetFromPayload(invoice) {
    return round2((invoice.line_items || []).reduce((s, li) => {
        return s + (parseFloat(li.rate) || 0) * (parseInt(li.quantity) || 1) - (parseFloat(li.discount) || 0);
    }, 0));
}

let passed = 0, failed = 0;

async function test(name, order) {
    try {
        const { invoice } = await buildZohoInvoicePayload(order, 'Haryana');
        const sNet = shopifyNet(order);
        const zNet = zohoNetFromPayload(invoice);
        const delta = Math.abs(sNet - zNet);

        if (delta <= 0.01) {
            console.log(`  ✅ ${name}: Shopify=₹${sNet} Zoho=₹${zNet} Δ=₹${delta}`);
            passed++;
        } else {
            console.log(`  ❌ ${name}: Shopify=₹${sNet} Zoho=₹${zNet} Δ=₹${delta} MISMATCH!`);
            console.log(`     Lines: ${JSON.stringify(invoice.line_items.map(l => ({ name: l.name, rate: l.rate, qty: l.quantity, disc: l.discount })))}`);
            failed++;
        }
    } catch (e) {
        console.log(`  ❌ ${name}: CRASHED — ${e.message}`);
        failed++;
    }
}

async function main() {
    console.log('\n🧪 Zero-Mismatch Price Verification\n');

    // 1) Simple order, no discounts, no shipping
    await test('Simple order (no discount, no shipping)', {
        order_number: 10001,
        total_discounts: '0.00',
        total_price: '1180.00',
        line_items: [
            { title: 'T-Shirt', sku: 'TS-001', quantity: 2, price: '590.00', variant_title: 'M', discount_allocations: [], tax_lines: [{ rate: 0.05 }] }
        ],
        shipping_lines: [],
        shipping_address: { province: 'Karnataka', province_code: 'KA', address1: '123 MG Road', city: 'Bangalore', zip: '560001' }
    });

    // 2) Order with discount code
    await test('Order with ₹200 discount', {
        order_number: 10002,
        total_discounts: '200.00',
        total_price: '980.00',
        line_items: [
            { title: 'Henley', sku: 'HN-001', quantity: 1, price: '1180.00', variant_title: 'L', discount_allocations: [{ amount: '200.00' }], tax_lines: [{ rate: 0.05 }] }
        ],
        shipping_lines: [],
        shipping_address: { province: 'Maharashtra', province_code: 'MH', address1: 'Marine Drive', city: 'Mumbai', zip: '400001' }
    });

    // 3) Order with shipping charge
    await test('Order with ₹80 shipping', {
        order_number: 10003,
        total_discounts: '0.00',
        total_price: '1260.00',
        line_items: [
            { title: 'Polo', sku: 'PL-001', quantity: 1, price: '1180.00', variant_title: 'S', discount_allocations: [], tax_lines: [{ rate: 0.05 }] }
        ],
        shipping_lines: [{ price: '80.00', title: 'Standard Shipping' }],
        shipping_address: { province: 'Delhi', province_code: 'DL', address1: 'CP', city: 'New Delhi', zip: '110001' }
    });

    // 4) Multi-item with proration-prone discount
    await test('3 items with ₹333 discount (proration stress)', {
        order_number: 10004,
        total_discounts: '333.00',
        total_price: '2367.00',
        line_items: [
            { title: 'Item A', sku: 'A', quantity: 1, price: '799.00', variant_title: '', discount_allocations: [], tax_lines: [{ rate: 0.05 }] },
            { title: 'Item B', sku: 'B', quantity: 1, price: '899.00', variant_title: '', discount_allocations: [], tax_lines: [{ rate: 0.05 }] },
            { title: 'Item C', sku: 'C', quantity: 1, price: '999.00', variant_title: '', discount_allocations: [], tax_lines: [{ rate: 0.05 }] }
        ],
        shipping_lines: [],
        shipping_address: { province: 'Haryana', province_code: 'HR', address1: 'Gurugram', city: 'Gurugram', zip: '122001' }
    });

    // 5) Order with discount + shipping + inter-state
    await test('Discount + shipping + inter-state IGST', {
        order_number: 10005,
        total_discounts: '500.00',
        total_price: '2260.00',
        line_items: [
            { title: 'Jacket', sku: 'JK-001', quantity: 1, price: '2499.00', variant_title: 'XL', discount_allocations: [{ amount: '500.00' }], tax_lines: [{ rate: 0.12 }] }
        ],
        shipping_lines: [{ price: '120.00', title: 'Express' }],
        shipping_address: { province: 'Tamil Nadu', province_code: 'TN', address1: 'Anna Nagar', city: 'Chennai', zip: '600040' }
    });

    // 6) Fractional prices (rounding stress test)
    await test('Fractional prices (₹333.33 × 3)', {
        order_number: 10006,
        total_discounts: '100.00',
        total_price: '899.99',
        line_items: [
            { title: 'Sock', sku: 'SK-001', quantity: 3, price: '333.33', variant_title: '', discount_allocations: [], tax_lines: [{ rate: 0.05 }] }
        ],
        shipping_lines: [],
        shipping_address: { province: 'Kerala', province_code: 'KL', address1: 'Kochi', city: 'Kochi', zip: '682001' }
    });

    // 7) Zero-price items (free gift)
    await test('Mixed paid + free items', {
        order_number: 10007,
        total_discounts: '0.00',
        total_price: '590.00',
        line_items: [
            { title: 'T-Shirt', sku: 'TS-001', quantity: 1, price: '590.00', variant_title: 'M', discount_allocations: [], tax_lines: [{ rate: 0.05 }] },
            { title: 'Free Sticker', sku: 'STK-001', quantity: 1, price: '0.00', variant_title: '', discount_allocations: [], tax_lines: [] }
        ],
        shipping_lines: [],
        shipping_address: { province: 'Gujarat', province_code: 'GJ', address1: 'SG Highway', city: 'Ahmedabad', zip: '380015' }
    });

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed === 0) console.log('🎉 ZERO MISMATCH GUARANTEED');
    else console.log('⚠️ SOME TESTS FAILED — review above');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
