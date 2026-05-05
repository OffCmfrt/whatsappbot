require('dotenv').config();
const { initializeDatabase } = require('./src/database/db');
const abandonedCartService = require('./src/services/abandonedCartService');
const AbandonedCart = require('./src/models/AbandonedCart');

async function runTest() {
    try {
        console.log('🔄 Initializing database for test...');
        await initializeDatabase();

        const fakeToken = 'test_token_' + Date.now();
        console.log('📦 Simulating incoming Shopify checkout payload...');
        const payload = {
            id: fakeToken,
            token: fakeToken,
            phone: '919413378016', // The user's phone number
            email: 'test@example.com',
            shipping_address: {
                first_name: 'AЯYAͶ',
                phone: '919413378016'
            },
            line_items: [
                {
                    title: 'Testing T-Shirt (Premium Black)',
                    quantity: 1,
                    price: '1499.00',
                    image_url: 'https://cdn.shopify.com/s/files/1/0861/1414/0467/files/black-tshirt-test.jpg'
                }
            ],
            total_price: '1499.00',
            currency: 'INR',
            abandoned_checkout_url: 'https://www.offcomfrt.in/cart/test-recovery'
        };

        // 1. Process payload (inserts into DB as 'pending')
        console.log('💾 Saving abandoned cart to database...');
        await abandonedCartService.processAbandonedCheckout(payload);

        // 2. Retrieve newly created cart
        const cart = await AbandonedCart.findByCheckoutId(fakeToken);
        if (!cart) {
            console.error('❌ Failed to find the newly created cart in DB!');
            process.exit(1);
        }

        // 3. Immediately send the first reminder (bypass the 1 hour cron wait)
        console.log('🚀 Triggering instant 1-hour WhatsApp reminder...');
        await abandonedCartService.sendReminder(cart, 'first_reminder');

        console.log('✅ Test complete! Check WhatsApp.');
        process.exit(0);

    } catch (err) {
        console.error('Error during test:', err);
        process.exit(1);
    }
}

runTest();
