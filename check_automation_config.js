require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

async function checkAutomationConfig() {
    try {
        console.log('Checking automation_config table for support-related messages...\n');
        
        // Check all automation configs
        const configs = await dbAdapter.query('SELECT * FROM automation_config');
        
        console.log(`Found ${configs.length} automation configs:\n`);
        
        configs.forEach((config, index) => {
            console.log(`${index + 1}. Key: ${config.key}`);
            console.log(`   Type: ${config.type}`);
            
            try {
                const content = typeof config.content === 'string' ? JSON.parse(config.content) : config.content;
                console.log(`   Content preview: ${JSON.stringify(content).substring(0, 200)}...`);
                
                // Check if it contains email
                if (JSON.stringify(content).includes('support@offcomfrt')) {
                    console.log(`   ⚠️  CONTAINS EMAIL!`);
                }
            } catch (e) {
                console.log(`   Content: ${config.content.substring(0, 200)}...`);
                if (config.content.includes('support@offcomfrt')) {
                    console.log(`   ⚠️  CONTAINS EMAIL!`);
                }
            }
            console.log('');
        });
        
    } catch (error) {
        console.error('Error:', error.message);
    }
    
    process.exit(0);
}

checkAutomationConfig();
