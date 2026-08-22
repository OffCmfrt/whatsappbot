const express = require('express');
const router = express.Router();
const axios = require('axios');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { dbAdapter } = require('../database/db');

// Services
const zohoService = require('../services/zohoService');
const zohoSyncService = require('../services/zohoSyncService');
const zohoReturnService = require('../services/zohoReturnService');
const zohoCodService = require('../services/zohoCodService');

// All routes require authentication
router.use(verifyToken);

// ============================================================
// DASHBOARD STATS — aggregated overview for all 5 sections
// ============================================================

router.get('/stats', async (req, res) => {
    try {
        const [syncStats, returnStats, codStats] = await Promise.all([
            zohoSyncService.getSyncStats(),
            zohoReturnService.getReturnStats(),
            zohoCodService.getCodStats()
        ]);

        res.json({
            success: true,
            sync: syncStats,
            returns: returnStats,
            cod: codStats
        });
    } catch (err) {
        console.error('❌ Zoho stats error:', err.message);
        res.status(500).json({ error: 'Failed to fetch Zoho stats', detail: err.message });
    }
});

// ============================================================
// SYNC LOG — order sync history with filters
// ============================================================

router.get('/sync', async (req, res) => {
    try {
        const { page = 1, limit = 50, status, search, dateFrom, dateTo } = req.query;
        const result = await zohoSyncService.getSyncLog({
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            search,
            dateFrom,
            dateTo
        });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Zoho sync log error:', err.message);
        res.status(500).json({ error: 'Failed to fetch sync log', detail: err.message });
    }
});

// Retry failed syncs
router.post('/sync/retry', requireAdmin, async (req, res) => {
    try {
        const result = await zohoSyncService.retryFailedSyncs();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Zoho sync retry error:', err.message);
        res.status(500).json({ error: 'Failed to retry syncs', detail: err.message });
    }
});

// Retry a single sync
router.post('/sync/retry/:id', requireAdmin, async (req, res) => {
    try {
        const rows = await dbAdapter.query('SELECT * FROM zoho_sync_log WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Sync log not found' });

        const row = rows[0];
        const payload = typeof row.original_payload === 'string' ? JSON.parse(row.original_payload) : row.original_payload;

        await dbAdapter.run('UPDATE zoho_sync_log SET status = ?, retry_count = 0 WHERE id = ?', ['pending', row.id]);
        const result = await zohoSyncService.syncOrderToZoho(payload);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Zoho single retry error:', err.message);
        res.status(500).json({ error: 'Failed to retry sync', detail: err.message });
    }
});

// ============================================================
// TAX CORRECTIONS — history of tax fixes applied
// ============================================================

