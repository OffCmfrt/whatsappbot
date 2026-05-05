const { dbAdapter } = require('./src/database/db');
async function run() {
    try {
        const rows = await dbAdapter.query('SELECT * FROM automation_config');
        console.log('--- START ---');
        for (const row of rows) {
            console.log(`KEY: ${row.key}`);
            console.log(`TYPE: ${row.type}`);
            console.log(`CONTENT: ${row.content}`);
            console.log('---');
        }
        console.log('--- END ---');
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}
run();
