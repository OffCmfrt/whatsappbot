const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { verifyToken, requirePermission, permissionGate, logOperatorActivity, adminCredentialFingerprint } = require('../middleware/auth');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Settings = require('../models/Settings');
const broadcastService = require('../services/broadcastService');
const followUpService = require('../services/followUpService');
const whatsappService = require('../services/whatsappService');
const { dbAdapter } = require('../database/db');
const cloudinaryService = require('../services/cloudinaryService');
const { toIST, formatDateForExport, fromISTtoUTC } = require('../utils/timezone');
const { invalidateCache: clearAllCaches, caches, getCacheStats, getCached, setCache } = require('../utils/cache');

// In-memory store for last known portal passwords (so admin can view them)
const portalPasswords = new Map();

// Lazy-load multer to save ~3-5MB at startup — only needed for file upload endpoints
let _upload = null;
function getUpload() {
  if (!_upload) {
    const multer = require('multer');
    _upload = multer({ storage: multer.memoryStorage() });
  }
  return _upload;
}

// Lazy-load xlsx (saves ~30-50MB at startup) — only loaded when export/import is triggered
let _xlsx = null;
function getXlsx() {
  if (!_xlsx) _xlsx = require('xlsx');
  return _xlsx;
}

// Advanced caching system imported from utils/cache
// Using LRU cache with TTL for better performance

// Targeted cache invalidation — only clear what's actually affected
function invalidateCache(target = null) {
  if (target && caches[target]) {
    caches[target].clear();
    console.log(`🗑️ Cache invalidated: ${target}`);
  } else {
    clearAllCaches(); // Fallback: clear all
    console.log('🗑️ All caches invalidated');
  }
}

// Admin login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Check credentials (in production, hash password and store in DB)
        if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
            // Generate JWT token — credFp ties the session to the current
            // ADMIN_PASSWORD so changing it on Render instantly logs everyone out
            const token = jwt.sign(
                { username, role: 'admin', credFp: adminCredentialFingerprint() },
                process.env.JWT_SECRET,
                { expiresIn: '24h' }
            );

            res.json({
                success: true,
                token,
                username
            });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// SMART LOGIN: route-level permission gate for operators.
// Master admin passes everything; operators are checked against the
// page/function permissions embedded in their JWT (see ROUTE_PERMISSIONS).
router.use(permissionGate);