router.get('/tax-corrections', async (req, res) => {
    try {
        const { page = 1, limit = 50, type } = req.query;
        let where = [];
        let params = [];
        let paramIdx = 1;

        if (type) {
            where.push(`correction_type = $${paramIdx++}`);
            params.push(type);
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const [rows, countResult] = await Promise.all([
            dbAdapter.query(
                `SELECT * FROM zoho_tax_corrections ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
                [...params, parseInt(limit), offset]
            ),
            dbAdapter.query(`SELECT COUNT(*) as total FROM zoho_tax_corrections ${whereClause}`, params)
        ]);

        res.json({
            success: true,
            data: rows,
            total: countResult[0]?.total || 0,
            page: parseInt(page),
            limit: parseInt(limit)
        });
    } catch (err) {
        console.error('❌ Zoho tax corrections error:', err.message);
        res.status(500).json({ error: 'Failed to fetch tax corrections', detail: err.message });
    }
});

// ============================================================
// RETURNS & RTO — return/RTO log and retry
// ============================================================

router.get('/returns', async (req, res) => {
    try {
        const { page = 1, limit = 50, status, returnType } = req.query;
        const result = await zohoReturnService.getReturnLog({
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            returnType
        });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Zoho returns log error:', err.message);
        res.status(500).json({ error: 'Failed to fetch returns log', detail: err.message });
    }
});

// Retry a failed return
router.post('/returns/retry/:id', requireAdmin, async (req, res) => {
    try {
        const result = await zohoReturnService.retryReturn(parseInt(req.params.id));
        res.json(result);
    } catch (err) {
        console.error('❌ Zoho return retry error:', err.message);
        res.status(500).json({ error: 'Failed to retry return', detail: err.message });
    }
});

// ============================================================
// COD RECONCILIATION — COD payment log and manual reconcile
// ============================================================

router.get('/cod', async (req, res) => {
    try {
        const { page = 1, limit = 50, status, search } = req.query;
        const result = await zohoCodService.getCodLog({
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            search
        });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Zoho COD log error:', err.message);
        res.status(500).json({ error: 'Failed to fetch COD log', detail: err.message });
    }
});

// Manual COD reconciliation
router.post('/cod/reconcile/:id', requireAdmin, async (req, res) => {
    try {
        const result = await zohoCodService.manualReconcile(parseInt(req.params.id));
        res.json(result);
    } catch (err) {
        console.error('❌ Zoho COD reconcile error:', err.message);
        res.status(500).json({ error: 'Failed to reconcile COD', detail: err.message });
    }
});

// ============================================================
// CONFIGURATION — Bundle mapping, GST rates, connection test
// ============================================================

// Get all bundle mappings
router.get('/config/bundles', async (req, res) => {
    try {
        const rows = await dbAdapter.query('SELECT * FROM zoho_bundle_map ORDER BY bundle_sku, id');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch bundle mappings', detail: err.message });
    }
});

// Add a bundle mapping
router.post('/config/bundles', requireAdmin, async (req, res) => {
    try {
        const { bundle_sku, component_sku, component_qty = 1, gst_rate = 5.0 } = req.body;
        if (!bundle_sku || !component_sku) {
            return res.status(400).json({ error: 'bundle_sku and component_sku are required' });
        }

        const result = await dbAdapter.run(
            `INSERT INTO zoho_bundle_map (bundle_sku, component_sku, component_qty, gst_rate)
             VALUES (?, ?, ?, ?)`,
            [bundle_sku, component_sku, parseInt(component_qty), parseFloat(gst_rate)]
        );
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
        if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
            return res.status(409).json({ error: 'This bundle SKU mapping already exists' });
        }
        res.status(500).json({ error: 'Failed to add bundle mapping', detail: err.message });
    }
});

// Update a bundle mapping
router.put('/config/bundles/:id', requireAdmin, async (req, res) => {
    try {
        const { component_sku, component_qty, gst_rate } = req.body;
        const updates = {};
        if (component_sku) updates.component_sku = component_sku;
        if (component_qty !== undefined) updates.component_qty = parseInt(component_qty);
        if (gst_rate !== undefined) updates.gst_rate = parseFloat(gst_rate);

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        await dbAdapter.update('zoho_bundle_map', updates, { id: parseInt(req.params.id) });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update bundle mapping', detail: err.message });
    }
});

// Delete a bundle mapping
router.delete('/config/bundles/:id', requireAdmin, async (req, res) => {
    try {
        await dbAdapter.delete('zoho_bundle_map', { id: parseInt(req.params.id) });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete bundle mapping', detail: err.message });
    }
});

// Delete ALL mappings of one bundle (wizard "remove bundle")
router.delete('/config/bundles/by-name/:name', requireAdmin, async (req, res) => {
    try {
        await dbAdapter.run('DELETE FROM zoho_bundle_map WHERE bundle_sku = ?', [decodeURIComponent(req.params.name)]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete bundle mappings', detail: err.message });
    }
});

// Apply a whole bundle mapping in one shot (wizard save)
router.post('/config/bundles/apply', requireAdmin, async (req, res) => {
    try {
        const { bundle_sku, gst_rate = 5.0, components } = req.body;
        if (!bundle_sku || !Array.isArray(components) || components.length === 0) {
            return res.status(400).json({ error: 'bundle_sku and a non-empty components array are required' });
        }
        await dbAdapter.run('DELETE FROM zoho_bundle_map WHERE bundle_sku = ?', [bundle_sku]);
        for (const c of components) {
            if (!c.component_sku) continue;
            await dbAdapter.run(
                `INSERT INTO zoho_bundle_map (bundle_sku, component_sku, component_qty, gst_rate)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (bundle_sku, component_sku) DO NOTHING`,
                [bundle_sku, c.component_sku, parseInt(c.component_qty || 1), parseFloat(gst_rate)]
            );
        }
        res.json({ success: true, applied: components.length });
    } catch (err) {
        res.status(500).json({ error: 'Failed to apply bundle mapping', detail: err.message });
    }
});

// ============================================================
// BUNDLE SETUP WIZARD — data powering the one-click mapper:
// Shopify bundle products + Zoho singles grouped by style/colorway
// + an auto-suggestion whenever colorways match the pack size.
// ============================================================

const BUNDLE_RX = /\b(TRIPLE|DOUBLE|BUNDLE|COMBO|PACK|SET|KIT)\b/i;
const normFam = (s) => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/-/g, '');

function packSizeOf(title) {
    const t = String(title).toUpperCase();
    if (/TRIPLE/.test(t)) return 3;
    if (/DOUBLE/.test(t)) return 2;
    let m = t.match(/COMBO[-\s]*(\d+)/);
    if (m) return parseInt(m[1]);
    m = t.match(/PACK\s*(?:OF)?[-\s]*(\d+)/);
    if (m) return parseInt(m[1]);
    m = t.match(/\(\s*(\d+)\s*SET\s*\)/);
    if (m) return parseInt(m[1]);
    return null; // BUNDLE/COMBO without number — size unknown
}

router.get('/config/bundles/wizard', requireAdmin, async (req, res) => {
    try {
        // 1. Shopify products that look like bundles
        let products = [];
        const shop = process.env.SHOPIFY_STORE;
        const token = process.env.SHOPIFY_ACCESS_TOKEN;
        if (shop && token) {
            // Shopify REST uses cursor (Link header) pagination, not page numbers
            let url = `https://${shop}/admin/api/2024-01/products.json?limit=250&fields=id,title,status`;
            while (url && products.length < 1500) {
                const r = await axios.get(url, {
                    headers: { 'X-Shopify-Access-Token': token }, timeout: 20000
                });
                products = products.concat(r.data?.products || []);
                const link = r.headers?.link || '';
                const next = link.split(',').find(l => l.includes('rel="next"'));
                url = next ? next.match(/<([^>]+)>/)[1] : null;
            }
        }
        const bundleProducts = products
            .filter(p => BUNDLE_RX.test(p.title))
            .map(p => ({ title: p.title, packSize: packSizeOf(p.title) }));

        // 2. Zoho items grouped into style → colorway → sizes (paginate all)
        let items = [];
        for (let page = 1; page <= 10; page++) {
            const batch = await zohoService.searchItem({ per_page: 200, page });
            items = items.concat(batch || []);
            if (!batch || batch.length < 200) break;
        }
        const groups = {};
        for (const it of items || []) {
            const name = it.name || '';
            const lastDash = name.lastIndexOf(' - ');
            const size = lastDash > -1 ? name.slice(lastDash + 3).trim() : '';
            const rest = lastDash > -1 ? name.slice(0, lastDash) : name;
            const pm = rest.match(/^(.*?)\s*\((.*)\)\s*$/);
            if (!pm) continue; // not a per-colorway single
            const famKey = normFam(pm[1]);
            const colorway = pm[2].trim().toUpperCase();
            groups[famKey] = groups[famKey] || { family: pm[1].trim(), colorways: {} };
            if (!groups[famKey].colorways[colorway]) {
                groups[famKey].colorways[colorway] = { baseName: rest, sizes: [] };
            }
            if (size) groups[famKey].colorways[colorway].sizes.push(size);
        }
        const catalog = Object.entries(groups).map(([famKey, g]) => ({
            famKey,
            family: g.family,
            colorways: Object.entries(g.colorways).map(([cw, v]) => ({
                colorway: cw,
                baseName: v.baseName,
                // Skip bundle/composite items that snuck into the grouping
                isPack: BUNDLE_RX.test(cw),
                sizeCount: v.sizes.length
            }))
        }));

        // 3. Existing mappings
        const rows = await dbAdapter.query('SELECT * FROM zoho_bundle_map ORDER BY bundle_sku, id');
        const configured = {};
        for (const r of rows) (configured[r.bundle_sku] = configured[r.bundle_sku] || []).push(r);

        // 4. Auto-suggest: match bundle title family against catalog families
        const suggestions = bundleProducts.map(bp => {
            const famKey = normFam(bp.title.replace(/\(.*$/, ''));
            const match = catalog.find(g => g.famKey === famKey);
            const singles = match ? match.colorways.filter(c => !c.isPack) : [];
            const fits = bp.packSize != null && singles.length > 0 && singles.length === bp.packSize;
            return {
                title: bp.title,
                packSize: bp.packSize,
                family: match ? match.family : null,
                candidates: singles,
                autoReady: fits,
                reason: !match
                    ? 'No matching singles found in Zoho for this style'
                    : !bp.packSize
                        ? 'Pack size unknown — pick the colorways inside manually'
                        : !fits
                            ? `${singles.length} colorway(s) in Zoho but pack holds ${bp.packSize} — pick manually`
                            : 'Colorways match the pack size — ready to apply'
            };
        });

        res.json({ success: true, suggestions, catalog, configured });
    } catch (err) {
        res.status(500).json({ error: 'Wizard data failed', detail: err.message });
    }
});

// Test Zoho connection
router.get('/config/test-connection', requireAdmin, async (req, res) => {
    try {
        const result = await zohoService.testConnection();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get current configuration
router.get('/config', requireAdmin, async (req, res) => {
    try {
        const bundleCount = await dbAdapter.query('SELECT COUNT(*) as count FROM zoho_bundle_map');
        res.json({
            success: true,
            config: {
                autoSync: process.env.ZOHO_AUTO_SYNC !== 'false',
                sellerState: process.env.ZOHO_SELLER_STATE || 'Haryana',
                booksDomain: process.env.ZOHO_BOOKS_DOMAIN || 'zoho.in',
                inventoryDomain: process.env.ZOHO_INVENTORY_DOMAIN || 'zoho.in',
                orgId: process.env.ZOHO_ORGANIZATION_ID ? '***configured***' : 'NOT SET',
                clientId: process.env.ZOHO_CLIENT_ID ? '***configured***' : 'NOT SET',
                bundleMappings: bundleCount[0]?.count || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch config', detail: err.message });
    }
});

module.exports = router;
