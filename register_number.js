/**
 * WhatsApp Cloud API - Phone Number Registration Script
 * 
 * Run this script to register your phone number ID with Meta. 
 * This is a required one-time step for the Cloud API.
 * 
 * Usage: node register_number.js [6-DIGIT-PIN]
 */
require('dotenv').config();
const axios = require('axios');

async function registerNumber() {
    const pin = process.argv[2] || '123456'; // Default to 123456 if none provided
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !accessToken) {
        console.error('❌ Error: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN is missing in .env');
        process.exit(1);
    }

    console.log(`🔄 Attempting to register phone number ID: ${phoneNumberId}...`);
    console.log(`🔑 Using PIN: ${pin}`);

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v21.0/${phoneNumberId}/register`,
            {
                messaging_product: 'whatsapp',
                pin: pin
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Registration Successful!');
        console.log('Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ Registration Failed!');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Error Details:', JSON.stringify(error.response.data.error, null, 2));
            
            if (error.response.data.error.code === 100) {
                console.log('\n💡 Tip: If you get a "param pin must be a 6 digit number", the PIN may be incorrect/not set.');
            }
        } else {
            console.error('Error Message:', error.message);
        }
        process.exit(1);
    }
}

registerNumber();
