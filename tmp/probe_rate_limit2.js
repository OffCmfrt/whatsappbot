require('dotenv').config();
process.env.ZOHO_RATE_BURST = '1000';
process.env.ZOHO_RATE_PER_SEC = '1000';
const z = require('../src/services/zohoService');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
    console.log(`resting 15 min (starting ${new Date().toISOString()})`);
    await sleep(15 * 60 * 1000);
    console.log('rest done — probing 1 call / 2s');
    let ok = 0, limited = 0;
    for (let i = 0; i < 12; i++) {
        const t0 = Date.now();
        try { await z.searchInvoice({ page: 1, per_page: 1 }); ok++; console.log(`call ${i + 1}: OK (${Date.now() - t0}ms)`); }
        catch (e) { limited++; console.log(`call ${i + 1}: FAIL ${e.message.slice(0, 80)}`); }
        await sleep(2000);
    }
    console.log(`RESULT 30/min pace → ok=${ok} failed=${limited}`);
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
