/**
 * Clean up duplicate welcome messages in widget_chats table.
 * Keeps only the earliest welcome message per session_id.
 */
require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

(async () => {
    try {
        // Find sessions with duplicate welcome messages (match by LIKE since content has newlines)
        const duplicates = await dbAdapter.query(`
            SELECT session_id, COUNT(*) as count, MIN(id) as keep_id
            FROM widget_chats
            WHERE content LIKE 'Welcome to OFFCOMFRT.%How can we assist you today?'
              AND sender = 'bot'
            GROUP BY session_id
            HAVING COUNT(*) > 1
            ORDER BY count DESC
        `);

        if (!duplicates || !duplicates.length) {
            console.log('✓ No duplicate welcome messages found');
            process.exit(0);
        }

        console.log(`Found ${duplicates.length} session(s) with duplicate welcome messages:\n`);

        let totalRemoved = 0;

        for (const row of duplicates) {
            const { session_id, count, keep_id } = row;
            const toRemove = count - 1;
            totalRemoved += toRemove;

            console.log(`  Session ${session_id}: ${count} duplicates → keeping id=${keep_id}, removing ${toRemove}`);

            // Delete all welcome messages for this session except the earliest one
            await dbAdapter.run(`
                DELETE FROM widget_chats
                WHERE session_id = $1
                  AND content LIKE 'Welcome to OFFCOMFRT.%How can we assist you today?'
                  AND sender = 'bot'
                  AND id != $2
            `, [session_id, keep_id]);
        }

        console.log(`\n✓ Removed ${totalRemoved} duplicate welcome message(s)`);

        // Update message_count in widget_chat_sessions to reflect the cleanup
        await dbAdapter.run(`
            UPDATE widget_chat_sessions wcs
            SET message_count = sub.new_count
            FROM (
                SELECT session_id, COUNT(*) as new_count
                FROM widget_chats
                GROUP BY session_id
            ) sub
            WHERE wcs.session_id = sub.session_id
              AND wcs.message_count != sub.new_count
        `);

        console.log('✓ Updated message_count in widget_chat_sessions');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
})();
