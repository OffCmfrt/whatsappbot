require('dotenv').config();
const zohoService = require('../src/services/zohoService');

(async () => {
    // Find all RAGLAN 001 items in Zoho to see the exact green naming
    let items = await zohoService.searchItem({ name: 'RAGLAN 001' });
    if (!items.length) items = await zohoService.searchItem({ name_contains: 'RAGLAN 001' });
    if (Array.isArray(items)) {
        for (const i of items) console.log(`"${i.name}" sku="${i.sku || ''}"`);
    } else {
        console.log(JSON.stringify(items, null, 2));
    }
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
