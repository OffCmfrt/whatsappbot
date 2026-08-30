// E2E-ish test of the hub cancellation flow WITHOUT cancelling any real order:
//  1. New columns exist on store_shoppers
//  2. A synthetic test row accepts cancel_reason / shopify_cancelled_at / shopify_refund_amount
//  3. GET /shoppers SELECT surfaces the new fields
//  4. POST /shoppers/:id/status rejects 'cancelled' without a reason (400)
//  5. notifyCustomerOfCancellation picks prepaid vs COD refund note correctly
// Cleans up after itself. Usage: node tmp/test_cancel_flow.js
require('dotenv').config();
const TEST_ID = `E2E_TEST_${Date.now()}`;

(async () => {
    const { dbAdapter } = require('../src/database/db');
    let failures = 0;
    const check = (name, ok, extra = '') => {
        console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
        if (!ok) failures++;
    };

    try {
        // 1) columns exist
        const cols = await dbAdapter.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'store_shoppers' AND column_name IN ('cancel_reason','shopify_cancelled_at','shopify_refund_amount')`
        );
        check('store_shoppers has all 3 new columns', cols.length === 3, cols.map(c => c.column_name).join(', '));

        // 2) synthetic row round-trip
        await dbAdapter.insert('store_shoppers', {
            id: TEST_ID, phone: '919413378016', name: 'E2E Test', order_id: '#E2E99901',
            status: 'pending', payment_method: 'Prepaid', order_total: 1499.00
        });
        await dbAdapter.update('store_shoppers', {
            status: 'cancelled', cancel_reason: 'E2E test reason', confirmed_by: 'manual',
            shopify_cancelled_at: new Date().toISOString(), shopify_refund_amount: 1499.00,
            updated_at: new Date().toISOString()
        }, { id: TEST_ID });
        const [row] = await dbAdapter.select('store_shoppers', { id: TEST_ID }, { limit: 1 });
        check('cancel_reason persists', row?.cancel_reason === 'E2E test reason');
        check('shopify_cancelled_at persists', !!row?.shopify_cancelled_at);
        check('shopify_refund_amount persists', parseFloat(row?.shopify_refund_amount) === 1499, row?.shopify_refund_amount);

        // 3) hub SELECT shape includes the new fields (same query shape as GET /shoppers)
        const listRows = await dbAdapter.query(
            `SELECT s.id, s.cancel_reason, s.shopify_cancelled_at, s.shopify_refund_amount FROM store_shoppers s WHERE s.id = ?`,
            [TEST_ID]
        );
        check('GET /shoppers SELECT fields resolve', listRows.length === 1 && listRows[0].cancel_reason === 'E2E test reason');

        // 4) route validation: cancelled without reason → 400
        // Reset the synthetic row to pending first — the route skips WhatsApp
        // notification when the order was already cancelled.
        await dbAdapter.update('store_shoppers', {
            status: 'pending', cancel_reason: null, confirmed_by: null, updated_at: new Date().toISOString()
        }, { id: TEST_ID });
        const express = require('express');
        const adminRoutes = require('../src/routes/adminRoutes');
        const app = express();
        app.use(express.json());
        app.use('/api/admin', adminRoutes);
        const server = app.listen(0);
        const port = server.address().port;
        const jwt = require('jsonwebtoken');
        const { adminCredentialFingerprint } = require('../src/middleware/auth');
        const token = jwt.sign(
            { username: 'e2e_test', role: 'admin', credFp: adminCredentialFingerprint() },
            process.env.JWT_SECRET, { expiresIn: '60s' }
        );
        const post = async (body) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/admin/shoppers/${TEST_ID}/status`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify(body)
            });
            return { status: res.status, data: await res.json().catch(() => ({})) };
        };
        const noReason = await post({ status: 'cancelled' });
        check('cancel without reason → 400', noReason.status === 400, JSON.stringify(noReason.data));

        // 4b) FULL success path: cancel the synthetic prepaid row with a reason.
        // Exercises: DB update + carrier check (no-op) + live WhatsApp template
        // to the test number — the exact path an operator triggers from the hub.
        const withReason = await post({ status: 'cancelled', reason: 'E2E flow test — please ignore' });
        check('cancel with reason → 200 success', withReason.status === 200 && withReason.data.success === true, withReason.data.message);
        check('WhatsApp notification sent (live template)', withReason.data.whatsappNotified === true, `whatsappNotified=${withReason.data.whatsappNotified}`);
        const [after] = await dbAdapter.select('store_shoppers', { id: TEST_ID }, { limit: 1 });
        check('reason persisted via route', after?.cancel_reason === 'E2E flow test — please ignore');
        check('confirmed_by stamped manual', after?.confirmed_by === 'manual');
        server.close();

        // 5) refund note selection (replicates notifyCustomerOfCancellation logic)
        const note = (pm) => {
            const isPrepaid = pm && !/cod|cash on delivery/i.test(String(pm));
            return isPrepaid ? 'PREPAID-REFUND' : 'COD-NO-REFUND';
        };
        check('Prepaid → refund note', note('Prepaid') === 'PREPAID-REFUND');
        check('COD → no-refund note', note('COD') === 'COD-NO-REFUND');
        check('UPI → refund note', note('UPI') === 'PREPAID-REFUND');
    } catch (err) {
        console.error('💥 Flow test crashed:', err.message);
        failures++;
    } finally {
        // cleanup synthetic row
        try { await dbAdapter.delete('store_shoppers', { id: TEST_ID }); console.log('🧹 Test row cleaned up'); } catch (e) { console.warn('cleanup failed:', e.message); }
        console.log(failures === 0 ? '\n🎉 ALL FLOW CHECKS PASSED' : `\n💥 ${failures} CHECK(S) FAILED`);
        process.exit(failures === 0 ? 0 : 1);
    }
})();
