require('dotenv').config();
process.env.ZOHO_RATE_BURST = '1000';
process.env.ZOHO_RATE_PER_SEC = '1000';
const z = require('../src/services/zohoService');
(async () => {
    let ok = 0, limited = 0;
    const start = Date.now();
    for (let i = 0; i < 20; i++) {
        try { await z.searchInvoice({ page: 1, per_page: 1 }); ok++; }
        catch (e) { if (/429|too many/i.test(e.message)) { limited++; console.log(`call ${i + 1}: 429`); } else console.log(`call ${i + 1} ERR:`, e.message); }
        console.log(`call ${i + 1}/${20} done (ok=${ok} limited=${limited}) t=${Math.round((Date.now() - start) / 1000)}s`);
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`RESULT 60/min pace → ok=${ok} rateLimited=${limited}`);
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
