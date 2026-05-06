require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

async function testMessages() {
    try {
        console.log('Testing messages query...');
        
        // Test 1: Count messages
        const countResult = await dbAdapter.query('SELECT COUNT(*) as count FROM messages');
        console.log('Total messages in database:', countResult);
        
        // Test 2: Get some messages
        const messages = await dbAdapter.query('SELECT * FROM messages ORDER BY created_at DESC LIMIT 10');
        console.log('Sample messages:', messages);
        
        // Test 3: Check table structure
        const tableInfo = await dbAdapter.query('PRAGMA table_info(messages)');
        console.log('Messages table structure:', tableInfo);
        
    } catch (error) {
        console.error('Error testing messages:', error);
    }
    
    process.exit(0);
}

testMessages();