// Get dashboard statistics
router.get('/stats', verifyToken, async (req, res) => {
    try {
        // Check cache first
        const cacheKey = 'dashboard_stats';
        const cached = getCached(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const [customerCount, orderCount, messagesCount] = await Promise.all([
            Customer.getCount(),
            Order.getCount(),
            getMessageCount()
        ]);

        const activeToday = await getActiveTodayCount();
        const customersGrowth = await calculateGrowth('customers');
        const ordersGrowth = await calculateGrowth('orders');
        const messagesGrowth = await calculateGrowth('messages');

        const response = {
            success: true,
            stats: {
                totalCustomers: customerCount,
                totalOrders: orderCount,
                totalMessages: messagesCount,
                activeToday,
                customersGrowth,
                ordersGrowth,
                messagesGrowth,
                activeGrowth: 0
            }
        };

        // Cache the response for 3 minutes
        setCache(cacheKey, response, 'stats', 3 * 60 * 1000);
        res.json(response);
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Get recent activity
router.get('/activity/recent', verifyToken, async (req, res) => {
    try {
        let activity = [];
        const recentMessages = await dbAdapter.query('SELECT * FROM messages ORDER BY created_at DESC LIMIT 10');
        activity = (recentMessages || []).map(msg => ({
            title: `Message from ${msg.customer_phone}`,
            description: msg.message_content.substring(0, 50) + '...',
            created_at: msg.created_at
        }));
        res.json({ success: true, activity });
    } catch (error) {
        console.error('Activity error:', error);
        res.status(500).json({ error: 'Failed to fetch activity' });
    }
});

// Get analytics charts data
router.get('/analytics/charts', verifyToken, async (req, res) => {
    try {
        // Check cache first
        const cached = getCached('charts');
        if (cached) {
            return res.json(cached);
        }

        const messageVolume = await getMessageVolume();
        const orderStatus = await getOrderStatusDistribution();

        const response = {
            success: true,
            messageVolume,
            orderStatus
        };

        // Cache the response
        setCache('charts', response);
        res.json(response);
    } catch (error) {
        console.error('Charts error:', error);
        res.status(500).json({ error: 'Failed to fetch charts' });
    }
});

// Get detailed analytics
router.get('/analytics/detailed', verifyToken, async (req, res) => {
    try {
        const faqData = {
            labels: ['Returns', 'Shipping', 'Payment', 'Sizing', 'Tracking'],
            values: [45, 38, 32, 28, 25]
        };
        const growthData = await getCustomerGrowth();
        res.json({
            success: true,
            faqData,
            growthData
        });
    } catch (error) {
        console.error('Detailed analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Get all customers with stats (and optional segment filtering)
router.get('/customers', verifyToken, async (req, res) => {
    try {
        const { limit = 100, offset = 0, segment } = req.query;
        let formattedCustomers = [];

        // Check cache first (only for unfiltered queries)
        const cacheKey = `customers:${limit}:${offset}:${segment || 'all'}`;
        if (!segment || segment === 'all') {
            const cached = getCached(cacheKey);
            if (cached) {
                return res.json(cached);
            }
        }

        // Build segment filter condition
        let segmentCondition = '';
        let segmentParams = [];

        if (segment && segment !== 'all') {
            if (segment === 'active') { // 7d messages
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                segmentCondition = `WHERE phone IN (SELECT DISTINCT customer_phone FROM messages WHERE created_at >= ?)`;
                segmentParams.push(sevenDaysAgo);
            } else if (segment === 'recent') { // 30d orders
                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                segmentCondition = `WHERE phone IN (SELECT DISTINCT customer_phone FROM orders WHERE created_at >= ?)`;
                segmentParams.push(thirtyDaysAgo);
            } else if (segment === 'first_time') { // exactly 1 order
                segmentCondition = `WHERE order_count = 1`;
            } else if (segment === 'second_time') { // exactly 2 orders
                segmentCondition = `WHERE order_count = 2`;
            } else if (segment === 'loyal') { // 3 to 4 orders
                segmentCondition = `WHERE order_count BETWEEN 3 AND 4`;
            } else if (segment === 'vip') { // 5+ orders
                segmentCondition = `WHERE order_count >= 5`;
            } else if (segment === 'inactive') { // no orders in 60d
                const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
                segmentCondition = `
                    WHERE phone NOT IN (
                        SELECT customer_phone FROM orders 
                        WHERE created_at >= ? AND customer_phone IS NOT NULL
                    )
                    AND created_at < ?
                `;
                segmentParams.push(sixtyDaysAgo, sixtyDaysAgo);
            }
        }

        const countSql = `SELECT COUNT(*) as total FROM customers ${segmentCondition}`;
        const countRes = await dbAdapter.query(countSql, segmentParams);
        const total = countRes[0]?.total || 0;

        // Optimized query using LEFT JOIN instead of correlated subquery
        const sql = `
            SELECT c.*, 
                COALESCE(m.message_count, 0) as message_count
            FROM customers c
            LEFT JOIN (
                SELECT customer_phone, COUNT(*) as message_count 
                FROM messages 
                GROUP BY customer_phone
            ) m ON c.phone = m.customer_phone
            ${segmentCondition}
            ORDER BY c.updated_at DESC
            LIMIT ? OFFSET ?
        `;
        formattedCustomers = await dbAdapter.query(sql, [...segmentParams, parseInt(limit), parseInt(offset)]);

        const response = {
            success: true,
            customers: formattedCustomers,
            total,
            page: Math.floor(offset / limit) + 1,
            limit: parseInt(limit)
        };

        // Cache the response (only for unfiltered queries)
        if (!segment || segment === 'all') {
            setCache(cacheKey, response, 'queries', 2 * 60 * 1000); // 2 minutes TTL
        }

        res.json(response);
    } catch (error) {
        console.error('Customers error:', error);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// Get customer details
router.get('/customers/:phone/details', verifyToken, async (req, res) => {
    try {
        const { phone } = req.params;
        let customerData = null;

        const customers = await dbAdapter.select('customers', { phone }, { limit: 1 });
        if (!customers || customers.length === 0) return res.status(404).json({ error: 'Customer not found' });

        const orders = await dbAdapter.query('SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 10', [phone]);
        const msgs = await dbAdapter.query('SELECT COUNT(*) as count FROM messages WHERE customer_phone = ?', [phone]);

        customerData = {
            ...customers[0],
            order_count: orders.length || 0,
            message_count: msgs[0]?.count || 0,
            orders: orders || []
        };

        res.json({ success: true, customer: customerData });
    } catch (error) {
        console.error('Customer details error:', error);
        res.status(500).json({ error: 'Failed to fetch customer details' });
    }
});

// Get all-time orders by phone from local database (for chat sidebar)
router.get('/customers/:phone/all-orders', verifyToken, async (req, res) => {
    try {
        const { phone } = req.params;
        
        console.log(`[ALL ORDERS] Fetching all-time orders from database for: ${phone}`);
        
        // Capped at 50 most recent orders to bound DB egress (chat sidebar use)
        const orders = await dbAdapter.query(
            'SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 50',
            [phone]
        );
        
        console.log(`[ALL ORDERS] Found ${(orders || []).length} orders for ${phone}`);
        
        res.json({ success: true, orders: orders || [], source: 'database' });
    } catch (error) {
        console.error('All orders error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch orders from database',
            details: error.message 
        });
    }
});

// Get all orders
router.get('/orders', verifyToken, async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        let formattedOrders = [];
        const safeLimit = Math.min(parseInt(limit) || 100, 500);
        const safeOffset = Math.max(0, parseInt(offset) || 0);

        const sql = `
            SELECT o.*, c.name as customer_name 
            FROM orders o 
            LEFT JOIN customers c ON o.customer_phone = c.phone 
            ORDER BY o.created_at DESC 
            LIMIT ? OFFSET ?
        `;
        formattedOrders = await dbAdapter.query(sql, [safeLimit, safeOffset]);

        res.json({ success: true, orders: formattedOrders });
    } catch (error) {
        console.error('Orders error:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Get messages
router.get('/messages', verifyToken, async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        let msgs = [];
        const safeLimit = Math.min(parseInt(limit) || 100, 500);
        const safeOffset = Math.max(0, parseInt(offset) || 0);
        // Only select columns the dashboard table renders (drops status/wa_message_id to cut DB egress)
        msgs = await dbAdapter.query('SELECT id, customer_phone, message_type, message_content, created_at FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?', [safeLimit, safeOffset]);
        res.json({ success: true, messages: msgs });
    } catch (error) {
        console.error('Messages error:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Send broadcast
router.post('/broadcast/send', verifyToken, async (req, res) => {
    try {
        const { message, segment, imageUrl, delay_seconds, phones } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        let result;
        if (phones && phones.length > 0) {
            // Priority 1: Direct phone list
            result = await broadcastService.sendToPhones(phones, message, req.admin.username, imageUrl, delay_seconds || 5);
        } else if (segment) {
            // Priority 2: Segment
            result = await broadcastService.sendToSegment(message, segment, req.admin.username, imageUrl, delay_seconds || 5);
        } else {
            return res.status(400).json({ error: 'Recipient segment or phone list is required' });
        }
        res.json(result);
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ error: 'Failed to send broadcast' });
    }
});

// Send template broadcast
router.post('/broadcast/template', verifyToken, async (req, res) => {
    try {
        const { templateName, language, segment, components, delay_seconds, phones } = req.body;
        if (!templateName) return res.status(400).json({ error: 'Template name is required' });

        let result;
        if (phones && phones.length > 0) {
            result = await broadcastService.sendTemplateToPhones(
                templateName,
                language || 'en_US',
                phones,
                req.admin.username,
                components || [],
                delay_seconds || 5
            );
        } else {
            result = await broadcastService.sendTemplateToSegment(
                templateName,
                language || 'en_US',
                segment || 'all',
                req.admin.username,
                components || [],
                delay_seconds || 5
            );
        }
        res.json(result);
    } catch (error) {
        console.error('Template broadcast error:', error);
        res.status(500).json({ error: 'Failed to send template broadcast' });
    }
});

// Get broadcast preview (list recipients)
router.get('/broadcast/preview', verifyToken, async (req, res) => {
    try {
        const { segment } = req.query;
        if (!segment) return res.status(400).json({ error: 'Segment is required' });

        const customers = await broadcastService.getCustomersBySegment(segment);
        res.json({ success: true, customers });
    } catch (error) {
        console.error('Broadcast preview error:', error);
        res.status(500).json({ error: 'Failed to fetch preview' });
    }
});

// Pause broadcast
router.post('/broadcast/pause', verifyToken, async (req, res) => {
    try {
        broadcastService.pause();
        res.json({ success: true, isPaused: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to pause broadcast' });
    }
});

// Resume broadcast
router.post('/broadcast/resume', verifyToken, async (req, res) => {
    try {
        broadcastService.resume();
        res.json({ success: true, isPaused: false });
    } catch (error) {
        res.status(500).json({ error: 'Failed to resume broadcast' });
    }
});

// Import contacts from File (Excel/CSV)
router.post('/broadcast/import', verifyToken, async (req, res) => {
    try {
        const { fileBase64, fileName } = req.body;
        if (!fileBase64) return res.status(400).json({ error: 'File data is required' });

        const buffer = Buffer.from(fileBase64, 'base64');
        const workbook = getXlsx().read(buffer, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const data = getXlsx().utils.sheet_to_json(worksheet);

        // Extract phone numbers (smart search for phone columns)
        const phones = [];
        data.forEach(row => {
            const phoneKey = Object.keys(row).find(key => 
                key.toLowerCase().includes('phone') || 
                key.toLowerCase().includes('mobile') || 
                key.toLowerCase().includes('number') ||
                key.toLowerCase().includes('contact')
            );
            if (phoneKey && row[phoneKey]) {
                const standardized = whatsappService.formatPhoneNumber(String(row[phoneKey]));
                if (standardized && standardized.length >= 10) {
                    phones.push({
                        phone: standardized,
                        name: row.name || row.Name || row.Customer || 'Customer'
                    });
                }
            }
        });

        res.json({ success: true, count: phones.length, customers: phones });
    } catch (error) {
        console.error('Import error:', error);
        res.status(500).json({ error: 'Failed to parse file' });
    }
});

// Upload image to Cloudinary
router.post('/upload', verifyToken, (req, res, next) => getUpload().single('image')(req, res, next), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const imageUrl = await cloudinaryService.uploadBuffer(req.file.buffer);
        res.json({ success: true, imageUrl });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

// Start Direct Chat
router.post('/chat/start', verifyToken, async (req, res) => {
    try {
        const { phone, message } = req.body;
        if (!phone || !message) return res.status(400).json({ error: 'Phone and message are required' });

        const standardized = whatsappService.formatPhoneNumber(phone);
        
        // 1. Send immediate message (WhatsApp service handles logging automatically)
        if (req.body.imageUrl) {
            await whatsappService.sendImage(standardized, req.body.imageUrl, message, 'text');
        } else {
            await whatsappService.sendMessage(standardized, message, 'text');
        }

        // 2. Ensure customer exists in DB
        let existing = await Customer.findByPhone(standardized);
        if (!existing) {
            existing = await Customer.getOrCreate(standardized, 'Manual Contact');
        }

        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Start chat error:', error.message);
        if (error.response?.data) {
            console.error('WhatsApp API specific error:', JSON.stringify(error.response.data, null, 2));
        }
        res.status(500).json({ error: 'Failed to initiate chat', details: error.message });
    }
});

// Get broadcast recipient count
router.get('/broadcast/count', verifyToken, async (req, res) => {
    try {
        const { segment } = req.query;
        if (!segment) return res.status(400).json({ error: 'Segment is required' });

        const customers = await broadcastService.getCustomersBySegment(segment);
        res.json({ success: true, count: customers.length });
    } catch (error) {
        console.error('Count error:', error);
        res.status(500).json({ error: 'Failed to get count' });
    }
});

// Get broadcast history
router.get('/broadcast/history', verifyToken, async (req, res) => {
    try {
        let broadcasts = [];
        broadcasts = await dbAdapter.query('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 20');
        res.json({ success: true, broadcasts });
    } catch (error) {
        console.error('Broadcast history error:', error);
        res.status(500).json({ error: 'Failed to fetch broadcast history' });
    }
});

// Create and send offer
router.post('/offers', verifyToken, async (req, res) => {
    try {
        const { title, description, discountCode, message, expiresAt } = req.body;
        if (!title || !message) return res.status(400).json({ error: 'Title and message are required' });

        const result = await broadcastService.sendOffer({ title, description, discountCode, message, expiresAt }, req.admin.username);
        res.json(result);
    } catch (error) {
        console.error('Offer error:', error);
        res.status(500).json({ error: 'Failed to send offer' });
    }
});

// Get analytics — uses SQL aggregation instead of loading ALL rows into memory
router.get('/analytics', verifyToken, async (req, res) => {
    try {
        // Aggregate by type in SQL (avoids loading all messages/orders into memory)
        const typeCounts = await dbAdapter.query(
            'SELECT message_type, COUNT(*) as count FROM messages GROUP BY message_type'
        );
        const statusCounts = await dbAdapter.query(
            'SELECT status, COUNT(*) as count FROM orders GROUP BY status'
        );

        // Last 7 days message volume — single aggregation query
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
        sevenDaysAgo.setHours(0, 0, 0, 0);
        const dailyCounts = await dbAdapter.query(
            `SELECT DATE(created_at) as date, COUNT(*) as count 
             FROM messages 
             WHERE created_at >= ? 
             GROUP BY DATE(created_at) 
             ORDER BY date`,
            [sevenDaysAgo.toISOString()]
        );

        // Build messagesByType
        const messagesByType = {};
        (typeCounts || []).forEach(row => {
            messagesByType[row.message_type] = Number(row.count);
        });

        // Build ordersByStatus
        const ordersByStatus = { labels: [], values: [] };
        (statusCounts || []).forEach(row => {
            ordersByStatus.labels.push(row.status || 'unknown');
            ordersByStatus.values.push(Number(row.count));
        });

        // Build messagesOverTime (last 7 days, fill missing days with 0)
        const messagesOverTime = {};
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            messagesOverTime[d.toISOString().split('T')[0]] = 0;
        }
        (dailyCounts || []).forEach(row => {
            const dateStr = row.date instanceof Date
                ? row.date.toISOString().split('T')[0]
                : String(row.date).split('T')[0];
            if (messagesOverTime.hasOwnProperty(dateStr)) {
                messagesOverTime[dateStr] = Number(row.count);
            }
        });

        const analytics = {
            messagesByType,
            ordersByStatus,
            messagesOverTime
        };
        res.json({ success: true, analytics });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ===================================
// Settings Endpoints
// ===================================

// Get global settings (e.g. Abandoned Cart Delays)
router.get('/settings', verifyToken, async (req, res) => {
    try {
        const firstDelay = await Settings.get('abandoned_cart_first_delay_hours', 1);
        const secondDelay = await Settings.get('abandoned_cart_second_delay_hours', 24);
        const autoTemplateSending = await Settings.get('auto_template_sending', 'false');

        res.json({
            success: true,
            settings: {
                abandoned_cart_first_delay_hours: Number(firstDelay),
                abandoned_cart_second_delay_hours: Number(secondDelay),
                auto_template_sending: String(autoTemplateSending) === 'true'
            }
        });
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Update global settings
router.post('/settings', verifyToken, async (req, res) => {
    try {
        const { abandoned_cart_first_delay_hours, abandoned_cart_second_delay_hours, auto_template_sending } = req.body;

        // Basic validation
        if (abandoned_cart_first_delay_hours !== undefined) {
            await Settings.set('abandoned_cart_first_delay_hours', Number(abandoned_cart_first_delay_hours));
        }

        if (abandoned_cart_second_delay_hours !== undefined) {
            await Settings.set('abandoned_cart_second_delay_hours', Number(abandoned_cart_second_delay_hours));
        }

        if (auto_template_sending !== undefined) {
            await Settings.set('auto_template_sending', auto_template_sending ? 'true' : 'false');
        }

        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Helper functions (Safe for Turso & Supabase)
async function getMessageCount() {
    const rows = await dbAdapter.query('SELECT COUNT(*) as count FROM messages');
    return rows[0]?.count || 0;
}

async function getActiveTodayCount() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rows = await dbAdapter.query('SELECT COUNT(DISTINCT customer_phone) as count FROM messages WHERE created_at >= ?', [today.toISOString()]);
    return rows[0]?.count || 0;
}

async function calculateGrowth(table) {
    try {
        const now = new Date();
        const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        const thisWk = await dbAdapter.query(`SELECT COUNT(*) as count FROM ${table} WHERE created_at >= ?`, [lastWeek.toISOString()]);
        const prevWk = await dbAdapter.query(`SELECT COUNT(*) as count FROM ${table} WHERE created_at >= ? AND created_at < ?`, [twoWeeksAgo.toISOString(), lastWeek.toISOString()]);
        const prevWkCount = prevWk[0]?.count || 0;
        if (!prevWkCount) return 0;
        return Math.round(((thisWk[0].count - prevWkCount) / prevWkCount) * 100);
    } catch (error) {
        return 0;
    }
}

async function getMessageVolume() {
    const labels = [];
    const values = [];
    const today = new Date();

    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        labels.push(date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);

        const rows = await dbAdapter.query('SELECT COUNT(*) as count FROM messages WHERE created_at >= ? AND created_at < ?', [date.toISOString(), nextDay.toISOString()]);
        values.push(rows[0]?.count || 0);
    }
    return { labels, values };
}

async function getOrderStatusDistribution() {
    // Use SQL aggregation instead of loading ALL orders into memory
    const rows = await dbAdapter.query(
        'SELECT status, COUNT(*) as count FROM orders GROUP BY status'
    );

    const labels = [];
    const values = [];
    (rows || []).forEach(row => {
        labels.push(row.status || 'unknown');
        values.push(Number(row.count));
    });

    return { labels, values };
}

async function getCustomerGrowth() {
    const labels = [];
    const values = [];
    const today = new Date();

    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        labels.push(date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));

        const rows = await dbAdapter.query('SELECT COUNT(*) as count FROM customers WHERE created_at <= ?', [date.toISOString()]);
        values.push(rows[0]?.count || 0);
    }
    return { labels, values };
}

// ===================================
// Templates CRUD Endpoints
// ===================================

router.get('/templates', verifyToken, async (req, res) => {
    try {
        await ensureTemplatesTable();
        const templates = await dbAdapter.query('SELECT * FROM templates ORDER BY updated_at DESC');
        res.json({ success: true, templates: templates || [] });
    } catch (error) {
        console.error('Templates fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});

// Sync templates from Meta
router.get('/templates/sync', verifyToken, async (req, res) => {
    try {
        const whatsappService = require('../services/whatsappService');
        const metaResponse = await whatsappService.getTemplates();
        const metaTemplates = metaResponse.data || [];

        console.log(`[TEMPLATES] Fetched ${metaTemplates.length} templates from Meta:`);
        metaTemplates.forEach((t, idx) => {
            console.log(`  ${idx + 1}. ${t.name} [${t.status}] [${t.language}] [${t.category}]`);
        });

        await ensureTemplatesTable();
        
        // Filter to only sync APPROVED templates (skip DRAFT, PENDING, REJECTED)
        const approvedTemplates = metaTemplates.filter(t => t.status === 'APPROVED');
        console.log(`[TEMPLATES] Filtering to APPROVED only: ${approvedTemplates.length} of ${metaTemplates.length}`);
        
        let syncedCount = 0;
        for (const t of approvedTemplates) {
            // Extract components
            const bodyComponent = t.components?.find(c => c.type === 'BODY');
            const headerComponent = t.components?.find(c => c.type === 'HEADER');
            const footerComponent = t.components?.find(c => c.type === 'FOOTER');
            const buttonsComponent = t.components?.find(c => c.type === 'BUTTONS');
            
            // Count variables in body text
            const bodyText = bodyComponent?.text || '';
            const variablesCount = (bodyText.match(/\{\{\d+\}\}/g) || []).length;
            
            // Get rejection reason if rejected
            let rejectionReason = null;
            if (t.status === 'REJECTED') {
                rejectionReason = t.error_reason || 'Meta policy violation';
            }
            
            // Upsert logic with enhanced component data
            const existing = await dbAdapter.query('SELECT id FROM templates WHERE name = ?', [t.name]);
            if (existing && existing.length > 0) {
                await dbAdapter.query(
                    `UPDATE templates SET 
                        category=?, status=?, language=?, body=?, header=?, footer=?, 
                        buttons=?, components=?, variables_count=?, rejection_reason=?, updated_at=? 
                    WHERE name=?`,
                    [
                        t.category, 
                        t.status, 
                        t.language, 
                        bodyText,
                        headerComponent?.text || headerComponent?.format || '',
                        footerComponent?.text || '',
                        JSON.stringify(buttonsComponent?.buttons || []),
                        JSON.stringify(t.components),
                        variablesCount,
                        rejectionReason,
                        new Date().toISOString(), 
                        t.name
                    ]
                );
            } else {
                await dbAdapter.query(
                    `INSERT INTO templates (
                        id, name, category, status, language, body, header, footer, 
                        buttons, components, variables_count, rejection_reason, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        t.id || `meta_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, 
                        t.name, 
                        t.category, 
                        t.status, 
                        t.language, 
                        bodyText,
                        headerComponent?.text || headerComponent?.format || '',
                        footerComponent?.text || '',
                        JSON.stringify(buttonsComponent?.buttons || []),
                        JSON.stringify(t.components),
                        variablesCount,
                        rejectionReason,
                        new Date().toISOString()
                    ]
                );
            }
            syncedCount++;
        }
        
        // Clear old templates that are no longer in Meta (sync cleanup)
        const templateNames = approvedTemplates.map(t => t.name);
        if (templateNames.length > 0) {
            const placeholders = templateNames.map(() => '?').join(',');
            await dbAdapter.query(
                `DELETE FROM templates WHERE name NOT IN (${placeholders})`,
                templateNames
            );
            console.log(`[TEMPLATES] Cleaned up old templates not in Meta account`);
        }
        
        // Invalidate cache after template changes
        invalidateCache('stats');

        res.json({ 
            success: true, 
            count: syncedCount,
            totalFetched: metaTemplates.length,
            approvedOnly: approvedTemplates.length,
            message: `Successfully synced ${syncedCount} APPROVED templates from Meta` 
        });
    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({ error: 'Failed to sync templates from Meta', details: error.message });
    }
});

async function ensureTemplatesTable() {
    // First ensure table exists
    await dbAdapter.query(`
        CREATE TABLE IF NOT EXISTS templates (
            id TEXT PRIMARY KEY,
            name TEXT,
            category TEXT,
            status TEXT,
            language TEXT,
            body TEXT,
            header TEXT,
            footer TEXT,
            buttons TEXT,
            components TEXT,
            variables_count INTEGER DEFAULT 0,
            rejection_reason TEXT,
            image_url TEXT,
            updated_at TEXT
        )
    `);

    // Defensively add new columns if they don't exist
    const columns = [
        { name: 'status', type: 'TEXT' },
        { name: 'language', type: 'TEXT' },
        { name: 'components', type: 'TEXT' },
        { name: 'header', type: 'TEXT' },
        { name: 'footer', type: 'TEXT' },
        { name: 'buttons', type: 'TEXT' },
        { name: 'variables_count', type: 'INTEGER DEFAULT 0' },
        { name: 'rejection_reason', type: 'TEXT' }
    ];

    for (const col of columns) {
        try {
            await dbAdapter.query(`ALTER TABLE templates ADD COLUMN ${col.name} ${col.type}`);
            console.log(`✅ Added column ${col.name} to templates table`);
        } catch (err) {
            // Ignore error if column already exists
            if (!err.message.includes('duplicate column name') && 
                !err.message.includes('SQLITE_ERROR')) {
                console.log(`ℹ️ Column ${col.name} might already exist: ${err.message}`);
            }
        }
    }
}

// Create new template and submit to Meta
router.post('/templates/create', verifyToken, async (req, res) => {
    try {
        const { 
            name, category, language, headerType, headerText, headerImageUrl,
            body, footer, buttons, exampleValues 
        } = req.body;
        
        // Validate template name
        if (!name || !/^[a-z0-9_]+$/.test(name)) {
            return res.status(400).json({ 
                error: 'Template name must contain only lowercase letters, numbers, and underscores' 
            });
        }
        
        if (name.length > 512) {
            return res.status(400).json({ error: 'Template name must be 512 characters or less' });
        }
        
        // Build template components
        const components = [];
        
        // Add header if present
        if (headerType !== 'NONE') {
            if (headerType === 'TEXT') {
                if (!headerText) {
                    return res.status(400).json({ error: 'Header text is required for TEXT header type' });
                }
                components.push({
                    type: 'HEADER',
                    format: 'TEXT',
                    text: headerText
                });
            } else if (headerType === 'IMAGE') {
                if (!headerImageUrl) {
                    return res.status(400).json({ error: 'Image URL is required for IMAGE header type' });
                }
                components.push({
                    type: 'HEADER',
                    format: 'IMAGE',
                    example: {
                        header_handle: [headerImageUrl]
                    }
                });
            }
        }
        
        // Validate body
        if (!body) {
            return res.status(400).json({ error: 'Body content is required' });
        }
        
        // Add body with examples
        const bodyComponent = {
            type: 'BODY',
            text: body
        };
        
        if (exampleValues && Array.isArray(exampleValues)) {
            bodyComponent.example = {
                body_text: [exampleValues]
            };
        }
        
        components.push(bodyComponent);
        
        // Add footer if present
        if (footer && footer.trim()) {
            components.push({
                type: 'FOOTER',
                text: footer
            });
        }
        
        // Add buttons if present
        if (buttons && buttons.length > 0) {
            if (buttons.length > 3) {
                return res.status(400).json({ error: 'Maximum 3 buttons allowed' });
            }
            
            components.push({
                type: 'BUTTONS',
                buttons: buttons.map(btn => ({
                    type: 'QUICK_REPLY',
                    text: btn.text.substring(0, 25) // Meta limit is 25 chars
                }))
            });
        }
        
        // Submit to Meta API
        const whatsappService = require('../services/whatsappService');
        const axios = require('axios');
        const response = await axios.post(
            `${whatsappService.wabaBaseURL}/message_templates`,
            {
                name,
                language,
                category,
                components
            },
            {
                headers: {
                    'Authorization': `Bearer ${whatsappService.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        // Save to local DB with PENDING status
        await dbAdapter.query(
            `INSERT INTO templates (id, name, category, status, language, body, header, footer, buttons, components, variables_count, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                response.data.id || `tpl_${Date.now()}`,
                name,
                category,
                'PENDING',
                language,
                body,
                headerText || '',
                footer || '',
                JSON.stringify(buttons),
                JSON.stringify(components),
                (body.match(/\{\{\d+\}\}/g) || []).length,
                new Date().toISOString()
            ]
        );
        
        res.json({ 
            success: true, 
            templateId: response.data.id,
            message: 'Template submitted to Meta for approval. Approval usually takes 24-48 hours.' 
        });
        
    } catch (error) {
        console.error('Template creation error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to create template',
            details: error.response?.data?.error?.message || error.message
        });
    }
});

// Check template approval status
router.get('/templates/:id/status', verifyToken, async (req, res) => {
    try {
        const whatsappService = require('../services/whatsappService');
        const axios = require('axios');
        const response = await axios.get(
            `${whatsappService.wabaBaseURL}/message_templates/${req.params.id}`,
            {
                headers: { 'Authorization': `Bearer ${whatsappService.accessToken}` }
            }
        );
        
        // Update local DB
        const template = response.data;
        let rejectionReason = null;
        if (template.status === 'REJECTED') {
            rejectionReason = template.error_reason || 'Meta policy violation';
        }
        
        await dbAdapter.query(
            'UPDATE templates SET status = ?, rejection_reason = ?, updated_at = ? WHERE id = ?',
            [template.status, rejectionReason, new Date().toISOString(), req.params.id]
        );
        
        res.json({ success: true, status: template.status, rejection_reason: rejectionReason });
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ error: 'Failed to check template status' });
    }
});

// Delete template
router.delete('/templates/:id', verifyToken, async (req, res) => {
    try {
        const whatsappService = require('../services/whatsappService');
        const axios = require('axios');
        
        // Try to delete from Meta first
        try {
            await axios.delete(
                `${whatsappService.wabaBaseURL}/message_templates/${req.params.id}`,
                {
                    headers: { 'Authorization': `Bearer ${whatsappService.accessToken}` }
                }
            );
        } catch (metaError) {
            console.warn('Meta deletion failed, removing from local DB only:', metaError.message);
        }
        
        // Delete from local DB
        await dbAdapter.query('DELETE FROM templates WHERE id = ?', [req.params.id]);
        
        invalidateCache('stats');
        
        res.json({ success: true, message: 'Template deleted successfully' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

async function ensureAutomationTable() {
    await dbAdapter.query(`
        CREATE TABLE IF NOT EXISTS automation_config (
            id TEXT PRIMARY KEY,
            type TEXT,
            key TEXT UNIQUE,
            content TEXT,
            description TEXT,
            updated_at TEXT
        )
    `);

    // Defensively add description column if it doesn't exist (for existing tables)
    try {
        await dbAdapter.query(`ALTER TABLE automation_config ADD COLUMN description TEXT`);
        console.log('✅ Added column description to automation_config');
    } catch (err) {
        // Likely already exists
    }
}



// Sync customers from Shiprocket
router.post('/shiprocket/sync', verifyToken, async (req, res) => {
    try {
        const shiprocketService = require('../services/shiprocketService');
        const count = await shiprocketService.syncAllCustomers();
        console.log('Shiprocket sync successful, count:', count);
        res.json({ success: true, count });
    } catch (error) {
        console.error('Shiprocket sync error:', error);
        res.status(500).json({ error: 'Failed to sync customers from Shiprocket' });
    }
});

// New: Sync customers from Shopify
router.post('/shopify/sync', verifyToken, async (req, res) => {
    try {
        const shopifyService = require('../services/shopifyService');
        const count = await shopifyService.syncAllCustomers();
        console.log('Shopify sync successful, count:', count);
        res.json({ success: true, count });
    } catch (error) {
        console.error('Shopify sync error:', error);
        res.status(500).json({ error: 'Failed to sync customers from Shopify' });
    }
});

// New: Unified sync (Supabase + Shopify + Shiprocket)
router.post('/sync/all', verifyToken, async (req, res) => {
    try {
        const shopifyService = require('../services/shopifyService');
        const shiprocketService = require('../services/shiprocketService');

        console.log('🔄 Starting Unified Background Sync...');
        
        // Start sync in background
        // We don't 'await' these so we can return response immediately
        const runBackgroundSync = async () => {
            try {
                let shopifyCount = 0;
                let shiprocketCount = 0;
                let supabaseCount = 0;

                // 1. Shopify (Only if configured)
                if (process.env.SHOPIFY_STORE && process.env.SHOPIFY_ACCESS_TOKEN) {
                    try {
                        shopifyCount = await shopifyService.syncAllCustomers();
                        console.log(`✅ Shopify background sync finished: ${shopifyCount}`);
                    } catch (e) { console.error('Shopify background sync failed:', e.message); }
                } else {
                    console.log('ℹ️ Shopify credentials missing, skipping Shopify sync.');
                }

                // 2. Shiprocket (Disabled customer sync as we rely on Shopify for the 7000+ records)
                /*
                try {
                    shiprocketCount = await shiprocketService.syncAllCustomers();
                    console.log(`✅ Shiprocket background sync finished: ${shiprocketCount}`);
                } catch (e) { console.error('Shiprocket background sync failed:', e.message); }
                */

                console.log(`🏁 Unified Background Sync Completed (Shopify Source).`);
            } catch (err) {
                console.error('Unified background sync error:', err);
            }
        };

        // Trigger background task
        runBackgroundSync();

        // Return immediately
        res.json({ 
            success: true, 
            message: 'Synchronization started in background. Data will appear shortly.',
            status: 'processing'
        });
    } catch (error) {
        console.error('Unified sync start error:', error);
        res.status(500).json({ error: 'Failed to start synchronization' });
    }
});

// Get customer segments
router.get('/customers/segments', verifyToken, async (req, res) => {
    try {
        // Check cache first
        const cached = getCached('customer_segments');
        if (cached) {
            return res.json(cached);
        }

        // Optimized query using pre-calculated order_count column
        const sql = `
            SELECT c.phone, c.order_count, c.created_at, 
                MAX(o.order_date) as last_order_at
            FROM customers c
            LEFT JOIN orders o ON c.phone = o.customer_phone
            GROUP BY c.phone, c.order_count, c.created_at
        `;
        const customers = await dbAdapter.query(sql);
        
        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

        const segments = {
            total: customers.length,
            one_time: customers.filter(c => c.order_count === 1).length,
            repeat: customers.filter(c => c.order_count > 1).length,
            vip: customers.filter(c => c.order_count >= 5).length,
            inactive: customers.filter(c => {
                const lastOrderDate = c.last_order_at ? new Date(c.last_order_at) : null;
                const joinedDate = new Date(c.created_at);
                
                if (lastOrderDate) {
                    // Has ordered before: inactive if last order > 60 days ago
                    return lastOrderDate < sixtyDaysAgo;
                } else {
                    // Never ordered: inactive if joined > 60 days ago
                    return joinedDate < sixtyDaysAgo;
                }
            }).length
        };

        const response = { success: true, segments };
        
        // Cache the response
        setCache('customer_segments', response, 'stats', 5 * 60 * 1000); // 5 minutes TTL
        
        res.json(response);
    } catch (error) {
        console.error('Fetch segments error:', error);
        res.status(500).json({ error: 'Failed to fetch customer segments' });
    }
});



router.post('/templates', verifyToken, async (req, res) => {
    try {
        const { id, name, category, body, image_url, updated_at } = req.body;
        await dbAdapter.query(`
            CREATE TABLE IF NOT EXISTS templates (
                id TEXT PRIMARY KEY,
                name TEXT,
                category TEXT,
                body TEXT,
                image_url TEXT,
                updated_at TEXT
            )
        `);
        await dbAdapter.query(
            `INSERT INTO templates (id, name, category, body, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, name, category, body, image_url || '', updated_at || new Date().toISOString()]
        );
        
        // Invalidate cache after template creation
        invalidateCache('stats');
        res.json({ success: true });
    } catch (error) {
        console.error('Template create error:', error);
        res.status(500).json({ error: 'Failed to create template' });
    }
});

router.put('/templates/:id', verifyToken, async (req, res) => {
    try {
        const { name, category, body, image_url, updated_at } = req.body;
        await dbAdapter.query(
            `UPDATE templates SET name=?, category=?, body=?, image_url=?, updated_at=? WHERE id=?`,
            [name, category, body, image_url || '', updated_at || new Date().toISOString(), req.params.id]
        );
        
        // Invalidate cache after template update
        invalidateCache('stats');
        res.json({ success: true });
    } catch (error) {
        console.error('Template update error:', error);
        res.status(500).json({ error: 'Failed to update template' });
    }
});

router.delete('/templates/:id', verifyToken, async (req, res) => {
    try {
        await dbAdapter.query('DELETE FROM templates WHERE id=?', [req.params.id]);
        
        // Invalidate cache after template deletion
        invalidateCache('stats');
        res.json({ success: true });
    } catch (error) {
        console.error('Template delete error:', error);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});



// ===================================
// Settings Routes
// ===================================

// GET /api/admin/settings — return current abandoned cart delay settings
router.get('/settings', verifyToken, async (req, res) => {
    try {
        const [firstDelay, secondDelay] = await Promise.all([
            Settings.get('abandoned_cart_first_delay_hours', 1),
            Settings.get('abandoned_cart_second_delay_hours', 24)
        ]);

        res.json({
            success: true,
            settings: {
                abandoned_cart_first_delay_hours: firstDelay,
                abandoned_cart_second_delay_hours: secondDelay
            }
        });
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch settings' });
    }
});

// POST /api/admin/settings — update abandoned cart delay settings
router.post('/settings', verifyToken, async (req, res) => {
    try {
        const { abandoned_cart_first_delay_hours, abandoned_cart_second_delay_hours } = req.body;

        const firstDelay = parseFloat(abandoned_cart_first_delay_hours);
        const secondDelay = parseFloat(abandoned_cart_second_delay_hours);

        if (isNaN(firstDelay) || isNaN(secondDelay) || firstDelay < 0 || secondDelay < 0) {
            return res.status(400).json({ success: false, error: 'Invalid delay values. Must be numbers >= 0.' });
        }

        const [ok1, ok2] = await Promise.all([
            Settings.set('abandoned_cart_first_delay_hours', firstDelay),
            Settings.set('abandoned_cart_second_delay_hours', secondDelay)
        ]);

        if (!ok1 || !ok2) {
            return res.status(500).json({ success: false, error: 'Failed to save one or more settings' });
        }

        res.json({
            success: true,
            message: 'Settings saved successfully',
            settings: {
                abandoned_cart_first_delay_hours: firstDelay,
                abandoned_cart_second_delay_hours: secondDelay
            }
        });
    } catch (error) {
        console.error('Error saving settings:', error);
        res.status(500).json({ success: false, error: 'Server error saving settings' });
    }
});

// ===================================
// Support Tickets Endpoints
// ===================================
// Cache Intl.DateTimeFormat per timezone — each instance allocates native ICU memory
// outside the V8 heap, so creating one per ticket bloats RSS without showing in heap stats
const timeFormatterCache = new Map();
function getTimeFormatter(timezone) {
    let fmt = timeFormatterCache.get(timezone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit' });
        timeFormatterCache.set(timezone, fmt);
    }
    return fmt;
}

// Helper to check if a ticket's created time falls within portal time range (for admin)
function isTicketInTimeRangeForAdmin(ticket, config) {
    if (!config || !config.time_start || !config.time_end) return true;

    const createdAt = new Date(ticket.created_at);
    const timezone = config.timezone || 'Asia/Kolkata';

    // Convert to target timezone using the cached formatter
    const timeStr = getTimeFormatter(timezone).format(createdAt);
    const [hour, minute] = timeStr.split(':').map(Number);
    const ticketMinutes = hour * 60 + minute;

    const [startHour, startMin] = config.time_start.split(':').map(Number);
    const [endHour, endMin] = config.time_end.split(':').map(Number);
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    let inRange;
    if (startMinutes <= endMinutes) {
        // Normal range (e.g., 06:00 to 18:00)
        inRange = ticketMinutes >= startMinutes && ticketMinutes < endMinutes;
    } else {
        // Overnight range (e.g., 18:00 to 06:00)
        inRange = ticketMinutes >= startMinutes || ticketMinutes < endMinutes;
    }
    
    // Debug first 3 tickets only
    if (global._debugTicketCount === undefined) global._debugTicketCount = 0;
    if (global._debugTicketCount < 3) {
        console.log(`   🎫 Ticket ${ticket.id} (${ticket.created_at}):`);
        console.log(`      UTC: ${createdAt.toISOString()}`);
        console.log(`      ${timezone}: ${timeStr} (${ticketMinutes} minutes)`);
        console.log(`      Range: ${config.time_start}-${config.time_end} (${startMinutes}-${endMinutes} minutes)`);
        console.log(`      Match: ${inRange}`);
        global._debugTicketCount++;
    }
    
    return inRange;
}

// Build a Postgres WHERE fragment matching tickets whose created_at (stored as UTC) falls
// within a time-based portal's IST time-of-day window. Returns null when the config has no
// range. Bounds are validated integers and the timezone is whitelisted, so inlining is
// injection-safe. Mirrors the JS logic in isTicketInTimeRangeForAdmin but runs in the DB so
// counts/queries cover every matching ticket without loading the whole table into memory.
function timeRangeSqlClause(config, col = 'created_at') {
    if (!config || !config.time_start || !config.time_end) return null;
    const tz = /^[A-Za-z0-9_+\-/]+$/.test(config.timezone || '') ? config.timezone : 'Asia/Kolkata';
    const [sh, sm] = String(config.time_start).split(':').map(Number);
    const [eh, em] = String(config.time_end).split(':').map(Number);
    if ([sh, sm, eh, em].some(n => !Number.isFinite(n))) return null;
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const local = `(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${tz}')`;
    const mins = `(EXTRACT(HOUR FROM ${local}) * 60 + EXTRACT(MINUTE FROM ${local}))`;
    return start <= end
        ? `${mins} >= ${start} AND ${mins} < ${end}`
        : `(${mins} >= ${start} OR ${mins} < ${end})`;
}

router.get('/support-tickets', verifyToken, async (req, res) => {
    try {
        const { status, is_read, date_from, date_to, time_from, time_to, search, portal, sort, urgent, urgent_filter } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const offset = (page - 1) * limit;

        // Urgent keywords live in the client's localStorage, so they arrive as a
        // comma-separated list and are matched in SQL (bounded to avoid huge queries)
        const urgentKeywords = String(urgent || '')
            .split(',').map(k => k.trim()).filter(k => k && k.length <= 50).slice(0, 20);

        // Get all portals to resolve portal names (manual/auto own tickets via portal_id;
        // time-based portals match tickets dynamically by their created time)
        const allPortalsForNames = await dbAdapter.query(
            "SELECT id, name, type, config FROM support_portals"
        );
        const portalNameById = {};
        allPortalsForNames.forEach(p => { portalNameById[p.id] = p.name; });
        // Pre-parse time-based portal configs once (not per ticket)
        const timeBasedPortals = allPortalsForNames
            .filter(p => p.type === 'time_based')
            .map(p => {
                try {
                    const config = typeof p.config === 'string' ? JSON.parse(p.config) : p.config;
                    return (config && config.time_start && config.time_end) ? { id: p.id, name: p.name, config } : null;
                } catch (e) {
                    console.error(` Error parsing config for portal ${p.name}:`, e);
                    return null;
                }
            })
            .filter(Boolean);

        // All filtering happens in SQL so we only ever pull one small page of rows
        const conditions = [];
        const params = [];

        if (status) {
            conditions.push('status = ?');
            params.push(status);
        }

        if (is_read !== undefined) {
            conditions.push('is_read = ?');
            params.push(is_read === 'true');
        }

        if (date_from) {
            conditions.push('created_at::date >= ?::date');
            params.push(date_from);
        }

        if (date_to) {
            conditions.push('created_at::date <= ?::date');
            params.push(date_to);
        }

        if (time_from) {
            conditions.push('created_at::time >= ?::time');
            params.push(time_from);
        }

        if (time_to) {
            conditions.push('created_at::time <= ?::time');
            params.push(time_to);
        }

        if (search && String(search).trim()) {
            const like = `%${String(search).trim()}%`;
            conditions.push('(ticket_number ILIKE ? OR customer_name ILIKE ? OR customer_phone ILIKE ? OR message ILIKE ?)');
            params.push(like, like, like, like);
        }

        if (portal === 'unassigned') {
            const timeClauses = timeBasedPortals
                .map(p => timeRangeSqlClause(p.config))
                .filter(Boolean);
            conditions.push(timeClauses.length
                ? `portal_id IS NULL AND NOT (${timeClauses.join(' OR ')})`
                : 'portal_id IS NULL');
        } else if (portal) {
            const pid = parseInt(portal, 10);
            if (Number.isFinite(pid)) {
                const tb = timeBasedPortals.find(p => p.id === pid);
                const timeClause = tb ? timeRangeSqlClause(tb.config) : null;
                if (timeClause) {
                    // Explicit assignment wins; otherwise match the portal's IST time window
                    conditions.push(`(portal_id = ? OR (portal_id IS NULL AND ${timeClause}))`);
                } else {
                    conditions.push('portal_id = ?');
                }
                params.push(pid);
            }
        }

        // Urgent keywords arrive regardless of whether the urgent filter is on —
        // they feed the "urgent" stat card, and filter the list only when urgent_filter=1
        const urgentActive = urgent_filter === '1' || urgent_filter === 'true';
        let urgentClause = null;
        const urgentParams = urgentKeywords.map(k => `%${k}%`);
        if (urgentKeywords.length) {
            urgentClause = '(' + urgentKeywords.map(() => 'message ILIKE ?').join(' OR ') + ')';
            if (urgentActive) {
                conditions.push(urgentClause);
                params.push(...urgentParams);
            }
        }

        const whereSql = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
        const orderSql = sort === 'oldest' ? 'created_at ASC, id ASC' : 'created_at DESC, id DESC';

        // Slim column set — message is truncated to a preview; the chat view loads
        // the full conversation separately. Keeps each page well under the response cap.
        const buildDataSql = (withOrderId) => `SELECT id, ticket_number, customer_phone, customer_name,
                LEFT(message, 600) AS message, status, is_read, portal_id, sentiment,
                ai_scenario, ai_confidence, source${withOrderId ? ', order_id' : ''}, created_at, updated_at
            FROM support_tickets${whereSql}
            ORDER BY ${orderSql}
            LIMIT ? OFFSET ?`;

        // Stat cards in one aggregation scan over the same filtered set
        const statsSql = `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_read = false)::int AS unread,
                COUNT(*) FILTER (WHERE status = 'open')::int AS open,
                COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                COUNT(*) FILTER (WHERE ${urgentClause || 'false'})::int AS urgent
            FROM support_tickets${whereSql}`;

        let tickets;
        let statsRow;
        const statsParams = urgentClause ? [...params, ...urgentParams] : params;
        try {
            const [dataRows, statsRows] = await Promise.all([
                dbAdapter.query(buildDataSql(true), [...params, limit, offset]),
                dbAdapter.query(statsSql, statsParams)
            ]);
            tickets = dataRows;
            statsRow = statsRows[0] || {};
        } catch (err) {
            // order_id may not exist on older schemas — retry without it
            if (!/order_id/.test(err.message || '')) throw err;
            const [dataRows, statsRows] = await Promise.all([
                dbAdapter.query(buildDataSql(false), [...params, limit, offset]),
                dbAdapter.query(statsSql, statsParams)
            ]);
            tickets = dataRows;
            statsRow = statsRows[0] || {};
        }

        // Enrich only this page with portal information (explicit portal_id from
        // manual/auto assignment wins; otherwise the first matching time-based portal)
        tickets.forEach(ticket => {
            if (ticket.portal_id) {
                ticket.portal_name = portalNameById[ticket.portal_id] || null;
                return;
            }
            for (const p of timeBasedPortals) {
                if (isTicketInTimeRangeForAdmin(ticket, p.config)) {
                    ticket.portal_id = p.id;
                    ticket.portal_name = p.name;
                    return;
                }
            }
        });

        res.json({
            success: true,
            tickets,
            meta: {
                total: statsRow.total || 0,
                unread: statsRow.unread || 0,
                open: statsRow.open || 0,
                resolved: statsRow.resolved || 0,
                urgent: statsRow.urgent || 0,
                page,
                limit,
                has_more: offset + tickets.length < (statsRow.total || 0)
            }
        });
    } catch (error) {
        console.error('Error fetching support tickets:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch support tickets' });
    }
});

router.put('/support-tickets/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, is_read } = req.body;

        if (!status && is_read === undefined) {
            return res.status(400).json({ success: false, error: 'Status or is_read is required' });
        }

        const updates = [];
        const params = [];

        if (status) {
            updates.push('status = ?');
            params.push(status);
        }

        if (is_read !== undefined) {
            updates.push('is_read = ?');
            params.push(!!is_read);
        }

        params.push(id);

        await dbAdapter.query(
            `UPDATE support_tickets SET ${updates.join(', ')} WHERE id = ?`,
            params
        );
        
        // If status changed, update the portal's assigned_count
        if (status) {
            const ticket = await dbAdapter.query(
                'SELECT portal_id FROM support_tickets WHERE id = ?',
                [id]
            );
            
            if (ticket[0]?.portal_id) {
                const countResult = await dbAdapter.query(
                    'SELECT COUNT(*) as count FROM support_tickets WHERE portal_id = ? AND status = \'open\'',
                    [ticket[0].portal_id]
                );
                const newCount = countResult[0]?.count || 0;
                await dbAdapter.run(
                    'UPDATE support_portals SET assigned_count = ? WHERE id = ?',
                    [newCount, ticket[0].portal_id]
                );
            }
        }
        
        // Invalidate cache after ticket status change
        invalidateCache('stats');

        // Outcome signal for AI learning: resolved ticket → recent examples from
        // this customer's conversation worked (fire-and-forget)
        if (status === 'resolved' || status === 'closed') {
            const resolvedTicket = await dbAdapter.query('SELECT customer_phone FROM support_tickets WHERE id = ?', [id]);
            if (resolvedTicket[0]?.customer_phone) {
                const aiLearning = require('../services/ai/learning');
                aiLearning.boostFromResolvedTicket(resolvedTicket[0].customer_phone).catch(() => {});
            }
        }

        res.json({ success: true, message: 'Ticket updated successfully' });
    } catch (error) {
        console.error('Error updating support ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to update support ticket' });
    }
});

// Mark ticket as read
router.patch('/support-tickets/:id/mark-read', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        await dbAdapter.query(
            `UPDATE support_tickets SET is_read = true WHERE id = ?`,
            [id]
        );

        res.json({ success: true, message: 'Ticket marked as read' });
    } catch (error) {
        console.error('Error marking ticket as read:', error);
        res.status(500).json({ success: false, error: 'Failed to mark ticket as read' });
    }
});

// Bulk mark tickets as read
router.patch('/support-tickets/bulk/mark-read', verifyToken, async (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Ticket IDs are required' });
        }

        const placeholders = ids.map(() => '?').join(',');
        await dbAdapter.query(
            `UPDATE support_tickets SET is_read = true WHERE id IN (${placeholders})`,
            ids
        );

        res.json({ success: true, message: `${ids.length} tickets marked as read` });
    } catch (error) {
        console.error('Error bulk marking tickets as read:', error);
        res.status(500).json({ success: false, error: 'Failed to bulk mark tickets as read' });
    }
});

// Assign single ticket to a portal
router.post('/support-tickets/:id/assign-portal', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { portalId } = req.body;

        // portalId can be null to remove assignment
        await dbAdapter.run(
            `UPDATE support_tickets SET portal_id = ? WHERE id = ?`,
            [portalId || null, id]
        );

        invalidateCache('stats');
        res.json({ 
            success: true, 
            message: portalId ? 'Ticket assigned to portal' : 'Ticket removed from portal'
        });
    } catch (error) {
        console.error('Error assigning ticket to portal:', error);
        res.status(500).json({ success: false, error: 'Failed to assign ticket to portal' });
    }
});

// Delete single support ticket
router.delete('/support-tickets/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Get ticket's portal_id before deletion
        const ticket = await dbAdapter.query(
            'SELECT portal_id FROM support_tickets WHERE id = ?',
            [id]
        );

        await dbAdapter.query(
            `DELETE FROM support_tickets WHERE id = ?`,
            [id]
        );
        
        // Update portal's assigned_count if ticket was assigned
        if (ticket[0]?.portal_id) {
            const countResult = await dbAdapter.query(
                'SELECT COUNT(*) as count FROM support_tickets WHERE portal_id = ? AND status = \'open\'',
                [ticket[0].portal_id]
            );
            const newCount = countResult[0]?.count || 0;
            await dbAdapter.run(
                'UPDATE support_portals SET assigned_count = ? WHERE id = ?',
                [newCount, ticket[0].portal_id]
            );
        }
        
        // Invalidate cache after ticket deletion
        invalidateCache('stats');

        res.json({ success: true, message: 'Ticket deleted successfully' });
    } catch (error) {
        console.error('Error deleting support ticket:', error);
        res.status(500).json({ success: false, error: 'Failed to delete support ticket' });
    }
});

// Bulk delete support tickets
router.delete('/support-tickets/bulk/delete', verifyToken, async (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Ticket IDs are required' });
        }

        // Create placeholders for the IN clause
        const placeholders = ids.map(() => '?').join(',');
        await dbAdapter.query(
            `DELETE FROM support_tickets WHERE id IN (${placeholders})`,
            ids
        );

        // Invalidate cache after bulk ticket deletion
        invalidateCache('stats');

        res.json({ success: true, message: `${ids.length} ticket(s) deleted successfully` });
    } catch (error) {
        console.error('Error bulk deleting support tickets:', error);
        res.status(500).json({ success: false, error: 'Failed to delete tickets' });
    }
});

// ===================================
// Shopper Hub Endpoints
// ===================================

// Get all shoppers with filtering and segmentation (Enhanced with Order details)
router.get('/shoppers', verifyToken, async (req, res) => {
    try {
        let { limit = 100, offset = 0, status, search, startDate, endDate, orderIdFrom, orderIdTo, paymentMethod, deliveryType, sortBy, noLimit } = req.query;
        
        // ENFORCE LIMITS to prevent memory overload
        // noLimit=true raises ceiling to 2000 for export use cases (single-day downloads)
        if (noLimit && noLimit === 'true') {
            const requestedLimit = parseInt(req.query.limit);
            limit = (requestedLimit && requestedLimit > 0 && requestedLimit <= 2000) ? requestedLimit : 2000;
        } else {
            limit = Math.min(parseInt(limit), 500); // Max 500 records per request
        }
        offset = Math.max(0, parseInt(offset));
        
        // CACHE for list queries without search
        // NOTE: cache key MUST include every filter param, otherwise a filtered
        // request collides with an earlier unfiltered response (filter appears broken)
        const cacheKey = `shoppers_list:${limit}:${offset}:${status || 'all'}:${search || 'none'}:${startDate || 'none'}:${endDate || 'none'}:${orderIdFrom || 'none'}:${orderIdTo || 'none'}:${paymentMethod || 'none'}:${deliveryType || 'none'}:${sortBy || 'newest'}`;
        if (!search) { // Only cache if no search term (search results are unique)
            const cached = getCached(cacheKey);
            if (cached) {
                return res.json(cached);
            }
        }
        
        let whereClause = 'WHERE 1=1';
        const params = [];

        // 'shipped' is a derived status: a confirmed shopper whose orders row carries an AWB / shipped status
        const shippedExpr = `(o.awb IS NOT NULL OR o.status = 'shipped')`;
        if (status && status !== 'all') {
            if (status === 'shipped') {
                whereClause += ` AND s.status = 'confirmed' AND ${shippedExpr}`;
            } else if (status === 'confirmed') {
                whereClause += ` AND s.status = 'confirmed' AND NOT COALESCE(${shippedExpr}, false)`;
            } else {
                whereClause += ' AND s.status = ?';
                params.push(status);
            }
        }

        if (search) {
            whereClause += ' AND (s.name LIKE ? OR s.phone LIKE ? OR s.order_id LIKE ?)';
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam);
        }

        if (startDate) {
            // Handle both date-only (YYYY-MM-DD) and datetime (YYYY-MM-DDTHH:mm:ss) formats
            // Convert IST date from frontend to UTC for database query
            const startDateTime = startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
            const utcStartDate = fromISTtoUTC(startDateTime) || startDateTime;
            whereClause += ' AND s.created_at >= ?';
            params.push(utcStartDate);
        }

        if (endDate) {
            // Handle both date-only (YYYY-MM-DD) and datetime (YYYY-MM-DDTHH:mm:ss) formats
            // Convert IST date from frontend to UTC for database query
            const endDateTime = endDate.includes('T') ? endDate : `${endDate} 23:59:59`;
            const utcEndDate = fromISTtoUTC(endDateTime) || endDateTime;
            whereClause += ' AND s.created_at <= ?';
            params.push(utcEndDate);
        }

        // Order ID Range Filter
        if (orderIdFrom) {
            whereClause += ' AND s.order_id >= ?';
            params.push(orderIdFrom);
        }
        if (orderIdTo) {
            whereClause += ' AND s.order_id <= ?';
            params.push(orderIdTo);
        }

        // Payment Method Filter
        if (paymentMethod) {
            whereClause += ' AND s.payment_method = ?';
            params.push(paymentMethod);
        }

        // Delivery Type Filter
        if (deliveryType) {
            whereClause += ' AND s.delivery_type = ?';
            params.push(deliveryType);
        }

        // Determine sort order
        let orderByClause = 'ORDER BY s.created_at DESC';
        if (sortBy === 'oldest') {
            orderByClause = 'ORDER BY s.created_at ASC';
        } else if (sortBy === 'orderIdAsc') {
            orderByClause = 'ORDER BY s.order_id ASC';
        } else if (sortBy === 'orderIdDesc') {
            orderByClause = 'ORDER BY s.order_id DESC';
        }

        // Count total rows - use GROUP BY to count unique order_ids
        // (joins orders so the derived 'shipped'/'confirmed' filters can reference o.*)
        const countSql = `SELECT COUNT(DISTINCT s.order_id) as total FROM store_shoppers s LEFT JOIN orders o ON o.order_id = s.order_id ${whereClause}`;
        const countRes = await dbAdapter.query(countSql, params);
        const total = countRes[0]?.total || 0;

        // Cleanup script ran 2026-04-29 — duplicates eliminated, skip expensive self-join
        const sql = `
            SELECT s.id, s.phone, s.name, s.email, s.order_id, s.address, s.city, s.province, s.zip,
                   s.payment_method, s.order_total, s.delivery_type, s.source,
                   CASE WHEN s.status = 'confirmed' AND ${shippedExpr} THEN 'shipped' ELSE s.status END as status,
                   s.customer_message, s.last_response_at, s.created_at, s.updated_at,
                   s.confirmed_by, s.items_json, s.rto_risk,
                   s.cancel_reason, s.shopify_cancelled_at, s.shopify_refund_amount,
                   o.awb,
                   o.courier_name,
                   COALESCE(s.order_total, o.total) as order_total,
                   o.status as order_status,
                   o.tracking_url
            FROM store_shoppers s
            LEFT JOIN orders o ON o.order_id = s.order_id
            ${whereClause} 
            ${orderByClause}
            LIMIT ? OFFSET ?
        `;
        const queryParams = [...params, parseInt(limit), parseInt(offset)];
        
        const shoppers = await dbAdapter.query(sql, queryParams);

        // Note: Deduplication removed after cleanup script ran on 2026-04-29
        // If duplicates reappear, re-enable the deduplication logic below

        const response = {
            success: true,
            shoppers,
            total,
            page: Math.floor(offset / limit) + 1
        };
        
        res.json(response);
        
        // Cache the response (only if no search)
        if (!search) {
            setCache(cacheKey, response, 'shoppers', 10 * 60 * 1000); // 10 minutes TTL
        }
    } catch (error) {
        console.error('Shoppers fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch shoppers' });
    }
});

// Update shopper details (Manual Edit)
router.put('/shoppers/:id', verifyToken, requirePermission('edit_orders'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, order_id, address, city, province, zip, items_json, order_total, delivery_type, payment_method } = req.body;
        logOperatorActivity(req, 'shopper_edit', `Edited shopper ${id}${name ? ` (name: ${name})` : ''}`);

        // Load the current row first so we can diff for the Shopify sync below
        const existingRows = await dbAdapter.select('store_shoppers', { id }, { limit: 1 });
        const existing = existingRows[0];
        if (!existing) {
            return res.status(404).json({ error: 'Shopper not found' });
        }

        const updateData = {
            updated_at: new Date().toISOString()
        };
        if (name !== undefined) updateData.name = name;
        if (phone !== undefined) updateData.phone = phone;
        if (order_id !== undefined) updateData.order_id = order_id;
        if (address !== undefined) updateData.address = address;
        if (city !== undefined) updateData.city = city;
        if (province !== undefined) updateData.province = province;
        if (zip !== undefined) updateData.zip = zip;
        if (items_json !== undefined) updateData.items_json = items_json;
        if (order_total !== undefined) {
            const totalNum = parseFloat(order_total);
            if (isNaN(totalNum) || totalNum < 0) {
                return res.status(400).json({ error: 'Invalid order total' });
            }
            updateData.order_total = totalNum;
        }
        if (delivery_type !== undefined) updateData.delivery_type = delivery_type;
        if (payment_method !== undefined) {
            // Admin can flip COD orders to Prepaid (or back) from the edit modal
            if (!['COD', 'Prepaid'].includes(payment_method)) {
                return res.status(400).json({ error: 'Invalid payment method (COD or Prepaid)' });
            }
            updateData.payment_method = payment_method;
        }

        await dbAdapter.update('store_shoppers', updateData, { id });
        
        // Invalidate cache after shopper update
        invalidateCache('shoppers');

        // Push the edits to Shopify so Shopify + GoKwik stay in sync with the hub
        let shopifySync = null;
        let gokwikSync = null;
        const itemsChanged = items_json !== undefined && items_json !== existing.items_json;
        const paymentChanged = payment_method !== undefined && payment_method !== existing.payment_method;
        const totalChanged = updateData.order_total !== undefined && parseFloat(existing.order_total) !== updateData.order_total;
        const addressChanged = ['address', 'city', 'province', 'zip'].some(
            f => updateData[f] !== undefined && String(existing[f] || '') !== String(updateData[f])
        ) || (name !== undefined && name !== existing.name) || (phone !== undefined && phone !== existing.phone);
        const targetOrderId = updateData.order_id || existing.order_id;
        if ((itemsChanged || paymentChanged) && targetOrderId) {
            try {
                const shopifyService = require('../services/shopifyService');
                let parsedItems = null;
                if (itemsChanged) {
                    try { parsedItems = JSON.parse(items_json); } catch (_) { parsedItems = null; }
                }
                shopifySync = await shopifyService.syncOrderEdits(targetOrderId, {
                    items: parsedItems,
                    paymentMethod: paymentChanged ? payment_method : null
                });
            } catch (syncError) {
                console.error('⚠️ Shopify order sync error (hub still updated):', syncError.message);
                shopifySync = { success: false, actions: [], warnings: [syncError.message] };
            }
        }

        // Mirror shipping-address edits to the Shopify order (best-effort)
        if (addressChanged && targetOrderId) {
            try {
                const shopifyService = require('../services/shopifyService');
                const addrSync = await shopifyService.updateShippingAddress(targetOrderId, {
                    name: name !== undefined ? name : undefined,
                    phone: phone !== undefined ? phone : undefined,
                    address1: address !== undefined ? address : undefined,
                    city: city !== undefined ? city : undefined,
                    state: province !== undefined ? province : undefined,
                    pincode: zip !== undefined ? zip : undefined
                });
                if (!shopifySync) shopifySync = { success: addrSync.success, actions: [], warnings: [] };
                if (addrSync.success) shopifySync.actions.push('Shipping address updated in Shopify');
                else shopifySync.warnings.push(...addrSync.warnings.map(w => `Address sync: ${w}`));
            } catch (addrError) {
                console.error('⚠️ Shopify address sync error (hub still updated):', addrError.message);
                if (!shopifySync) shopifySync = { success: false, actions: [], warnings: [] };
                shopifySync.warnings.push(`Address sync: ${addrError.message}`);
            }
        }

        // Mirror the same edits to GoKwik (no-op until GOKWIK_ORDER_UPDATE_PATH is configured)
        if ((itemsChanged || paymentChanged || totalChanged || addressChanged) && targetOrderId) {
            try {
                const gokwikService = require('../services/gokwikService');
                let parsedItems = null;
                if (itemsChanged) {
                    try { parsedItems = JSON.parse(items_json); } catch (_) { parsedItems = null; }
                }
                gokwikSync = await gokwikService.notifyOrderUpdate(targetOrderId, {
                    ...(parsedItems ? { items: parsedItems } : {}),
                    ...(totalChanged ? { orderTotal: updateData.order_total } : {}),
                    ...(paymentChanged ? { paymentMethod: payment_method } : {}),
                    ...(addressChanged ? { shippingAddress: { name, phone, address, city, state: province, pincode: zip } } : {})
                });
            } catch (gkError) {
                console.error('⚠️ GoKwik order sync error (hub still updated):', gkError.message);
                gokwikSync = { success: false, skipped: false, reason: gkError.message };
            }
        }

        res.json({ success: true, message: 'Shopper updated successfully', shopify_sync: shopifySync, gokwik_sync: gokwikSync });
    } catch (error) {
        console.error('Shopper update error:', error);
        res.status(500).json({ error: 'Failed to update shopper' });
    }
});

// Live shipping address from the Shopify order — used by the edit modal's
// "Pull from Shopify" button so hub address fields can be re-synced
router.get('/shoppers/:id/shopify-address', verifyToken, async (req, res) => {
    try {
        const rows = await dbAdapter.select('store_shoppers', { id: req.params.id }, { limit: 1 });
        const shopper = rows[0];
        if (!shopper) return res.status(404).json({ success: false, error: 'Shopper not found' });
        if (!shopper.order_id) return res.status(400).json({ success: false, error: 'Shopper has no order ID' });

        const shopifyService = require('../services/shopifyService');
        const address = await shopifyService.getShippingAddress(shopper.order_id);
        if (!address) return res.status(404).json({ success: false, error: 'No shipping address found on the Shopify order' });

        res.json({ success: true, address });
    } catch (error) {
        console.error('Shopify address fetch error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch address from Shopify' });
    }
});

// Shopify product catalog for the edit-order product picker (cached 10 min in service)
router.get('/shopify/products', verifyToken, async (req, res) => {
    try {
        const shopifyService = require('../services/shopifyService');
        const catalog = await shopifyService.getProductCatalog(req.query.refresh === '1');
        res.json({ success: true, products: catalog });
    } catch (error) {
        console.error('Shopify catalog fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch product catalog' });
    }
});

// Send the customer a WhatsApp notice about a manual cancellation.
// Delegates to whatsappService.sendOrderCancellationNotice, which uses the
// Meta template order_cancelled_v1 and falls back to a plain session message
// while the template is pending approval or if the template call fails.
async function notifyCustomerOfCancellation(shopper, reason) {
    if (!shopper?.phone) return false;
    const isPrepaid = shopper.payment_method && !/cod|cash on delivery/i.test(String(shopper.payment_method));
    const amount = parseFloat(shopper.order_total) || 0;
    const refundNote = isPrepaid
        ? `Your prepaid amount of ₹${amount.toLocaleString('en-IN')} will be refunded to the original payment method within 5-7 business days.`
        : 'This was a Cash on Delivery order, so no refund is applicable.';
    return await whatsappService.sendOrderCancellationNotice(
        shopper.phone,
        shopper.name || 'Customer',
        shopper.order_id || 'N/A',
        reason,
        refundNote
    );
}

// Update shopper status manually (Confirm/Reject)
router.post('/shoppers/:id/status', verifyToken, requirePermission('edit_orders'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'confirmed', 'cancelled', 'edit_details'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        // Manual cancellations must carry a reason — it is stored on the order
        // and included in the WhatsApp notice sent to the customer.
        // (Customer-initiated WhatsApp cancels are stamped 'AUTO' by the bot.)
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        if (status === 'cancelled' && !reason) {
            return res.status(400).json({ error: 'Cancellation reason is required' });
        }

        // Previous status (before this update) — a re-cancel must not re-notify the customer
        const prevRows = await dbAdapter.select('store_shoppers', { id }, { limit: 1 });
        const wasAlreadyCancelled = status === 'cancelled' && prevRows[0]?.status === 'cancelled';
        logOperatorActivity(req, 'status_update', `Shopper ${id} → ${status}${status === 'cancelled' ? ` (reason: ${reason})` : ''}`);

        const updateData = { 
            status, 
            updated_at: new Date().toISOString()
        };

        // Track confirmation method for non-pending statuses
        if (['confirmed', 'cancelled', 'edit_details'].includes(status)) {
            updateData.confirmed_by = 'manual';
        }
        if (status === 'cancelled') {
            updateData.cancel_reason = reason;
        }

        await dbAdapter.update('store_shoppers', updateData, { id });

        // If the order was already shipped, cancel the shipment at its carrier too
        let shipmentCancellation = null;
        let whatsappNotified = null;
        if (status === 'cancelled') {
            try {
                const shopperRows = await dbAdapter.select('store_shoppers', { id }, { limit: 1 });
                const shopper = shopperRows[0];
                const orderId = shopper?.order_id;
                if (orderId) {
                    const shipping = require('../services/shippingService');
                    shipmentCancellation = await shipping.cancelActiveShipmentForOrder(orderId);
                    if (shipmentCancellation.hadShipment && !shipmentCancellation.cancelled) {
                        console.error(`⚠️ Order ${orderId} cancelled in hub but carrier cancellation failed: ${shipmentCancellation.error}`);
                    } else if (shipmentCancellation.cancelled) {
                        console.log(`📦 Cancelled shipment (AWB: ${shipmentCancellation.awb}) at ${shipmentCancellation.carrier} for order ${orderId}`);
                    }
                }
                // Notify the customer on WhatsApp with the reason — only on the
                // first cancel (re-cancelling must not spam the customer again)
                if (!wasAlreadyCancelled) {
                    whatsappNotified = await notifyCustomerOfCancellation(shopper, reason);
                }
            } catch (shipError) {
                console.error('⚠️ Carrier cancellation check failed (order status still updated):', shipError.message);
                shipmentCancellation = { hadShipment: true, cancelled: false, error: shipError.message };
            }
        }

        // Invalidate cache after shopper status change
        invalidateCache('shoppers');

        let message = `Status updated to ${status}`;
        if (shipmentCancellation?.cancelled) {
            message += ` — shipment (AWB: ${shipmentCancellation.awb}) cancelled at ${shipmentCancellation.carrier}`;
        } else if (shipmentCancellation?.hadShipment && !shipmentCancellation.cancelled) {
            message += ` — but carrier cancellation FAILED: ${shipmentCancellation.error}. Cancel it manually from the shipments drawer.`;
        }
        if (status === 'cancelled' && whatsappNotified === true) {
            message += ' — customer notified on WhatsApp';
        }
        res.json({ success: true, message, shipmentCancellation, whatsappNotified });
    } catch (error) {
        console.error('Shopper status update error:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Bulk delete shoppers
router.delete('/shoppers/bulk', verifyToken, requirePermission('edit_orders'), async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No IDs provided' });
        }
        logOperatorActivity(req, 'shopper_delete', `Bulk deleted ${ids.length} shoppers`);

        const placeholders = ids.map(() => '?').join(',');
        const sql = `DELETE FROM store_shoppers WHERE id IN (${placeholders})`;
        await dbAdapter.query(sql, ids);

        // Invalidate cache after bulk shopper deletion
        invalidateCache('shoppers');
        res.json({ success: true, message: `Successfully deleted ${ids.length} records` });
    } catch (error) {
        console.error('Shoppers bulk delete error:', error);
        res.status(500).json({ error: 'Failed to delete shoppers' });
    }
});

// Cancel a shopper's order in Shopify (optionally refunding prepaid orders).
// Powers the Shoppers Hub "Cancel in Shopify & Refund" premium bulk action —
// the hub loops over selected cancelled orders and calls this once per order.
router.post('/shoppers/:id/shopify-cancel', verifyToken, requirePermission('edit_orders'), async (req, res) => {
    try {
        const { id } = req.params;
        const refundPrepaid = req.body?.refundPrepaid !== false;

        const rows = await dbAdapter.select('store_shoppers', { id }, { limit: 1 });
        const shopper = rows[0];
        if (!shopper) return res.status(404).json({ success: false, error: 'Shopper not found' });
        if (!shopper.order_id) return res.status(400).json({ success: false, error: 'Shopper has no order ID' });

        logOperatorActivity(req, 'shopify_cancel', `Shopper ${id} (order ${shopper.order_id}) → Shopify cancel${refundPrepaid ? ' + prepaid refund' : ''}`);

        const shopifyService = require('../services/shopifyService');
        const result = await shopifyService.cancelAndRefundOrder(shopper.order_id, { refundPrepaid });

        console.log(`🔍 [shopify-cancel] Shopper ${id}, order ${shopper.order_id}: cancelled=${result.cancelled}, refunded=${result.refunded}, refundAmount=${result.refundAmount}, refundSkipped=${result.refundSkipped}, error=${result.error}`);

        if (!result.cancelled) {
            return res.status(502).json({ success: false, error: result.error || 'Shopify cancellation failed', result });
        }

        // Persist the channel-sync state so the hub shows the "Synced" badge
        // on this cancelled order (cancelled on the order channel itself).
        try {
            await dbAdapter.update('store_shoppers', {
                shopify_cancelled_at: new Date().toISOString(),
                shopify_refund_amount: result.refunded ? (result.refundAmount || null) : null,
                updated_at: new Date().toISOString()
            }, { id });
            invalidateCache('shoppers');
        } catch (syncErr) {
            console.warn(`⚠️ Could not persist Shopify cancel sync flag for shopper ${id}:`, syncErr.message);
        }

        res.json({ success: true, result });
    } catch (error) {
        console.error('Shopify cancel error:', error);
        res.status(500).json({ success: false, error: 'Failed to cancel order in Shopify' });
    }
});

// Get customers with 2+ orders within 24 hours
router.get('/shoppers/multi-orders', verifyToken, async (req, res) => {
    try {
        const { status, search, startDate, endDate, minOrders = '2', sort = 'newest' } = req.query;
        const minOrdersNum = parseInt(minOrders) || 2;

        // Build date filter clause for the self-join
        let dateJoinClause = '';
        const joinParams = [];
        if (startDate && endDate) {
            // Convert IST dates from frontend to UTC for database query
            const utcStartDate1 = fromISTtoUTC(startDate + ' 00:00:00') || (startDate + ' 00:00:00');
            const utcEndDate1 = fromISTtoUTC(endDate + ' 23:59:59') || (endDate + ' 23:59:59');
            dateJoinClause = ` AND s1.created_at >= ? AND s1.created_at <= ? AND s2.created_at >= ? AND s2.created_at <= ?`;
            joinParams.push(utcStartDate1, utcEndDate1, utcStartDate1, utcEndDate1);
        } else if (startDate) {
            const utcStartDate = fromISTtoUTC(startDate + ' 00:00:00') || (startDate + ' 00:00:00');
            dateJoinClause = ` AND s1.created_at >= ? AND s2.created_at >= ?`;
            joinParams.push(utcStartDate, utcStartDate);
        } else if (endDate) {
            const utcEndDate = fromISTtoUTC(endDate + ' 23:59:59') || (endDate + ' 23:59:59');
            dateJoinClause = ` AND s1.created_at <= ? AND s2.created_at <= ?`;
            joinParams.push(utcEndDate, utcEndDate);
        }

        // Find phones with 2+ orders where at least one pair is within 24 hours (86400 seconds)
        const multiOrderPhonesSql = `
            SELECT DISTINCT s1.phone
            FROM store_shoppers s1
            JOIN store_shoppers s2 ON s1.phone = s2.phone
                AND s1.id != s2.id
                AND ABS(EXTRACT(EPOCH FROM (s1.created_at - s2.created_at))) <= 86400
                ${dateJoinClause}
        `;
        const phoneRows = await dbAdapter.query(multiOrderPhonesSql, joinParams);
        const phones = phoneRows.map(r => r.phone);

        if (phones.length === 0) {
            return res.json({ success: true, groups: [], totalCustomers: 0, totalOrders: 0, statusCounts: { all: 0, pending: 0, confirmed: 0, cancelled: 0, edit_details: 0 } });
        }

        // Fetch all orders for those phones with optional status filter
        const placeholders = phones.map(() => '?').join(',');;
        let statusClause = '';
        const ordersParams = [...phones];
        if (status && status !== 'all') {
            statusClause = ' AND s.status = ?';
            ordersParams.push(status);
        }

        // Date filter on orders query
        let orderDateClause = '';
        if (startDate) {
            orderDateClause += ' AND s.created_at >= ?';
            const utcStartDate = fromISTtoUTC(startDate + ' 00:00:00') || (startDate + ' 00:00:00');
            ordersParams.push(utcStartDate);
        }
        if (endDate) {
            orderDateClause += ' AND s.created_at <= ?';
            const utcEndDate = fromISTtoUTC(endDate + ' 23:59:59') || (endDate + ' 23:59:59');
            ordersParams.push(utcEndDate);
        }

        const ordersSql = `
            SELECT s.*, 
                   (SELECT o.awb FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as awb,
                   (SELECT o.courier_name FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as courier_name,
                   (SELECT o.tracking_url FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as tracking_url,
                   (SELECT o.status FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as order_status
            FROM store_shoppers s
            WHERE s.phone IN (${placeholders})
            ${statusClause}
            ${orderDateClause}
            ORDER BY s.phone, s.created_at DESC
        `;
        const orders = await dbAdapter.query(ordersSql, ordersParams);

        // Group by phone with deduplication by order_id
        const groupsMap = {};
        let totalOrders = 0;

        for (const order of orders) {
            const phone = order.phone;
            if (!groupsMap[phone]) {
                groupsMap[phone] = {
                    phone,
                    name: order.name || 'Unknown Customer',
                    orders: [],
                    seenOrderIds: new Set()
                };
            }
            
            // Skip if this order_id was already added for this phone
            if (groupsMap[phone].seenOrderIds.has(order.order_id)) {
                continue;
            }
            
            groupsMap[phone].seenOrderIds.add(order.order_id);
            groupsMap[phone].orders.push(order);
            totalOrders++;
        }
        
        // Clean up the temporary Set
        Object.values(groupsMap).forEach(g => delete g.seenOrderIds);

        // Only include groups with minOrders+ orders
        let groups = Object.values(groupsMap).filter(g => g.orders.length >= minOrdersNum);

        // Search filter
        if (search) {
            const q = search.toLowerCase();
            groups = groups.filter(g =>
                (g.name || '').toLowerCase().includes(q) ||
                (g.phone || '').includes(q) ||
                g.orders.some(o => (o.order_id || '').toLowerCase().includes(q))
            );
        }

        // Compute total value per group for sorting
        for (const g of groups) {
            g.totalValue = g.orders.reduce((sum, o) => sum + (Number(o.order_total) || 0), 0);
            g.latestOrderDate = g.orders.reduce((latest, o) => {
                const d = new Date(o.created_at);
                return d > latest ? d : latest;
            }, new Date(0));
            g.earliestOrderDate = g.orders.reduce((earliest, o) => {
                const d = new Date(o.created_at);
                return d < earliest ? d : earliest;
            }, new Date());
        }

        // Sort
        switch (sort) {
            case 'oldest':
                groups.sort((a, b) => a.earliestOrderDate - b.earliestOrderDate);
                break;
            case 'order_count_desc':
                groups.sort((a, b) => b.orders.length - a.orders.length);
                break;
            case 'order_count_asc':
                groups.sort((a, b) => a.orders.length - b.orders.length);
                break;
            case 'total_desc':
                groups.sort((a, b) => b.totalValue - a.totalValue);
                break;
            case 'total_asc':
                groups.sort((a, b) => a.totalValue - b.totalValue);
                break;
            case 'name_asc':
                groups.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                break;
            case 'name_desc':
                groups.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
                break;
            case 'recent_order':
                groups.sort((a, b) => b.latestOrderDate - a.latestOrderDate);
                break;
            case 'newest':
            default:
                groups.sort((a, b) => b.earliestOrderDate - a.earliestOrderDate);
                break;
        }

        // Compute status counts across ALL groups (unfiltered by status for pill counts)
        // We need a separate count without status filter
        let statusCountsParams = [...phones];
        const statusCountSql = `
            SELECT s.status, COUNT(*) as cnt
            FROM store_shoppers s
            WHERE s.phone IN (${placeholders})
            GROUP BY s.status
        `;
        const statusRows = await dbAdapter.query(statusCountSql, statusCountsParams);
        const statusCounts = { all: 0, pending: 0, confirmed: 0, cancelled: 0, edit_details: 0 };
        for (const row of statusRows) {
            const s = (row.status || 'pending').replace(' ', '_');
            if (statusCounts.hasOwnProperty(s)) statusCounts[s] = row.cnt;
            statusCounts.all += row.cnt;
        }

        // Total value across filtered groups
        const totalValue = groups.reduce((sum, g) => sum + g.totalValue, 0);
        const avgValue = totalOrders > 0 ? totalValue / totalOrders : 0;

        res.json({
            success: true,
            groups,
            totalCustomers: groups.length,
            totalOrders,
            totalValue,
            avgValue,
            statusCounts
        });
    } catch (error) {
        console.error('Multi-orders fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch multi-orders' });
    }
});

// Export shoppers to Excel
router.get('/shoppers/export', verifyToken, requirePermission('export'), async (req, res) => {
    try {
        const { status, search, startDate, endDate, orderIdFrom, orderIdTo, format = 'xlsx', exportType } = req.query;
        logOperatorActivity(req, 'export', `Shoppers export (status: ${status || 'all'}, format: ${format})`);
        
        let whereClause = 'WHERE 1=1';
        const params = [];

        // Same derived 'shipped' status semantics as the /shoppers list endpoint
        const shippedExpr = `(o.awb IS NOT NULL OR o.status = 'shipped')`;
        if (status && status !== 'all') {
            if (status === 'shipped') {
                whereClause += ` AND s.status = 'confirmed' AND ${shippedExpr}`;
            } else if (status === 'confirmed') {
                whereClause += ` AND s.status = 'confirmed' AND NOT COALESCE(${shippedExpr}, false)`;
            } else {
                whereClause += ' AND s.status = ?';
                params.push(status);
            }
        }
        if (search) {
            whereClause += ' AND (s.name LIKE ? OR s.phone LIKE ? OR s.order_id LIKE ?)';
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam);
        }
        if (startDate) {
            // Handle both date-only (YYYY-MM-DD) and datetime (YYYY-MM-DDTHH:mm:ss) formats
            // Convert IST date from frontend to UTC for database query
            const startDateTime = startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
            const utcStartDateTime = fromISTtoUTC(startDateTime) || startDateTime;
            whereClause += ' AND s.created_at >= ?';
            params.push(utcStartDateTime);
        }
        if (endDate) {
            // Handle both date-only (YYYY-MM-DD) and datetime (YYYY-MM-DDTHH:mm:ss) formats
            // Convert IST date from frontend to UTC for database query
            const endDateTime = endDate.includes('T') ? endDate : `${endDate} 23:59:59`;
            const utcEndDateTime = fromISTtoUTC(endDateTime) || endDateTime;
            whereClause += ' AND s.created_at <= ?';
            params.push(utcEndDateTime);
        }
        // Order ID Range Filter for Export
        if (orderIdFrom) {
            whereClause += ' AND s.order_id >= ?';
            params.push(orderIdFrom);
        }
        if (orderIdTo) {
            whereClause += ' AND s.order_id <= ?';
            params.push(orderIdTo);
        }

        const sql = `
            SELECT s.name, s.phone, s.email, s.order_id, s.address, s.city, s.province, s.zip, s.country, 
                   s.payment_method, s.items_json,
                   CASE WHEN s.status = 'confirmed' AND ${shippedExpr} THEN 'shipped' ELSE s.status END as status,
                   s.created_at, s.customer_message,
                   s.delivery_type, COALESCE(s.order_total, o.total) as order_total,
                   o.awb, o.courier_name
            FROM store_shoppers s
            INNER JOIN (
                SELECT order_id, MAX(updated_at) as max_updated
                FROM store_shoppers
                GROUP BY order_id
            ) latest_s ON s.order_id = latest_s.order_id AND s.updated_at = latest_s.max_updated
            LEFT JOIN orders o ON s.order_id = o.order_id
            ${whereClause} 
            ORDER BY s.created_at DESC
            LIMIT 5000
        `;
        const shoppers = await dbAdapter.query(sql, params);

        // Format data for export
        const exportData = shoppers.map(s => {
            // Parse items_json into readable product string
            let productsStr = '';
            try {
                const items = JSON.parse(s.items_json || '[]');
                productsStr = items.map(item => {
                    let size = item.size || item.variant_size || item.product_size || '';
                    if (!size && item.variant_title) {
                        const sizeMatch = item.variant_title.match(/Size:\s*(\w+)/i) || item.variant_title.match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
                        if (sizeMatch) size = sizeMatch[1].toUpperCase();
                    }
                    const sizePart = size ? ` (${size})` : '';
                    return `${item.title || item.name || 'Product'}${sizePart} x${item.quantity || 1}`;
                }).join('; ');
            } catch (e) {
                productsStr = s.items_json || '';
            }

            // Determine delivery type
            const deliveryType = s.delivery_type || 'Standard';

            // Format status for readability
            const statusMap = {
                'pending': 'Pending',
                'confirmed': 'Confirmed',
                'shipped': 'Shipped',
                'cancelled': 'Cancelled',
                'edit_details': 'Edit Details'
            };
            const statusDisplay = statusMap[s.status] || (s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : 'Pending');

            return {
                'Name': s.name || '',
                'Phone': s.phone || '',
                'Email': s.email || '',
                'Order ID': s.order_id || '',
                'Status': statusDisplay,
                'Order Total': s.order_total || '',
                'Payment Method': s.payment_method || '',
                'Delivery Type': deliveryType,
                'Products': productsStr,
                'Address': s.address || '',
                'City': s.city || '',
                'Province': s.province || '',
                'ZIP': s.zip || '',
                'Country': s.country || '',
                'AWB': s.awb || '',
                'Courier': s.courier_name || '',
                'Customer Message': s.customer_message || '',
                'Created At (IST)': formatDateForExport(s.created_at) || ''
            };
        });

        // Handle different export formats
        if (format === 'csv') {
            const ws = getXlsx().utils.json_to_sheet(exportData);
            const csv = getXlsx().utils.sheet_to_csv(ws);
            const istDate = toIST(new Date(), 'date');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=shoppers_${istDate}.csv`);
            return res.send(csv);
        }

        // Create Excel workbook
        const wb = getXlsx().utils.book_new();
        const ws = getXlsx().utils.json_to_sheet(exportData);
        getXlsx().utils.book_append_sheet(wb, ws, exportType === 'daily' ? "Daily Report" : "Shoppers");

        const buffer = getXlsx().write(wb, { type: 'buffer', bookType: 'xlsx' });

        const istDate = toIST(new Date(), 'date');
        const filename = exportType === 'daily' 
            ? `daily_report_${istDate}.xlsx`
            : `shoppers_${status || 'all'}_${istDate}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.send(buffer);
    } catch (error) {
        console.error('Shoppers export error:', error);
        res.status(500).json({ error: 'Failed to export shoppers' });
    }
});

// Inbox Export - export orders/messages from inbox with filters
router.get('/inbox/export', verifyToken, requirePermission('export'), async (req, res) => {
    try {
        const { tab = 'confirmed', startDate, endDate, confirmedBy, paymentMethod, deliveryType, search, format = 'xlsx', orderIds, dateField = 'updated_at' } = req.query;
        logOperatorActivity(req, 'export', `Inbox export (tab: ${tab}, format: ${format})`);

        // Validate dateField
        const validDateFields = ['created_at', 'updated_at'];
        const safeDateField = validDateFields.includes(dateField) ? dateField : 'updated_at';

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (tab === 'confirmed') {
            whereClause += ' AND s.status = ?';
            params.push('confirmed');

            if (startDate) {
                const startDateTime = startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
                const utcStartDate = fromISTtoUTC(startDateTime) || startDateTime;
                whereClause += ` AND s.${safeDateField} >= ?`;
                params.push(utcStartDate);
            }
            if (endDate) {
                const endDateTime = endDate.includes('T') ? endDate : `${endDate} 23:59:59`;
                const utcEndDate = fromISTtoUTC(endDateTime) || endDateTime;
                whereClause += ` AND s.${safeDateField} <= ?`;
                params.push(utcEndDate);
            }
            if (confirmedBy) {
                whereClause += ' AND s.confirmed_by = ?';
                params.push(confirmedBy);
            }
            if (paymentMethod) {
                whereClause += ' AND s.payment_method = ?';
                params.push(paymentMethod);
            }
            if (deliveryType) {
                whereClause += ' AND s.delivery_type = ?';
                params.push(deliveryType);
            }
            if (search) {
                whereClause += ' AND (s.name LIKE ? OR s.phone LIKE ? OR s.order_id LIKE ?)';
                const searchParam = `%${search}%`;
                params.push(searchParam, searchParam, searchParam);
            }
            if (orderIds) {
                const ids = orderIds.split(',').map(id => id.trim()).filter(Boolean);
                if (ids.length > 0) {
                    const placeholders = ids.map(() => '?').join(',');
                    whereClause += ` AND s.order_id IN (${placeholders})`;
                    params.push(...ids);
                }
            }
        } else {
            // Unread tab export — export customers with unread messages
            whereClause += ' AND s.status != ?';
            params.push('cancelled');

            if (startDate) {
                const startDateTime = startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
                const utcStartDate = fromISTtoUTC(startDateTime) || startDateTime;
                whereClause += ' AND s.created_at >= ?';
                params.push(utcStartDate);
            }
            if (endDate) {
                const endDateTime = endDate.includes('T') ? endDate : `${endDate} 23:59:59`;
                const utcEndDate = fromISTtoUTC(endDateTime) || endDateTime;
                whereClause += ' AND s.created_at <= ?';
                params.push(utcEndDate);
            }
            if (search) {
                whereClause += ' AND (s.name LIKE ? OR s.phone LIKE ? OR s.order_id LIKE ?)';
                const searchParam = `%${search}%`;
                params.push(searchParam, searchParam, searchParam);
            }
            if (orderIds) {
                const ids = orderIds.split(',').map(id => id.trim()).filter(Boolean);
                if (ids.length > 0) {
                    const placeholders = ids.map(() => '?').join(',');
                    whereClause += ` AND s.order_id IN (${placeholders})`;
                    params.push(...ids);
                }
            }
        }

        const sql = `
            SELECT s.name, s.phone, s.email, s.order_id, s.address, s.city, s.province, s.zip,
                   s.payment_method, s.items_json, s.status, s.created_at, s.customer_message,
                   s.delivery_type, s.confirmed_by, s.updated_at,
                   COALESCE(s.order_total, o.total) as order_total,
                   o.awb, o.courier_name
            FROM store_shoppers s
            INNER JOIN (
                SELECT order_id, MAX(updated_at) as max_updated
                FROM store_shoppers
                GROUP BY order_id
            ) latest_s ON s.order_id = latest_s.order_id AND s.updated_at = latest_s.max_updated
            LEFT JOIN orders o ON s.order_id = o.order_id
            ${whereClause}
            ORDER BY s.updated_at DESC
        `;
        const shoppers = await dbAdapter.query(sql, params);

        // Format data for export
        const exportData = shoppers.map(s => {
            let productsStr = '';
            try {
                const items = JSON.parse(s.items_json || '[]');
                productsStr = items.map(item => {
                    let size = item.size || item.variant_size || item.product_size || '';
                    if (!size && item.variant_title) {
                        const sizeMatch = item.variant_title.match(/Size:\s*(\w+)/i) || item.variant_title.match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
                        if (sizeMatch) size = sizeMatch[1].toUpperCase();
                    }
                    const sizePart = size ? ` (${size})` : '';
                    return `${item.title || item.name || 'Product'}${sizePart} x${item.quantity || 1}`;
                }).join('; ');
            } catch (e) {
                productsStr = s.items_json || '';
            }

            return {
                'Name': s.name || '',
                'Phone': s.phone || '',
                'Order ID': s.order_id || '',
                'Status': (s.status || 'pending').charAt(0).toUpperCase() + (s.status || 'pending').slice(1),
                'Order Total': s.order_total || '',
                'Payment Method': s.payment_method || '',
                'Delivery Type': s.delivery_type || 'Standard',
                'Confirmed By': s.confirmed_by || '',
                'Products': productsStr,
                'City': s.city || '',
                'AWB': s.awb || '',
                'Courier': s.courier_name || '',
                'Customer Message': s.customer_message || '',
                'Order Date (IST)': formatDateForExport(s.created_at) || '',
                'Confirmed Date (IST)': formatDateForExport(s.updated_at) || ''
            };
        });

        const istDate = toIST(new Date(), 'date');
        const tabLabel = tab === 'confirmed' ? 'confirmed_orders' : 'inbox';

        if (format === 'csv') {
            const ws = getXlsx().utils.json_to_sheet(exportData);
            const csv = getXlsx().utils.sheet_to_csv(ws);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=${tabLabel}_${istDate}.csv`);
            return res.send(csv);
        }

        const wb = getXlsx().utils.book_new();
        const ws = getXlsx().utils.json_to_sheet(exportData);
        getXlsx().utils.book_append_sheet(wb, ws, 'Inbox Export');
        const buffer = getXlsx().write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${tabLabel}_${istDate}.xlsx`);
        res.send(buffer);
    } catch (error) {
        console.error('Inbox export error:', error);
        res.status(500).json({ error: 'Failed to export inbox data' });
    }
});

// ===================================
// Live Chat Endpoints
// ===================================

// IMPORTANT: Specific routes MUST come before parameterized routes!

// Get unread customer messages
router.get('/chat/unread', verifyToken, async (req, res) => {
    try {
        const { limit = 20, offset = 0, startDate, endDate, search, actionType } = req.query;

        // Cache unread chat list (2 min TTL) — heavy query with JOINs + NOT EXISTS
        const chatCacheKey = `chat_unread:${limit}:${offset}:${startDate || 'all'}:${endDate || 'all'}:${search || 'none'}:${actionType || 'all'}`;
        if (!search) {
            const cached = getCached(chatCacheKey);
            if (cached) return res.json(cached);
        }

        // Build date filter for messages
        let dateClause = '';
        const dateParams = [];
        if (startDate) {
            const startDateTime = startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
            const utcStartDate = fromISTtoUTC(startDateTime) || startDateTime;
            dateClause += ' AND m.created_at >= ?';
            dateParams.push(utcStartDate);
        }
        if (endDate) {
            const endDateTime = endDate.includes('T') ? endDate : `${endDate} 23:59:59`;
            const utcEndDate = fromISTtoUTC(endDateTime) || endDateTime;
            dateClause += ' AND m.created_at <= ?';
            dateParams.push(utcEndDate);
        }

        // Build search filter
        let searchClause = '';
        if (search) {
            searchClause += ' AND (c.name LIKE ? OR m.customer_phone LIKE ? OR s.order_id LIKE ?)';
            const searchParam = `%${search}%`;
            dateParams.push(searchParam, searchParam, searchParam);
        }

        // Build action type filter (filter by shopper status)
        let actionClause = '';
        if (actionType) {
            actionClause += ' AND s.status = ?';
            dateParams.push(actionType);
        }

        // Find phones with unread incoming messages (optimized with JOINs instead of correlated subqueries)
        const unreadSql = `
            SELECT m.customer_phone as phone,
                   MAX(m.created_at) as last_message_at,
                   COUNT(*) as unread_count,
                   MAX(m.message_content) as latest_message,
                   MAX(c.name) as name,
                   MAX(ls.id) as shopper_id,
                   MAX(ls.order_id) as order_id,
                   MAX(ls.status) as status,
                   MAX(ls.order_total) as order_total,
                   MAX(ls.delivery_type) as delivery_type,
                   MAX(ls.payment_method) as payment_method,
                   MAX(ls.confirmed_by) as confirmed_by,
                   MAX(ls.created_at) as created_at,
                   MAX(ls.updated_at) as updated_at,
                   MAX(ls.last_response_at) as last_response_at
            FROM messages m
            LEFT JOIN (
                SELECT s1.id, s1.phone, s1.order_id, s1.status, s1.order_total,
                       s1.delivery_type, s1.payment_method, s1.confirmed_by,
                       s1.created_at, s1.updated_at, s1.last_response_at
                FROM store_shoppers s1
                INNER JOIN (
                    SELECT phone, MAX(created_at) as max_created
                    FROM store_shoppers
                    GROUP BY phone
                ) s2 ON s1.phone = s2.phone AND s1.created_at = s2.max_created
            ) ls ON ls.phone = m.customer_phone
            LEFT JOIN customers c ON c.phone = m.customer_phone
            WHERE m.message_type = 'incoming'
              AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id)
              ${dateClause}
              ${searchClause}
              ${actionClause}
            GROUP BY m.customer_phone
            ORDER BY last_message_at DESC
            LIMIT ? OFFSET ?
        `;
        const shoppers = await dbAdapter.query(unreadSql, [...dateParams, parseInt(limit), parseInt(offset)]);

        // Get total count of phones with unread messages (optimized)
        const countSql = `
            SELECT COUNT(DISTINCT m.customer_phone) as total
            FROM messages m
            WHERE m.message_type = 'incoming'
              AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id)
              ${dateClause}
              ${searchClause}
              ${actionClause}
        `;
        const countRes = await dbAdapter.query(countSql, dateParams);
        const total = countRes[0]?.total || 0;

        const result = {
            success: true,
            shoppers,
            total,
            page: Math.floor(offset / limit) + 1
        };

        if (!search) {
            setCache(chatCacheKey, result, 'shoppers', 2 * 60 * 1000); // 2 minutes TTL
        }

        res.json(result);
    } catch (error) {
        console.error('Unread messages fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch unread messages' });
    }
});

// Get chat history for a specific customer
router.get('/chat/:phone', verifyToken, async (req, res) => {
    try {
        const { phone } = req.params;
        const { limit = 200 } = req.query;
        
        // Normalize phone number
        const cleanPhone = phone.replace(/\D/g, '');
        
        // Get ALL messages from messages table (incoming + all outgoing types)
        const phoneVariations = [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`];
        
        const messages = await dbAdapter.query(
            `SELECT 
                m.id,
                m.message_content as content,
                m.message_type as type,
                m.status,
                m.created_at,
                CASE 
                    WHEN m.message_type = 'incoming' THEN 'customer'
                    ELSE 'agent'
                END as sender,
                CASE 
                    WHEN m.message_type = 'incoming' AND mr.id IS NULL THEN 0
                    ELSE 1
                END as is_read
            FROM messages m
            LEFT JOIN message_reads mr ON m.id = mr.message_id
            WHERE m.customer_phone IN (?, ?, ?, ?)
            ORDER BY m.created_at ASC 
            LIMIT ?`,
            [...phoneVariations, parseInt(limit)]
        );
        
        // Ensure all created_at values are proper ISO strings for frontend IST conversion
        const formattedMessages = messages.map(msg => ({
            ...msg,
            created_at: msg.created_at ? new Date(msg.created_at).toISOString() : null
        }));
        
        // Get customer info
        const customerInfo = await dbAdapter.query(
            `SELECT 
                name, phone, email, order_id, status,
                customer_message, last_response_at, response_count
            FROM store_shoppers 
            WHERE phone IN (?, ?, ?, ?)
            ORDER BY created_at DESC LIMIT 1`,
            [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`]
        );
        
        res.json({
            success: true,
            phone: cleanPhone,
            customer: customerInfo[0] || null,
            messages: formattedMessages
        });
    } catch (error) {
        console.error('Chat history fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

// Send manual reply to customer
router.post('/chat/send', verifyToken, requirePermission('send_messages'), async (req, res) => {
    try {
        const { phone, message, type = 'text', suggestedText = null } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }
        logOperatorActivity(req, 'chat_message', `Sent ${type} message to ${phone}`);
        
        // Normalize phone number
        const cleanPhone = phone.replace(/\D/g, '');
        const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;
        
        // Send message via WhatsApp service
        const whatsappService = require('../services/whatsappService');
        let result;
        
        if (type === 'template' && req.body.templateName) {
            // Send template message (WhatsApp service handles logging automatically with manual_reply type)
            const templateData = {
                name: req.body.templateName,
                language: { code: req.body.language || 'en_US' },
                components: req.body.components || []
            };
            result = await whatsappService.sendTemplate(formattedPhone, templateData, 'manual_reply');
        } else {
            // Send text message (WhatsApp service handles logging automatically with manual_reply type)
            result = await whatsappService.sendMessage(formattedPhone, message, 'manual_reply');
        }
        
        // Update shopper record if exists
        await dbAdapter.query(
            `UPDATE store_shoppers 
             SET last_response_at = ?,
                 response_count = COALESCE(response_count, 0) + 1
             WHERE phone = ? OR phone = ?`,
            [new Date().toISOString(), formattedPhone, cleanPhone]
        );
        
        // AI learning: pair this human reply with the customer's latest question
        // so future suggestions imitate approved answers (fire-and-forget).
        // suggestedText tells us if an AI draft was accepted as-is or corrected.
        if (type === 'text') {
            const aiLearning = require('../services/ai/learning');
            aiLearning.learnFromAgentReply({ phone: cleanPhone, replyText: message, suggestedText }).catch(() => {});
        }
        
        res.json({
            success: true,
            message: 'Message sent successfully',
            messageId: result?.messages?.[0]?.id || null
        });
    } catch (error) {
        console.error('Manual reply error:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

// Mark all messages for a phone as read
router.post('/chat/mark-read/:phone', verifyToken, async (req, res) => {
    try {
        const { phone } = req.params;
        const cleanPhone = phone.replace(/\D/g, '');
        
        console.log(`[Mark Read] Processing phone: ${phone}, cleanPhone: ${cleanPhone}`);

        // Find all unread incoming messages for this phone
        const unreadMessages = await dbAdapter.query(
            `SELECT m.id FROM messages m
             LEFT JOIN message_reads mr ON m.id = mr.message_id
             WHERE m.customer_phone IN (?, ?, ?, ?)
               AND m.message_type = 'incoming'
               AND mr.id IS NULL`,
            [cleanPhone, `+${cleanPhone}`, `91${cleanPhone}`, `+91${cleanPhone}`]
        );
        
        console.log(`[Mark Read] Found ${unreadMessages?.length || 0} unread messages`);

        if (!unreadMessages || unreadMessages.length === 0) {
            return res.json({ success: true, marked: 0 });
        }

        // Batch insert read status for all unread messages (much faster than individual inserts)
        const now = new Date().toISOString();
        let markedCount = 0;
        
        // Insert in batches of 50 to avoid overwhelming the database
        const batchSize = 50;
        for (let i = 0; i < unreadMessages.length; i += batchSize) {
            const batch = unreadMessages.slice(i, i + batchSize);
            
            // Build batch INSERT with placeholders: (?, ?, ?), (?, ?, ?), ...
            const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
            const params = batch.flatMap(msg => [msg.id, now, 'admin']);
            
            try {
                await dbAdapter.query(
                    `INSERT INTO message_reads (message_id, read_at, read_by) VALUES ${placeholders} ON CONFLICT (message_id) DO NOTHING`,
                    params
                );
                markedCount += batch.length;
            } catch (insertErr) {
                console.error('Batch mark read error:', insertErr.message);
            }
        }

        res.json({ success: true, marked: markedCount });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark messages as read' });
    }
});

// Get recently confirmed orders
router.get('/shoppers/recent-confirmed', verifyToken, async (req, res) => {
    try {
        const { limit = 20, offset = 0, startDate, endDate, confirmedBy, paymentMethod, deliveryType, search, dateField = 'updated_at' } = req.query;

        // Validate dateField to prevent SQL injection
        const validDateFields = ['created_at', 'updated_at'];
        const safeDateField = validDateFields.includes(dateField) ? dateField : 'updated_at';

        // Build date filter
        let dateClause = '';
        const dateParams = [];
        if (startDate) {
            const startDateTime = startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
            const utcStartDate = fromISTtoUTC(startDateTime) || startDateTime;
            dateClause += ` AND s.${safeDateField} >= ?`;
            dateParams.push(utcStartDate);
        }
        if (endDate) {
            const endDateTime = endDate.includes('T') ? endDate : `${endDate} 23:59:59`;
            const utcEndDate = fromISTtoUTC(endDateTime) || endDateTime;
            dateClause += ` AND s.${safeDateField} <= ?`;
            dateParams.push(utcEndDate);
        }

        // Confirmation method filter
        if (confirmedBy) {
            dateClause += ' AND s.confirmed_by = ?';
            dateParams.push(confirmedBy);
        }

        // Payment method filter
        if (paymentMethod) {
            dateClause += ' AND s.payment_method = ?';
            dateParams.push(paymentMethod);
        }

        // Delivery type filter
        if (deliveryType) {
            dateClause += ' AND s.delivery_type = ?';
            dateParams.push(deliveryType);
        }

        // Search filter
        if (search) {
            dateClause += ' AND (s.name LIKE ? OR s.phone LIKE ? OR s.order_id LIKE ?)';
            const searchParam = `%${search}%`;
            dateParams.push(searchParam, searchParam, searchParam);
        }

        // Cleanup script ran 2026-04-29 — duplicates eliminated, skip expensive self-join
        const confirmedSql = `
            SELECT s.id, s.phone, s.name, s.order_id, s.status, s.customer_message,
                   s.last_response_at, s.created_at, s.updated_at, s.order_total, s.delivery_type,
                   s.payment_method, s.items_json, s.email, s.address, s.city, s.province, s.zip,
                   s.confirmed_by,
                   o.awb, o.courier_name, o.status as order_status, o.tracking_url,
                   COALESCE(s.order_total, o.total) as order_total
            FROM store_shoppers s
            LEFT JOIN orders o ON s.order_id = o.order_id
            WHERE s.status = 'confirmed'
              ${dateClause}
            ORDER BY s.updated_at DESC
            LIMIT ? OFFSET ?
        `;
        const shoppers = await dbAdapter.query(confirmedSql, [...dateParams, parseInt(limit), parseInt(offset)]);

        // Get total confirmed count (reuse same filter clauses)
        let countDateClause = '';
        const countParams = [];
        if (startDate) {
            const startDateTime = startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
            const utcSD = fromISTtoUTC(startDateTime) || startDate;
            countDateClause += ` AND ${safeDateField} >= ?`;
            countParams.push(utcSD);
        }
        if (endDate) {
            const endDateTime = endDate.includes('T') ? endDate : `${endDate} 23:59:59`;
            const utcED = fromISTtoUTC(endDateTime) || endDate;
            countDateClause += ` AND ${safeDateField} <= ?`;
            countParams.push(utcED);
        }
        if (confirmedBy) {
            countDateClause += ' AND confirmed_by = ?';
            countParams.push(confirmedBy);
        }
        if (paymentMethod) {
            countDateClause += ' AND payment_method = ?';
            countParams.push(paymentMethod);
        }
        if (deliveryType) {
            countDateClause += ' AND delivery_type = ?';
            countParams.push(deliveryType);
        }
        if (search) {
            countDateClause += ' AND (name LIKE ? OR phone LIKE ? OR order_id LIKE ?)';
            const searchParam = `%${search}%`;
            countParams.push(searchParam, searchParam, searchParam);
        }
        const countSql = `SELECT COUNT(*) as total FROM store_shoppers WHERE status = 'confirmed' ${countDateClause}`;
        const countRes = await dbAdapter.query(countSql, countParams);
        const total = countRes[0]?.total || 0;

        res.json({
            success: true,
            shoppers,
            total,
            page: Math.floor(offset / limit) + 1
        });
    } catch (error) {
        console.error('Recent confirmed fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch recent confirmations' });
    }
});

// Get comprehensive analytics data for Shoppers Hub (Orders-based)
router.get('/analytics/orders', verifyToken, async (req, res) => {
    try {
        const { startDate, endDate, noLimit } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start date and end date are required' });
        }
        
        // Convert IST dates from frontend to UTC for database query
        const utcStartDate = fromISTtoUTC(startDate + ' 00:00:00') || (startDate + ' 00:00:00');
        const utcEndDate = fromISTtoUTC(endDate + ' 23:59:59') || (endDate + ' 23:59:59');
        
        // Build query - NO LIMIT for analytics to get all historical data
        let limitClause = '';
        if (!noLimit || noLimit !== 'true') {
            limitClause = 'LIMIT 500'; // Default limit for regular queries
        }
        
        // Fetch all orders in the date range
        const orders = await dbAdapter.query(`
            SELECT 
                o.id, o.order_id, c.name as customer_name, o.customer_phone, o.status,
                o.total as total_price, o.created_at, o.updated_at
            FROM orders o
            LEFT JOIN customers c ON o.customer_phone = c.phone
            WHERE o.created_at >= ? AND o.created_at <= ?
            ORDER BY o.created_at DESC
            ${limitClause}
        `, [utcStartDate, utcEndDate]);
        
        // Invalidate cache to ensure fresh analytics data
        invalidateCache('stats');
        
        res.json({
            success: true,
            orders: orders || [],
            count: orders ? orders.length : 0
        });
    } catch (error) {
        console.error('Analytics orders error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics data' });
    }
});

// Get chat analytics (response rates, etc.)
router.get('/chat/analytics/overview', verifyToken, async (req, res) => {
    try {
        const { startDate, endDate, noLimit } = req.query;
        
        // Check cache first (3 min TTL for analytics)
        const analyticsCacheKey = `analytics_overview:${startDate || 'all'}:${endDate || 'all'}:${noLimit || 'false'}`;
        const cached = getCached(analyticsCacheKey);
        if (cached) {
            return res.json(cached);
        }
        
        // Build date filter - support custom date range or noLimit for all data
        let dateFilter = "";
        const dateParams = [];
        
        if (startDate && endDate) {
            // Convert IST dates from frontend to UTC for database query
            const utcStartDate = fromISTtoUTC(startDate + ' 00:00:00') || (startDate + ' 00:00:00');
            const utcEndDate = fromISTtoUTC(endDate + ' 23:59:59') || (endDate + ' 23:59:59');
            dateFilter = "WHERE s.created_at >= ? AND s.created_at <= ?";
            dateParams.push(utcStartDate, utcEndDate);
        } else if (!noLimit || noLimit !== 'true') {
            // Default: last 30 days if no date range and noLimit not set
            dateFilter = "WHERE s.created_at >= NOW() - INTERVAL '30 days'";
        }
        // If noLimit=true and no dates, dateFilter stays empty (ALL historical data)
        
        // Same derived 'shipped' semantics as the /shoppers list endpoint:
        // a confirmed shopper whose orders row carries an AWB / shipped status.
        // 'confirmed' therefore only counts confirmed-but-not-yet-shipped shoppers.
        const shippedExpr = `(o.awb IS NOT NULL OR o.status = 'shipped')`;
        
        // Get overall stats - lightweight aggregation
        const stats = await dbAdapter.query(`
            SELECT 
                COUNT(*) as total_orders,
                COUNT(DISTINCT s.phone) as total_shoppers,
                SUM(CASE WHEN s.status = 'confirmed' AND NOT COALESCE(${shippedExpr}, false) THEN 1 ELSE 0 END) as confirmed_count,
                SUM(CASE WHEN s.status = 'confirmed' AND ${shippedExpr} THEN 1 ELSE 0 END) as shipped_count,
                SUM(CASE WHEN s.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
                SUM(CASE WHEN s.status = 'edit_details' THEN 1 ELSE 0 END) as edit_requests_count,
                SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN s.customer_message IS NOT NULL THEN 1 ELSE 0 END) as responded_count,
                AVG(CASE WHEN s.response_count > 0 THEN s.response_count END) as avg_response_count
            FROM store_shoppers s
            LEFT JOIN orders o ON o.order_id = s.order_id
            ${dateFilter}
        `, dateParams);
        
        // Get daily stats with per-status breakdown (IST timezone)
        // created_at is TIMESTAMP (no tz) storing UTC — convert UTC→IST correctly
        const dailyStats = await dbAdapter.query(`
            SELECT 
                TO_CHAR(DATE(s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') as date,
                COUNT(*) as total,
                SUM(CASE WHEN s.status = 'confirmed' AND NOT COALESCE(${shippedExpr}, false) THEN 1 ELSE 0 END) as confirmed,
                SUM(CASE WHEN s.status = 'confirmed' AND ${shippedExpr} THEN 1 ELSE 0 END) as shipped,
                SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN s.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                SUM(CASE WHEN s.status = 'edit_details' THEN 1 ELSE 0 END) as edit_details,
                SUM(CASE WHEN s.status != 'pending' THEN 1 ELSE 0 END) as responded
            FROM store_shoppers s
            LEFT JOIN orders o ON o.order_id = s.order_id
            ${dateFilter}
            GROUP BY DATE(s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')
            ORDER BY date DESC
        `, dateParams);
        
        const response = {
            success: true,
            overview: stats[0] || {},
            daily: dailyStats
        };
        
        // Cache for 15 minutes — analytics queries are expensive
        setCache(analyticsCacheKey, response, 'stats', 15 * 60 * 1000);
        
        res.json(response);
    } catch (error) {
        console.error('Chat analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ============================================
// Follow-Up Campaign Endpoints
// ============================================

// Get all follow-up campaigns
router.get('/follow-up/campaigns', verifyToken, async (req, res) => {
    try {
        const { status, limit } = req.query;
        const result = await followUpService.getCampaigns({ status, limit });
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Follow-up campaigns error:', error);
        res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
});

// Create new follow-up campaign
router.post('/follow-up/campaigns', verifyToken, async (req, res) => {
    try {
        const { name, templateName, messageContent, recipients } = req.body;
        
        // Create campaign
        const result = await followUpService.createCampaign({
            name,
            templateName,
            messageContent,
            createdBy: req.admin?.username || 'admin'
        });
        
        if (!result.success) {
            return res.status(500).json({ error: result.error });
        }
        
        const campaignId = result.campaign.id;
        
        // Add recipients if provided
        if (recipients) {
            let shoppers = [];
            
            if (recipients.type === 'all_pending') {
                // Get all pending shoppers
                const pendingShoppers = await followUpService.getPendingShoppers();
                shoppers = pendingShoppers;
            } else if (recipients.type === 'selected' && recipients.shopperIds) {
                // Get selected shoppers
                for (const shopperId of recipients.shopperIds) {
                    const shopper = await dbAdapter.query(
                        'SELECT * FROM store_shoppers WHERE id = ?',
                        [shopperId]
                    );
                    if (shopper && shopper.length > 0) {
                        shoppers.push(shopper[0]);
                    }
                }
            } else if (recipients.type === 'manual' && recipients.entries) {
                // Process manual entries (phone numbers or order IDs)
                for (const entry of recipients.entries) {
                    // Try to find by phone or order_id
                    let shopper = await dbAdapter.query(
                        'SELECT * FROM store_shoppers WHERE phone = ? OR order_id = ? LIMIT 1',
                        [entry, entry]
                    );
                    if (shopper && shopper.length > 0) {
                        shoppers.push(shopper[0]);
                    }
                }
            } else if (recipients.type === 'imported' && recipients.entries) {
                // Process imported entries
                for (const entry of recipients.entries) {
                    let shopper = await dbAdapter.query(
                        'SELECT * FROM store_shoppers WHERE phone = ? OR order_id = ? LIMIT 1',
                        [entry, entry]
                    );
                    if (shopper && shopper.length > 0) {
                        shoppers.push(shopper[0]);
                    }
                }
            }
            
            // Add shoppers to campaign
            if (shoppers.length > 0) {
                await followUpService.addRecipients(campaignId, shoppers);
            }
        }
        
        res.json(result);
    } catch (error) {
        console.error('Create follow-up campaign error:', error);
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});

// Get campaign details
router.get('/follow-up/campaigns/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const campaignId = parseInt(id);
        
        if (isNaN(campaignId)) {
            return res.status(400).json({ error: 'Invalid campaign ID' });
        }
        
        const result = await followUpService.getCampaignDetails(campaignId);
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(404).json({ error: result.error });
        }
    } catch (error) {
        console.error('Follow-up campaign details error:', error);
        res.status(500).json({ error: 'Failed to fetch campaign details' });
    }
});

// Add recipients to campaign
router.post('/follow-up/campaigns/:id/recipients', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { shoppers } = req.body;
        const campaignId = parseInt(id);
        
        if (isNaN(campaignId)) {
            return res.status(400).json({ error: 'Invalid campaign ID' });
        }
        
        if (!shoppers || !Array.isArray(shoppers) || shoppers.length === 0) {
            return res.status(400).json({ error: 'Shoppers array is required' });
        }
        
        const result = await followUpService.addRecipients(campaignId, shoppers);
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Add recipients error:', error);
        res.status(500).json({ error: 'Failed to add recipients' });
    }
});

// Start/send campaign
router.post('/follow-up/campaigns/:id/send', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const campaignId = parseInt(id);
        
        if (isNaN(campaignId)) {
            return res.status(400).json({ error: 'Invalid campaign ID' });
        }
        logOperatorActivity(req, 'followup_send', `Sent follow-up campaign ${campaignId}`);
        
        const result = await followUpService.sendCampaign(campaignId);
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Send campaign error:', error);
        res.status(500).json({ error: 'Failed to start campaign' });
    }
});

// Pause campaign
router.post('/follow-up/campaigns/:id/pause', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await followUpService.pauseCampaign(parseInt(id));
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Pause campaign error:', error);
        res.status(500).json({ error: 'Failed to pause campaign' });
    }
});

// Resume campaign
router.post('/follow-up/campaigns/:id/resume', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await followUpService.resumeCampaign(parseInt(id));
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Resume campaign error:', error);
        res.status(500).json({ error: 'Failed to resume campaign' });
    }
});

// Delete campaign
router.delete('/follow-up/campaigns/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await followUpService.deleteCampaign(parseInt(id));
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Delete campaign error:', error);
        res.status(500).json({ error: 'Failed to delete campaign' });
    }
});

// Get pending shoppers for selection
router.get('/follow-up/pending-shoppers', verifyToken, async (req, res) => {
    try {
        const { search, startDate, endDate, limit } = req.query;
        const result = await followUpService.getPendingShoppers({
            search,
            startDate,
            endDate,
            limit: limit || 100
        });
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Pending shoppers error:', error);
        res.status(500).json({ error: 'Failed to fetch pending shoppers' });
    }
});

// Import recipients from Excel/CSV
router.post('/follow-up/campaigns/:id/import', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { fileBase64 } = req.body;
        
        if (!fileBase64) {
            return res.status(400).json({ error: 'File data is required' });
        }
        
        // Parse Excel file
        const buffer = Buffer.from(fileBase64, 'base64');
        const workbook = getXlsx().read(buffer, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const data = getXlsx().utils.sheet_to_json(worksheet);
        
        // Extract order IDs or phone numbers
        const orderIds = [];
        const phones = [];
        
        data.forEach(row => {
            const orderIdKey = Object.keys(row).find(key => 
                key.toLowerCase().includes('order') || 
                key.toLowerCase().includes('order_id')
            );
            const phoneKey = Object.keys(row).find(key => 
                key.toLowerCase().includes('phone') || 
                key.toLowerCase().includes('mobile')
            );
            
            if (orderIdKey && row[orderIdKey]) {
                orderIds.push(String(row[orderIdKey]));
            }
            if (phoneKey && row[phoneKey]) {
                phones.push(whatsappService.formatPhoneNumber(String(row[phoneKey])));
            }
        });
        
        // Find matching shoppers
        let shoppers = [];
        if (orderIds.length > 0) {
            const placeholders = orderIds.map(() => '?').join(',');
            shoppers = await dbAdapter.query(
                `SELECT * FROM store_shoppers 
                 WHERE order_id IN (${placeholders}) 
                 AND status = 'pending'`,
                orderIds
            );
        } else if (phones.length > 0) {
            const placeholders = phones.map(() => '?').join(',');
            shoppers = await dbAdapter.query(
                `SELECT * FROM store_shoppers 
                 WHERE phone IN (${placeholders}) 
                 AND status = 'pending'`,
                phones
            );
        }
        
        // Add to campaign
        const result = await followUpService.addRecipients(parseInt(id), shoppers);
        
        res.json({
            success: true,
            parsed: data.length,
            matched: shoppers.length,
            ...result
        });
    } catch (error) {
        console.error('Import recipients error:', error);
        res.status(500).json({ error: 'Failed to import recipients' });
    }
});

// Get follow-up analytics
router.get('/follow-up/analytics', verifyToken, async (req, res) => {
    try {
        const { status } = req.query;
        const result = await followUpService.getAnalytics({ status });
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Follow-up analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Export campaign results
router.get('/follow-up/campaigns/:id/export', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { format = 'xlsx' } = req.query;
        
        const result = await followUpService.getCampaignDetails(parseInt(id));
        
        if (!result.success) {
            return res.status(404).json({ error: result.error });
        }
        
        const exportData = result.recipients.map(r => ({
            'Phone': r.phone,
            'Order ID': r.order_id,
            'Status': r.status,
            'Response Type': r.response_type || '',
            'Sent At': r.sent_at || '',
            'Delivered At': r.delivered_at || '',
            'Read At': r.read_at || '',
            'Responded At': r.responded_at || '',
            'Error': r.error_message || ''
        }));
        
        if (format === 'csv') {
            const ws = getXlsx().utils.json_to_sheet(exportData);
            const csv = getXlsx().utils.sheet_to_csv(ws);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=follow_up_campaign_${id}.csv`);
            return res.send(csv);
        }
        
        // Excel format
        const wb = getXlsx().utils.book_new();
        const ws = getXlsx().utils.json_to_sheet(exportData);
        getXlsx().utils.book_append_sheet(wb, ws, 'Recipients');
        
        const buffer = getXlsx().write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=follow_up_campaign_${id}.xlsx`);
        res.send(buffer);
    } catch (error) {
        console.error('Export campaign error:', error);
        res.status(500).json({ error: 'Failed to export campaign' });
    }
});

// ============================================
// Support Portal Management Endpoints
// ============================================

// Helper to generate a random slug
function generateSlug(name) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const suffix = Math.random().toString(36).substring(2, 8);
    return `${base}-${suffix}`;
}

// Helper to generate a random password
function generatePassword(length = 10) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

// Create a new support portal
router.post('/support-portals', verifyToken, async (req, res) => {
    try {
        const { name, type, password, config } = req.body;

        if (!name || !type) {
            return res.status(400).json({ success: false, error: 'Name and type are required' });
        }

        if (!['manual', 'time_based', 'auto'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid portal type' });
        }

        const slug = generateSlug(name);
        const portalPassword = password || generatePassword();
        const passwordHash = await bcrypt.hash(portalPassword, 10);

        const result = await dbAdapter.run(
            `INSERT INTO support_portals (name, slug, password_hash, type, config) VALUES (?, ?, ?, ?, ?)`,
            [name, slug, passwordHash, type, config ? JSON.stringify(config) : null]
        );

        // Store password in memory so admin can view it later
        const portalId = result.lastInsertRowid;
        portalPasswords.set(String(portalId), portalPassword);

        const portal = await dbAdapter.query(
            'SELECT id, name, slug, type, config, created_at FROM support_portals WHERE id = ?',
            [portalId]
        );

        res.json({
            success: true,
            portal: portal[0],
            password: portalPassword, // Return plain password once for sharing
            url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${slug}`
        });
    } catch (error) {
        console.error('Create support portal error:', error);
        res.status(500).json({ success: false, error: 'Failed to create support portal' });
    }
});

// List all support portals with ticket counts
router.get('/support-portals', verifyToken, async (req, res) => {
    try {
        const portals = await dbAdapter.query(`
            SELECT p.*, 
                   COUNT(t.id) as ticket_count,
                   SUM(CASE WHEN t.status = 'open' THEN 1 ELSE 0 END) as assigned_count
            FROM support_portals p
            LEFT JOIN support_tickets t ON t.portal_id = p.id
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `);

        // For time-based portals, calculate dynamic ticket count
        const enrichedPortals = await Promise.all(portals.map(async (portal) => {
            if (portal.type === 'time_based' && portal.config) {
                try {
                    const config = typeof portal.config === 'string' ? JSON.parse(portal.config) : portal.config;
                    const rangeClause = timeRangeSqlClause(config);
                    if (rangeClause) {
                        // Count ALL unassigned tickets whose IST created-time falls in the range.
                        // Done in SQL so the count reflects every matching ticket, not just the
                        // newest 500 rows (which severely undercounted with thousands of tickets).
                        const [row] = await dbAdapter.query(
                            `SELECT COUNT(*) AS ticket_count,
                                    COUNT(*) FILTER (WHERE status = 'open') AS open_count
                             FROM support_tickets
                             WHERE portal_id IS NULL AND ${rangeClause}`
                        );

                        return {
                            ...portal,
                            ticket_count: Number(row?.ticket_count || 0),
                            assigned_count: Number(row?.open_count || 0),
                            config,
                            url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${portal.slug}`
                        };
                    }
                } catch (e) {
                    console.error('Error calculating time-based portal count:', e);
                }
            }
            
            return {
                ...portal,
                config: typeof portal.config === 'string' ? JSON.parse(portal.config) : portal.config,
                url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${portal.slug}`
            };
        }));

        res.json({
            success: true,
            portals: enrichedPortals
        });
    } catch (error) {
        console.error('List support portals error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch support portals' });
    }
});

// Delete a support portal
router.delete('/support-portals/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Clear portal_id from assigned tickets
        await dbAdapter.run(
            'UPDATE support_tickets SET portal_id = NULL WHERE portal_id = ?',
            [id]
        );

        await dbAdapter.run(
            'DELETE FROM support_portals WHERE id = ?',
            [id]
        );

        invalidateCache('stats');
        res.json({ success: true, message: 'Portal deleted successfully' });
    } catch (error) {
        console.error('Delete support portal error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete support portal' });
    }
});

// Manually assign tickets to a portal
router.post('/support-portals/:id/assign', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { ticketIds } = req.body;

        if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
            return res.status(400).json({ success: false, error: 'Ticket IDs are required' });
        }

        const placeholders = ticketIds.map(() => '?').join(',');
        await dbAdapter.run(
            `UPDATE support_tickets SET portal_id = ? WHERE id IN (${placeholders})`,
            [id, ...ticketIds]
        );

        // Update assigned_count for the portal
        const countResult = await dbAdapter.query(
            'SELECT COUNT(*) as count FROM support_tickets WHERE portal_id = ? AND status = \'open\'',
            [id]
        );
        const newCount = countResult[0]?.count || 0;
        await dbAdapter.run(
            'UPDATE support_portals SET assigned_count = ? WHERE id = ?',
            [newCount, id]
        );

        invalidateCache('stats');
        res.json({ success: true, message: `${ticketIds.length} tickets assigned to portal` });
    } catch (error) {
        console.error('Assign tickets error:', error);
        res.status(500).json({ success: false, error: 'Failed to assign tickets' });
    }
});

// Clear all ticket assignments from a portal
router.post('/support-portals/:id/clear', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        await dbAdapter.run(
            'UPDATE support_tickets SET portal_id = NULL WHERE portal_id = ?',
            [id]
        );

        invalidateCache('stats');
        res.json({ success: true, message: 'All tickets cleared from portal' });
    } catch (error) {
        console.error('Clear portal tickets error:', error);
        res.status(500).json({ success: false, error: 'Failed to clear tickets' });
    }
});

// Helper: resolve the tickets that currently belong to a portal (returns row objects).
// Works for all portal types: manual/auto own tickets via portal_id, time-based match by
// created time (excluding tickets already assigned elsewhere).
async function getPortalTicketRows(portal, onlyOpen = true) {
    const statusClause = onlyOpen ? " AND status = 'open'" : "";
    if (portal.type === 'time_based') {
        const config = portal.config
            ? (typeof portal.config === 'string' ? JSON.parse(portal.config) : portal.config)
            : {};
        const rangeClause = timeRangeSqlClause(config);
        // Only unassigned tickets are part of a time-based portal's shared pool. Filter the
        // time window in SQL so a split distributes ALL matching tickets, not just recent rows.
        const rangeSql = rangeClause ? ` AND (${rangeClause})` : '';
        return await dbAdapter.query(
            `SELECT id, created_at, status, portal_id FROM support_tickets WHERE portal_id IS NULL${statusClause}${rangeSql} ORDER BY created_at DESC`
        );
    }
    return await dbAdapter.query(
        `SELECT id, created_at, status, portal_id FROM support_tickets WHERE portal_id = ?${statusClause} ORDER BY created_at DESC LIMIT 1000`,
        [portal.id]
    );
}

// Split a portal into N portals with even (round-robin) ticket distribution.
// Typical use: turn one time-based portal into 2 portals sharing its load evenly.
router.post('/support-portals/:id/split', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { count = 2, namePrefix, keepSource = false, onlyOpen = true } = req.body;

        const splitCount = parseInt(count);
        if (!splitCount || splitCount < 2 || splitCount > 10) {
            return res.status(400).json({ success: false, error: 'Split count must be between 2 and 10' });
        }

        const portals = await dbAdapter.query('SELECT * FROM support_portals WHERE id = ?', [id]);
        if (!portals || portals.length === 0) {
            return res.status(404).json({ success: false, error: 'Portal not found' });
        }
        const source = portals[0];

        // Resolve the tickets currently belonging to the source portal
        const tickets = await getPortalTicketRows(source, onlyOpen);
        if (!tickets || tickets.length === 0) {
            return res.status(400).json({ success: false, error: 'Source portal has no tickets to split' });
        }

        // Create N new portals that own tickets explicitly via portal_id
        const prefix = (namePrefix && String(namePrefix).trim()) || source.name;
        const createdPortals = [];
        for (let i = 0; i < splitCount; i++) {
            const name = `${prefix} ${i + 1}`;
            const slug = generateSlug(name);
            const password = generatePassword();
            const passwordHash = await bcrypt.hash(password, 10);

            const rows = await dbAdapter.query(
                `INSERT INTO support_portals (name, slug, password_hash, type, is_active, assigned_count)
                 VALUES (?, ?, ?, 'manual', true, 0) RETURNING id`,
                [name, slug, passwordHash]
            );
            const newId = rows[0].id;
            portalPasswords.set(String(newId), password);

            createdPortals.push({
                id: newId,
                name,
                slug,
                password,
                url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${slug}`,
                ticketCount: 0
            });
        }

        // Distribute tickets evenly (round-robin)
        for (let i = 0; i < tickets.length; i++) {
            const target = createdPortals[i % splitCount];
            await dbAdapter.run('UPDATE support_tickets SET portal_id = ? WHERE id = ?', [target.id, tickets[i].id]);
            target.ticketCount++;
        }

        // Persist assigned counts
        for (const p of createdPortals) {
            await dbAdapter.run('UPDATE support_portals SET assigned_count = ? WHERE id = ?', [p.ticketCount, p.id]);
        }

        // Optionally remove the source portal (its tickets are now explicitly assigned)
        if (!keepSource) {
            await dbAdapter.run('DELETE FROM support_portals WHERE id = ?', [source.id]);
            portalPasswords.delete(String(source.id));
        }

        await dbAdapter.run(
            'INSERT INTO distribution_history (distribution_type, portal_count, ticket_count, filters_applied) VALUES (?, ?, ?, ?)',
            ['split', createdPortals.length, tickets.length, JSON.stringify({ sourcePortalId: source.id, sourceName: source.name, keepSource, onlyOpen })]
        );

        invalidateCache('stats');
        res.json({
            success: true,
            message: `${tickets.length} tickets split evenly across ${createdPortals.length} portals`,
            portals: createdPortals,
            stats: {
                totalTickets: tickets.length,
                totalPortals: createdPortals.length,
                distributionMode: 'split'
            }
        });
    } catch (error) {
        console.error('Split portal error:', error);
        res.status(500).json({ success: false, error: 'Failed to split portal' });
    }
});

// Transfer tickets from one portal to another.
// Accepts either explicit ticketIds, a count (oldest-first), or moves all tickets.
router.post('/support-portals/transfer', verifyToken, async (req, res) => {
    try {
        const { fromPortalId, toPortalId, ticketIds, count, onlyOpen = true } = req.body;

        if (!fromPortalId || !toPortalId) {
            return res.status(400).json({ success: false, error: 'Source and destination portals are required' });
        }
        if (String(fromPortalId) === String(toPortalId)) {
            return res.status(400).json({ success: false, error: 'Source and destination must be different portals' });
        }

        const dest = await dbAdapter.query('SELECT id FROM support_portals WHERE id = ?', [toPortalId]);
        if (!dest || dest.length === 0) {
            return res.status(404).json({ success: false, error: 'Destination portal not found' });
        }
        const fromPortals = await dbAdapter.query('SELECT * FROM support_portals WHERE id = ?', [fromPortalId]);
        if (!fromPortals || fromPortals.length === 0) {
            return res.status(404).json({ success: false, error: 'Source portal not found' });
        }
        const source = fromPortals[0];

        // Determine which ticket ids to move
        let idsToMove = [];
        if (Array.isArray(ticketIds) && ticketIds.length > 0) {
            idsToMove = ticketIds;
        } else {
            const tickets = await getPortalTicketRows(source, onlyOpen);
            // Oldest first (FIFO) so the longest-waiting tickets move first
            tickets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            const n = count ? Math.min(parseInt(count), tickets.length) : tickets.length;
            idsToMove = tickets.slice(0, n).map(t => t.id);
        }

        if (idsToMove.length === 0) {
            return res.status(400).json({ success: false, error: 'No tickets available to transfer' });
        }

        const placeholders = idsToMove.map(() => '?').join(',');
        await dbAdapter.run(
            `UPDATE support_tickets SET portal_id = ? WHERE id IN (${placeholders})`,
            [toPortalId, ...idsToMove]
        );

        // Recalculate assigned (open) counts for both portals
        for (const pid of [fromPortalId, toPortalId]) {
            const c = await dbAdapter.query(
                "SELECT COUNT(*) as count FROM support_tickets WHERE portal_id = ? AND status = 'open'",
                [pid]
            );
            await dbAdapter.run('UPDATE support_portals SET assigned_count = ? WHERE id = ?', [c[0]?.count || 0, pid]);
        }

        await dbAdapter.run(
            'INSERT INTO distribution_history (distribution_type, portal_count, ticket_count, filters_applied) VALUES (?, ?, ?, ?)',
            ['transfer', 2, idsToMove.length, JSON.stringify({ fromPortalId, toPortalId })]
        );

        invalidateCache('stats');
        res.json({ success: true, message: `${idsToMove.length} ticket(s) transferred`, transferred: idsToMove.length });
    } catch (error) {
        console.error('Transfer tickets error:', error);
        res.status(500).json({ success: false, error: 'Failed to transfer tickets' });
    }
});

// Auto-distribute open tickets into N portals with advanced features
router.post('/support-portals/auto-distribute', verifyToken, async (req, res) => {
    try {
        const { 
            count, 
            namePrefix,
            distributionMode = 'round_robin',
            filters = {},
            shifts = [],
            portalSettings = {}
        } = req.body;

        const isShiftDistribution = distributionMode === 'shift_based';
        const normalizedShifts = Array.isArray(shifts)
            ? shifts.map((shift, index) => {
                const rawPortalCount = parseInt(shift.portalCount || shift.count || 1);
                return {
                    name: String(shift.name || `Shift ${index + 1}`).trim(),
                    prefix: String(shift.prefix || shift.name || namePrefix || 'Agent').trim(),
                    start: shift.start,
                    end: shift.end,
                    portalCount: Number.isFinite(rawPortalCount) ? Math.max(1, rawPortalCount) : 1
                };
            })
            : [];
        const totalShiftPortals = normalizedShifts.reduce((sum, shift) => sum + shift.portalCount, 0);

        if (isShiftDistribution) {
            if (normalizedShifts.length === 0) {
                return res.status(400).json({ success: false, error: 'At least one time period is required' });
            }
            if (totalShiftPortals < 1 || totalShiftPortals > 50) {
                return res.status(400).json({ success: false, error: 'Shift-based distribution supports 1 to 50 total portals' });
            }
            for (const shift of normalizedShifts) {
                if (!shift.start || !shift.end) {
                    return res.status(400).json({ success: false, error: 'Each time period requires a start and end time' });
                }
            }
        } else if (!count || count < 2 || count > 20) {
            return res.status(400).json({ success: false, error: 'Count must be between 2 and 20' });
        }

        // Build ticket query based on filters
        let ticketQuery = "SELECT id, created_at, status FROM support_tickets WHERE status = 'open'";
        const queryParams = [];

        // Apply date/time filters
        if (filters.dateFrom) {
            ticketQuery += " AND DATE(created_at) >= ?";
            queryParams.push(filters.dateFrom);
        }
        if (filters.dateTo) {
            ticketQuery += " AND DATE(created_at) <= ?";
            queryParams.push(filters.dateTo);
        }
        if (filters.timeFrom) {
            ticketQuery += " AND TIME(created_at) >= ?";
            queryParams.push(filters.timeFrom);
        }
        if (filters.timeTo) {
            ticketQuery += " AND TIME(created_at) <= ?";
            queryParams.push(filters.timeTo);
        }

        ticketQuery += " ORDER BY created_at DESC";

        const openTickets = await dbAdapter.query(ticketQuery, queryParams);

        if (!openTickets || openTickets.length === 0) {
            return res.status(400).json({ success: false, error: 'No tickets match the specified filters' });
        }

        const createdPortals = [];
        const shiftPortalGroups = [];
        const maxTickets = portalSettings.maxTickets || null;

        // Create portals based on distribution mode
        if (isShiftDistribution) {
            // Create one or more portals for each time period. Tickets inside a period
            // are distributed only across that period's portals to avoid cross-shift mixing.
            for (let i = 0; i < normalizedShifts.length; i++) {
                const shift = normalizedShifts[i];
                const group = { shift, portals: [], nextIndex: 0 };

                for (let portalIndex = 0; portalIndex < shift.portalCount; portalIndex++) {
                    const name = shift.portalCount > 1
                        ? `${shift.prefix} ${portalIndex + 1}`
                        : shift.prefix;
                    const slug = generateSlug(name);
                    const password = generatePassword();
                    const passwordHash = await bcrypt.hash(password, 10);

                    const distributionRule = JSON.stringify({
                        shift_name: shift.name,
                        shift_start: shift.start,
                        shift_end: shift.end,
                        shift_portal_count: shift.portalCount,
                        shift_portal_index: portalIndex + 1,
                        date_from: filters.dateFrom || null,
                        date_to: filters.dateTo || null,
                        status_filter: filters.statusFilter || ['open']
                    });

                    const result = await dbAdapter.run(
                        `INSERT INTO support_portals (name, slug, password_hash, type, config, max_tickets, shift_start, shift_end, is_active, distribution_rule, assigned_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [name, slug, passwordHash, 'auto', JSON.stringify({ shift, shiftPortalIndex: portalIndex + 1 }), maxTickets, shift.start, shift.end, 1, distributionRule, 0]
                    );

                    const portal = {
                        id: result.lastInsertRowid,
                        name,
                        slug,
                        password,
                        url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${slug}`,
                        shift,
                        maxTickets,
                        ticketCount: 0
                    };

                    createdPortals.push(portal);
                    group.portals.push(portal);
                }

                shiftPortalGroups.push(group);
            }
        } else {
            // Create N portals (round_robin, filter_based, workload_balanced)
            for (let i = 0; i < count; i++) {
                const name = `${namePrefix || 'Portal'} ${i + 1}`;
                const slug = generateSlug(name);
                const password = generatePassword();
                const passwordHash = await bcrypt.hash(password, 10);

                const distributionRule = JSON.stringify({
                    date_from: filters.dateFrom || null,
                    date_to: filters.dateTo || null,
                    time_from: filters.timeFrom || null,
                    time_to: filters.timeTo || null,
                    status_filter: filters.statusFilter || ['open']
                });

                const result = await dbAdapter.run(
                    `INSERT INTO support_portals (name, slug, password_hash, type, config, max_tickets, is_active, distribution_rule, assigned_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [name, slug, passwordHash, 'auto', null, maxTickets, 1, distributionRule, 0]
                );

                createdPortals.push({
                    id: result.lastInsertRowid,
                    name,
                    slug,
                    password,
                    url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${slug}`,
                    maxTickets,
                    ticketCount: 0
                });
            }
        }

        // Distribute tickets based on mode
        let distributionStats = {};

        if (isShiftDistribution) {
            // Shift-based distribution: match each ticket to its time period, then
            // evenly round-robin within that period's own portals.
            for (const ticket of openTickets) {
                const matchedShift = matchTicketToShift(ticket.created_at, normalizedShifts);
                if (!matchedShift) continue;

                const group = shiftPortalGroups.find(g => g.shift === matchedShift);
                if (!group || group.portals.length === 0) continue;

                let targetPortal = null;
                for (let attempt = 0; attempt < group.portals.length; attempt++) {
                    const candidate = group.portals[group.nextIndex % group.portals.length];
                    group.nextIndex++;

                    if (!maxTickets || candidate.ticketCount < maxTickets) {
                        targetPortal = candidate;
                        break;
                    }
                }

                if (targetPortal) {
                    await dbAdapter.run(
                        'UPDATE support_tickets SET portal_id = ? WHERE id = ?',
                        [targetPortal.id, ticket.id]
                    );
                    targetPortal.ticketCount++;
                }
            }
        } else if (distributionMode === 'workload_balanced') {
            // Workload-balanced distribution
            for (const ticket of openTickets) {
                // Find portal with least tickets
                let minPortal = createdPortals[0];
                let minCount = createdPortals[0].ticketCount;

                for (const portal of createdPortals) {
                    if (portal.ticketCount < minCount) {
                        if (!maxTickets || portal.ticketCount < maxTickets) {
                            minPortal = portal;
                            minCount = portal.ticketCount;
                        }
                    }
                }

                if (minPortal && (!maxTickets || minPortal.ticketCount < maxTickets)) {
                    await dbAdapter.run(
                        'UPDATE support_tickets SET portal_id = ? WHERE id = ?',
                        [minPortal.id, ticket.id]
                    );
                    minPortal.ticketCount++;
                }
            }
        } else {
            // Round-robin or filter-based (even distribution)
            for (let i = 0; i < openTickets.length; i++) {
                const portalIndex = i % count;
                if (!maxTickets || createdPortals[portalIndex].ticketCount < maxTickets) {
                    await dbAdapter.run(
                        'UPDATE support_tickets SET portal_id = ? WHERE id = ?',
                        [createdPortals[portalIndex].id, openTickets[i].id]
                    );
                    createdPortals[portalIndex].ticketCount++;
                }
            }
        }

        // Update assigned_count in database
        for (const portal of createdPortals) {
            await dbAdapter.run(
                'UPDATE support_portals SET assigned_count = ? WHERE id = ?',
                [portal.ticketCount, portal.id]
            );
        }

        // Record distribution in history
        await dbAdapter.run(
            'INSERT INTO distribution_history (distribution_type, portal_count, ticket_count, filters_applied) VALUES (?, ?, ?, ?)',
            [distributionMode, createdPortals.length, openTickets.length, JSON.stringify({ filters, shifts: normalizedShifts.length > 0 ? normalizedShifts : shifts, portalSettings })]
        );

        invalidateCache('stats');
        res.json({
            success: true,
            message: `${openTickets.length} tickets distributed across ${createdPortals.length} portals`,
            portals: createdPortals,
            stats: {
                totalTickets: openTickets.length,
                totalPortals: createdPortals.length,
                distributionMode,
                portalBreakdown: createdPortals.map(p => ({
                    name: p.name,
                    ticketCount: p.ticketCount,
                    capacity: maxTickets || 'unlimited',
                    utilization: maxTickets ? Math.round((p.ticketCount / maxTickets) * 100) : null
                }))
            }
        });
    } catch (error) {
        console.error('Auto-distribute error:', error);
        res.status(500).json({ success: false, error: 'Failed to auto-distribute tickets' });
    }
});

