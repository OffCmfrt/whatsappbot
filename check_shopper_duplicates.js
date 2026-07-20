/**
 * Check for Duplicate Orders in Shoppers Hub
 * 
 * This is a read-only diagnostic script to check for duplicates.
 * Run: node check_shopper_duplicates.js
 */

require('dotenv').config();
const { dbAdapter, testConnection } = require('./src/database/db');

async function checkDuplicates() {
    console.log('🔍 Checking for duplicate orders in Shoppers Hub...\n');

    try {
        // Test database connection
        const connected = await testConnection();
        if (!connected) {
            console.error('❌ Database connection failed');
            process.exit(1);
        }

        console.log('✅ Connected to database\n');

        // Check 1: Count duplicates
        console.log('📊 Check 1: Counting duplicate order_ids...');
        const duplicateCount = await dbAdapter.query(`
            SELECT 
                COUNT(*) as total_duplicate_groups,
                SUM(dup_count - 1) as total_duplicate_rows
            FROM (
                SELECT order_id, COUNT(*) as dup_count
                FROM store_shoppers
                GROUP BY order_id
                HAVING COUNT(*) > 1
            )
        `);

        const dupGroups = duplicateCount[0]?.total_duplicate_groups || 0;
        const dupRows = duplicateCount[0]?.total_duplicate_rows || 0;

        if (dupGroups === 0) {
            console.log('✅ No duplicates found! Database is clean.\n');
        } else {
            console.log(`⚠️  Found ${dupGroups} order_id(s) with duplicates`);
            console.log(`⚠️  Total duplicate rows: ${dupRows}\n`);
        }

        // Check 2: Show sample duplicates
        if (dupGroups > 0) {
            console.log('📋 Sample duplicates (first 10):');
            const samples = await dbAdapter.query(`
                SELECT order_id, COUNT(*) as count, GROUP_CONCAT(id) as ids
                FROM store_shoppers
                GROUP BY order_id
                HAVING COUNT(*) > 1
                LIMIT 10
            `);

            samples.forEach(s => {
                console.log(`   Order ${s.order_id}: ${s.count} entries (IDs: ${s.ids})`);
            });
            console.log('');
        }

        // Check 3: Overall statistics
        console.log('📈 Check 2: Overall statistics...');
        const stats = await dbAdapter.query(`
            SELECT 
                COUNT(*) as total_entries,
                COUNT(DISTINCT order_id) as unique_orders,
                COUNT(*) - COUNT(DISTINCT order_id) as duplicate_count
            FROM store_shoppers
        `);

        console.log(`   Total entries: ${stats[0]?.total_entries || 0}`);
        console.log(`   Unique orders: ${stats[0]?.unique_orders || 0}`);
        console.log(`   Duplicate entries: ${stats[0]?.duplicate_count || 0}\n`);

        // Check 4: Verify unique index exists
        console.log('🔐 Check 3: Verifying unique index...');
        const indexes = await dbAdapter.query(`
            SELECT name, sql 
            FROM sqlite_master 
            WHERE type='index' AND tbl_name='store_shoppers' 
            AND name LIKE '%unique%'
        `);

        if (indexes && indexes.length > 0) {
            console.log('✅ Unique index exists:');
            indexes.forEach(idx => {
                console.log(`   ${idx.name}`);
            });
        } else {
            console.log('⚠️  No unique index found on order_id');
            console.log('💡 Run: node apply_shopper_unique_index.js\n');
        }

        console.log('\n✅ Diagnostic complete!\n');

        // Exit with appropriate code
        if (dupRows > 0) {
            console.log('💡 To fix duplicates, run: node cleanup_duplicate_shoppers.js\n');
            process.exit(1);
        } else {
            process.exit(0);
        }

    } catch (error) {
        console.error('❌ Error during check:', error);
        process.exit(1);
    }
}

checkDuplicates();
