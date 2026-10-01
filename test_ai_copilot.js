/**
 * AI Copilot test suite (no network, no DB) — run: node test_ai_copilot.js
 *
 * Mocks the Groq client, aiStore and dbAdapter via require.cache, then verifies:
 *  1. Tool-call loop executes read-only tools and returns the final answer
 *  2. Confirmation gating — mutating tools are NEVER executed by the loop
 *  3. Confirm/cancel/wrong-actor paths of pending actions
 *  4. run_sql_read rejects every non-SELECT payload
 *  5. suggestReply returns ≤3 drafts and never touches any send function
 */

const path = require('path');

// ---------- require.cache mocking ----------
function mockModule(modulePath, exportsObj) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// Mock dbAdapter (used by tools.js + suggestReply.js)
const dbCalls = [];
const mockDbAdapter = {
    async query(sql, params = []) {
        dbCalls.push({ sql, params });
        if (/FROM\s+messages/i.test(sql)) {
            return [
                { message_type: 'outgoing', message_content: 'Hi! How can we help?', created_at: '2026-07-25T09:00:00Z' },
                { message_type: 'incoming', message_content: 'Where is my order #1234?', created_at: '2026-07-25T09:01:00Z' }
            ];
        }
        if (/FROM\s+customers/i.test(sql)) {
            return [{ phone: '919876543210', name: 'Test Customer', email: 'test@example.com' }];
        }
        if (/FROM\s+orders/i.test(sql)) {
            return [{ order_id: '#1234', status: 'shipped', awb: 'AWB123', courier_name: 'Delhivery', product_name: 'Oversized Tee', total: 999, payment_method: 'COD', expected_delivery: null, created_at: '2026-07-20T10:00:00Z' }];
        }
        if (/FROM\s+returns/i.test(sql)) {
            return [{ return_id: 'RET-001', order_id: '#1234', items: 'Oversized Tee - L', reason: 'Size issue', status: 'completed', refund_amount: 999, refund_status: 'refunded', created_at: '2026-07-22T10:00:00Z' }];
        }
        if (/FROM\s+exchanges/i.test(sql)) {
            return [{ exchange_id: 'EXC-001', order_id: '#1234', old_items: 'Oversized Tee - M', new_items: 'Oversized Tee - XL', reason: 'Size change', status: 'pickup_booked', price_difference: 0, payment_status: 'completed', created_at: '2026-07-23T10:00:00Z' }];
        }
        if (/FROM\s+support_tickets/i.test(sql)) {
            return [{ id: 1, ticket_number: 'TKT-001', message: 'Where is my order', status: 'open', sentiment: 'neutral', ai_confidence: 0.9, ai_scenario: 'where_is_my_order', created_at: '2026-07-25T09:00:00Z' }];
        }
        if (/FROM\s+ai_usage_log/i.test(sql)) return [{ count: 0 }];
        return [];
    },
    async run() { return { changes: 0 }; },
    async insert() { return { id: 1 }; },
    async update() { return { changes: 0 }; },
    async delete() { return { changes: 0 }; }
};
mockModule('./src/database/db', { dbAdapter: mockDbAdapter, initializeDatabase: async () => {} });

// Mock Settings (always returns the default → copilot enabled, default limits)
mockModule('./src/models/Settings', { get: async (key, def) => def, set: async () => {} });

// Mock aiClient with a scripted response queue
let scriptedResponses = [];
let aiCallCount = 0;
let lastPrompt = null; // capture last user prompt for assertion
function scriptAi(responses) { scriptedResponses = responses.slice(); aiCallCount = 0; }
mockModule('./src/services/ai/aiClient', {
    isConfigured: () => true,
    getConfig: () => ({ provider: 'mock', model: 'mock-model', baseUrl: 'http://mock' }),
    estimateTokens: (t) => Math.ceil(String(t || '').length / 4),
    computeCostUsd: () => 0,
    async chatCompletion({ messages }) {
        aiCallCount++;
        lastPrompt = messages?.[1]?.content || null; // capture user content
        if (!scriptedResponses.length) throw new Error('Test script exhausted: unexpected extra AI call');
        const next = scriptedResponses.shift();
        return { message: next, finishReason: next.tool_calls ? 'tool_calls' : 'stop', usage: { prompt_tokens: 100, completion_tokens: 50 }, model: 'mock-model' };
    }
});

