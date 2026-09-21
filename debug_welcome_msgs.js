/**
 * Debug: Check what welcome messages exist in widget_chats
 */
require('dotenv').config();
const { dbAdapter } = require('./src/database/db');

(async () => {
    try {
        const rows = await dbAdapter.query(`
            SELECT session_id, id, sender, LEFT(content, 80) as content_preview, created_at
            FROM widget_chats
            WHERE sender = 'bot' AND content LIKE '%Welcome%'
            ORDER BY session_id, created_at
            LIMIT 50
        `);

        console.log(`Found ${rows.length} welcome-like bot messages:\n`);
        rows.forEach(r => {
            console.log(`  [${r.session_id}] id=${r.id} | ${r.content_preview} | ${r.created_at}`);
        });

        // Also check for exact duplicates per session
        const dupes = await dbAdapter.query(`
            SELECT session_id, COUNT(*) as cnt
            FROM widget_chats
            WHERE sender = 'bot' AND content LIKE '%Welcome%'
            GROUP BY session_id
            HAVING COUNT(*) > 1
        `);

        console.log(`\nSessions with multiple welcome messages: ${dupes.length}`);
        dupes.forEach(d => console.log(`  ${d.session_id}: ${d.cnt} messages`));

        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
})();
