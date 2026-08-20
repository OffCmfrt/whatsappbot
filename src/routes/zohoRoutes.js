const express = require('express');
const router = express.Router();
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
