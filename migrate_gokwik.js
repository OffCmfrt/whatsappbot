const { dbAdapter } = require('./src/database/db');

async function migrateGokwik() {
    console.log('🚀 Starting GoKwik fields migration...');

    try {
        // Add gokwik_order_id column if it doesn't exist
        try {
            await dbAdapter.run(`ALTER TABLE store_shoppers ADD COLUMN gokwik_order_id TEXT`);
            console.log('✅ Added gokwik_order_id column');
        } catch (e) {
            if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
                console.log('ℹ️ gokwik_order_id column already exists');
            } else {
                throw e;
            }
        }

        // Add rto_risk column if it doesn't exist
        try {
            await dbAdapter.run(`ALTER TABLE store_shoppers ADD COLUMN rto_risk VARCHAR(20)`);
            console.log('✅ Added rto_risk column');
        } catch (e) {
            if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
                console.log('ℹ️ rto_risk column already exists');
            } else {
                throw e;
            }
        }

        // Index for cross-referencing GoKwik order IDs
        try {
            await dbAdapter.run('CREATE INDEX IF NOT EXISTS idx_store_shoppers_gokwik_order_id ON store_shoppers(gokwik_order_id)');
            console.log('✅ Index idx_store_shoppers_gokwik_order_id ensured');
        } catch (e) {
            console.log('ℹ️ Index already exists or created');
        }

        console.log('✅ Migration completed successfully!');
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
migrateGokwik().then(() => {
    console.log('✨ Migration script finished');
    process.exit(0);
});
