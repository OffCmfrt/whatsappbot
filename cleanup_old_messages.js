/**
 * Cleanup Script: Enforce 200 Message Limit Per Customer
 * 
 * This script will scan all customers and delete older messages
 * for any customer who has more than 200 messages in the database.
 * 
 * Run: node cleanup_old_messages.js
 */

require('dotenv').config();
const { dbAdapter, testConnection } = require('./src/database/db');

async function cleanupAllCustomers() {
    console.log('🔄 Starting message cleanup for all customers...\n');

    try {
        // Test database connection
        const connected = await testConnection();
        if (!connected) {
            console.error('❌ Database connection failed');
            process.exit(1);
        }

        // Get all customers with message counts
        console.log('📊 Scanning customers with messages...');
        const customerCounts = await dbAdapter.query(`
            SELECT customer_phone, COUNT(*) as message_count
            FROM messages
            GROUP BY customer_phone
            HAVING message_count > 200
            ORDER BY message_count DESC
        `);

        if (!customerCounts || customerCounts.length === 0) {
            console.log('✅ All customers are within the 200 message limit. No cleanup needed.');
            return;
        }

        console.log(`\n📋 Found ${customerCounts.length} customers with more than 200 messages:\n`);
        
        let totalDeleted = 0;
        
        for (const customer of customerCounts) {
            const phone = customer.customer_phone;
            const currentCount = customer.message_count;
            const toDelete = currentCount - 200;
            
            console.log(`🧹 ${phone}: ${currentCount} messages → deleting ${toDelete} oldest messages`);
            
            // Delete old messages, keep only latest 200
            const cleanPhone = phone.replace(/\D/g, '');
            const result = await dbAdapter.query(`
                DELETE FROM messages 
                WHERE customer_phone = ? 
                AND id NOT IN (
                    SELECT id FROM messages 
                    WHERE customer_phone = ? 
                    ORDER BY created_at DESC 
                    LIMIT 200
                )
            `, [cleanPhone, cleanPhone]);

            const deleted = result.rowsAffected || 0;
            totalDeleted += deleted;
            
            console.log(`   ✅ Deleted ${deleted} messages`);
        }

        console.log('\n' + '='.repeat(60));
        console.log(`🎉 Cleanup Complete!`);
        console.log(`📊 Total messages deleted: ${totalDeleted}`);
        console.log(`👥 Customers cleaned: ${customerCounts.length}`);
        console.log('='.repeat(60));

        // Verify final state
        const remainingOverLimit = await dbAdapter.query(`
            SELECT customer_phone, COUNT(*) as message_count
            FROM messages
            GROUP BY customer_phone
            HAVING message_count > 200
        `);

        if (remainingOverLimit && remainingOverLimit.length > 0) {
            console.warn(`\n⚠️ Warning: ${remainingOverLimit.length} customers still have over 200 messages`);
        } else {
            console.log('\n✅ Verified: All customers now have 200 or fewer messages');
        }

    } catch (error) {
        console.error('❌ Error during cleanup:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the cleanup
cleanupAllCustomers();
