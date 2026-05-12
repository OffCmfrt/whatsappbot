require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

async function checkSupportEntries() {
    try {
        console.log('Checking database for support-related entries...\n');
        
        // Check automation_config for support/help/menu
        const configs = await dbAdapter.query(
            "SELECT key, type, content FROM automation_config WHERE key IN ('support', 'help', 'menu', 'contact') OR content LIKE '%support%'"
        );
        
        console.log(`Found ${configs.length} entries:\n`);
        
        configs.forEach((config, index) => {
            console.log(`${index + 1}. Key: ${config.key}`);
            console.log(`   Type: ${config.type}`);
            console.log(`   Content:`);
            
            try {
                const content = typeof config.content === 'string' ? JSON.parse(config.content) : config.content;
                console.log(`   ${JSON.stringify(content, null, 2).substring(0, 500)}...`);
            } catch (e) {
                console.log(`   ${config.content.substring(0, 500)}...`);
            }
            console.log('');
        });
        
        console.log('\n✅ Check complete');
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

checkSupportEntries();
