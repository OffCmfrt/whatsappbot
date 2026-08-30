// Test: order_cancelled_v1 template approval + live send to the test number.
// Usage: node tmp/test_cancel_template.js
require('dotenv').config();
const axios = require('axios');

const TEST_PHONE = '9413378016';
const TEMPLATE_NAME = 'order_cancelled_v1';

async function checkTemplateApproval() {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (!accessToken || !wabaId) throw new Error('Missing WHATSAPP_ACCESS_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID');

    let url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?limit=100`;
    let found = null;
    while (url && !found) {
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const page = res.data?.data || [];
        found = page.find(t => t.name === TEMPLATE_NAME) || null;
        const next = res.data?.paging?.next;
        url = next || null;
    }
    return found;
}

(async () => {
    // 1) Approval status
    console.log(`🔍 Checking approval status of "${TEMPLATE_NAME}"...`);
    let tpl = null;
    try {
        tpl = await checkTemplateApproval();
    } catch (err) {
        console.error('❌ Template lookup failed:', err.response?.data?.error?.message || err.message);
    }
    if (!tpl) {
        console.log(`⚠️ Template "${TEMPLATE_NAME}" NOT FOUND on the WABA — run scripts/create_order_cancelled_template.js first.`);
    } else {
        console.log(`✅ Found: name=${tpl.name}, language=${tpl.language}, category=${tpl.category}, status=${tpl.status}`);
        if (tpl.rejection_reason) console.log(`   ⛔ rejection_reason: ${tpl.rejection_reason}`);
    }

    // 2) Live send through the exact code path used by the hub cancel route
    const whatsappService = require('../src/services/whatsappService');
    const prepaidNote = 'Your prepaid amount of ₹1,499 will be refunded to the original payment method within 5-7 business days.';
    const codNote = 'This was a Cash on Delivery order, so no refund is applicable.';

    console.log(`\n📤 Sending PREPAID cancellation notice to ${TEST_PHONE}...`);
    const r1 = await whatsappService.sendOrderCancellationNotice(
        TEST_PHONE, 'Sunny', '#99901', 'Customer requested cancellation (test)', prepaidNote
    );
    console.log(r1 ? '✅ Prepaid notice dispatched' : '❌ Prepaid notice FAILED');

    console.log(`\n📤 Sending COD cancellation notice to ${TEST_PHONE}...`);
    const r2 = await whatsappService.sendOrderCancellationNotice(
        TEST_PHONE, 'Sunny', '#99902', 'Out of stock (test)', codNote
    );
    console.log(r2 ? '✅ COD notice dispatched' : '❌ COD notice FAILED');

    const approved = tpl?.status === 'APPROVED';
    console.log(`\n🧾 SUMMARY: template ${tpl ? tpl.status : 'NOT FOUND'} · sends used ${approved ? 'APPROVED TEMPLATE' : 'FALLBACK SESSION MESSAGE'}`);
    process.exit(0);
})().catch(err => {
    console.error('💥 Test crashed:', err.message);
    process.exit(1);
});
