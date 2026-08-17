require('dotenv').config();
const axios = require('axios');

const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

if (!accessToken || !wabaId) {
    console.error('❌ Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID in .env');
    process.exit(1);
}

async function submitTemplate(template) {
    console.log(`\n🚀 Submitting template: "${template.name}" ...`);
    try {
        const res = await axios.post(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
            template,
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        console.log(`✅ "${template.name}" submitted! ID: ${res.data.id}  Status: ${res.data.status}`);
        return res.data;
    } catch (err) {
        const errData = err.response?.data?.error;
        console.error(`❌ Failed to submit "${template.name}":`, JSON.stringify(errData || err.message, null, 2));
        return null;
    }
}

async function run() {
    // ─── Out for Delivery template ─────────────────────────────────────────
    // UTILITY category — transactional shipping status update
    // Parameters: {{1}} = Order Number, {{2}} = AWB Number
    const template = {
        name: 'out_for_delivery_v1',
        language: 'en',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: `🚚 *OUT FOR DELIVERY – MANDATORY STEPS*

Hi! Your order is *Out for Delivery* and is expected to be delivered today.

📦 *Order Number:* {{1}}
🚚 *AWB:* {{2}}

*Before opening the package, please record a continuous unboxing video showing:*

• The sealed package from all sides before opening.
• The AWB/shipping label clearly visible.
• The complete unboxing process without any cuts or pauses.
• All the product(s) received inside the package.

⚠️ *Important:* This unboxing video is *mandatory* and will be required in case of any future disputes, such as:
• Wrong product received
• Missing item(s)
• Damaged or defective product
• Transit-related issues

*Without a valid unboxing video, we may be unable to process such claims.*

Thank you for your cooperation! 💙`,
                example: {
                    body_text: [['#12345', '4128930283']]
                }
            }
        ]
    };

    console.log(`📋 Submitting template to WABA: ${wabaId}`);
    console.log(`   Template name: ${template.name}`);
    console.log(`   Category: ${template.category}`);
    console.log(`   Parameters: {{1}} = Order Number, {{2}} = AWB`);

    const result = await submitTemplate(template);

    if (result) {
        console.log('\n✅ Template submitted! It will be reviewed by Meta and activated within a few minutes.');
        console.log('ℹ️  Check your WhatsApp Manager → Message Templates to track approval status.');
        console.log('\nOnce approved, the shipment sync will automatically send this template when');
        console.log('any carrier reports "Out for Delivery" status for an order.');
    } else {
        console.log('\n❌ Template submission failed. Check the error above.');
    }
}

run();