// Helper function to match ticket to shift
function matchTicketToShift(ticketCreatedAt, shifts) {
    const ticketDate = new Date(ticketCreatedAt);
    const ticketHour = ticketDate.getHours();
    const ticketMinute = ticketDate.getMinutes();
    const ticketTime = ticketHour * 60 + ticketMinute;

    for (const shift of shifts) {
        const [startH, startM] = shift.start.split(':').map(Number);
        const [endH, endM] = shift.end.split(':').map(Number);
        const startTime = startH * 60 + startM;
        const endTime = endH * 60 + endM;

        // Handle overnight shifts (e.g., 17:00 - 01:00)
        if (endTime < startTime) {
            if (ticketTime >= startTime || ticketTime < endTime) {
                return shift;
            }
        } else {
            if (ticketTime >= startTime && ticketTime < endTime) {
                return shift;
            }
        }
    }
    return null;
}

// Get distribution statistics
router.get('/support-portals/distribution-stats', verifyToken, async (req, res) => {
    try {
        const history = await dbAdapter.query(
            'SELECT * FROM distribution_history ORDER BY created_at DESC LIMIT 50'
        );

        const portalStats = await dbAdapter.query(
            `SELECT 
                id, name, max_tickets, assigned_count, shift_start, shift_end, is_active,
                CASE 
                    WHEN max_tickets > 0 THEN ROUND((assigned_count * 100.0 / max_tickets), 1)
                    ELSE 0
                END as utilization_percent
            FROM support_portals 
            WHERE type = 'auto' 
            ORDER BY created_at DESC`
        );

        res.json({
            success: true,
            history,
            portalStats,
            summary: {
                totalDistributions: history.length,
                totalPortals: portalStats.length,
                avgUtilization: portalStats.length > 0 
                    ? Math.round(portalStats.reduce((sum, p) => sum + parseFloat(p.utilization_percent), 0) / portalStats.length)
                    : 0
            }
        });
    } catch (error) {
        console.error('Distribution stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch distribution stats' });
    }
});

