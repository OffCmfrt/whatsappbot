/**
 * Test: WhatsApp confirmation button must act on exactly ONE order —
 * the order whose confirmation message was most recently sent to the phone.
 *
 * Fully isolated: DB adapter and WhatsApp service are stubbed in-memory.
 * No real DB connection, no real WhatsApp calls.
 *
 * Run: node test/test_button_confirm_single_order.js
 */
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');

// ── In-memory state ────────────────────────────────────────────────────────
const PHONE = '919999999999';

// Order A: created EARLIER but its confirmation was sent LAST (customer is
// looking at A's message). Order B: created LATER but confirmation sent earlier.
// The old buggy logic (ORDER BY created_at DESC) would pick B — the new logic
// must pick A.
let shoppers = [];
let confirmations = [];
const updates = [];           // every UPDATE store_shoppers call: { params, sql }
const sentMessages = [];      // every whatsapp message sent

function resetState(withConfirmations) {
    shoppers = [
        { id: 'shop_A', phone: PHONE, order_id: '42001', status: 'pending', created_at: '2026-08-08T10:00:00Z' },
        { id: 'shop_B', phone: PHONE, order_id: '42002', status: 'pending', created_at: '2026-08-08T11:00:00Z' }
    ];
    confirmations = withConfirmations ? [
        { phone: PHONE, order_id: '42001', sent_at: '2026-08-08T12:00:00Z' }, // A sent LAST
        { phone: PHONE, order_id: '42002', sent_at: '2026-08-08T11:05:00Z' }  // B sent earlier
    ] : [];
    updates.length = 0;
    sentMessages.length = 0;
}

// ── Stub dbAdapter ─────────────────────────────────────────────────────────
const dbAdapter = {
    async query(sql, params = []) {
        if (sql.includes('LEFT JOIN shopper_confirmations')) {
            // resolveShopperForButtonClick join query
            const phone = params[0];
            const status = params.length > 1 ? params[1] : null;
            let rows = shoppers
                .filter(s => s.phone === phone && (!status || s.status === status))
                .map(s => {
                    const c = confirmations.find(x => x.phone === s.phone && x.order_id === s.order_id);
                    return { id: s.id, order_id: s.order_id, confirmation_sent_at: c ? c.sent_at : null };
                });
            // ORDER BY c.sent_at DESC NULLS LAST, s.created_at DESC
            rows.sort((a, b) => {
                const an = a.confirmation_sent_at === null, bn = b.confirmation_sent_at === null;
                if (an !== bn) return an ? 1 : -1; // NULLS LAST
                if (!an && !bn && a.confirmation_sent_at !== b.confirmation_sent_at) {
                    return a.confirmation_sent_at < b.confirmation_sent_at ? 1 : -1;
                }
                const sa = shoppers.find(s => s.id === a.id).created_at;
                const sb = shoppers.find(s => s.id === b.id).created_at;
                return sa < sb ? 1 : -1;
            });
            return rows.slice(0, 1);
        }
        if (sql.includes('UPDATE store_shoppers')) {
            updates.push({ sql, params });
            // simulate WHERE id = ? (params order: now, msg, now, id)
            const id = params[params.length - 1];
            const target = shoppers.find(s => s.id === id);
            if (target && sql.includes("'confirmed'")) target.status = 'confirmed';
            if (target && sql.includes("'cancelled'")) target.status = 'cancelled';
            if (target && sql.includes("'edit_details'")) target.status = 'edit_details';
            return [];
        }
        if (sql.includes('follow_up_recipients') || sql.includes('follow_up_campaigns')) return [];
        if (sql.startsWith('SELECT id, order_id FROM store_shoppers')) {
            // legacy fallback lookup
            const phone = params[0];
            const status = params.length > 1 ? params[1] : null;
            const rows = shoppers
                .filter(s => s.phone === phone && (!status || s.status === status))
                .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            return rows.slice(0, 1);
        }
        return [];
    },
    async update(table, data, where) {
        updates.push({ sql: `dbAdapter.update(${table})`, params: [data, where] });
        if (table === 'store_shoppers' && where.id) {
            const t = shoppers.find(s => s.id === where.id);
            if (t && data.status) t.status = data.status;
        }
        return { changes: 1 };
    }
};

// ── Stub all top-level dependencies of messageHandler ─────────────────────
function stub(rel, exportsObj) {
    const abs = path.resolve(root, rel);
    const m = new Module(abs);
    m.filename = abs;
    m.loaded = true;
    m.exports = exportsObj;
    require.cache[abs] = m;
}

