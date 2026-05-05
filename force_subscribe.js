require('dotenv').config();

async function forceSubscribe() {
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    console.log(`📡 Forcing Webhook Subscription for WABA: ${wabaId}`);

    try {
        const response = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/subscribed_apps`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const data = await response.json();
        
        console.log('\n--- META API RESPONSE ---');
        console.log(JSON.stringify(data, null, 2));
        
        if (data.success) {
            console.log('\n✅ COMPLETELY SUCCESSFUL! Meta has now forcefully linked your physical number to the webhook.');
        } else {
            console.log('\n❌ FAILED to subscribe. Please check the error above.');
        }

    } catch (err) {
        console.error('Error:', err);
    }
}

forceSubscribe();