// Update portal distribution rules
router.post('/support-portals/:id/update-rules', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { maxTickets, shiftStart, shiftEnd, isActive, distributionRule, priorityLevel } = req.body;

        const updates = [];
        const values = [];

        if (maxTickets !== undefined) {
            updates.push('max_tickets = ?');
            values.push(maxTickets);
        }
        if (shiftStart !== undefined) {
            updates.push('shift_start = ?');
            values.push(shiftStart);
        }
        if (shiftEnd !== undefined) {
            updates.push('shift_end = ?');
            values.push(shiftEnd);
        }
        if (isActive !== undefined) {
            updates.push('is_active = ?');
            values.push(isActive ? 1 : 0);
        }
        if (distributionRule !== undefined) {
            updates.push('distribution_rule = ?');
            values.push(JSON.stringify(distributionRule));
        }
        if (priorityLevel !== undefined) {
            updates.push('priority_level = ?');
            values.push(priorityLevel);
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'No updates provided' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);

        await dbAdapter.run(
            `UPDATE support_portals SET ${updates.join(', ')} WHERE id = ?`,
            values
        );

        invalidateCache('stats');
        res.json({ success: true, message: 'Portal rules updated successfully' });
    } catch (error) {
        console.error('Update portal rules error:', error);
        res.status(500).json({ success: false, error: 'Failed to update portal rules' });
    }
});

