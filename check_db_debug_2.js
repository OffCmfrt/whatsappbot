const { dbAdapter } = require('./src/database/db');
async function run() {
    try {
        const res = await dbAdapter.query('SELECT * FROM automation_config');
        res.forEach(row => {
            try {
                const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
                const hasButtons = content && content.buttons && content.buttons.length > 0;
                const hasCta = content && (content.cta_text || content.cta_url);
                const hasImage = content && (content.image_url || content.imageUrl);
                
                if (hasButtons || hasCta || hasImage) {
                    console.log(`KEY: ${row.key} | TYPE: ${row.type}`);
                    console.log(`  Buttons: ${hasButtons ? content.buttons.length : 0}`);
                    console.log(`  CTA: ${hasCta ? 'Yes' : 'No'}`);
                    console.log(`  Image: ${hasImage ? 'Yes' : 'No'}`);
                    if (hasCta) console.log(`  CTA URL: ${content.cta_url}`);
                    if (hasButtons) console.log(`  First Btn: ${content.buttons[0].text}`);
                }
            } catch (e) {}
        });
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}
run();
