require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

async function updateSupportMessages() {
    try {
        console.log('Updating support messages in database...\n');
        
        // Update the 'contact' FAQ
        const contactContent = {
            answer: ` *Contact OffComfrt Support*

*We're here to help!*

🌐 Website: www.offcomfrt.in
💬 WhatsApp: Right here! (24/7)

*Response Time:*
• WhatsApp: Within 24 hours

*Office Hours:*
Mon-Sat: 10 AM - 7 PM IST
Sunday: Closed

*I can help you with:*
• Order tracking
• Returns & exchanges
• Product questions
• Size guidance

How can I help you today?`
        };
        
        await dbAdapter.query(
            'UPDATE automation_config SET content = ? WHERE key = ?',
            [JSON.stringify(contactContent), 'contact']
        );
        console.log('✅ Updated "contact" FAQ - removed email');
        
        // Update the 'cancel' FAQ to remove email
        const cancelConfig = await dbAdapter.query('SELECT content FROM automation_config WHERE key = ?', ['cancel']);
        if (cancelConfig && cancelConfig.length > 0) {
            let cancelContent = typeof cancelConfig[0].content === 'string' 
                ? JSON.parse(cancelConfig[0].content) 
                : cancelConfig[0].content;
            
            // Remove email reference if present
            if (cancelContent.answer && cancelContent.answer.includes('support@offcomfrt')) {
                cancelContent.answer = cancelContent.answer.replace(/write to \*support@offcomfrt\.in\*/g, 'type "support" to contact us');
                cancelContent.answer = cancelContent.answer.replace(/support@offcomfrt\.in/g, '');
                
                await dbAdapter.query(
                    'UPDATE automation_config SET content = ? WHERE key = ?',
                    [JSON.stringify(cancelContent), 'cancel']
                );
                console.log('✅ Updated "cancel" FAQ - removed email');
            }
        }
        
        console.log('\n✅ All support messages updated successfully!');
        
    } catch (error) {
        console.error('Error:', error.message);
        console.error(error);
    }
    
    process.exit(0);
}

updateSupportMessages();