// Rebalance tickets across existing portals
router.post('/support-portals/rebalance', verifyToken, async (req, res) => {
    try {
        const { portalIds } = req.body;

        // Get all active auto portals
        const portals = await dbAdapter.query(
            "SELECT id, max_tickets FROM support_portals WHERE type = 'auto' AND is_active = true" +
            (portalIds && portalIds.length > 0 ? ` AND id IN (${portalIds.join(',')})` : '')
        );

        if (portals.length < 2) {
            return res.status(400).json({ success: false, error: 'Need at least 2 active portals to rebalance' });
        }

        // Get all unassigned or assigned tickets from these portals
        const portalIdList = portals.map(p => p.id).join(',');
        const tickets = await dbAdapter.query(
            `SELECT id FROM support_tickets WHERE portal_id IN (${portalIdList}) AND status = 'open' ORDER BY created_at`
        );

        if (tickets.length === 0) {
            return res.status(400).json({ success: false, error: 'No tickets to rebalance' });
        }

        // Clear current assignments
        await dbAdapter.run(
            `UPDATE support_tickets SET portal_id = NULL WHERE portal_id IN (${portalIdList}) AND status = 'open'`
        );

        // Reset assigned counts
        for (const portal of portals) {
            await dbAdapter.run('UPDATE support_portals SET assigned_count = 0 WHERE id = ?', [portal.id]);
        }

        // Redistribute using workload-balanced algorithm
        const portalStats = portals.map(p => ({
            id: p.id,
            maxTickets: p.max_tickets,
            ticketCount: 0
        }));

        for (const ticket of tickets) {
            // Find portal with least tickets
            let minPortal = portalStats[0];
            for (const portal of portalStats) {
                if (portal.ticketCount < minPortal.ticketCount) {
                    if (!portal.maxTickets || portal.ticketCount < portal.maxTickets) {
                        minPortal = portal;
                    }
                }
            }

            if (minPortal && (!minPortal.maxTickets || minPortal.ticketCount < minPortal.maxTickets)) {
                await dbAdapter.run(
                    'UPDATE support_tickets SET portal_id = ? WHERE id = ?',
                    [minPortal.id, ticket.id]
                );
                minPortal.ticketCount++;
            }
        }

        // Update assigned counts
        for (const portal of portalStats) {
            await dbAdapter.run(
                'UPDATE support_portals SET assigned_count = ? WHERE id = ?',
                [portal.ticketCount, portal.id]
            );
        }

        // Record in history
        await dbAdapter.run(
            'INSERT INTO distribution_history (distribution_type, portal_count, ticket_count, filters_applied) VALUES (?, ?, ?, ?)',
            ['rebalance', portals.length, tickets.length, JSON.stringify({ portalIds })]
        );

        invalidateCache('stats');
        res.json({
            success: true,
            message: `${tickets.length} tickets rebalanced across ${portals.length} portals`,
            stats: portalStats.map(p => ({
                portalId: p.id,
                ticketCount: p.ticketCount
            }))
        });
    } catch (error) {
        console.error('Rebalance error:', error);
        res.status(500).json({ success: false, error: 'Failed to rebalance tickets' });
    }
});

