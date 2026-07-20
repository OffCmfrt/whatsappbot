const { createClient } = require('@libsql/client');

async function wipeCustomers() {
    try {
        console.log('🔄 Connecting directly to Turso...');
        const client = createClient({
            url: 'libsql://whatsappbot-offcomfrt.aws-ap-south-1.turso.io',
            authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MDQ0NjIsImlkIjoiYjc2OWM1MzEtOTE2NS00ZjI5LTlhMDQtMDZjMmYwZGUxNDg1IiwicmlkIjoiOTE2YWZmMTUtY2ViNy00MmZjLTgzYjktNTU5OTZkM2I1YzM3In0.EHkL9Cow4BqQpRoLDzh1Ux8mNU3Uc9FmYlHhRcDNlN72UFJvPtEcXyUGchTCH9psYiynGcZ4Ejs7rGle09mUDQ'
        });

        console.log('🧹 Wiping all relational tables first...');
        await client.execute('DELETE FROM messages');
        await client.execute('DELETE FROM conversations');
        await client.execute('DELETE FROM returns');
        await client.execute('DELETE FROM exchanges');
        await client.execute('DELETE FROM orders');

        const res = await client.execute('DELETE FROM customers');
        console.log(`✅ SUCCESS! Erased ALL previously saved customers from the Production Database (${res.rowsAffected} deleted).`);
        console.log(`You are now officially a 'Brand New User' again.`);
        console.log(`Open WhatsApp and send "Hey" right now. The language menu WILL show up first!`);
        process.exit(0);
    } catch (err) {
        console.error('Error connecting to Turso:', err);
    }
}

wipeCustomers();
