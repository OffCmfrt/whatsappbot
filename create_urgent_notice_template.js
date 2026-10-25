/**
 * Create Urgent Notice Template for Meta WhatsApp
 * 
 * This script submits a template with a variable placeholder for custom messages.
 * Template format: "Dear {{1}}, [Your message here]"
 * 
 * Run this ONCE to create the template in Meta.
 * After approval, you can use it from the Shoppers Hub chat interface.
 */

const axios = require('axios');
require('dotenv').config();

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

if (!ACCESS_TOKEN || !WABA_ID) {
    console.error('❌ Missing environment variables:');
    console.error('  - WHATSAPP_ACCESS_TOKEN');
    console.error('  - WHATSAPP_BUSINESS_ACCOUNT_ID');
    process.exit(1);
}

async function createUrgentNoticeTemplate() {
    try {
        console.log('📝 Creating urgent_notice template...');
        console.log(`WABA ID: ${WABA_ID}`);

        const templateData = {
            name: 'customer_support_notice',
            language: 'en',
            category: 'UTILITY',
            components: [
                {
                    type: 'BODY',
                    text: 'Dear {{1}},\n\n{{2}}\n\n{{3}}\n\nIf you have any questions, please reply to this message.\n\nThank you,\nOFFCOMFRT Support Team',
                    example: {
                        body_text: [
                            [
                                'Priya',
                                'Important Update About Your Order',
                                'Your order #12345 has been delayed by 1 day due to high demand. We apologize for the inconvenience and appreciate your patience.'
                            ]
                        ]
                    }
                }
            ]
        };

        const response = await axios.post(
            `https://graph.facebook.com/v21.0/${WABA_ID}/message_templates`,
            templateData,
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Template submitted successfully!');
        console.log('Template ID:', response.data.id);
        console.log('\n⏳ Next steps:');
        console.log('1. Wait for Meta to review and approve the template (usually 24-48 hours)');
        console.log('2. Once approved, you can use it from Shoppers Hub chat interface');
        console.log('3. The template will appear in the notice modal');
        console.log('\n📋 Template details:');
        console.log('Name: customer_support_notice');
        console.log('Variables:');
        console.log('  {{1}} = Customer name (auto-filled)');
        console.log('  {{2}} = Notice subject (e.g., "Urgent Notice", "Important Update")');
        console.log('  {{3}} = Your custom message (you type this)');

    } catch (error) {
        console.error('❌ Error creating template:');
        if (error.response?.data) {
            console.error(JSON.stringify(error.response.data, null, 2));
            
            // Handle specific errors
            const errorCode = error.response.data.error?.code;
            if (errorCode === 100) {
                console.error('\n💡 Hint: Template name might already exist or format is invalid');
            } else if (errorCode === 131030) {
                console.error('\n💡 Hint: Check your WABA_ID and access token permissions');
            }
        }
        process.exit(1);
    }
}

createUrgentNoticeTemplate();
