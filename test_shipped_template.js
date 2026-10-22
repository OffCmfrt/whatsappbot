require('dotenv').config();
const whatsappService = require('./src/services/whatsappService');

// Test the order_shipped_v2 template with REAL shipment data
const PHONE = '9413378016';
const NAME = 'Aaryan';
const ORDER_ID = '#63737';
const CARRIER = 'Ekart';
const AWB = 'LUAP0001702784';
const TRACKING_URL = 'https://app.elite.ekartlogistics.in/track/LUAP0001702784';

async function run() {
    console.log('🧪 Testing order_shipped_v2 template...\n');
    console.log(`   To: ${PHONE}`);
    console.log(`   Name: ${NAME}`);
    console.log(`   Order: ${ORDER_ID}`);
    console.log(`   Carrier: ${CARRIER}`);
    console.log(`   AWB: ${AWB}`);
    console.log(`   Tracking URL: ${TRACKING_URL}\n`);

    await whatsappService.sendOrderShippedTemplate(
        PHONE,
        NAME,
        ORDER_ID,
        CARRIER,
        AWB,
        TRACKING_URL,
        { isReship: false, reason: null }
    );

    console.log('\n✅ Test complete!');
    process.exit(0);
}

run().catch(err => {
    console.error('❌ Test failed:', err.message);
    process.exit(1);
});
