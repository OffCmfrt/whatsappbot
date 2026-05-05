const { dbAdapter } = require('./src/database/db');
async function run() {
    try {
        const res = await dbAdapter.query('SELECT * FROM automation_config');
        console.log('--- START DATA ---');
        // Filter to only show important fields to avoid truncation
        const refined = res.map(row => ({
            id: row.id,
            key: row.key,
            type: row.type,
            content: row.content
        }));
        console.log(JSON.stringify(refined, null, 2));
        console.log('--- END DATA ---');
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}
run();
