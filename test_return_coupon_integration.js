require('dotenv').config();
const axios = require('axios');

async function testReturnCouponIntegration() {
    console.log('🧪 Testing WhatsApp Return Coupon Integration\n');

    // Configuration - UPDATE THESE WITH YOUR ACTUAL VALUES
    const WHATSAPP_BOT_URL = 'https://whatsappbot-4l4b.onrender.com';
    const INTERNAL_TOKEN = 'JAZZdope';
    
    // Test phone number (your number to receive the test message)
    const TEST_PHONE = '919413378016'; // UPDATE WITH YOUR PHONE NUMBER

    console.log('📋 Configuration:');
    console.log(`- WhatsApp Bot URL: ${WHATSAPP_BOT_URL}`);
    console.log(`- Internal Token: ${INTERNAL_TOKEN}`);
    console.log(`- Test Phone: ${TEST_PHONE}`);
    console.log('');

    // Test payload
    const testPayload = {
        phone: TEST_PHONE,
        message: `Hi Test User! 👋\n\nGreat news! Your return for order *ORD-TEST-123* has been approved. ✅\n\n🎁 *Your Exclusive Compensation:*\n━━━━━━━━━━━━━━━━━\n💰 Discount Code: *TEST15*\n💎 Value: 15%\n📝 Usage: 3 time(s)\n━━━━━━━━━━━━━━━━━\n\nApply this code at checkout on any product!`,
        type: 'return_approved_with_discount',
        requestId: 'test-' + Date.now(),
        templateData: {
            templateName: 'return_approved_discount',
            customerName: 'Test User',
            orderNumber: 'ORD-TEST-123',
            discountCode: 'TEST15',
            value: '15',
            valueType: 'percentage',
            usage: '3 time(s)'
        }
    };

    try {
        console.log('📤 Sending test request to WhatsApp bot...');
        console.log('Endpoint:', `${WHATSAPP_BOT_URL}/api/internal/send-notification`);
        console.log('');

        const response = await axios.post(
            `${WHATSAPP_BOT_URL}/api/internal/send-notification`,
            testPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-internal-token': INTERNAL_TOKEN
                },
                timeout: 30000
            }
        );

        console.log('✅ RESPONSE RECEIVED:');
        console.log('Status:', response.status);
        console.log('Data:', JSON.stringify(response.data, null, 2));
        console.log('');

        if (response.data.success) {
            console.log('✅ SUCCESS! WhatsApp message sent!');
            console.log('📱 Check your phone for the message');
            if (response.data.fallback) {
                console.log('⚠️  Note: Sent as plain text (template may not be approved yet)');
            } else {
                console.log('🎉 Template was used successfully!');
            }
        } else {
            console.log('❌ Request failed:', response.data.error);
        }

    } catch (error) {
        console.log('❌ ERROR:');
        if (error.response) {
            console.log('Status:', error.response.status);
            console.log('Data:', JSON.stringify(error.response.data, null, 2));
            
            if (error.response.status === 401) {
                console.log('\n💡 Fix: WHATSAPP_INTERNAL_TOKEN mismatch between services');
            } else if (error.response.status === 404) {
                console.log('\n💡 Fix: Check WHATSAPP_BOT URL is correct');
            }
        } else if (error.code === 'ECONNREFUSED') {
            console.log('Connection refused - WhatsApp bot may be sleeping on Render');
            console.log('💡 Visit your WhatsApp bot URL to wake it up, then try again');
        } else if (error.code === 'ENOTFOUND') {
            console.log('DNS error - Check WHATSAPP_BOT_URL is correct');
        } else {
            console.log(error.message);
        }
    }
}

testReturnCouponIntegration();
