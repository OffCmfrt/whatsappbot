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
        if (process.env.NODE_ENV !== 'production') {
            return res.json({
                success: true,
                sync: { today: { total: 3, synced: 3, failed: 0, pendingRetry: 0 } },
                returns: { today: { returns: 1, rtos: 0, exchanges: 1 }, creditNotesCreated: 2, failedReturns: 0 },
                cod: { pending: 0, reconciled: 3, total: 3 }
            });
        }
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
        if (process.env.NODE_ENV !== 'production') {
            return res.json({
                success: true,
                data: [
                    {
                        id: 1,
                        shopify_order_id: '10482',
                        zoho_invoice_id: 'INV-10482',
                        status: 'synced',
                        created_at: new Date(Date.now() - 3600000).toISOString(),
                        transformation: { bundle_breaks: [], tax_corrections: [] },
                        error_message: null
                    },
                    {
                        id: 2,
                        shopify_order_id: '10483',
                        zoho_invoice_id: 'INV-10483',
                        status: 'synced',
                        created_at: new Date(Date.now() - 7200000).toISOString(),
                        transformation: { bundle_breaks: [], tax_corrections: [] },
                        error_message: null
                    },
                    {
                        id: 3,
                        shopify_order_id: '10484',
                        zoho_invoice_id: 'INV-10484',
                        status: 'synced',
                        created_at: new Date(Date.now() - 10800000).toISOString(),
                        transformation: { bundle_breaks: [], tax_corrections: [] },
                        error_message: null
                    }
                ],
                total: 3,
                page: 1,
                limit: 25,
                totalPages: 1
            });
        }
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
        const { page = 1, limit = 50, type, search } = req.query;
        let where = [];
        let params = [];
        let paramIdx = 1;

        if (type) {
            where.push(`correction_type = $${paramIdx++}`);
            params.push(type);
        }
        if (search) {
            where.push(`(shopify_order_id ILIKE $${paramIdx} OR correction_type ILIKE $${paramIdx})`);
            params.push(`%${search.trim()}%`);
            paramIdx++;
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const parsedPage = Math.max(1, parseInt(page, 10) || 1);
        const parsedLimit = Math.max(1, parseInt(limit, 10) || 50);
        const offset = (parsedPage - 1) * parsedLimit;

        const [rows, countResult, statsResult] = await Promise.all([
            dbAdapter.query(
                `SELECT * FROM zoho_tax_corrections ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
                [...params, parsedLimit, offset]
            ),
            dbAdapter.query(`SELECT COUNT(*) as total FROM zoho_tax_corrections ${whereClause}`, params),
            dbAdapter.query(`
                SELECT 
                    COUNT(*) as total_count,
                    COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as today_count,
                    COUNT(CASE WHEN correction_type = 'rate_fix' THEN 1 END) as rate_fixes,
                    COUNT(CASE WHEN correction_type IN ('state_fix', 'intra_state', 'inter_state') THEN 1 END) as state_fixes
                FROM zoho_tax_corrections
            `).catch(() => [{}])
        ]);

        const total = parseInt(countResult[0]?.total || 0, 10);
        const statsRow = statsResult[0] || {};

        res.json({
            success: true,
            data: rows,
            total,
            page: parsedPage,
            limit: parsedLimit,
            totalPages: Math.ceil(total / parsedLimit),
            stats: {
                today: parseInt(statsRow.today_count || 0, 10),
                rateFixes: parseInt(statsRow.rate_fixes || 0, 10),
                stateFixes: parseInt(statsRow.state_fixes || 0, 10),
                total: parseInt(statsRow.total_count || total, 10)
            }
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
        const { page = 1, limit = 50, status, returnType, search } = req.query;
        const result = await zohoReturnService.getReturnLog({
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            returnType,
            search
        });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Zoho returns log error:', err.message);
        if (process.env.NODE_ENV !== 'production') {
            const allMock = [
                {
                    id: 1,
                    shopify_order_id: '10482',
                    return_type: 'return',
                    zoho_credit_note_id: 'CN-10482-1',
                    status: 'synced',
                    source: 'portal',
                    request_id: 'RET-10482-1',
                    reason: 'Size too large — requesting exchange or return',
                    items: JSON.stringify([{ title: 'Vintage Oversized Tee - Black / L', quantity: 1, price: 1499 }]),
                    refund_amount: 1499,
                    refund_status: 'Completed',
                    customer_name: 'Rahul Sharma',
                    customer_email: 'rahul.sharma@example.com',
                    customer_phone: '9876543210',
                    shipping_address: { address1: '42, MG Road', city: 'Bengaluru', province: 'Karnataka', zip: '560001', country: 'India' },
                    created_at: new Date(Date.now() - 86400000).toISOString(),
                    updated_at: new Date(Date.now() - 3600000).toISOString(),
                    log: {
                        source: 'return_and_exchange_portal',
                        portal_url: 'https://offcomfrt.in/pages/return',
                        request_id: 'RET-10482-1',
                        order_number: '10482',
                        customer_name: 'Rahul Sharma',
                        customer_phone: '919876543210',
                        type: 'return',
                        status: 'approved',
                        reason: 'Size too large — requesting exchange or return',
                        refund_mode: 'store_credit',
                        refund_amount: 1499,
                        refund_status: 'completed',
                        pickup_status: 'completed',
                        carrier: 'Delhivery',
                        awb: 'AWB987654321',
                        zoho_sync: {
                            credit_note_id: 'CN-10482-1',
                            status: 'synced',
                            created_at: new Date(Date.now() - 86400000).toISOString()
                        }
                    },
                    error_message: null
                },
                {
                    id: 2,
                    shopify_order_id: '10483',
                    return_type: 'exchange',
                    zoho_credit_note_id: null,
                    status: 'waiting_for_payment',
                    source: 'portal',
                    request_id: 'EXCH-10483-1',
                    reason: 'Size too small — please replace with size M',
                    items: JSON.stringify([{ title: 'Heavyweight Boxy Hoodie - Slate / S', quantity: 1, price: 2999 }]),
                    price_difference: 150,
                    payment_status: 'pending',
                    customer_name: 'Priya Patel',
                    customer_email: 'priya.patel@example.com',
                    customer_phone: '9811223344',
                    shipping_address: { address1: 'Flat 7B, Sunrise Apartments', address2: 'Andheri West', city: 'Mumbai', province: 'Maharashtra', zip: '400058', country: 'India' },
                    created_at: new Date(Date.now() - 172800000).toISOString(),
                    updated_at: new Date(Date.now() - 7200000).toISOString(),
                    log: {
                        source: 'return_and_exchange_portal',
                        portal_url: 'https://offcomfrt.in/pages/exchange',
                        request_id: 'EXCH-10483-1',
                        order_number: '10483',
                        customer_name: 'Priya Patel',
                        customer_phone: '919811223344',
                        type: 'exchange',
                        status: 'waiting_for_payment',
                        reason: 'Size too small — please replace with size M',
                        replacement_item: 'Heavyweight Boxy Hoodie - Slate / M',
                        pickup_status: 'pickup_booked',
                        carrier: 'Ekart',
                        awb: 'AWB112233445'
                    },
                    error_message: null
                },
                {
                    id: 3,
                    shopify_order_id: '53643',
                    return_type: 'return',
                    zoho_credit_note_id: null,
                    status: 'waiting_for_payment',
                    source: 'portal',
                    request_id: 'REQ-53153',
                    reason: 'Product defective — seam torn on first use',
                    items: JSON.stringify([{ title: 'Classic Crew Neck Tee - White / M', quantity: 1, price: 1299 }]),
                    refund_amount: 1299,
                    refund_status: 'pending',
                    customer_name: 'Arman .',
                    customer_email: 'armanjawli08@gmail.com',
                    customer_phone: '8850999236',
                    shipping_address: { address1: 'House No 12, Sector 4', city: 'Navi Mumbai', province: 'Maharashtra', zip: '400706', country: 'India' },
                    created_at: new Date(Date.now() - 43200000).toISOString(),
                    updated_at: new Date(Date.now() - 1800000).toISOString(),
                    log: {
                        source: 'return_and_exchange_portal',
                        request_id: 'REQ-53153',
                        order_number: '53643',
                        customer_name: 'Arman .',
                        customer_phone: '8850999236',
                        type: 'return',
                        status: 'waiting_for_payment'
                    },
                    error_message: null
                }
            ];
            const searchStr = (req.query.search || '').trim().toLowerCase();
            const filtered = searchStr ? allMock.filter(r =>
                r.shopify_order_id.toLowerCase().includes(searchStr) ||
                (r.request_id || '').toLowerCase().includes(searchStr) ||
                (r.zoho_credit_note_id || '').toLowerCase().includes(searchStr)
            ) : allMock;
            return res.json({
                success: true,
                data: filtered,
                total: filtered.length,
                page: 1,
                limit: 25,
                totalPages: 1
            });
        }
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
// PAYMENT LINK — generate & send Razorpay link via WhatsApp
// ============================================================
router.post('/returns/payment-link', async (req, res) => {
    try {
        const { request_id, order_number, amount, phone } = req.body;
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, error: 'Valid amount is required' });
        }
        if (!phone) {
            return res.status(400).json({ success: false, error: 'Customer phone number is required' });
        }

        const amountPaise = Math.round(parseFloat(amount) * 100);

        // Generate Razorpay payment link
        const razorpayService = require('../services/razorpayService');
        let paymentLink = null;
        let shortUrl = null;

        try {
            const linkResult = await razorpayService.createPaymentLink({
                amount: amountPaise,
                currency: 'INR',
                description: `Return/Exchange balance — Order #${order_number || 'N/A'} (${request_id || 'N/A'})`,
                customer: { contact: phone.replace(/^0/, '').replace(/^\+?91/, '91') },
                callback_url: process.env.BASE_URL ? `${process.env.BASE_URL}/api/payments/razorpay-webhook` : undefined,
                expire_by: Math.floor(Date.now() / 1000) + 86400 * 3 // 3-day expiry
            });
            paymentLink = linkResult.paymentLinkId;
            shortUrl = linkResult.shortUrl;
        } catch (rpErr) {
            console.warn('⚠️ Razorpay link creation failed:', rpErr.message);
            // Dev fallback: generate a dummy link
            if (process.env.NODE_ENV !== 'production') {
                shortUrl = `https://rzp.io/l/demo-${Date.now()}`;
            } else {
                return res.status(500).json({ success: false, error: 'Failed to create payment link: ' + rpErr.message });
            }
        }

        // Send via WhatsApp
        const whatsappPhone = String(phone).replace(/\D/g, '').replace(/^0/, '').replace(/^(?!91)/, '91');
        try {
            const botService = require('../services/botService');
            await botService.sendMessage(whatsappPhone, [
                `💳 *Payment Link — Order #${order_number}*`,
                ``,
                `Amount: *₹${parseFloat(amount).toLocaleString('en-IN')}*`,
                `Request ID: ${request_id || 'N/A'}`,
                ``,
                `Pay here: ${shortUrl}`,
                ``,
                `_Link expires in 3 days. Your return/exchange will be confirmed once payment is received._`
            ].join('\n'));
        } catch (waErr) {
            console.warn('⚠️ WhatsApp send failed (non-fatal):', waErr.message);
        }

        res.json({ success: true, link: shortUrl, payment_link_id: paymentLink });
    } catch (err) {
        console.error('❌ Payment link error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to generate payment link', detail: err.message });
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

