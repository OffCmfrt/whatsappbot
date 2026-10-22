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
    // ─── Order Shipped template ─────────────────────────────────────────
    // UTILITY category — transactional shipping confirmation
    // Body Parameters:
    //   {{1}} = Customer Name
    //   {{2}} = Order ID
    //   {{3}} = Carrier / Courier Name
    //   {{4}} = AWB / Tracking Number
    // Button:
    //   URL button → {{1}} = AWB (redirects via /track/:awb to carrier URL)
    const TRACK_BASE = 'https://whatsappbot-4l4b.onrender.com/track/';
    const template = {
        name: 'order_shipped_v2',
        language: 'en',
        category: 'UTILITY',
        components: [
            {
                type: 'HEADER',
                format: 'TEXT',
                text: 'Your Order Has Been Shipped'
            },
            {
                type: 'BODY',
                text: `Hi {{1}},\n\nGreat news! Your OFFCOMFRT order *{{2}}* has been shipped via *{{3}}*.\n\n\ud83d\udce6 *Tracking Number (AWB):* {{4}}\n\nYou can track your package in real-time using the button below. Thank you for shopping with us! \ud83d\udc99`,
                example: {
                    body_text: [['Aaryan', '#12345', 'Shiprocket', '4128930283']]
                }
            },
            {
                type: 'FOOTER',
                text: 'Team OFFCOMFRT'
            },
            {
                type: 'BUTTONS',
                buttons: [
                    {
                        type: 'URL',
                        text: 'Track Your Order',
                        url: `${TRACK_BASE}{{1}}`,
                        example: ['4128930283']
                    }
                ]
            }
        ]
    };

    console.log(`📋 Submitting template to WABA: ${wabaId}`);
    console.log(`   Template name: ${template.name}`);
    console.log(`   Category: ${template.category}`);
    console.log(`   Body Parameters:`);
    console.log(`      {{1}} = Customer Name`);
    console.log(`      {{2}} = Order ID`);
    console.log(`      {{3}} = Carrier / Courier Name`);
    console.log(`      {{4}} = AWB / Tracking Number`);
    console.log(`   Button:`);
    console.log(`      URL {{1}} = AWB (redirects to carrier tracking URL)`);
    console.log(`      Base: ${TRACK_BASE}`);

    const result = await submitTemplate(template);

    if (result) {
        console.log('\n✅ Template submitted! It will be reviewed by Meta and activated within a few minutes.');
        console.log('ℹ️  Check your WhatsApp Manager → Message Templates to track approval status.');
        console.log('\nOnce approved, the shipping service will automatically send this template');
        console.log('with a "Track Your Order" button whenever any carrier ships an order.');
    } else {
        console.log('\n❌ Template submission failed. Check the error above.');
    }
}

run();
