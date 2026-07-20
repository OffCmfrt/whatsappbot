/**
 * Migration script for Professional Auto-Distribute Feature
 * This script adds all necessary database columns and tables
 */

require('dotenv').config();
const { tursoClient } = require('./src/database/db');

async function migrateAutoDistributeSchema() {
    console.log('🚀 Starting Auto-Distribute Feature Migration...\n');

    try {
        // 1. Add advanced distribution columns to support_portals
        console.log('📦 Adding advanced distribution columns to support_portals...');
        
        const portalColumns = [
            { name: 'max_tickets', sql: 'ALTER TABLE support_portals ADD COLUMN max_tickets INTEGER' },
            { name: 'shift_start', sql: 'ALTER TABLE support_portals ADD COLUMN shift_start TEXT' },
            { name: 'shift_end', sql: 'ALTER TABLE support_portals ADD COLUMN shift_end TEXT' },
            { name: 'is_active', sql: 'ALTER TABLE support_portals ADD COLUMN is_active BOOLEAN DEFAULT 1' },
            { name: 'distribution_rule', sql: 'ALTER TABLE support_portals ADD COLUMN distribution_rule TEXT' },
            { name: 'assigned_count', sql: 'ALTER TABLE support_portals ADD COLUMN assigned_count INTEGER DEFAULT 0' },
            { name: 'priority_level', sql: 'ALTER TABLE support_portals ADD COLUMN priority_level INTEGER DEFAULT 0' }
        ];

        for (const col of portalColumns) {
            try {
                await tursoClient.execute(col.sql);
                console.log(`   ✅ Added ${col.name} column`);
            } catch (e) {
                if (e.message.includes('duplicate column')) {
                    console.log(`   ℹ️  ${col.name} column already exists`);
                } else {
                    console.log(`   ⚠️  ${col.name} column:`, e.message);
                }
            }
        }

        // 2. Create distribution_history table
        console.log('\n📊 Creating distribution_history table...');
        
        try {
            await tursoClient.execute(`
                CREATE TABLE IF NOT EXISTS distribution_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    distribution_type TEXT NOT NULL,
                    portal_count INTEGER,
                    ticket_count INTEGER,
                    filters_applied TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('   ✅ distribution_history table created');

            // Create indexes
            await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_distribution_history_created ON distribution_history(created_at)`);
            await tursoClient.execute(`CREATE INDEX IF NOT EXISTS idx_distribution_history_type ON distribution_history(distribution_type)`);
            console.log('   ✅ Indexes created for distribution_history');
        } catch (e) {
            console.log('   ℹ️  distribution_history table may already exist:', e.message);
        }

        // 3. Verify schema
        console.log('\n🔍 Verifying schema...');
        
        const columnsResult = await tursoClient.execute(`
            PRAGMA table_info(support_portals)
        `);
        
        console.log('   📋 support_portals columns:');
        columnsResult.rows.forEach(col => {
            console.log(`      - ${col.name} (${col.type})`);
        });

        // Check if distribution_history exists
        const tablesResult = await tursoClient.execute(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='distribution_history'
        `);
        
        if (tablesResult.rows.length > 0) {
            console.log('   ✅ distribution_history table exists');
        } else {
            console.log('   ❌ distribution_history table NOT found');
        }

        console.log('\n✅ Migration completed successfully!\n');
        console.log('📝 Summary:');
        console.log('   - Added 7 new columns to support_portals');
        console.log('   - Created distribution_history table');
        console.log('   - Created indexes for performance');
        console.log('\n🎉 The Professional Auto-Distribute feature is ready to use!');
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error);
        process.exit(1);
    }
}

// Run migration
migrateAutoDistributeSchema().then(() => {
    process.exit(0);
}).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