// ============================================================
// PRICE VALIDATION — flagged mismatches between Zoho and Shopify
// ============================================================

router.get('/price-flags', requireAdmin, async (req, res) => {
    try {
        const { limit = 100 } = req.query;
        // The transformation JSONB column stores price_validation after sync.
        // Find rows where the delta exceeds ₹1 (flagged = true).
        const rows = await dbAdapter.query(
            `SELECT shopify_order_id, zoho_invoice_id, created_at,
                    transformation->'price_validation' as price_validation
             FROM zoho_sync_log
             WHERE status = 'synced'
               AND transformation->'price_validation'->>'flagged' = 'true'
             ORDER BY created_at DESC
             LIMIT ?`,
            [parseInt(limit)]
        );

        const total = await dbAdapter.query(
            `SELECT COUNT(*) as count FROM zoho_sync_log
             WHERE status = 'synced'
               AND transformation->'price_validation'->>'flagged' = 'true'`
        );

        res.json({
            success: true,
            total: total[0]?.count || 0,
            flagged: rows.map(r => ({
                order_id: r.shopify_order_id,
                invoice_id: r.zoho_invoice_id,
                created_at: r.created_at,
                zoho_net: r.price_validation?.zoho_net,
                shopify_net: r.price_validation?.shopify_net,
                delta: r.price_validation?.delta
            }))
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch price flags', detail: err.message });
    }
});

module.exports = router;
