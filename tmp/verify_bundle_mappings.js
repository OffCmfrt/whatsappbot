/**
 * Verify all 15 bundle mappings are correct:
 * A) Each component base name exists in Zoho (any size)
 * B) Each bundle key matches a real Shopify product title
 */
require('dotenv').config();
const axios = require('axios');
const zoho = require('../src/services/zohoService');
const { dbAdapter } = require('../src/database/db');

(async () => {
    const rows = await dbAdapter.query(
        'SELECT bundle_sku, component_sku, component_qty FROM zoho_bundle_map ORDER BY bundle_sku, id', []);
    const bundles = {};
    for (const r of rows) (bundles[r.bundle_sku] = bundles[r.bundle_sku] || []).push(r.component_sku);

    // ── A. Zoho catalog check: component base names ──
    console.log('═══ A. ZOHO CATALOG — component base names ═══');
    let zohoOk = true;
    const checked = new Map();
    for (const comp of [...new Set(Object.values(bundles).flat())]) {
        if (checked.has(comp)) continue;
        // style prefix = strip colourway paren, search variants
        const style = comp.replace(/\(.*$/, '').trim();
        const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();
        const cands = await zoho.searchItem({ name_contains: style, per_page: 200 });
        const matches = cands.filter(c => norm(c.name).startsWith(norm(comp)));
        checked.set(comp, matches);
        if (matches.length > 0) {
            const sizes = matches.map(m => m.name.split(' - ').pop()).join(', ');
            console.log(`  ✅ "${comp}" → ${matches.length} sizes (${sizes})`);
        } else {
            console.log(`  ❌ "${comp}" → NOT FOUND (searched "${style}", ${cands.length} candidates)`);
            zohoOk = false;
        }
    }

    // ── B. Shopify title check: bundle keys ──
    console.log('\n═══ B. SHOPIFY — bundle product titles ═══');
    const shop = process.env.SHOPIFY_STORE, token = process.env.SHOPIFY_ACCESS_TOKEN;
    const res = await axios.get(`https://${shop}/admin/api/2024-01/products.json?limit=250&status=active`, {
        headers: { 'X-Shopify-Access-Token': token }, timeout: 20000
    });
    const titles = new Set((res.data.products || []).map(p => p.title));
    const normT = s => String(s || '').toUpperCase().replace(/\s*([()])\s*/g, '$1').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
    const normTitles = new Set([...titles].map(normT));
    let shopOk = true;
    for (const key of Object.keys(bundles)) {
        const exact = titles.has(key);
        const fuzzy = normTitles.has(normT(key));
        if (exact) console.log(`  ✅ "${key}" — exact match`);
        else if (fuzzy) console.log(`  ⚠️ "${key}" — matches after normalisation (transform handles it)`);
        else { console.log(`  ❌ "${key}" — no active Shopify product with this title`); shopOk = false; }
    }

    console.log(`\n${zohoOk && shopOk ? '✅ ALL MAPPINGS VERIFIED' : '⚠️ ISSUES FOUND — see above'}`);
    process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