// Get currently active shifts
router.get('/support-portals/active-shifts', verifyToken, async (req, res) => {
    try {
        const now = new Date();
        const currentTime = now.getHours() * 60 + now.getMinutes();

        const portals = await dbAdapter.query(
            "SELECT id, name, shift_start, shift_end, is_active, assigned_count, max_tickets FROM support_portals WHERE type = 'auto' AND is_active = true"
        );

        const activePortals = portals.filter(portal => {
            if (!portal.shift_start || !portal.shift_end) return true; // No shift time = always active

            const [startH, startM] = portal.shift_start.split(':').map(Number);
            const [endH, endM] = portal.shift_end.split(':').map(Number);
            const startTime = startH * 60 + startM;
            const endTime = endH * 60 + endM;

            if (endTime < startTime) {
                return currentTime >= startTime || currentTime < endTime;
            } else {
                return currentTime >= startTime && currentTime < endTime;
            }
        });

        res.json({
            success: true,
            activePortals,
            totalPortals: portals.length,
            currentTime: now.toTimeString().slice(0, 5)
        });
    } catch (error) {
        console.error('Active shifts error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch active shifts' });
    }
});

// Get last known password for a support portal
router.get('/support-portals/:id/password', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const password = portalPasswords.get(String(id));

        if (!password) {
            return res.json({
                success: true,
                password: null,
                message: 'Password not available. Change the password to set a new one.'
            });
        }

        res.json({ success: true, password });
    } catch (error) {
        console.error('Get portal password error:', error);
        res.status(500).json({ success: false, error: 'Failed to retrieve password' });
    }
});

// Change support portal password
router.put('/support-portals/:id/password', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }

        const portal = await dbAdapter.query('SELECT id FROM support_portals WHERE id = ?', [id]);
        if (!portal || portal.length === 0) {
            return res.status(404).json({ success: false, error: 'Portal not found' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await dbAdapter.run(
            'UPDATE support_portals SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [passwordHash, id]
        );

        // Store new password in memory so admin can view it
        portalPasswords.set(String(id), newPassword);

        res.json({
            success: true,
            message: 'Password updated successfully',
            password: newPassword // Return once so admin can share with agent
        });
    } catch (error) {
        console.error('Change portal password error:', error);
        res.status(500).json({ success: false, error: 'Failed to change password' });
    }
});

// ============================================================
// SHIPPING MODULE (Shopper Hub) — carrier-agnostic shipping API
// ============================================================
const shippingService = require('../services/shippingService');

// Configured carriers + their capabilities (drives the UI carrier cards)
router.get('/shipping/carriers', verifyToken, async (req, res) => {
    try {
        res.json({ success: true, carriers: shippingService.getConfiguredCarriers() });
    } catch (error) {
        console.error('Shipping carriers error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch carriers' });
    }
});

// Order lookup for forward shipments — search by order ID / name / phone / AWB.
// Returns shippable candidates with their consignee details and shipment state,
// so the "New Shipment" flow can auto-grab everything from just an order ID.
router.get('/shipping/orders/lookup', verifyToken, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ success: true, orders: [] });

        const like = `%${q}%`;
        const rows = await dbAdapter.query(`
            SELECT s.id AS shopper_id, s.order_id, s.name, s.phone, s.address, s.city, s.province, s.zip,
                   s.status AS shopper_status, s.payment_method, s.items_json,
                   COALESCE(s.order_total, o.total) AS order_total,
                   s.created_at,
                   act.id AS active_shipment_id, act.status AS active_shipment_status,
                   act.awb AS active_awb, act.carrier AS active_carrier,
                   last_sh.status AS last_shipment_status, last_sh.carrier AS last_shipment_carrier,
                   last_sh.error_message AS last_shipment_error
            FROM store_shoppers s
            INNER JOIN (
                SELECT order_id, MAX(updated_at) AS max_updated
                FROM store_shoppers
                GROUP BY order_id
            ) latest ON latest.order_id = s.order_id AND s.updated_at = latest.max_updated
            LEFT JOIN orders o ON o.order_id = s.order_id
            LEFT JOIN LATERAL (
                SELECT id, status, awb, carrier FROM shipments sp
                WHERE sp.order_id = s.order_id AND sp.status NOT IN ('cancelled', 'failed')
                ORDER BY sp.id DESC LIMIT 1
            ) act ON TRUE
            LEFT JOIN LATERAL (
                SELECT status, carrier, error_message FROM shipments sp2
                WHERE sp2.order_id = s.order_id
                ORDER BY sp2.id DESC LIMIT 1
            ) last_sh ON TRUE
            WHERE (s.order_id ILIKE ? OR s.name ILIKE ? OR s.phone ILIKE ? OR o.awb ILIKE ?)
            ORDER BY s.updated_at DESC
            LIMIT 10
        `, [like, like, like, like]);

        res.json({ success: true, orders: rows });
    } catch (error) {
        console.error('Shipping order lookup error:', error);
        res.status(500).json({ success: false, error: 'Order lookup failed' });
    }
});

// Prefilled shipment draft for admin review/edit before shipping
router.get('/shipping/orders/:shopperId/draft', verifyToken, async (req, res) => {
    try {
        const result = await shippingService.buildShipmentContext(req.params.shopperId);
        if (result.error) return res.status(result.status || 500).json({ success: false, error: result.error });

        // Include any existing shipments so the UI can show history/blockers
        const shipments = await shippingService.listShipments({ orderId: result.ctx.orderId, limit: 20 });
        res.json({ success: true, draft: result.ctx, shipments });
    } catch (error) {
        console.error('Shipping draft error:', error);
        res.status(500).json({ success: false, error: 'Failed to build shipment draft' });
    }
});

// Serviceability + rate cards for a carrier
router.post('/shipping/serviceability', verifyToken, async (req, res) => {
    try {
        const { shopperId, carrier, packageOverrides, consigneeOverrides } = req.body;
        if (!shopperId || !carrier) return res.status(400).json({ success: false, error: 'shopperId and carrier are required' });

        const result = await shippingService.checkServiceability({ shopperId, carrier, packageOverrides, consigneeOverrides });
        if (result.error) return res.status(result.status || 500).json({ success: false, error: result.error });
        res.json({ success: true, ...result.data });
    } catch (error) {
        console.error('Shipping serviceability error:', error);
        res.status(500).json({ success: false, error: 'Serviceability check failed' });
    }
});

// Create shipment (idempotent — 409 if an active shipment exists).
// Re-ship: reshipOfShipmentId + reshipReason link the new shipment to the one
// it replaces (audit trail + replacement-worded WhatsApp notification).
router.post('/shipping/ship', verifyToken, requirePermission('ship_orders'), async (req, res) => {
    try {
        const { shopperId, carrier, courierId, packageOverrides, consigneeOverrides, notifyCustomer, reshipOfShipmentId, reshipReason } = req.body;
        if (!shopperId || !carrier) return res.status(400).json({ success: false, error: 'shopperId and carrier are required' });
        logOperatorActivity(req, 'ship_order', `Shipped shopper ${shopperId} via ${carrier}`);

        const result = await shippingService.ship({
            shopperId,
            carrier,
            courierId,
            packageOverrides,
            consigneeOverrides,
            notifyCustomer: Boolean(notifyCustomer),
            shippedBy: req.admin?.username || 'admin',
            reshipOfShipmentId: reshipOfShipmentId ? parseInt(reshipOfShipmentId) : null,
            reshipReason: reshipReason ? String(reshipReason).substring(0, 300) : null
        });
        if (result.error) {
            return res.status(result.status || 500).json({ success: false, error: result.error, status: result.status || 500, shipment: result.shipment || null });
        }

        // Best-effort: mirror consignee edits to the Shopify order's shipping
        // address + notify GoKwik, so both match what actually shipped (non-blocking)
        if (consigneeOverrides && (consigneeOverrides.address || consigneeOverrides.city || consigneeOverrides.pincode || consigneeOverrides.name || consigneeOverrides.phone)) {
            try {
                const shopperRows = await dbAdapter.select('store_shoppers', { id: shopperId }, { limit: 1 });
                const orderId = shopperRows[0]?.order_id;
                if (orderId) {
                    const shopifyService = require('../services/shopifyService');
                    shopifyService.updateShippingAddress(orderId, {
                        name: consigneeOverrides.name,
                        phone: consigneeOverrides.phone,
                        address1: consigneeOverrides.address,
                        city: consigneeOverrides.city,
                        state: consigneeOverrides.state,
                        pincode: consigneeOverrides.pincode
                    }).then(sync => {
                        if (sync.success) console.log(`🔄 Shopify shipping address synced for order ${orderId}`);
                        else console.warn(`⚠️ Shopify address sync skipped for ${orderId}: ${sync.warnings.join('; ')}`);
                    }).catch(e => console.error('⚠️ Shopify address sync error:', e.message));

                    const gokwikService = require('../services/gokwikService');
                    gokwikService.notifyOrderUpdate(orderId, { shippingAddress: consigneeOverrides })
                        .catch(e => console.error('⚠️ GoKwik address sync error:', e.message));
                }
            } catch (syncSetupError) {
                console.error('⚠️ Shopify/GoKwik address sync setup error:', syncSetupError.message);
            }
        }

        res.json({ success: true, ...result.data });
    } catch (error) {
        console.error('Shipping ship error:', error);
        res.status(500).json({ success: false, error: 'Failed to create shipment' });
    }
});

