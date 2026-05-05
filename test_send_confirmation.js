require('dotenv').config();
const whatsappService = require('./src/services/whatsappService');

async function sendTest() {
    const testPhone = '9413378016';
    console.log(`🚀 Sending test confirmation template to ${testPhone}...`);
    
    try {
        const result = await whatsappService.sendShopperConfirmation(
            testPhone, 
            'Naman', 
            '18428', 
            '1999', 
            'Premium Tee - Black (M) x 1'
        );
        
        console.log('Final Result:', result);
        
        if (result) {
            console.log('✅ Template sent successfully!');
        } else {
            console.log('❌ Failed to send template.');
        }
    } catch (error) {
        console.error('❌ Error Message:', error.message);
        if (error.response?.data) {
            console.error('❌ Meta Error Detail:', JSON.stringify(error.response.data, null, 2));
        }
    }
    
    process.exit(0);
}

sendTest();
