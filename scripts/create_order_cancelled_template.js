require('dotenv').config();
const axios = require('axios');

// Meta WhatsApp template: order cancellation notice with reason.
// Sent when an order is cancelled MANUALLY from Shoppers Hub (never for
// customer-initiated "AUTO" cancellations). Category UTILITY = order management.
async function createOrderCancelledTemplate() {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

    if (!accessToken || !wabaId) {
        console.error('❌ Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID in .env');
        process.exit(1);
    }

    const templateData = {
        name: "order_cancelled_v1",
        language: "en_US",
        category: "UTILITY",
        components: [
            {
                type: "BODY",
                text: "Hi {{1}},\n\nYour OFFCOMFRT order *{{2}}* has been cancelled.\n\nReason: {{3}}\n\n{{4}}\n\nWe hope to serve you again soon. 💙\nTeam OFFCOMFRT",
                example: {
                    body_text: [
                        [
                            "Rahul",
                            "#42390",
                            "Size not available, please pick another style",
                            "Your prepaid amount of ₹1,499 will be refunded to the original payment method within 5-7 business days."
                        ]
                    ]
                }
            }
        ]
    };

    try {
        console.log("Creating order_cancelled_v1 template on Meta...");
        const response = await axios.post(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
            templateData,
            { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        console.log("✅ SUCCESS: Template submitted for approval!");
        console.log("Template ID:", response.data.id);
        console.log("Status:", response.data.status || "PENDING");
        console.log("\n📝 Template Details:");
        console.log("- Name: order_cancelled_v1");
        console.log("- Language: en_US");
        console.log("- Category: UTILITY");
        console.log("- Variables: {{1}}=Name, {{2}}=Order ID, {{3}}=Reason, {{4}}=Refund note");
    } catch (error) {
        console.error("❌ ERROR:");
        if (error.response) {
            console.error(JSON.stringify(error.response.data, null, 2));
            console.error("\n💡 If the error is about duplicate template, it already exists!");
        } else {
            console.error(error.message);
        }
    }
}

createOrderCancelledTemplate();