// Shipment history (filterable)
router.get('/shipping/shipments', verifyToken, async (req, res) => {
    try {
        const { order_id, status, limit, offset } = req.query;
        const shipments = await shippingService.listShipments({ orderId: order_id, status, limit, offset });
        res.json({ success: true, shipments });
    } catch (error) {
        console.error('Shipments list error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch shipments' });
    }
});

// Schedule pickup for a shipment
router.post('/shipping/shipments/:id/pickup', verifyToken, async (req, res) => {
    try {
        const { pickupDate } = req.body;
        if (!pickupDate || !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
            return res.status(400).json({ success: false, error: 'pickupDate (YYYY-MM-DD) is required' });
        }
        const result = await shippingService.schedulePickup(req.params.id, pickupDate);
        if (result.error) return res.status(result.status || 500).json({ success: false, error: result.error });
        res.json({ success: true, ...result.data });
    } catch (error) {
        console.error('Shipping pickup error:', error);
        res.status(500).json({ success: false, error: 'Failed to schedule pickup' });
    }
});

// Generate/fetch label (?type=manifest|invoice for Shiprocket extras)
router.get('/shipping/shipments/:id/label', verifyToken, async (req, res) => {
    try {
        const { type } = req.query;
        const result = (type === 'manifest' || type === 'invoice')
            ? await shippingService.generateDocument(req.params.id, type)
            : await shippingService.generateLabel(req.params.id);
        if (result.error) return res.status(result.status || 500).json({ success: false, error: result.error });
        res.json({ success: true, ...result.data });
    } catch (error) {
        console.error('Shipping label error:', error);
        res.status(500).json({ success: false, error: 'Failed to generate label' });
    }
});

// Cancel shipment at the carrier + mark cancelled locally.
// force=true closes the shipment locally even when the carrier refuses (already
// delivered/RTO/lost) so the order can be re-shipped — the reason is returned as
// a warning and stored on the shipment row.
router.post('/shipping/shipments/:id/cancel', verifyToken, requirePermission('ship_orders'), async (req, res) => {
    try {
        logOperatorActivity(req, 'shipment_cancel', `Cancelled shipment ${req.params.id}${req.body?.force ? ' (forced)' : ''}`);
        const result = await shippingService.cancelShipment(req.params.id, { force: Boolean(req.body?.force) });
        if (result.error) {
            return res.status(result.status || 500).json({
                success: false,
                error: result.error,
                carrierRejected: Boolean(result.carrierRejected)
            });
        }
        res.json({ success: true, ...result.data });
    } catch (error) {
        console.error('Shipping cancel error:', error);
        res.status(500).json({ success: false, error: 'Failed to cancel shipment' });
    }
});

// Normalized live tracking timeline
router.get('/shipping/shipments/:id/track', verifyToken, async (req, res) => {
    try {
        const result = await shippingService.trackShipment(req.params.id);
        if (result.error) return res.status(result.status || 500).json({ success: false, error: result.error });
        res.json({ success: true, tracking: result.data });
    } catch (error) {
        console.error('Shipping track error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch tracking' });
    }
});

// On-demand carrier status sync — polls carriers for active shipments and
// advances statuses (pickup_scheduled → in_transit → delivered / rto).
// Fired in the background when the Shipped Orders view opens/refreshes;
// the 30-min cron (shipmentSyncCron) covers everything in between.
router.post('/shipping/sync-statuses', verifyToken, async (req, res) => {
    try {
        const shipmentSyncService = require('../services/shipmentSyncService');
        const limit = Math.min(parseInt(req.body?.limit) || 60, 200);
        const result = await shipmentSyncService.syncActiveShipments({ limit });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Shipping status sync error:', error);
        res.status(500).json({ success: false, error: 'Failed to sync shipment statuses' });
    }
});

// Full shipped-orders history — shipments joined with orders + shoppers + customers,
// with search/carrier/status/payment/date filters and aggregate stats.
// Powers the "Shipped Orders" view in the Shopper Hub (Shiprocket-style panel).
router.get('/shipping/history', verifyToken, async (req, res) => {
    try {
        const { search, carrier, status, payment_mode, date_from, date_to, limit = 25, offset = 0 } = req.query;
        const safeLimit = Math.min(parseInt(limit) || 25, 1000);
        const safeOffset = Math.max(0, parseInt(offset) || 0);

        let where = ' WHERE 1=1';
        const params = [];

        if (search) {
            const like = `%${search}%`;
            where += ` AND (s.order_id ILIKE ? OR s.awb ILIKE ? OR s.courier_name ILIKE ? OR ss.name ILIKE ? OR ss.phone ILIKE ? OR c.name ILIKE ? OR o.customer_phone ILIKE ?)`;
            params.push(like, like, like, like, like, like, like);
        }
        if (carrier) { where += ' AND s.carrier = ?'; params.push(carrier); }
        if (status) {
            // Grouped filter: 'in_transit' covers shipped + in_transit, 'cancelled' covers cancelled + failed + rto
            if (status === 'in_transit') where += ` AND s.status IN ('shipped', 'in_transit', 'out_for_delivery')`;
            else if (status === 'cancelled') where += ` AND s.status IN ('cancelled', 'failed', 'rto')`;
            else if (status === 'ready') where += ` AND s.status IN ('created', 'awb_assigned')`;
            else { where += ' AND s.status = ?'; params.push(status); }
        }
        if (payment_mode) { where += ' AND s.payment_mode = ?'; params.push(payment_mode); }
        // Date filters compare against IST calendar days (ops team works in IST)
        if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
            where += ` AND (s.created_at + INTERVAL '5 hours 30 minutes')::date >= ?::date`;
            params.push(date_from);
        }
        if (date_to && /^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
            where += ` AND (s.created_at + INTERVAL '5 hours 30 minutes')::date <= ?::date`;
            params.push(date_to);
        }

        const baseFrom = `
            FROM shipments s
            LEFT JOIN orders o ON o.order_id = s.order_id
            LEFT JOIN store_shoppers ss ON ss.id = s.shopper_id
            LEFT JOIN customers c ON c.phone = o.customer_phone
        `;

        const [rows, countRows, statsRows, carrierRows] = await Promise.all([
            dbAdapter.query(`
                SELECT s.*,
                       COALESCE(ss.name, c.name) AS customer_name,
                       COALESCE(ss.phone, o.customer_phone) AS customer_phone,
                       COALESCE(ss.address, '') AS customer_address,
                       COALESCE(ss.city, '') AS customer_city,
                       COALESCE(ss.province, '') AS customer_state,
                       COALESCE(ss.zip, '') AS customer_pincode,
                       ss.items_json,
                       COALESCE(ss.order_total, o.total) AS order_total,
                       o.product_name, o.status AS order_status, o.expected_delivery
                ${baseFrom}${where}
                ORDER BY s.created_at DESC
                LIMIT ? OFFSET ?
            `, [...params, safeLimit, safeOffset]),
            dbAdapter.query(`SELECT COUNT(*)::int AS total ${baseFrom}${where}`, params),
            dbAdapter.query(`
                SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE s.status IN ('created', 'awb_assigned'))::int AS ready_to_ship,
                       COUNT(*) FILTER (WHERE s.status = 'pickup_scheduled')::int AS pickup_scheduled,
                       COUNT(*) FILTER (WHERE s.status IN ('shipped', 'in_transit', 'out_for_delivery'))::int AS in_transit,
                       COUNT(*) FILTER (WHERE s.status = 'delivered')::int AS delivered,
                       COUNT(*) FILTER (WHERE s.status IN ('cancelled', 'failed', 'rto'))::int AS cancelled,
                       COUNT(*) FILTER (WHERE s.payment_mode = 'COD')::int AS cod_count,
                       COALESCE(SUM(s.cod_amount) FILTER (WHERE s.payment_mode = 'COD' AND s.status NOT IN ('cancelled', 'failed')), 0)::float AS cod_value,
                       COALESCE(SUM(s.freight_charge) FILTER (WHERE s.status NOT IN ('cancelled', 'failed')), 0)::float AS freight_total
                ${baseFrom}${where}
            `, params),
            dbAdapter.query(`SELECT DISTINCT carrier FROM shipments ORDER BY carrier`)
        ]);

        res.json({
            success: true,
            shipments: rows,
            total: countRows[0]?.total || 0,
            stats: statsRows[0] || {},
            carriers: carrierRows.map(r => r.carrier),
            limit: safeLimit,
            offset: safeOffset
        });
    } catch (error) {
        console.error('Shipping history error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch shipping history' });
    }
});

// ============ AI COPILOT ROUTES ============

// Chat with the admin AI copilot (tool-calling agent, mutating actions gated by confirm)
router.post('/ai/chat', verifyToken, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }
        const { runAgent } = require('../services/ai/agent');
        const result = await runAgent({
            actor: req.admin?.username || 'admin',
            userMessage: String(message).trim().substring(0, 4000)
        });
        res.json({ success: true, reply: result.reply, pendingAction: result.pendingAction, usage: result.usage });
    } catch (error) {
        console.error('AI chat error:', error.message);
        const friendly = ['AI_RATE_LIMIT', 'AI_UNAVAILABLE'].includes(error.code)
            ? error.message
            : 'AI request failed. Please try again.';
        res.status(500).json({ success: false, error: friendly });
    }
});

// Confirm and execute a pending AI action
router.post('/ai/confirm/:id', verifyToken, async (req, res) => {
    try {
        const { executeConfirmedAction } = require('../services/ai/agent');
        const result = await executeConfirmedAction(req.params.id, req.admin?.username || 'admin');
        if (!result.ok) return res.status(400).json({ success: false, error: result.error, summary: result.summary });
        res.json({ success: true, result: result.result, summary: result.summary });
    } catch (error) {
        console.error('AI confirm error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to execute action' });
    }
});

// Cancel a pending AI action
router.post('/ai/cancel/:id', verifyToken, async (req, res) => {
    try {
        const aiStore = require('../services/ai/aiStore');
        const result = await aiStore.cancelPendingAction(req.params.id, req.admin?.username || 'admin');
        if (!result.ok) return res.status(400).json({ success: false, error: result.error });
        res.json({ success: true });
    } catch (error) {
        console.error('AI cancel error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to cancel action' });
    }
});

// AI reply suggestions for a customer chat (drafts only — never auto-sent)
router.post('/ai/suggest-reply', verifyToken, async (req, res) => {
    try {
        const { phone, ticketId, prefetch } = req.body;
        if (!phone) return res.status(400).json({ success: false, error: 'Customer phone is required' });
        const { suggestReply } = require('../services/ai/suggestReply');
        const result = await suggestReply({
            actor: req.admin?.username || 'admin',
            phone,
            ticketId: ticketId || null,
            prefetch: Boolean(prefetch)
        });
        res.json({ success: true, suggestions: result.suggestions });
    } catch (error) {
        console.error('AI suggest-reply error:', error.message);
        const known = ['AI_NOT_CONFIGURED', 'AI_DISABLED', 'AI_LIMIT', 'NO_HISTORY', 'AI_RATE_LIMIT', 'AI_UNAVAILABLE'];
        const status = known.includes(error.code) ? 400 : 500;
        res.status(status).json({ success: false, error: known.includes(error.code) ? error.message : 'Failed to generate suggestions' });
    }
});

// AI usage stats for the dashboard widget
router.get('/ai/usage', verifyToken, async (req, res) => {
    try {
        const aiStore = require('../services/ai/aiStore');
        const { getConfig, isConfigured } = require('../services/ai/aiClient');
        const days = Math.min(parseInt(req.query.days) || 30, 90);
        const stats = await aiStore.getUsageStats(days);
        const cfg = getConfig();
        res.json({
            success: true,
            configured: isConfigured(),
            provider: cfg.provider,
            model: cfg.model,
            ...stats
        });
    } catch (error) {
        console.error('AI usage error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch AI usage' });
    }
});

// Clear the copilot chat history for the current admin
router.post('/ai/clear-history', verifyToken, async (req, res) => {
    try {
        const aiStore = require('../services/ai/aiStore');
        await aiStore.clearChatHistory(req.admin?.username || 'admin');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to clear history' });
    }
});

// Load copilot chat history (for panel restore on reload)
router.get('/ai/history', verifyToken, async (req, res) => {
    try {
        const aiStore = require('../services/ai/aiStore');
        const history = await aiStore.getChatHistory(req.admin?.username || 'admin');
        res.json({ success: true, history });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load history' });
    }
});

// ---------- Learned replies curation (AI learning) ----------

// List learned examples (optional ?search= and ?limit=)
router.get('/ai/learned', verifyToken, async (req, res) => {
    try {
        const aiLearning = require('../services/ai/learning');
        const rows = await aiLearning.listLearnedReplies({ search: req.query.search || '', limit: req.query.limit });
        res.json({ success: true, learned: rows });
    } catch (error) {
        console.error('AI learned list error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to load learned replies' });
    }
});

// Create a hand-written golden example (pinned by default)
router.post('/ai/learned', verifyToken, async (req, res) => {
    try {
        const { question, reply, pinned } = req.body;
        if (!question || !reply) return res.status(400).json({ success: false, error: 'Question and reply are required' });
        const aiLearning = require('../services/ai/learning');
        const row = await aiLearning.createLearnedReply({ question, reply, pinned: pinned !== false });
        res.json({ success: true, learned: row });
    } catch (error) {
        console.error('AI learned create error:', error.message);
        res.status(500).json({ success: false, error: error.message || 'Failed to create learned reply' });
    }
});

// Edit or pin/unpin a learned example
router.put('/ai/learned/:id', verifyToken, async (req, res) => {
    try {
        const { question, reply, pinned } = req.body;
        const aiLearning = require('../services/ai/learning');
        await aiLearning.updateLearnedReply(parseInt(req.params.id), { question, reply, pinned });
        res.json({ success: true });
    } catch (error) {
        console.error('AI learned update error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to update learned reply' });
    }
});

// Delete a learned example
router.delete('/ai/learned/:id', verifyToken, async (req, res) => {
    try {
        const aiLearning = require('../services/ai/learning');
        await aiLearning.deleteLearnedReply(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        console.error('AI learned delete error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to delete learned reply' });
    }
});

// ---------- AI Copilot Pro routes ----------

// Bulk import learned replies (CSV or JSON)
router.post('/ai/learned/import', verifyToken, async (req, res) => {
    try {
        const { items } = req.body; // [{ question, reply, pinned? }]
        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({ success: false, error: 'items array is required' });
        }
        const aiLearning = require('../services/ai/learning');
        let imported = 0;
        const errors = [];
        for (const item of items.slice(0, 200)) {
            try {
                await aiLearning.createLearnedReply({
                    question: item.question || '',
                    reply: item.reply || '',
                    pinned: item.pinned !== false
                });
                imported++;
            } catch (e) {
                errors.push(`${item.question?.substring(0, 40) || '(empty)'}: ${e.message}`);
            }
        }
        res.json({ success: true, imported, errors: errors.slice(0, 10) });
    } catch (error) {
        console.error('AI learned import error:', error.message);
        res.status(500).json({ success: false, error: 'Import failed' });
    }
});

// Test retrieval: see which learned examples match a sample question
router.get('/ai/learned/test', verifyToken, async (req, res) => {
    try {
        const { findSimilarExamples } = require('../services/ai/learning');
        const question = req.query.question || '';
        if (!question.trim()) return res.status(400).json({ success: false, error: 'question param required' });
        const examples = await findSimilarExamples(question, 5);
        res.json({ success: true, examples });
    } catch (error) {
        console.error('AI learned test error:', error.message);
        res.status(500).json({ success: false, error: 'Test failed' });
    }
});

// AI behavior settings (save)
router.put('/ai/settings', verifyToken, async (req, res) => {
    try {
        const Settings = require('../../models/Settings');
        const allowed = ['ai_admin_copilot_enabled', 'ai_learning_enabled', 'ai_daily_admin_limit', 'ai_suggest_reply_daily_limit'];
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                await Settings.set(key, String(req.body[key]));
            }
        }
        res.json({ success: true });
    } catch (error) {
        console.error('AI settings save error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
});

// AI insights (analytics page data)
router.get('/ai/insights', verifyToken, async (req, res) => {
    try {
        const { getInsights } = require('../services/ai/insights');
        const insights = await getInsights();
        res.json({ success: true, ...insights });
    } catch (error) {
        console.error('AI insights error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to load insights' });
    }
});

// ---------- AI Workflows CRUD ----------

router.get('/ai/workflows', verifyToken, async (req, res) => {
    try {
        const workflows = require('../services/ai/workflows');
        const rows = await workflows.listWorkflows();
        res.json({ success: true, workflows: rows });
    } catch (error) {
        console.error('AI workflows list error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to list workflows' });
    }
});