stub('src/services/whatsappService.js', {
    sendMessage: async (to, text) => { sentMessages.push({ to, text }); return { ok: true }; },
    sendImage: async () => ({ ok: true }),
    sendButtonMessage: async () => ({ ok: true }),
    sendListMessage: async () => ({ ok: true })
});
stub('src/services/followUpService.js', {});
stub('src/services/languageService.js', { translate: (key) => key });
stub('src/models/Customer.js', { getOrCreate: async () => ({ phone: PHONE, preferred_language: 'en' }) });
stub('src/database/db.js', { dbAdapter });
stub('src/utils/validators.js', { sanitizeInput: (s) => (s || '').trim() });
stub('src/utils/portalAssignment.js', { getPortalIdForNewTicket: async () => null });
stub('src/services/ai/autoSupportAgent.js', { processCustomerMessage: async () => ({ reply: null }) });

const messageHandler = require('../src/handlers/messageHandler');

// ── Test helpers ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, label) {
    if (cond) { console.log(`   ✅ ${label}`); passed++; }
    else { console.log(`   ❌ ${label}`); failed++; }
}

(async () => {
    console.log('\n━━━ Test 1: Confirm click targets the order whose confirmation was sent last ━━━');
    resetState(true);
    await messageHandler.handleCommand(PHONE, 'shop_confirm', 'Tester', 'en');
    assert(updates.length === 1, `exactly 1 shopper row updated (got ${updates.length})`);
    assert(updates[0].params[3] === 'shop_A', 'updated row is shop_A (order 42001, last confirmation sent)');
    assert(shoppers.find(s => s.id === 'shop_A').status === 'confirmed', 'order A is now confirmed');
    assert(shoppers.find(s => s.id === 'shop_B').status === 'pending', 'order B stays pending');
    assert(sentMessages.some(m => m.text.includes('42001')), 'reply echoes confirmed order ID 42001');

    console.log('\n━━━ Test 2: Second click (from B\'s message) confirms only B ━━━');
    // Simulate: after A is confirmed, customer taps button on B's message.
    // A is no longer pending, so B is the only pending target.
    updates.length = 0; sentMessages.length = 0;
    await messageHandler.handleCommand(PHONE, 'shop_confirm', 'Tester', 'en');
    assert(updates.length === 1, `exactly 1 shopper row updated (got ${updates.length})`);
    assert(updates[0].params[3] === 'shop_B', 'updated row is shop_B (order 42002)');
    assert(shoppers.find(s => s.id === 'shop_B').status === 'confirmed', 'order B now confirmed');

    console.log('\n━━━ Test 3: No pending orders → no update, warning message sent ━━━');
    updates.length = 0; sentMessages.length = 0;
    await messageHandler.handleCommand(PHONE, 'shop_confirm', 'Tester', 'en');
    assert(updates.length === 0, `no updates issued (got ${updates.length})`);
    assert(sentMessages.some(m => m.text.includes('No Pending Orders')), 'customer told no pending orders');

    console.log('\n━━━ Test 4: Cancel click targets the same single order ━━━');
    resetState(true);
    await messageHandler.handleCommand(PHONE, 'shop_cancel', 'Tester', 'en');
    assert(updates.length === 1, `exactly 1 shopper row updated (got ${updates.length})`);
    assert(updates[0].params[3] === 'shop_A', 'cancelled row is shop_A');
    assert(shoppers.find(s => s.id === 'shop_B').status === 'pending', 'order B stays pending');

    console.log('\n━━━ Test 5: Legacy fallback — no shopper_confirmations rows ━━━');
    resetState(false);
    await messageHandler.handleCommand(PHONE, 'shop_confirm', 'Tester', 'en');
    assert(updates.length === 1, `exactly 1 shopper row updated (got ${updates.length})`);
    assert(updates[0].params[3] === 'shop_B', 'falls back to most recent pending order (shop_B)');

    console.log('\n━━━ Test 6: Edit click targets the same single order ━━━');
    resetState(true);
    await messageHandler.handleCommand(PHONE, 'shop_edit', 'Tester', 'en');
    const editUpdates = updates.filter(u => String(u.sql).includes('edit_details') || String(u.sql).includes('dbAdapter.update'));
    assert(editUpdates.length === 1, `exactly 1 shopper row set to edit_details (got ${editUpdates.length})`);
    assert(shoppers.find(s => s.id === 'shop_A').status === 'edit_details', 'order A marked edit_details');
    assert(shoppers.find(s => s.id === 'shop_B').status === 'pending', 'order B stays pending');

    console.log(`\n━━━ RESULT: ${passed} passed, ${failed} failed ━━━`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('Test crashed:', err);
    process.exit(1);
});
