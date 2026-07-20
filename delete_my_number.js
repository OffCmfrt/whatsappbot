const { dbAdapter } = require('./src/database/db');

async function testReset() {
    try {
        console.log('🔄 Connecting to Database...');
        // Replace with your actual phone number you are testing from (e.g. 919413378016)
        const myTestingNumber = '919413378016'; 

        // Try to delete using query
        await dbAdapter.query('DELETE FROM customers');
        console.log(`✅ Completely wiped the customers table so you can test as a new user!`);
        console.log(`You are now officially a 'Brand New User' again.`);
        console.log(`Open WhatsApp and send "Hey" right now. The language menu WILL show up first!`);
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
    }
}

testReset();
