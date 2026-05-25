require('dotenv').config();
const axios = require('axios');

async function createReturnCouponTemplate() {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    
    const templateData = {
        name: "return_approved_discount",
        language: "en_US",
        category: "MARKETING",
        components: [
            {
                type: "BODY",
                text: "Hi {{1}}! Great news! 🎉\n\nYour return for order {{2}} has been approved.\n\n🎁 Your Exclusive Compensation:\nDiscount Code: {{3}}\nValue: {{4}} off\nUsage: {{5}}\n\nApply this code at checkout on any product in our store. Thank you for your patience!\n\nHappy Shopping! 🛍️",
                example: {
                    body_text: [
                        [ "John", "ORD-12345", "RETURN15", "15%", "3 time(s)" ]
                    ]
                }
            }
        ]
    };

    try {
        console.log("Creating return_approved_discount template on Meta...");
        const response = await axios.post(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
            templateData,
            { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        console.log("✅ SUCCESS: Template created!");
        console.log("Template ID:", response.data.id);
        console.log("Status:", response.data.status);
        console.log("\n📝 Template Details:");
        console.log("- Name: return_approved_discount");
        console.log("- Language: en_US");
        console.log("- Category: MARKETING");
        console.log("- Variables: {{1}}=Name, {{2}}=Order, {{3}}=Code, {{4}}=Value, {{5}}=Usage");
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

createReturnCouponTemplate();
