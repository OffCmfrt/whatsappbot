// Offline logic test for shopifyService.cancelAndRefundOrder
// Stubs Shopify I/O and verifies decision branches (no real API calls).
const svc = require('../src/services/shopifyService');

const CFG = { base: 'https://x.myshopify.com/admin/api/2024-01', headers: {} };
svc._restConfig = () => CFG;

function makeOrder(overrides = {}) {
    return {
        id: 555000111,
        name: '#42999',
        financial_status: 'paid',
        currency: 'INR',
        total_price: '1499.00',
        cancelled_at: null,
        transactions: [{ kind: 'sale', status: 'success', amount: '1499.00' }],
        line_items: [{ id: 1, quantity: 1, refundable_quantity: 1 }],
        ...overrides
    };
}

let refundCalls = 0, cancelCalls = 0;
svc._createFullRefund = async () => { refundCalls++; return 1499; };
svc._cancelShopifyOrder = async () => { cancelCalls++; return null; };
// Simulate the real behaviour: transactions are fetched separately
svc._fetchTransactions = async () => [{ kind: 'sale', status: 'success', amount: '1499.00' }];

(async () => {
    let failures = 0;
    const check = (name, cond) => {
        console.log(`${cond ? '✅' : '❌'} ${name}`);
        if (!cond) failures++;
    };

    // 1. Prepaid order → refund then cancel
    svc.getOrderById = async () => makeOrder();
    let r = await svc.cancelAndRefundOrder('#42999');
    check('prepaid: refunded', r.refunded === true && r.refundAmount === 1499);
    check('prepaid: cancelled', r.cancelled === true);
    check('prepaid: no error', !r.error);

    // 2. Refund failure → must NOT cancel
    svc._createFullRefund = async () => { throw new Error('gateway down'); };
    r = await svc.cancelAndRefundOrder('#42999');
    check('refund fail: not refunded', r.refunded === false);
    check('refund fail: NOT cancelled (money safety)', r.cancelled === false);
    check('refund fail: error surfaced', /Refund failed: gateway down/.test(r.error || ''));
    svc._createFullRefund = async () => { refundCalls++; return 1499; };

    // 3. COD order (pending financial status, no captured transactions) → cancel only, no refund
    svc._fetchTransactions = async () => [];
    svc.getOrderById = async () => makeOrder({ financial_status: 'pending', transactions: [] });
    r = await svc.cancelAndRefundOrder('#43000');
    check('cod: not refunded', r.refunded === false);
    check('cod: skip reason', /Not prepaid/.test(r.refundSkipped || ''));
    check('cod: cancelled', r.cancelled === true);

    // 4. refundPrepaid=false → paid order cancelled without refund
    svc._fetchTransactions = async () => [{ kind: 'sale', status: 'success', amount: '1499.00' }];
    svc.getOrderById = async () => makeOrder();
    r = await svc.cancelAndRefundOrder('#43001', { refundPrepaid: false });
    check('toggle off: not refunded', r.refunded === false);
    check('toggle off: skip reason', /disabled/.test(r.refundSkipped || ''));
    check('toggle off: cancelled', r.cancelled === true);

    // 5. Already cancelled in Shopify → idempotent pass-through
    svc.getOrderById = async () => makeOrder({ cancelled_at: '2026-08-01T00:00:00Z', financial_status: 'refunded' });
    r = await svc.cancelAndRefundOrder('#43002');
    check('already cancelled: flagged', r.alreadyCancelled === true && r.cancelled === true);
    check('already refunded: skip reason', /Already refunded/.test(r.refundSkipped || ''));

    // 6. Order not found
    svc.getOrderById = async () => null;
    r = await svc.cancelAndRefundOrder('#99999');
    check('not found: error', /not found/i.test(r.error || ''));
    check('not found: not cancelled', r.cancelled === false);

    console.log(failures === 0 ? '\n🎉 ALL TESTS PASSED' : `\n💥 ${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