// Mock aiStore with an in-memory implementation
const store = { pending: [], history: [], usage: [], nextId: 1 };
mockModule('./src/services/ai/aiStore', {
    async createPendingAction({ actor, toolName, toolArgs, summary }) {
        const row = { id: store.nextId++, actor, tool_name: toolName, tool_args: toolArgs || {}, summary, status: 'pending', result: null, expires_at: new Date(Date.now() + 600000).toISOString() };
        store.pending.push(row);
        return row;
    },
    async getPendingAction(id) { return store.pending.find(r => r.id === Number(id)) || null; },
    async updatePendingAction(id, fields) {
        const row = store.pending.find(r => r.id === Number(id));
        if (row) Object.assign(row, fields);
    },
    async claimPendingAction(id, actor) {
        const row = store.pending.find(r => r.id === Number(id));
        if (!row) return { ok: false, error: 'Action not found' };
        if (row.actor !== actor) return { ok: false, error: 'This action belongs to another user' };
        if (row.status !== 'pending') return { ok: false, error: `Action is already ${row.status}` };
        if (new Date(row.expires_at).getTime() < Date.now()) { row.status = 'expired'; return { ok: false, error: 'Action expired' }; }
        row.status = 'confirmed';
        return { ok: true, action: row };
    },
    async cancelPendingAction(id, actor) {
        const row = store.pending.find(r => r.id === Number(id));
        if (!row) return { ok: false, error: 'Action not found' };
        if (row.actor !== actor) return { ok: false, error: 'This action belongs to another user' };
        if (row.status !== 'pending') return { ok: false, error: `Action is already ${row.status}` };
        row.status = 'cancelled';
        return { ok: true };
    },
    async getChatHistory() { return store.history.slice(-20); },
    async appendChatHistory(actor, role, content) { store.history.push({ actor, role, content }); },
    async pruneChatHistory() {},
    async clearChatHistory(actor) { store.history = store.history.filter(h => h.actor !== actor); },
    async logUsage(entry) { store.usage.push(entry); },
    async getTodayUsageCount() { return 0; },
    async getUsageStats() { return { daily: [], totals: {} }; }
});

// ---------- tiny test harness ----------
let passed = 0, failed = 0;
function assert(condition, label) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.error(`  ❌ ${label}`); }
}
function toolCall(id, name, args) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

