require('dotenv').config();
const shopifyService = require('../src/services/shopifyService');
(async () => {
    const res = await shopifyService.syncFulfillment('42390', {
        awb: 'LUAP0001402889', courierName: 'Ekart (EKART)', notifyCustomer: false
    });
    console.log('syncFulfillment result:', JSON.stringify(res, null, 2));
    process.exit(0);
})().catch(e => { console.error('💥', e.message); process.exit(1); });
