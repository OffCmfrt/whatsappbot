const assert = require('assert');
const { generateEscalationSummary, createWidgetTicket, redactPII } = require('../src/services/ai/customerAgent');

async function runTests() {
    console.log('🧪 Starting Unit Tests for Change 14: Context-Rich Ticket Escalation\n');

    // Test 1: PII Redaction
    console.log('Test 1: PII Redaction Guardrail');
    const rawText = 'My card is 4111-2222-3333-4444 and password: mysecretpassword123';
    const cleaned = redactPII(rawText);
    assert.strictEqual(cleaned.includes('4111-2222-3333-4444'), false, 'Card number should be redacted');
    assert.strictEqual(cleaned.includes('mysecretpassword123'), false, 'Password should be redacted');
    console.log('  ✅ PII successfully redacted');

    // Test 2: AI Summary Generation for COD scenario
    console.log('\nTest 2: AI Summary Generation for COD Double Payment');
    const summaryCOD = await generateEscalationSummary(
        [{ sender: 'user', text: 'Courier asked for cash delivery' }],
        'I paid online for Order 53686 but delivery courier asked for cash',
        { detectedScenario: 'COD_DOUBLE_PAYMENT_REFUND', orderId: '53686' }
    );
    assert.ok(summaryCOD.includes('53686'), 'Summary should reference order ID');
    assert.ok(summaryCOD.toLowerCase().includes('cod') || summaryCOD.toLowerCase().includes('cash'), 'Summary should capture COD issue');
    console.log(`  ✅ Summary Generated: "${summaryCOD}"`);

    // Test 3: Widget Ticket Creation & WhatsApp Deep Link Structuring
    console.log('\nTest 3: Widget Ticket Creation & WhatsApp Deep Link');
    const ticketRes = await createWidgetTicket({
        name: 'Jane Doe',
        phone: '9876543210',
        email: 'jane@example.com',
        message: 'Order 53686 shows delivered but I did not receive it.',
        orderId: '53686',
        source: 'widget',
        sessionId: 'sess_12345',
        context: {
            detectedScenario: 'POD_INVESTIGATION',
            orderId: '53686'
        },
        chatHistory: [
            { sender: 'user', text: 'Where is my package?' },
            { sender: 'bot', text: 'It shows delivered.' },
            { sender: 'user', text: 'Order 53686 shows delivered but I did not receive it.' }
        ]
    });

    assert.strictEqual(ticketRes.success, true, 'Ticket creation should succeed');
    assert.ok(ticketRes.ticketNumber.startsWith('WDG-'), 'Ticket number should start with WDG-');
    assert.ok(ticketRes.whatsappLink.includes('https://wa.me/'), 'WhatsApp link should be wa.me format');
    assert.ok(ticketRes.whatsappLink.includes(encodeURIComponent(ticketRes.ticketNumber)), 'WhatsApp link should contain encoded ticket number');
    assert.ok(ticketRes.whatsappLink.includes('%2353686'), 'WhatsApp link should contain encoded order number #53686');

    console.log(`  ✅ Ticket Created: ${ticketRes.ticketNumber}`);
    console.log(`  ✅ WhatsApp Link: ${ticketRes.whatsappLink}`);

    console.log('\n🎉 ALL CHANGE 14 UNIT TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
