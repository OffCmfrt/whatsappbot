/**
 * Clean Up Duplicate Store Shoppers
 * 
 * This script removes duplicate entries in store_shoppers table,
 * keeping only the oldest entry (lowest id) for each order_id.
 * 
 * Run: node cleanup_duplicate_shoppers.js
 */

require('dotenv').config();
const { dbAdapter, testConnection } = require('./src/database/db');

async function cleanupDuplicates() {
    console.log('🧹 Cleaning up duplicate store_shoppers entries...\n');

    try {
        // Test database connection
        const connected = await testConnection();
        if (!connected) {
            console.error('❌ Database connection failed');
            process.exit(1);
        }

        console.log('✅ Connected to database\n');

        // Step 1: Count total duplicates
        console.log('🔍 Scanning for duplicates...');
        
        const duplicateCount = await dbAdapter.query(`
            SELECT COUNT(*) as total_duplicates
            FROM store_shoppers
            WHERE id NOT IN (
                SELECT MIN(id) FROM store_shoppers GROUP BY order_id
            )
        `);

        const totalDuplicates = duplicateCount[0]?.total_duplicates || 0;
        
        if (totalDuplicates === 0) {
            console.log('✅ No duplicates found. Database is clean!\n');
            process.exit(0);
        }

        console.log(`⚠️  Found ${totalDuplicates} duplicate entries to delete\n`);

        // Step 2: Show sample of duplicates
        console.log('📊 Sample duplicates (first 10):');
        const samples = await dbAdapter.query(`
            SELECT s1.order_id, s1.id as duplicate_id, s1.created_at
            FROM store_shoppers s1
            WHERE s1.id NOT IN (
                SELECT MIN(id) FROM store_shoppers GROUP BY order_id
            )
            LIMIT 10
        `);

        samples.forEach(s => {
            console.log(`   Order ${s.order_id}: ID ${s.id} (created: ${s.created_at})`);
        });

        console.log(`\n   ...and ${totalDuplicates - 10} more\n`);

        // Step 3: Delete duplicates
        console.log('🗑️  Deleting duplicates...');
        
        const deleteResult = await dbAdapter.run(`
            DELETE FROM store_shoppers
            WHERE id NOT IN (
                SELECT MIN(id) FROM store_shoppers GROUP BY order_id
            )
        `);

        console.log(`✅ Deleted ${deleteResult.changes} duplicate entries\n`);

        // Step 4: Verify cleanup
        console.log('🔍 Verifying cleanup...');
        
        const remainingDuplicates = await dbAdapter.query(`
            SELECT order_id, COUNT(*) as count
            FROM store_shoppers
            GROUP BY order_id
            HAVING COUNT(*) > 1
            LIMIT 5
        `);

        if (remainingDuplicates && remainingDuplicates.length > 0) {
            console.log(`⚠️  Warning: ${remainingDuplicates.length} order_id(s) still have duplicates`);
            remainingDuplicates.forEach(d => {
                console.log(`   Order ${d.order_id}: ${d.count} entries`);
            });
        } else {
            console.log('✅ All duplicates removed successfully!\n');
        }

        // Step 5: Show final stats
        const finalStats = await dbAdapter.query(`
            SELECT 
                COUNT(*) as total_entries,
                COUNT(DISTINCT order_id) as unique_orders
            FROM store_shoppers
        `);

        console.log('📊 Final statistics:');
        console.log(`   Total entries: ${finalStats[0]?.total_entries || 0}`);
        console.log(`   Unique orders: ${finalStats[0]?.unique_orders || 0}`);
        console.log(`   Duplicates removed: ${totalDuplicates}\n`);

        console.log('✅ Cleanup complete!');
        console.log('💡 Tip: This script should be run periodically to prevent duplicate buildup\n');

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
        process.exit(1);
    }
}

cleanupDuplicates();
