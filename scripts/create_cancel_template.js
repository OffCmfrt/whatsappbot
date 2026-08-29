require('dotenv').config();
const axios = require('axios');

// Registers the order-cancellation utility template used by the Shoppers Hub
// manual-cancel flow (adminRoutes → notifyCustomerOfCancellation).
// Body variables: {{1}} name, {{2}} order ID, {{3}} reason, {{4}} refund note.

async function createTemplate() {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

    const templateData = {
        name: "order_cancelled_v1",
        language: "en_US",
        category: "UTILITY",
        components: [
            {
                type: "HEADER",
                format: "TEXT",
                text: "OFFCOMFRT ORDER CANCELLED"
            },
            {
                type: "BODY",
                text: "Hello {{1}},\n\nYour *Offcomfrt* order *{{2}}* has been cancelled.\n\n▫️ *Reason:* {{3}}\n▫️ {{4}}\n\nFor any queries, simply reply to this message.",
                example: {
                    body_text: [
                        [ "Customer", "ORD-123456", "Customer requested cancellation", "This was a Cash on Delivery order, so no refund is applicable." ]
                    ]
                }
            }
        ]
    };

    try {
        console.log("Creating template on Meta (order_cancelled_v1)...");
        const response = await axios.post(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
            templateData,
            { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        console.log("SUCCESS:", JSON.stringify(response.data, null, 2));
        console.log("ℹ️ The template must be APPROVED by Meta before it can be sent.");
        console.log("ℹ️ Until then, the hub falls back to a plain WhatsApp session message.");
    } catch (error) {
        console.error("ERROR:");
        if (error.response) {
            console.error(JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(error.message);
        }
    }
}

createTemplate();
