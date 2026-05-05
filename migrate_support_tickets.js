const { dbAdapter } = require('./src/database/db');

async function migrateSupportTickets() {
    console.log('🚀 Starting support tickets migration...');

    try {
        // Add ticket_number column if it doesn't exist
        try {
            await dbAdapter.run(`ALTER TABLE support_tickets ADD COLUMN ticket_number TEXT`);
            console.log('✅ Added ticket_number column');
        } catch (e) {
            if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
                console.log('ℹ️ ticket_number column already exists');
            } else {
                throw e;
            }
        }

        // Add is_read column if it doesn't exist
        try {
            await dbAdapter.run(`ALTER TABLE support_tickets ADD COLUMN is_read BOOLEAN DEFAULT 0`);
            console.log('✅ Added is_read column');
        } catch (e) {
            if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
                console.log('ℹ️ is_read column already exists');
            } else {
                throw e;
            }
        }

        // Set existing tickets as read (backward compatibility)
        await dbAdapter.run(`UPDATE support_tickets SET is_read = 1 WHERE is_read IS NULL`);
        console.log('✅ Set existing tickets as read');

        // Generate ticket numbers for tickets without them
        const ticketsWithoutNumbers = await dbAdapter.query(
            `SELECT id, created_at FROM support_tickets WHERE ticket_number IS NULL ORDER BY created_at ASC`
        );

        console.log(`📝 Found ${ticketsWithoutNumbers.length} tickets without ticket numbers`);

        for (let i = 0; i < ticketsWithoutNumbers.length; i++) {
            const ticket = ticketsWithoutNumbers[i];
            const ticketNumber = generateTicketNumber(ticket.created_at, i + 1);
            
            await dbAdapter.run(
                `UPDATE support_tickets SET ticket_number = ? WHERE id = ?`,
                [ticketNumber, ticket.id]
            );
            
            if ((i + 1) % 100 === 0 || i === ticketsWithoutNumbers.length - 1) {
                console.log(`✅ Generated ticket numbers for ${i + 1}/${ticketsWithoutNumbers.length} tickets`);
            }
        }

        // Create indexes if they don't exist
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)',
            'CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read ON support_tickets(is_read)',
            'CREATE INDEX IF NOT EXISTS idx_support_tickets_is_read_created ON support_tickets(is_read, created_at DESC)',
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_ticket_number ON support_tickets(ticket_number)'
        ];

        for (const indexSQL of indexes) {
            try {
                await dbAdapter.run(indexSQL);
            } catch (e) {
                console.log(`ℹ️ Index already exists or created: ${indexSQL.split('idx_')[1]?.split(' ')[0]}`);
            }
        }

        console.log('✅ Migration completed successfully!');
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

function generateTicketNumber(date, sequence) {
    const d = date ? new Date(date) : new Date();
    const year = d.getFullYear();
    const seq = sequence.toString().padStart(4, '0');
    return `TKT-${year}-${seq}`;
}

// Run migration
migrateSupportTickets().then(() => {
    console.log('✨ Migration script finished');
    process.exit(0);
});
