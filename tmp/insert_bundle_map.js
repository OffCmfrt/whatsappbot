/**
 * Configure bundle mappings for packs where pack size == colorway count
 * ("one of each colorway"). Component names are the Zoho single-item base
 * names; the size suffix ("- M") is appended at transform time.
 * Idempotent: ON CONFLICT DO NOTHING on (bundle_sku, component_sku).
 */
require('dotenv').config();
const { dbAdapter } = require('../src/database/db');

const ROWS = [
    // bundle title (as Shopify sends it)        component (Zoho single base name)   qty  gst
    ['RAGLAN 001 ( TRIPLE )',   'RAGLAN 001 ( B )',              1, 5],
    ['RAGLAN 001 ( TRIPLE )',   'RAGLAN 001 ( G )',              1, 5],
    ['RAGLAN 001 ( TRIPLE )',   'RAGLAN 001 ( W )',              1, 5],
    ['WAFFLE-001 (BUNDLE)',     'WAFFLE - 001 ( ACID WASH )',    1, 5],
    ['WAFFLE-001 (BUNDLE)',     'WAFFLE - 001 ( AW-D )',         1, 5],
    ['POLO- 001 ( COMBO )',     'POLO- 001 ( BLACK )',           1, 5],
    ['POLO- 001 ( COMBO )',     'POLO- 001 ( OFF- WHITE )',      1, 5],
    ['HENLEY - 002 ( COMBO)',   'HENLEY - 002 ( B )',            1, 5],
    ['HENLEY - 002 ( COMBO)',   'HENLEY - 002 ( W )',            1, 5],
    ['SLUB - 001 ( COMBO )',    'SLUB - 001 ( ACID WASH)',       1, 5],
    ['SLUB - 001 ( COMBO )',    'SLUB - 001 ( B )',              1, 5],
    ['SLUB - 001 ( COMBO-2 )',  'SLUB - 001 ( ACID WASH)',       1, 5],
    ['SLUB - 001 ( COMBO-2 )',  'SLUB - 001 ( B )',              1, 5],
    ['SWEATSHIRT-001 ( BUNDLE )', 'SWEATSHIRT-001 ( BLACK )',    1, 5],
    ['SWEATSHIRT-001 ( BUNDLE )', 'SWEATSHIRT-001 ( GREY )',     1, 5]
];

(async () => {
    // schema migration (same as zohoService init, for immediate effect)
    await dbAdapter.run('ALTER TABLE zoho_bundle_map DROP CONSTRAINT IF EXISTS zoho_bundle_map_bundle_sku_key', []);
    await dbAdapter.run('CREATE UNIQUE INDEX IF NOT EXISTS zoho_bundle_map_pair ON zoho_bundle_map(bundle_sku, component_sku)', []);

    for (const [b, c, q, g] of ROWS) {
        await dbAdapter.run(
            `INSERT INTO zoho_bundle_map (bundle_sku, component_sku, component_qty, gst_rate)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (bundle_sku, component_sku) DO NOTHING`,
            [b, c, q, g]
        );
    }
    const all = await dbAdapter.query('SELECT bundle_sku, component_sku, component_qty, gst_rate FROM zoho_bundle_map ORDER BY id');
    console.log(`✅ ${all.length} bundle mapping rows now configured:`);
    for (const r of all) console.log(`  ${r.bundle_sku} → ${r.component_sku} x${r.component_qty} @${r.gst_rate}%`);
    process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
