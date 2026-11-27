'use strict';
// Desk AI reply suggestions (support-desk engine). Verifies the scenario
// anchor derived from the ticket's structured reason/sub, the guardrail error
// codes, the non-JSON model fallback, and that the cache is reused while the
// thread is unchanged but busted by a new message.
//
// Runs fully offline: every dependency the service calls through a module
// object (aiClient, aiStore, Settings, learning, Support) is stubbed here, so
// no DB query and no AI request is ever made.
// Run: node --test test/testSuggestReplyDesk.js

const test = require('node:test');
const assert = require('node:assert/strict');

const aiClient = require('../src/services/ai/aiClient');
const aiStore = require('../src/services/ai/aiStore');
const Settings = require('../src/models/Settings');
const learning = require('../src/services/ai/learning');
const Support = require('../src/services/supportService');
const { suggestReplyDesk, scenarioOf } = require('../src/services/ai/suggestReplyDesk');

/* ───────────────────────── stubs ───────────────────────── */

let chatPayload = { suggestions: ['Draft one.', 'Draft two.'] };
let chatRaw = null;      // when set, chatCompletion returns raw non-JSON text
let usageCount = 0;

function genericChat() {
    return {
        message: { content: chatRaw != null ? chatRaw : JSON.stringify(chatPayload) },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'test-model'
    };
}

aiClient.isConfigured = () => true;
aiClient.chatCompletion = async () => genericChat();
aiStore.getTodayUsageCount = async () => usageCount;
aiStore.logUsage = async () => {};
Settings.get = async (key) => (key === 'ai_suggest_reply_daily_limit' ? '500' : 'true');
learning.findSimilarExamples = async () => [];

const at = (n) => 1700000000000 + n;
const event = (text) => ({ kind: 'event', text, at: at(0) });
const cust = (text, n) => ({ role: 'customer', text, at: at(n) });

function ticketRow(overrides = {}) {
    return {
        id: 500,
        ticket_number: 'TKT-72995',
        order_id: '72995',
        channel: 'website',
        status: 'open',
        customer_phone: '91888949801',
        customer_name: 'Digvijay',
        customer_email: 'dig@example.com',
        message: 'I want the size L but it is not in stock',
        reason: 'return',
        sub: 'exchange_req',
        reason_label: 'Return or exchange',
        sub_label: 'Exchange for another size or product',
        thread: [event('Request raised'), cust('I want to change the size', 2), cust('I want the size L but it is not in stock so what can I do', 3)],
        ...overrides
    };
}

// Default: the desk reads the ticket's own order + hub context gracefully as
// empty, which is exactly the offline path (customerContextService unreachable).
Support.contextFor = async () => null;
Support.getOrderByNumber = async () => null;
let currentTicket = ticketRow();
Support.getTicket = async () => currentTicket;

/* ───────────────────────── scenario anchor ───────────────────────── */

test('scenarioOf maps the structured reason/sub to an SOP class', () => {
    assert.equal(scenarioOf('return', 'exchange_req'), 'Size change');
    assert.equal(scenarioOf('delivery', 'address_change'), 'Address change');
    assert.equal(scenarioOf('delivery', 'delayed'), 'Delayed/Not received');
    assert.equal(scenarioOf('credit', 'refund_original'), 'Refund');
    assert.equal(scenarioOf('order', 'cancel'), 'Cancellation');
    assert.equal(scenarioOf('product', 'damaged'), 'Damaged/Wrong item');
    // reason-level fallback when the sub is 'other'
    assert.equal(scenarioOf('product', 'other'), 'Damaged/Wrong item');
    assert.equal(scenarioOf('other', 'other'), null);
    assert.equal(scenarioOf(null, null), null);
});

/* ───────────────────────── happy path ───────────────────────── */

test('generates drafts from the ticket thread', async () => {
    currentTicket = ticketRow();
    const res = await suggestReplyDesk({ actor: 'desk:agent', ticketId: 500 });
    assert.deepEqual(res.suggestions, ['Draft one.', 'Draft two.']);
});

/* ───────────────────────── guardrail codes ───────────────────────── */

test('empty thread + empty message throws NO_HISTORY', async () => {
    currentTicket = ticketRow({ thread: [], message: '' });
    await assert.rejects(
        () => suggestReplyDesk({ actor: 'desk:agent', ticketId: 601 }),
        (e) => e.code === 'NO_HISTORY'
    );
});

test('missing ticket throws NO_TICKET', async () => {
    currentTicket = null;
    await assert.rejects(
        () => suggestReplyDesk({ actor: 'desk:agent', ticketId: 602 }),
        (e) => e.code === 'NO_TICKET'
    );
    currentTicket = ticketRow();
});

test('AI_NOT_CONFIGURED when the provider key is missing', async () => {
    aiClient.isConfigured = () => false;
    await assert.rejects(
        () => suggestReplyDesk({ actor: 'desk:agent', ticketId: 604 }),
        (e) => e.code === 'AI_NOT_CONFIGURED'
    );
    aiClient.isConfigured = () => true;
});

test('AI_DISABLED when the copilot setting is off', async () => {
    Settings.get = async (key) => (key === 'ai_admin_copilot_enabled' ? 'false' : '500');
    await assert.rejects(
        () => suggestReplyDesk({ actor: 'desk:agent', ticketId: 603 }),
        (e) => e.code === 'AI_DISABLED'
    );
    Settings.get = async (key) => (key === 'ai_suggest_reply_daily_limit' ? '500' : 'true');
});

test('AI_LIMIT when the daily budget is exhausted', async () => {
    usageCount = 500;
    await assert.rejects(
        () => suggestReplyDesk({ actor: 'desk:limited', ticketId: 605 }),
        (e) => e.code === 'AI_LIMIT'
    );
    usageCount = 0;
});

/* ───────────────────────── fallback + cache ───────────────────────── */

test('non-JSON model output falls back to a single draft', async () => {
    chatRaw = 'Sure — your exchange from M to L is being arranged.';
    const res = await suggestReplyDesk({ actor: 'desk:agent', ticketId: 606 });
    chatRaw = null;
    assert.equal(res.suggestions.length, 1);
    assert.match(res.suggestions[0], /exchange/);
});

test('cache reused while the thread is unchanged, busted by a new message', async () => {
    let calls = 0;
    aiClient.chatCompletion = async () => {
        calls++;
        return { message: { content: JSON.stringify({ suggestions: ['x'] }) }, usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'm' };
    };

    const id = 700;
    currentTicket = ticketRow({ id, thread: [cust('hello', 1)] });
    await suggestReplyDesk({ actor: 'desk:agent', ticketId: id });
    await suggestReplyDesk({ actor: 'desk:agent', ticketId: id });
    assert.equal(calls, 1, 'second identical request served from cache');

    // A new customer message changes the thread version → fresh generation.
    currentTicket = ticketRow({ id, thread: [cust('hello', 1), cust('and?', 2)] });
    await suggestReplyDesk({ actor: 'desk:agent', ticketId: id });
    assert.equal(calls, 2, 'thread change forces regeneration');

    aiClient.chatCompletion = async () => genericChat();
});
