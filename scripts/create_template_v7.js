require('dotenv').config();
const axios = require('axios');

async function createTemplate() {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    
    const templateData = {
        name: "order_confirmation_v7",
        language: "en_US",
        category: "UTILITY",
        components: [
            {
                type: "HEADER",
                format: "TEXT",
                text: "OFFCOMFRT ORDER CONFIRM"
            },
            {
                type: "BODY",
                text: "Hello {{1}},\n\nYour *Offcomfrt* order has been received.\n\n▫️ *Order ID:* {{2}}\n▫️ *Amount:* Rs.{{3}}\n▫️ *Payment Method:* {{4}}\n▫️ *Products:* {{5}}\n\nPlease select an option below:",
                example: {
                    body_text: [
                        [ "Customer", "ORD-123456", "1999", "Cash on Delivery", "Premium Tee - Black (Size: M) x1, Joggers - Grey (Size: L) x2" ]
                    ]
                }
            },
            {
                type: "BUTTONS",
                buttons: [
                    { type: "QUICK_REPLY", text: "Confirm Order" },
                    { type: "QUICK_REPLY", text: "Cancel Order" },
                    { type: "QUICK_REPLY", text: "Edit Details" }
                ]
            }
        ]
    };

    try {
        console.log("Creating template on Meta (order_confirmation_v7)...");
        const response = await axios.post(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
            templateData,
            { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        console.log("SUCCESS:", JSON.stringify(response.data, null, 2));
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