router.post('/ai/workflows', verifyToken, async (req, res) => {
    try {
        const workflows = require('../services/ai/workflows');
        const row = await workflows.createWorkflow(req.body);
        res.json({ success: true, workflow: row });
    } catch (error) {
        console.error('AI workflow create error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

router.put('/ai/workflows/:id', verifyToken, async (req, res) => {
    try {
        const workflows = require('../services/ai/workflows');
        await workflows.updateWorkflow(parseInt(req.params.id), req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('AI workflow update error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to update workflow' });
    }
});

router.delete('/ai/workflows/:id', verifyToken, async (req, res) => {
    try {
        const workflows = require('../services/ai/workflows');
        await workflows.deleteWorkflow(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        console.error('AI workflow delete error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to delete workflow' });
    }
});

// ---------- Conversation Review Center ----------

// List conversations (support tickets with filters)
router.get('/ai/conversations', verifyToken, async (req, res) => {
    try {
        const { status, sentiment, priority, scenario, search, limit, offset } = req.query;
        const n = Math.min(parseInt(limit) || 30, 100);
        const off = parseInt(offset) || 0;
        const params = [];
        let sql = `SELECT t.id, t.ticket_number, t.customer_phone, t.customer_name, t.message, t.status,
                          t.portal_id, t.sentiment, t.ai_confidence, t.ai_scenario, t.source,
                          t.created_at, t.updated_at,
                          c.name as customer_display_name, c.email as customer_email
                   FROM support_tickets t
                   LEFT JOIN customers c ON c.phone = t.customer_phone
                   WHERE 1=1`;

        if (status) { sql += ' AND t.status = ?'; params.push(status); }
        if (sentiment) { sql += ' AND t.sentiment = ?'; params.push(sentiment); }
        if (scenario) { sql += ' AND t.ai_scenario = ?'; params.push(scenario); }
        if (search && search.trim()) {
            const like = `%${search.trim()}%`;
            sql += ' AND (t.customer_name ILIKE ? OR t.customer_phone LIKE ? OR t.ticket_number ILIKE ?)';
            params.push(like, `%${search.trim().replace(/\D/g, '').slice(-10) || search.trim()}%`, like);
        }

        // Count total before pagination
        const countSql = `SELECT COUNT(*)::int AS total FROM support_tickets t WHERE 1=1` +
            sql.slice(sql.indexOf('WHERE 1=1') + 'WHERE 1=1'.length);
        const countParams = params.slice();
        const countRows = await dbAdapter.query(countSql, countParams);
        const total = countRows[0]?.total || 0;

        sql += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
        params.push(n, off);

        const rows = await dbAdapter.query(sql, params);

        res.json({
            success: true,
            conversations: rows,
            total,
            limit: n,
            offset: off
        });
    } catch (error) {
        console.error('Conversations list error:', error.message, error.stack);
        res.status(500).json({ success: false, error: `Failed to load conversations: ${error.message}` });
    }
});

// Get full conversation thread for a ticket
router.get('/ai/conversations/:ticketId', verifyToken, async (req, res) => {
    try {
        const ticketId = parseInt(req.params.ticketId);
        if (isNaN(ticketId)) return res.status(400).json({ success: false, error: 'Invalid ticket ID' });

        // Get the ticket
        const tickets = await dbAdapter.query(
            `SELECT t.*, c.name as customer_display_name, c.email as customer_email, c.phone as customer_phone_full
             FROM support_tickets t
             LEFT JOIN customers c ON c.phone = t.customer_phone
             WHERE t.id = ?`,
            [ticketId]
        );
        if (!tickets.length) return res.status(404).json({ success: false, error: 'Ticket not found' });
        const ticket = tickets[0];

        // Get the conversation thread (messages for this customer)
        const phone = ticket.customer_phone;
        const messages = await dbAdapter.query(
            `SELECT id, message_type, message_content, status, created_at
             FROM messages
             WHERE customer_phone LIKE ?
             ORDER BY created_at DESC LIMIT 50`,
            [`%${String(phone).replace(/\D/g, '').slice(-10)}`]
        );

        // Get related orders
        const orders = await dbAdapter.query(
            `SELECT order_id, status, awb, courier_name, total, payment_method, created_at
             FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 5`,
            [`%${String(phone).replace(/\D/g, '').slice(-10)}`]
        );

        // Parse AI suggestion from ticket message
        let aiSuggestion = null;
        const suggestionMatch = ticket.message.match(/💡 \[AI SUGGESTED REPLY - SOP: (.+?)\]\n([\s\S]*?)$/);
        if (suggestionMatch) {
            aiSuggestion = {
                scenario: suggestionMatch[1],
                reply: suggestionMatch[2]?.trim() || ''
            };
        }

        res.json({
            success: true,
            ticket: {
                id: ticket.id,
                ticketNumber: ticket.ticket_number,
                customerName: ticket.customer_name || ticket.customer_display_name,
                customerPhone: phone,
                customerEmail: ticket.customer_email,
                message: ticket.message,
                status: ticket.status,
                sentiment: ticket.sentiment,
                aiConfidence: ticket.ai_confidence,
                aiScenario: ticket.ai_scenario,
                source: ticket.source,
                portalId: ticket.portal_id,
                createdAt: ticket.created_at,
                updatedAt: ticket.updated_at,
                aiSuggestion
            },
            messages: messages.reverse(),
            orders
        });
    } catch (error) {
        console.error('Conversation detail error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to load conversation' });
    }
});

// Update ticket (priority, status, sentiment override)
router.put('/ai/conversations/:ticketId', verifyToken, async (req, res) => {
    try {
        const ticketId = parseInt(req.params.ticketId);
        const updates = {};
        if (req.body.status) updates.status = req.body.status;
        if (req.body.sentiment) updates.sentiment = req.body.sentiment;
        if (req.body.ai_scenario) updates.ai_scenario = req.body.ai_scenario;
        updates.updated_at = new Date().toISOString();

        await dbAdapter.update('support_tickets', updates, { id: ticketId });
        res.json({ success: true });
    } catch (error) {
        console.error('Conversation update error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to update conversation' });
    }
});

// Enhanced analytics bundle (Phase 4)
router.get('/ai/analytics', verifyToken, async (req, res) => {
    try {
        const { getEnhancedAnalytics } = require('../services/ai/insights');
        const analytics = await getEnhancedAnalytics();
        res.json({ success: true, ...analytics });
    } catch (error) {
        console.error('Enhanced analytics error:', error.message, error.stack);
        res.status(500).json({ success: false, error: `Failed to load analytics: ${error.message}` });
    }
});

// Live monitoring snapshot (Phase 4.2)
router.get('/ai/live', verifyToken, async (req, res) => {
    try {
        const { getLiveSnapshot } = require('../services/ai/insights');
        const snapshot = await getLiveSnapshot();
        res.json({ success: true, ...snapshot });
    } catch (error) {
        console.error('Live snapshot error:', error.message, error.stack);
        res.status(500).json({ success: false, error: `Failed to load live data: ${error.message}` });
    }
});

// Quality metrics endpoint
router.get('/ai/quality-metrics', verifyToken, async (req, res) => {
    try {
        const [sentimentDist, scenarioDist, confidenceAvg, escalationRate, resolutionRate] = await Promise.all([
            dbAdapter.query(
                `SELECT sentiment, COUNT(*)::int AS count
                 FROM support_tickets
                 WHERE sentiment IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'
                 GROUP BY sentiment`
            ),
            dbAdapter.query(
                `SELECT ai_scenario, COUNT(*)::int AS count
                 FROM support_tickets
                 WHERE ai_scenario IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'
                 GROUP BY ai_scenario ORDER BY count DESC`
            ),
            dbAdapter.query(
                `SELECT AVG(ai_confidence)::float AS avg_confidence, COUNT(*)::int AS total
                 FROM support_tickets
                 WHERE ai_confidence IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'`
            ),
            dbAdapter.query(
                `SELECT
                    COUNT(*)::int AS total,
                    COUNT(CASE WHEN ai_confidence < 0.6 OR sentiment = 'frustrated' THEN 1 END)::int AS escalated
                 FROM support_tickets
                 WHERE created_at >= NOW() - INTERVAL '30 days'`
            ),
            dbAdapter.query(
                `SELECT
                    COUNT(*)::int AS total,
                    COUNT(CASE WHEN status IN ('resolved', 'closed') THEN 1 END)::int AS resolved
                 FROM support_tickets
                 WHERE created_at >= NOW() - INTERVAL '30 days'`
            )
        ]);

        res.json({
            success: true,
            sentimentDistribution: sentimentDist,
            scenarioDistribution: scenarioDist,
            avgConfidence: confidenceAvg[0]?.avg_confidence || 0,
            totalClassified: confidenceAvg[0]?.total || 0,
            escalationRate: escalationRate[0]?.total ? (escalationRate[0].escalated / escalationRate[0].total * 100).toFixed(1) : 0,
            resolutionRate: resolutionRate[0]?.total ? (resolutionRate[0].resolved / resolutionRate[0].total * 100).toFixed(1) : 0
        });
    } catch (error) {
        console.error('Quality metrics error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to load quality metrics' });
    }
});

// ==========================================
// PREMIUM INVENTORY INTELLIGENCE
// Computes true sellable stock per product/variant by reconciling Shopify
// on-hand stock with units out in the field: in-circulation shipments,
// RTO returns coming back, open customer returns and exchange pipelines.
//   final_available = on_hand + rto_incoming + return_incoming
//                     + exchange_incoming − exchange_outgoing
// ==========================================

// Fetch open return/exchange requests from the external returns server —
// Shopify portal submissions live there, not in the local returns/exchanges
// tables. Graceful: returns { connected: false } when unconfigured or down.
async function fetchReturnsServerPipeline(windowDays) {
    const baseUrl = process.env.RETURNS_SERVER_URL;
    const token = process.env.WHATSAPP_INTERNAL_TOKEN;
    if (!baseUrl) return { connected: false, reason: 'RETURNS_SERVER_URL not configured', requests: [] };
    try {
        const axios = require('axios');
        const res = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/inventory-open-requests`, {
            params: { window: windowDays },
            headers: { 'x-internal-token': token || '' },
            timeout: 15000
        });
        if (!res.data?.success) return { connected: false, reason: res.data?.error || 'unexpected response', requests: [] };
        return { connected: true, requests: Array.isArray(res.data.requests) ? res.data.requests : [] };
    } catch (err) {
        console.warn(`⚠️ Returns server pipeline fetch failed: ${err.message}`);
        return { connected: false, reason: err.message, requests: [] };
    }
}

router.get('/inventory', verifyToken, async (req, res) => {
    try {
        const windowDays = Math.max(0, Math.min(parseInt(req.query.window, 10) || 90, 730));
        const force = req.query.refresh === '1' || req.query.refresh === 'true';
        const cacheKey = `inventory_intel:${windowDays}`;
        if (!force) {
            const cached = getCached(cacheKey);
            if (cached) return res.json({ ...cached, cached: true });
        }

        const shopifyService = require('../services/shopifyService');
        const { extractItemSize } = require('../utils/orderItems');

        const catalog = await shopifyService.getProductCatalog(force);

        const windowSql = windowDays > 0 ? `AND created_at >= NOW() - INTERVAL '${windowDays} days'` : '';

        // Cache bundle map separately (static config data, rarely changes)
        const bundleCacheKey = 'zoho_bundle_map';
        let bundleRows = getCached(bundleCacheKey);
        if (!bundleRows || force) {
            bundleRows = await dbAdapter.query(`SELECT bundle_sku, component_sku, component_qty FROM zoho_bundle_map`);
            setCache(bundleCacheKey, bundleRows, 'stats', 3600000); // Cache for 1 hour
        }

        // Two lightweight per-row scans — optimized for index usage.
        // A) windowed history → delivered + RTO buckets (split into two queries to avoid OR)
        // B) current in-circulation shipments (never window-trimmed)
        const [historyDelivered, historyRto, circulationRows, returnRows, exchangeRows, rsPipeline, salesRows] = await Promise.all([
            // History: delivered orders
            dbAdapter.query(`
                SELECT s.items_json, s.status AS shopper_status, o.status AS order_status
                FROM store_shoppers s
                INNER JOIN orders o ON o.order_id = s.order_id
                WHERE s.items_json IS NOT NULL
                  AND o.status = 'delivered'
                  ${windowDays > 0 ? `AND s.created_at >= NOW() - INTERVAL '${windowDays} days'` : ''}
            `),
            // History: RTO orders (order status OR shopper status)
            dbAdapter.query(`
                SELECT s.items_json, s.status AS shopper_status, 'rto' AS order_status
                FROM store_shoppers s
                WHERE s.items_json IS NOT NULL
                  AND s.status = 'rto'
                  ${windowDays > 0 ? `AND s.created_at >= NOW() - INTERVAL '${windowDays} days'` : ''}
            `),
            dbAdapter.query(`
                SELECT s.items_json, s.status AS shopper_status, o.status AS order_status, o.awb
                FROM store_shoppers s
                INNER JOIN orders o ON o.order_id = s.order_id
                WHERE s.items_json IS NOT NULL
                  AND s.status = 'confirmed'
                  AND (o.awb IS NOT NULL OR o.status = 'shipped')
                  AND COALESCE(o.status, '') NOT IN ('delivered','rto','cancelled','failed')
            `),
            dbAdapter.query(`SELECT items FROM returns WHERE status IN ('pending_approval','initiated','approved','pickup_scheduled') ${windowSql}`),
            dbAdapter.query(`SELECT old_items, new_items FROM exchanges WHERE status IN ('pending_approval','initiated','pickup_scheduled') ${windowSql}`),
            fetchReturnsServerPipeline(windowDays),
            // Trailing 84 days of shipped/delivered units for velocity & forecast
            // series — always a fixed window, independent of the pipeline window.
            dbAdapter.query(`
                SELECT s.items_json, s.created_at
                FROM store_shoppers s
                INNER JOIN orders o ON o.order_id = s.order_id
                WHERE s.items_json IS NOT NULL
                  AND s.created_at >= NOW() - INTERVAL '84 days'
                  AND o.status IN ('delivered','shipped')
            `)
        ]);

        // ---------- Bundle / combo expansion (Zoho configuration) ----------
        // Combos & bundles are NOT distinct products — zoho_bundle_map breaks
        // them into their single-product components (e.g. "POLO- 001 ( COMBO )"
        // = POLO- 001 BLACK + OFF-WHITE). Every order-derived count is expanded
        // into components, and the bundle products themselves are excluded from
        // the dashboard catalog so they never surface as separate items.
        const normBundleKey = (s) => String(s || '').toUpperCase()
            .replace(/\s*([()])\s*/g, '$1')
            .replace(/\s*-\s*/g, '-')
            .replace(/\s+/g, ' ').trim();
        const bundleMap = new Map(); // raw / normalized bundle key -> component rows
        for (const r of bundleRows) {
            for (const k of [r.bundle_sku, normBundleKey(r.bundle_sku)]) {
                if (!k) continue;
                if (!bundleMap.has(k)) bundleMap.set(k, []);
                bundleMap.get(k).push(r);
            }
        }
        const activeCatalog = catalog.filter(p =>
            !bundleMap.has(p.title) && !bundleMap.has(normBundleKey(p.title)));

        // ---------- Variant resolution indexes ----------
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const skuIndex = new Map();      // normalized sku -> { p, v }
        const titleIndex = new Map();    // normalized product title -> product
        const variantKey = (p, v) => `${p.id}:${v.id}`;
        for (const p of activeCatalog) {
            titleIndex.set(norm(p.title), p);
            for (const v of (p.variants || [])) {
                if (v.sku) skuIndex.set(norm(v.sku), { p, v });
            }
        }

        // Resolve a raw line item ({title|product_name|name, sku, variant|variant_title|size, quantity})
        // to a catalog variant. Returns { p, v } or null.
        const resolveItem = (item) => {
            if (!item || typeof item !== 'object') return null;
            const sku = norm(item.sku);
            if (sku && skuIndex.has(sku)) return skuIndex.get(sku);

            const title = norm(item.title || item.product_name || item.name);
            if (!title) return null;

            let product = titleIndex.get(title) || null;
            if (!product) {
                // Titles often carry trailing size/colour suffixes — match by containment
                for (const [pTitle, p] of titleIndex) {
                    if (!pTitle) continue;
                    if (title.startsWith(pTitle) || pTitle.startsWith(title)) { product = p; break; }
                }
            }
            if (!product) return null;

            const variants = product.variants || [];
            if (variants.length === 1) return { p: product, v: variants[0] };

            const size = norm(extractItemSize(item));
            // Colourway hint: whatever the title carries beyond the product
            // family (bundle component "POLO- 001 ( BLACK )" → "black").
            const pNorm = norm(product.title);
            const extraTokens = title.startsWith(pNorm)
                ? title.slice(pNorm.length).split(' ').filter(Boolean)
                : [];
            const wanted = [...extraTokens, ...(size ? [size] : [])];
            if (wanted.length) {
                const hit = variants.find(v => {
                    const vt = norm(v.title);
                    if (!vt) return false;
                    const vtTokens = vt.split(' ').filter(Boolean);
                    return wanted.every(t => vtTokens.includes(t) || vt.includes(t));
                });
                if (hit) return { p: product, v: hit };
            }
            if (size) {
                const hit = variants.find(v => norm(v.title) && norm(v.title).split(' ').includes(size));
                if (hit) return { p: product, v: hit };
            }
            return { p: product, v: null }; // product matched but variant is ambiguous
        };

        const parseItems = (raw) => {
            if (!raw) return [];
            try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return Array.isArray(parsed) ? parsed : [];
            } catch (_) { return []; }
        };

        // Expand combo/bundle line items into their single-product components
        // per zoho_bundle_map; non-bundle items pass through untouched.
        const expandBundleItems = (items) => {
            if (!bundleMap.size) return items;
            const out = [];
            for (const item of items) {
                if (!item || typeof item !== 'object') continue;
                const comps = bundleMap.get(item.sku || '')
                    || bundleMap.get(item.title || '')
                    || bundleMap.get(normBundleKey(item.title));
                if (!comps) { out.push(item); continue; }
                const qty = Math.max(1, parseInt(item.quantity ?? item.qty, 10) || 1);
                for (const c of comps) {
                    out.push({
                        title: c.component_sku,
                        sku: '',
                        variant: item.variant || item.variant_title || item.size || '',
                        quantity: qty * (c.component_qty || 1),
                    });
                }
            }
            return out;
        };

        // ---------- Aggregate buckets per variant ----------
        const BUCKETS = ['in_circulation', 'delivered', 'rto_incoming', 'return_incoming', 'exchange_incoming', 'exchange_outgoing'];
        const stats = new Map(); // variantKey -> bucket counts
        const ensureStats = (key) => {
            if (!stats.has(key)) stats.set(key, Object.fromEntries(BUCKETS.map(b => [b, 0])));
            return stats.get(key);
        };
        const untracked = new Map(); // "title|size" -> { title, size, bucket counts }

        const addItemUnits = (items, bucket) => {
            for (const item of expandBundleItems(items)) {
                const qty = Math.max(1, parseInt(item.quantity ?? item.qty, 10) || 1);
                const resolved = resolveItem(item);
                if (resolved && resolved.v) {
                    ensureStats(variantKey(resolved.p, resolved.v))[bucket] += qty;
                } else {
                    const title = String(item.title || item.product_name || item.name || 'Unknown item').trim();
                    const size = extractItemSize(item) || resolved?.v?.title || '';
                    const uKey = `${norm(title)}|${norm(size)}`;
                    if (!untracked.has(uKey)) {
                        untracked.set(uKey, { title, size, ...Object.fromEntries(BUCKETS.map(b => [b, 0])) });
                    }
                    untracked.get(uKey)[bucket] += qty;
                }
            }
        };

        // 1) Forward orders: in-circulation / delivered / RTO buckets.
        //    Circulation rows are counted from the dedicated query only; the
        //    windowed history query skips them to avoid double counting.
        const classifyRow = (row) => {
            const orderStatus = String(row.order_status || '').toLowerCase();
            const shipped = row.shopper_status === 'confirmed' && (row.awb || orderStatus === 'shipped');
            if (row.shopper_status === 'rto' || orderStatus === 'rto') return 'rto_incoming';
            if (orderStatus === 'delivered') return 'delivered';
            if (shipped && !['cancelled', 'failed'].includes(orderStatus)) return 'in_circulation';
            return null;
        };
        for (const row of circulationRows) {
            const bucket = classifyRow(row);
            if (bucket) addItemUnits(parseItems(row.items_json), bucket);
        }
        // Process split history queries (delivered + RTO)
        for (const row of historyDelivered) {
            addItemUnits(parseItems(row.items_json), 'delivered');
        }
        for (const row of historyRto) {
            addItemUnits(parseItems(row.items_json), 'rto_incoming');
        }

        // 2) Open customer returns → stock coming back
        for (const row of returnRows) addItemUnits(parseItems(row.items), 'return_incoming');

        // 3) Open exchanges → old items come back, replacement items go out
        for (const row of exchangeRows) {
            addItemUnits(parseItems(row.old_items), 'exchange_incoming');
            addItemUnits(parseItems(row.new_items), 'exchange_outgoing');
        }

        // 4) External returns server — Shopify portal return/exchange requests
        //    (separate system; no overlap with the local returns/exchanges tables)
        const rsUnits = { return_incoming: 0, exchange_incoming: 0, exchange_outgoing: 0 };
        const rsQty = (items) => items.reduce((acc, i) => acc + Math.max(1, parseInt(i?.quantity, 10) || 1), 0);
        for (const request of rsPipeline.requests) {
            const items = Array.isArray(request.items) ? request.items : [];
            if (items.length === 0) continue;
            if (request.type === 'return') {
                rsUnits.return_incoming += rsQty(items);
                addItemUnits(items, 'return_incoming');
            } else if (request.type === 'exchange') {
                rsUnits.exchange_incoming += rsQty(items);
                addItemUnits(items, 'exchange_incoming');
                // Replacements ship via carrier (not a Shopify order), so Shopify
                // on-hand is NOT decremented for them — reserve them here.
                const replacements = items
                    .filter(i => i && (i.replacementProductTitle || i.replacementSku || i.replacementVariant))
                    .map(i => ({
                        title: i.replacementProductTitle || i.name || i.title || '',
                        sku: i.replacementSku || '',
                        variant: i.replacementVariant || '',
                        quantity: i.quantity
                    }));
                if (replacements.length) {
                    rsUnits.exchange_outgoing += rsQty(replacements);
                    addItemUnits(replacements, 'exchange_outgoing');
                }
            }
        }

        // ---------- 12-week sales velocity (fixed trailing 84 days) ----------
        const VEL_DAYS = 84;
        const nowTs = Date.now();
        const salesByVariant = new Map(); // variantKey -> { days: number[84], lastSaleTs }
        for (const row of salesRows) {
            const ts = new Date(row.created_at).getTime();
            if (!ts || isNaN(ts)) continue;
            const ageDays = Math.floor((nowTs - ts) / 86400000);
            if (ageDays < 0 || ageDays >= VEL_DAYS) continue;
            for (const item of expandBundleItems(parseItems(row.items_json))) {
                const qty = Math.max(1, parseInt(item.quantity ?? item.qty, 10) || 1);
                const resolved = resolveItem(item);
                if (!resolved || !resolved.v) continue; // unattributable units can't feed SKU velocity
                const key = variantKey(resolved.p, resolved.v);
                if (!salesByVariant.has(key)) salesByVariant.set(key, { days: new Array(VEL_DAYS).fill(0), lastSaleTs: 0 });
                const entry = salesByVariant.get(key);
                entry.days[ageDays] += qty;
                if (ts > entry.lastSaleTs) entry.lastSaleTs = ts;
            }
        }

        // Recency-weighted weekly forecast (same method as the control tower prototype):
        // forecast the latest week off the prior 5 weeks so one bad week can't crater it.
        const weightedMovingForecast = (weeks) => {
            const recent = weeks.slice(6, 11);
            const weights = [1, 1.2, 1.5, 1.8, 2.2];
            const wsum = weights.reduce((a, b) => a + b, 0);
            return recent.reduce((a, v, i) => a + v * weights[i], 0) / wsum;
        };
        const ageBucketOf = (d) => (d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : d <= 120 ? '91-120' : d <= 180 ? '121-180' : '180+');

        // Assumptions with no live data source (surfaced in the UI):
        const LEAD_TIME_DAYS = 25;      // manufacturer lead time — fixed assumption
        const DEAD_SALE_DAYS = 45;      // no sale for 45d => dead stock
        const OVERSTOCK_COVER_DAYS = 90;
        const TARGET_COVER_DAYS = 45;   // replenishment target cover
        const SLOW_VELOCITY = 0.15;     // < ~1 unit/week

        // ---------- Assemble product/variant response ----------
        const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
        let products = activeCatalog.map(p => {
            const productCreatedAt = p.created_at ? new Date(p.created_at).getTime() : null;
            const ageingDays = productCreatedAt && !isNaN(productCreatedAt)
                ? Math.max(0, Math.floor((nowTs - productCreatedAt) / 86400000))
                : null;
            const variants = (p.variants || []).map(v => {
                const s = stats.get(variantKey(p, v)) || Object.fromEntries(BUCKETS.map(b => [b, 0]));
                const onHand = typeof v.inventory === 'number' ? v.inventory : 0;
                const finalAvailable = onHand + s.rto_incoming + s.return_incoming + s.exchange_incoming - s.exchange_outgoing;
                const shippedUnits = s.delivered + s.rto_incoming + s.in_circulation;

                // ----- sales history derivations (trailing 84 days) -----
                const sv = salesByVariant.get(variantKey(p, v));
                const days = sv ? sv.days : new Array(VEL_DAYS).fill(0);
                const weeklySales = Array.from({ length: 12 }, (_, w) => {
                    const startAge = (11 - w) * 7; // w=0 oldest week, w=11 latest
                    let sum = 0;
                    for (let a = startAge; a < startAge + 7; a++) sum += days[a] || 0;
                    return sum;
                });
                const sumDays = (n) => { let t = 0; for (let a = 0; a < n; a++) t += days[a] || 0; return t; };
                const sales7 = sumDays(7), sales14 = sumDays(14), sales30 = sumDays(30), sales60 = sumDays(60), sales90 = sumDays(VEL_DAYS);
                const mean = weeklySales.reduce((a, b) => a + b, 0) / weeklySales.length || 0.0001;
                const variance = weeklySales.reduce((a, b) => a + (b - mean) ** 2, 0) / weeklySales.length;
                const cv = Math.sqrt(variance) / (mean || 1);
                const xyz = cv < 0.5 ? 'X' : cv < 1.0 ? 'Y' : 'Z';
                const velocity = +(weightedMovingForecast(weeklySales) / 7).toFixed(2); // units/day
                const lastSaleDaysAgo = sv ? Math.floor((nowTs - sv.lastSaleTs) / 86400000) : VEL_DAYS + 1;

                // ----- cover, classification, replenishment -----
                const daysOfCover = velocity > 0.05 ? +(finalAvailable / velocity).toFixed(1) : 999;
                const incomingQty = s.rto_incoming + s.return_incoming + s.exchange_incoming;
                const incomingEtaDays = incomingQty > 0 ? 7 : null; // returns pipeline has no ETA — assume ~1 week
                const incomingArrivesInTime = incomingQty > 0 && incomingEtaDays <= daysOfCover + 3;
                const isDead = lastSaleDaysAgo > DEAD_SALE_DAYS && onHand > 0;
                const isOverstock = daysOfCover > OVERSTOCK_COVER_DAYS && velocity > SLOW_VELOCITY;
                const isStockoutRisk = velocity > 0.05 && daysOfCover <= LEAD_TIME_DAYS && !incomingArrivesInTime;
                const isSlowMover = !isDead && velocity > 0.05 && velocity < SLOW_VELOCITY;
                const safetyStock = Math.round(velocity * (xyz === 'Z' ? 12 : xyz === 'Y' ? 8 : 5));
                const reorderPoint = Math.round(velocity * LEAD_TIME_DAYS + safetyStock);
                const recommendedQty = Math.max(0, Math.round(velocity * TARGET_COVER_DAYS + safetyStock - finalAvailable));

                let bucket, reason, priority;
                if (isDead) {
                    bucket = 'DO NOT BUY'; reason = `No sale in ${lastSaleDaysAgo}d+ – capital better spent elsewhere`; priority = 'Low';
                } else if (isOverstock) {
                    bucket = 'OVERSTOCK – DO NOT REPLENISH'; reason = `${daysOfCover}d cover already on hand vs ${LEAD_TIME_DAYS}d lead time`; priority = 'Low';
                } else if (isStockoutRisk) {
                    bucket = 'BUY NOW'; reason = `Stocks out in ${Math.floor(daysOfCover)}d, replenishment takes ${LEAD_TIME_DAYS}d`; priority = 'Critical';
                } else if (daysOfCover <= LEAD_TIME_DAYS + 14) {
                    bucket = 'BUY SOON'; reason = `${daysOfCover}d cover approaching ${LEAD_TIME_DAYS}d lead time`; priority = 'High';
                } else {
                    bucket = 'MONITOR'; reason = `${daysOfCover === 999 ? 'No demand signal' : daysOfCover + 'd cover'} – healthy for now`; priority = 'Normal';
                }

                const status = isDead ? 'Dead'
                    : onHand === 0 ? 'Out of stock'
                    : isStockoutRisk ? 'Stockout risk'
                    : isOverstock ? 'Overstock'
                    : isSlowMover ? 'Slow mover'
                    : 'Healthy';

                const skuCode = (v.sku || `OC-${String(p.id).slice(-4)}-${String(v.title || 'DEF').replace(/[^A-Za-z0-9]+/g, '').slice(0, 6).toUpperCase() || 'DEF'}`).toUpperCase();

                return {
                    id: v.id,
                    title: v.title || 'Default',
                    sku: v.sku || '',
                    sku_code: skuCode,
                    price: v.price,
                    compare_at_price: v.compare_at_price,
                    on_hand: onHand,
                    in_circulation: s.in_circulation,
                    delivered: s.delivered,
                    rto_incoming: s.rto_incoming,
                    return_incoming: s.return_incoming,
                    exchange_incoming: s.exchange_incoming,
                    exchange_outgoing: s.exchange_outgoing,
                    final_available: finalAvailable,
                    stock_value: money(onHand * v.price),
                    rto_rate_pct: shippedUnits > 0 ? Math.round(s.rto_incoming / shippedUnits * 1000) / 10 : 0,
                    return_rate_pct: s.delivered > 0 ? Math.round(s.return_incoming / s.delivered * 1000) / 10 : 0,
                    low_stock: onHand <= 3,
                    // control-tower derivations
                    weekly_sales: weeklySales,
                    velocity,
                    sales7, sales14, sales30, sales60, sales90,
                    sell_through_30: onHand + sales30 > 0 ? +((sales30 / (onHand + sales30)) * 100).toFixed(1) : 0,
                    days_of_cover: daysOfCover,
                    weeks_of_supply: daysOfCover === 999 ? null : +(daysOfCover / 7).toFixed(1),
                    last_sale_days_ago: lastSaleDaysAgo,
                    xyz, cv: +cv.toFixed(2),
                    lead_time_days: LEAD_TIME_DAYS,
                    safety_stock: safetyStock,
                    reorder_point: reorderPoint,
                    incoming_qty: incomingQty,
                    incoming_eta_days: incomingEtaDays,
                    ageing_days: ageingDays,
                    age_bucket: ageingDays != null ? ageBucketOf(ageingDays) : null,
                    is_dead: isDead,
                    is_overstock: isOverstock,
                    is_stockout_risk: isStockoutRisk,
                    is_slow_mover: isSlowMover,
                    status,
                    replenishment: {
                        bucket, reason, priority,
                        recommended_qty: recommendedQty,
                        purchase_value: money(recommendedQty * v.price), // at selling price — no cost data
                        target_cover_days: TARGET_COVER_DAYS
                    },
                    value_at_price: money(onHand * v.price),
                    revenue_30: money(sales30 * v.price)
                };
            });
            const sum = (key) => variants.reduce((acc, v) => acc + (v[key] || 0), 0);
            const totals = {
                on_hand: sum('on_hand'),
                in_circulation: sum('in_circulation'),
                delivered: sum('delivered'),
                rto_incoming: sum('rto_incoming'),
                return_incoming: sum('return_incoming'),
                exchange_incoming: sum('exchange_incoming'),
                exchange_outgoing: sum('exchange_outgoing'),
                final_available: sum('final_available'),
                stock_value: money(sum('stock_value'))
            };
            const shippedUnits = totals.delivered + totals.rto_incoming + totals.in_circulation;
            return {
                id: p.id,
                title: p.title,
                image: p.image,
                handle: p.handle,
                variant_count: variants.length,
                ageing_days: ageingDays,
                totals,
                rto_rate_pct: shippedUnits > 0 ? Math.round(totals.rto_incoming / shippedUnits * 1000) / 10 : 0,
                variants
            };
        }).sort((a, b) => a.title.localeCompare(b.title));

        // ---------- ABC classification (30-day revenue share) ----------
        const flatVariants = products.flatMap(p => p.variants);
        const rankedByRevenue = flatVariants
            .map(v => ({ v, revenue30: v.revenue_30 }))
            .sort((a, b) => b.revenue30 - a.revenue30);
        const totalRevenue30 = rankedByRevenue.reduce((a, x) => a + x.revenue30, 0) || 1;
        let cumRevenue = 0;
        for (const x of rankedByRevenue) {
            cumRevenue += x.revenue30;
            const cumPct = cumRevenue / totalRevenue30;
            x.v.abc = cumPct <= 0.7 ? 'A' : cumPct <= 0.9 ? 'B' : 'C';
        }

        // ---------- Forecast accuracy (WMAPE across variants) ----------
        let errSum = 0, actualSum = 0, overBias = 0;
        for (const v of flatVariants) {
            const actual = v.weekly_sales[11] || 0;
            const forecast = weightedMovingForecast(v.weekly_sales);
            errSum += Math.abs(actual - forecast);
            actualSum += actual;
            if (forecast > actual) overBias += 1;
        }
        const wmape = actualSum > 0 ? (errSum / actualSum) * 100 : 0;

        // ---------- Portfolio summary ----------
        const agg = (key) => products.reduce((acc, p) => acc + p.totals[key], 0);
        const onHandUnits = agg('on_hand');
        const summary = {
            products: products.length,
            variants: products.reduce((acc, p) => acc + p.variant_count, 0),
            on_hand_units: onHandUnits,
            stock_value: money(agg('stock_value')),
            in_circulation_units: agg('in_circulation'),
            rto_incoming_units: agg('rto_incoming'),
            return_incoming_units: agg('return_incoming'),
            exchange_incoming_units: agg('exchange_incoming'),
            exchange_outgoing_units: agg('exchange_outgoing'),
            final_available_units: onHandUnits + agg('rto_incoming') + agg('return_incoming') + agg('exchange_incoming') - agg('exchange_outgoing'),
            delivered_units: agg('delivered'),
            low_stock_variants: products.reduce((acc, p) => acc + p.variants.filter(v => v.low_stock).length, 0),
            // control-tower portfolio derivations (monetary figures at selling price — no cost data)
            weekly_sales_total: Array.from({ length: 12 }, (_, w) => flatVariants.reduce((a, v) => a + (v.weekly_sales[w] || 0), 0)),
            sales_30_total: flatVariants.reduce((a, v) => a + v.sales30, 0),
            sales_7_total: flatVariants.reduce((a, v) => a + v.sales7, 0),
            velocity_units_per_day: +(flatVariants.reduce((a, v) => a + v.velocity, 0)).toFixed(2),
            lead_time_days: LEAD_TIME_DAYS,
            counts: {
                dead: flatVariants.filter(v => v.is_dead).length,
                out_of_stock: flatVariants.filter(v => v.on_hand === 0).length,
                stockout_risk: flatVariants.filter(v => v.is_stockout_risk).length,
                overstock: flatVariants.filter(v => v.is_overstock).length,
                slow_mover: flatVariants.filter(v => v.is_slow_mover).length,
                healthy: flatVariants.filter(v => v.status === 'Healthy').length,
                buy_now: flatVariants.filter(v => v.replenishment.bucket === 'BUY NOW').length,
                buy_soon: flatVariants.filter(v => v.replenishment.bucket === 'BUY SOON').length
            },
            forecast: {
                wmape_pct: +wmape.toFixed(1),
                accuracy_pct: +Math.max(0, Math.min(100, 100 - wmape)).toFixed(1),
                over_bias: overBias,
                under_bias: flatVariants.length - overBias
            }
        };

        const untrackedList = [...untracked.values()].filter(u => BUCKETS.some(b => u[b] > 0))
            .sort((a, b) => a.title.localeCompare(b.title));

        const response = {
            success: true,
            window_days: windowDays,
            generated_at: new Date().toISOString(),
            summary,
            products,
            untracked: untrackedList,
            returns_server: {
                connected: rsPipeline.connected,
                reason: rsPipeline.connected ? null : (rsPipeline.reason || null),
                open_requests: rsPipeline.requests.length,
                units: rsUnits
            }
        };
        setCache(cacheKey, response, 'stats', 60 * 60 * 1000); // 1 hour — inventory data changes slowly, cache aggressively
        res.json(response);
    } catch (error) {
        console.error('Inventory intelligence error:', error);
        res.status(500).json({ success: false, error: 'Failed to compute inventory intelligence' });
    }
});

module.exports = router;
