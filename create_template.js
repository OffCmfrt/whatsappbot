require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const https = require('https');

const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

if (!accessToken || !wabaId || !phoneNumberId) {
    console.error('❌ Missing WHATSAPP_ACCESS_TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID or WHATSAPP_PHONE_NUMBER_ID in .env');
    process.exit(1);
}

// Step 1: Upload an image to WhatsApp media to get a handle for the template example
async function uploadImageAndGetHandle() {
    console.log('📤 Uploading sample image to WhatsApp media...');

    // Download the image buffer first
    const imageUrl = 'https://images.pexels.com/photos/1566412/pexels-photo-1566412.jpeg?auto=compress&cs=tinysrgb&w=800';
    const imageBuffer = await new Promise((resolve, reject) => {
        https.get(imageUrl, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
    });

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'image/jpeg');
    form.append('file', imageBuffer, { filename: 'sample.jpg', contentType: 'image/jpeg' });

    const uploadRes = await axios.post(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/media`,
        form,
        { headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` } }
    );

    const mediaId = uploadRes.data.id;
    console.log(`✅ Image uploaded. Media ID: ${mediaId}`);
    return mediaId;
}

// Step 2: Build and submit both templates
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
    let mediaHandle;
    try {
        mediaHandle = await uploadImageAndGetHandle();
    } catch (err) {
        console.error('❌ Failed to upload sample image:', err.response?.data || err.message);
        process.exit(1);
    }

    // ─── Template definitions ────────────────────────────────────────────────
    // Matches EXACTLY what abandonedCartService.js sends:
    //   Header  → IMAGE (dynamic product photo)
    //   Body    → {{1}} = firstName, {{2}} = productTitle
    //   Button  → Dynamic URL suffix appended to https://www.offcomfrt.in/

    const templates = [
        {
            name: "abandoned_cart_v1",
            language: "en",
            category: "MARKETING",
            components: [
                {
                    type: "HEADER",
                    format: "TEXT",
                    text: "You left something behind!",
                },
                {
                    type: "BODY",
                    text: "Hi {{1}} \ud83d\udc4b\n\nWe noticed you left some comfort behind! \ud83d\uded2\n\n*{{2}}* is waiting for you safe and sound.\n\nComplete your order seamlessly using the link below \ud83d\udc47",
                    example: { body_text: [["Aaryan", "WAFFLE - 001 ( B )"]] }
                },
                {
                    type: "BUTTONS",
                    buttons: [
                        {
                            type: "URL",
                            text: "Checkout Now",
                            url: "https://www.offcomfrt.in/{{1}}",
                            example: ["checkout/test-url"]
                        }
                    ]
                }
            ]
        },
        {
            name: "abandoned_cart_v2",
            language: "en",
            category: "MARKETING",
            components: [
                {
                    type: "HEADER",
                    format: "TEXT",
                    text: "Your cart is expiring soon!",
                },
                {
                    type: "BODY",
                    text: "Hey {{1}}, this is your last reminder! \u23f0\n\n*{{2}}* is still in your cart, but stock is limited.\n\nDon\u2019t let someone else grab your comfort \u2014 complete your order now before it\u2019s too late! \ud83d\ude0a",
                    example: { body_text: [["Aaryan", "WAFFLE - 001 ( B )"]] }
                },
                {
                    type: "BUTTONS",
                    buttons: [
                        {
                            type: "URL",
                            text: "Complete My Order",
                            url: "https://www.offcomfrt.in/{{1}}",
                            example: ["checkout/test-url"]
                        }
                    ]
                }
            ]
        }
    ];

    console.log(`\n📋 Submitting ${templates.length} templates to WABA: ${wabaId}`);
    for (const t of templates) {
        await submitTemplate(t);
        // Small delay between submissions
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('\n✅ All done! Templates will be reviewed by Meta and activated within a few minutes.');
    console.log('ℹ️  Check your WhatsApp Manager → Message Templates to track status.');
}

run();