(async () => {
    const { runAgent, executeConfirmedAction } = require('./src/services/ai/agent');
    const { getTool, validateReadOnlySql } = require('./src/services/ai/tools');
    const { suggestReply } = require('./src/services/ai/suggestReply');

    // ---- 1. Tool-call loop with a read-only tool ----
    console.log('\n1. Tool-call loop (read-only tool)');
    scriptAi([
        { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'search_customers', { query: '98765' })] },
        { role: 'assistant', content: 'Found 1 customer: Test Customer.' }
    ]);
    const dbCallsBefore = dbCalls.length;
    const r1 = await runAgent({ actor: 'tester', userMessage: 'find customer 98765' });
    assert(r1.reply === 'Found 1 customer: Test Customer.', 'returns final model answer');
    assert(r1.pendingAction === null || r1.pendingAction === undefined || !r1.pendingAction, 'no pending action for read-only tool');
    assert(dbCalls.length > dbCallsBefore, 'read-only tool actually queried the DB');
    assert(aiCallCount === 2, 'made exactly 2 model calls');

    // ---- 2. Confirmation gating: mutating tool must NOT execute ----
    console.log('\n2. Confirmation gating (send_whatsapp_message)');
    const sendTool = getTool('send_whatsapp_message');
    assert(sendTool && sendTool.requiresConfirmation === true, 'send_whatsapp_message is flagged requiresConfirmation');
    let sendExecuted = false;
    const originalSendExec = sendTool.execute;
    sendTool.execute = async (...a) => { sendExecuted = true; return originalSendExec.apply(sendTool, a); };

    scriptAi([
        { role: 'assistant', content: null, tool_calls: [toolCall('call_2', 'send_whatsapp_message', { phone: '919876543210', message: 'Your order shipped!' })] },
        { role: 'assistant', content: 'I prepared the WhatsApp message — please confirm to send.' }
    ]);
    const r2 = await runAgent({ actor: 'tester', userMessage: 'tell the customer their order shipped' });
    assert(!sendExecuted, 'gated tool was NOT executed by the agent loop');
    assert(r2.pendingAction && r2.pendingAction.id, 'pending action returned to the dashboard');
    const savedPending = store.pending.find(p => p.id === r2.pendingAction.id);
    assert(savedPending && savedPending.status === 'pending', 'pending action saved with status=pending');
    assert(savedPending && savedPending.tool_name === 'send_whatsapp_message', 'pending action stores the tool name');

    // every mutating tool must carry the flag
    for (const name of ['update_ticket', 'book_shipment', 'schedule_pickup', 'send_whatsapp_message', 'create_broadcast_draft']) {
        assert(getTool(name).requiresConfirmation === true, `${name} requires confirmation`);
    }

    // ---- 3. Confirm / cancel / wrong-actor paths ----
    console.log('\n3. Pending action confirm/cancel');
    const wrongActor = await executeConfirmedAction(r2.pendingAction.id, 'someone-else');
    assert(wrongActor.ok === false, 'other admins cannot confirm your action');
    assert(!sendExecuted, 'tool still not executed after failed claim');

    sendTool.execute = async () => { sendExecuted = true; return { sent: true, mocked: true }; };
    const confirmed = await executeConfirmedAction(r2.pendingAction.id, 'tester');
    assert(confirmed.ok === true, 'owner can confirm and execute');
    assert(sendExecuted, 'tool executed exactly once after explicit confirm');
    assert(savedPending.status === 'executed', 'action marked executed');
    const again = await executeConfirmedAction(r2.pendingAction.id, 'tester');
    assert(again.ok === false, 'action cannot be executed twice');
    sendTool.execute = originalSendExec;

    // ---- 4. run_sql_read only accepts SELECT ----
    console.log('\n4. SQL guard');
    const badQueries = [
        'DELETE FROM orders',
        'UPDATE customers SET name = null',
        "INSERT INTO messages VALUES ('x')",
        'DROP TABLE orders',
        'SELECT 1; DROP TABLE orders',
        'WITH x AS (SELECT 1) UPDATE orders SET total = 0',
        'TRUNCATE messages',
        ''
    ];
    for (const q of badQueries) {
        assert(validateReadOnlySql(q) !== null, `rejects: ${q || '(empty)'}`);
    }
    assert(validateReadOnlySql('SELECT * FROM orders') === null, 'accepts plain SELECT');
    assert(validateReadOnlySql('WITH t AS (SELECT 1 AS n) SELECT * FROM t') === null, 'accepts WITH … SELECT');
    let sqlToolThrew = false;
    try { await getTool('run_sql_read').execute({ sql: 'DELETE FROM orders' }, { actor: 'tester' }); }
    catch (e) { sqlToolThrew = true; }
    assert(sqlToolThrew, 'run_sql_read tool throws on non-SELECT');

    // ---- 5. suggestReply: drafts only, nothing sent ----
    console.log('\n5. Reply suggestions');
    scriptAi([
        { role: 'assistant', content: JSON.stringify({ suggestions: ['Draft one 😊', 'Draft two', 'Draft three', 'Draft four (extra)'] }) }
    ]);
    const usageBefore = store.usage.length;
    const s = await suggestReply({ actor: 'tester', phone: '+91 98765 43210' });
    assert(Array.isArray(s.suggestions) && s.suggestions.length === 3, 'returns at most 3 drafts');
    assert(s.suggestions[0] === 'Draft one 😊', 'drafts come from the model response');
    assert(store.usage.some((u, i) => i >= usageBefore && u.kind === 'suggest_reply'), 'usage logged as suggest_reply');
    const loadedSendModules = Object.keys(require.cache).filter(k => /whatsappService|broadcast/i.test(k));
    assert(loadedSendModules.length === 0, 'no send/broadcast module was ever loaded');

    // ---- 6. suggestReply includes returns+exchanges in prompt ----
    console.log('\n6. Reply suggestions with exchange context');
    scriptAi([
        { role: 'assistant', content: JSON.stringify({ suggestions: ['Draft about exchange M→XL'] }) }
    ]);
    const s2 = await suggestReply({ actor: 'tester', phone: '+91 98765 43210' });
    assert(Array.isArray(s2.suggestions) && s2.suggestions.length >= 1, 'returns drafts with exchange context');
    const prompt = lastPrompt;
    assert(prompt && typeof prompt === 'string', 'prompt was captured');
    const parsed = JSON.parse(prompt);
    assert(parsed.rnx && Array.isArray(parsed.rnx), 'rnx array present in prompt');
    const exchange = parsed.rnx.find(r => r.t === 'E');
    assert(exchange !== undefined, 'exchange record found in rnx with t=E');
    assert(exchange.old && exchange.old.includes('M'), 'exchange old size = M');
    assert(exchange.new && exchange.new.includes('XL'), 'exchange new size = XL');
    assert(exchange.st === 'pickup_booked', 'exchange status = pickup_booked');
    const ret = parsed.rnx.find(r => r.t === 'R');
    assert(ret !== undefined, 'return record found in rnx with t=R');
    assert(parsed.ord && parsed.ord.length > 0, 'orders also present (ord)');
    assert(parsed.tkt && parsed.tkt.length > 0, 'tickets also present (tkt)');
    assert(parsed.sent === 'neutral', 'sentiment forwarded as sent');
    assert(parsed.sc === 'where_is_my_order', 'scenario forwarded as sc');

    // ---- summary ----
    console.log(`\n${'='.repeat(40)}\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => {
    console.error('\n💥 Test run crashed:', e);
    process.exit(1);
});
