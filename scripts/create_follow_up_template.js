require('dotenv').config();
const axios = require('axios');

/**
 * Create Follow-Up Template for Pending Orders
 * 
 * This template is used to send follow-up messages to customers
 * who haven't responded to their order confirmation.
 * 
 * Template Name: order_follow_up_v1
 * Category: UTILITY
 * Language: en_US
 * 
 * Buttons:
 * 1. Confirm Order - Confirms the order
 * 2. Cancel Order - Cancels the order
 * 3. Edit Details - Requests to edit order details
 */

async function createFollowUpTemplate() {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    
    if (!accessToken || !wabaId) {
        console.error('ERROR: WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID must be set in .env');
        process.exit(1);
    }

    const templateData = {
        name: "order_follow_up_v1",
        language: "en_US",
        category: "UTILITY",
        components: [
            {
                type: "HEADER",
                format: "TEXT",
                text: "ORDER FOLLOW-UP"
            },
            {
                type: "BODY",
                text: "Hi {{1}},\n\nWe noticed you haven't confirmed your *Offcomfrt* order yet.\n\n▫️ *Order ID:* {{2}}\n▫️ *Amount:* Rs.{{3}}\n▫️ *Products:* {{4}}\n\nPlease select an option below to proceed:",
                example: {
                    body_text: [
                        [ "Customer", "ORD-123456", "1999", "Premium Tee - Black (Size: M) x1" ]
                    ]
                }
            },
            {
                type: "FOOTER",
                text: "Offcomfrt - Comfort Redefined"
            },
            {
                type: "BUTTONS",
                buttons: [
                    { 
                        type: "QUICK_REPLY", 
                        text: "Confirm Order"
                    },
                    { 
                        type: "QUICK_REPLY", 
                        text: "Cancel Order"
                    },
                    { 
                        type: "QUICK_REPLY", 
                        text: "Edit Details"
                    }
                ]
            }
        ]
    };

    try {
        console.log("Creating follow-up template on Meta (order_follow_up_v1)...");
        console.log("Template Data:", JSON.stringify(templateData, null, 2));
        
        const response = await axios.post(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
            templateData,
            { 
                headers: { 
                    'Authorization': `Bearer ${accessToken}`, 
                    'Content-Type': 'application/json' 
                } 
            }
        );
        
        console.log("\n✅ SUCCESS! Template created successfully.");
        console.log("Response:", JSON.stringify(response.data, null, 2));
        console.log("\nTemplate ID:", response.data.id);
        console.log("Template Name:", response.data.name);
        console.log("Status:", response.data.status);
        
    } catch (error) {
        console.error("\n❌ ERROR creating template:");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response:", JSON.stringify(error.response.data, null, 2));
            
            // Handle specific error cases
            if (error.response.data?.error?.code === 100) {
                console.error("\n⚠️  Template may already exist or there's a validation error.");
            }
            if (error.response.data?.error?.code === 200) {
                console.error("\n⚠️  Permission error. Check your access token permissions.");
            }
        } else {
            console.error("Error:", error.message);
        }
        process.exit(1);
    }
}

// Run the script
createFollowUpTemplate();
