require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

(async () => {
    const result = await dbAdapter.query(
        "SELECT id, order_id, payment_method FROM store_shoppers WHERE payment_method = 'Prepaid' ORDER BY created_at DESC LIMIT 5"
    );
    console.log('Sample prepaid orders:', JSON.stringify(result, null, 2));
    process.exit(0);
})();
