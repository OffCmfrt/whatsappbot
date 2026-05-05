const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { verifyToken } = require('../middleware/auth');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Settings = require('../models/Settings');
const broadcastService = require('../services/broadcastService');
const followUpService = require('../services/followUpService');
const whatsappService = require('../services/whatsappService');
const { dbAdapter } = require('../database/db');
const xlsx = require('xlsx');
const multer = require('multer');
const cloudinaryService = require('../services/cloudinaryService');
const { toIST, formatDateForExport, fromISTtoUTC } = require('../utils/timezone');
const { invalidateCache: clearAllCaches, getCacheStats } = require('../utils/cache');
const upload = multer({ storage: multer.memoryStorage() });

// Advanced caching system imported from utils/cache
// Using LRU cache with TTL for better performance

// Invalidate all caches (call after data mutations)
function invalidateCache() {
  clearAllCaches(); // From utils/cache
  console.log('🗑️ All caches invalidated');
}

// Admin login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Check credentials (in production, hash password and store in DB)
        if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
            // Generate JWT token
            const token = jwt.sign(
                { username, role: 'admin' },
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

// Get dashboard statistics
router.get('/stats', verifyToken, async (req, res) => {
    try {
        // Check cache first
        const cached = getCached('stats');
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

        // Cache the response
        setCache('stats', response);
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

        const sql = `
            SELECT c.*, 
                (SELECT COUNT(*) FROM messages m WHERE m.customer_phone = c.phone) as message_count
            FROM customers c
            ${segmentCondition}
            ORDER BY c.updated_at DESC
            LIMIT ? OFFSET ?
        `;
        formattedCustomers = await dbAdapter.query(sql, [...segmentParams, parseInt(limit), parseInt(offset)]);

        res.json({
            success: true,
            customers: formattedCustomers,
            total,
            page: Math.floor(offset / limit) + 1,
            limit: parseInt(limit)
        });
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
        
        // Fetch ALL orders from database (no limit)
        const orders = await dbAdapter.query(
            'SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC',
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

        const sql = `
            SELECT o.*, c.name as customer_name 
            FROM orders o 
            LEFT JOIN customers c ON o.customer_phone = c.phone 
            ORDER BY o.created_at DESC 
            LIMIT ? OFFSET ?
        `;
        formattedOrders = await dbAdapter.query(sql, [parseInt(limit), parseInt(offset)]);

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
        msgs = await dbAdapter.query('SELECT * FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?', [parseInt(limit), parseInt(offset)]);
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
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);

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
router.post('/upload', verifyToken, upload.single('image'), async (req, res) => {
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

// Get analytics
router.get('/analytics', verifyToken, async (req, res) => {
    try {
        let messageStats = [];
        let orderStats = [];

        messageStats = await dbAdapter.query('SELECT message_type, created_at FROM messages');
        orderStats = await dbAdapter.query('SELECT status, created_at FROM orders');

        const analytics = {
            messagesByType: processMessagesByType(messageStats),
            ordersByStatus: processOrdersByStatus(orderStats),
            messagesOverTime: processMessagesOverTime(messageStats)
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
    const orders = await dbAdapter.query('SELECT status FROM orders');

    const statusCounts = {};
    (orders || []).forEach(order => {
        statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;
    });

    return { labels: Object.keys(statusCounts), values: Object.values(statusCounts) };
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

function processMessagesByType(messages) {
    const counts = {};
    messages.forEach(msg => {
        counts[msg.message_type] = (counts[msg.message_type] || 0) + 1;
    });
    return counts;
}

function processOrdersByStatus(orders) {
    const counts = {};
    orders.forEach(order => {
        counts[order.status] = (counts[order.status] || 0) + 1;
    });
    return counts;
}

function processMessagesOverTime(messages) {
    const last7Days = {};
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        last7Days[date.toISOString().split('T')[0]] = 0;
    }
    messages.forEach(msg => {
        const dateStr = msg.created_at.split('T')[0];
        if (last7Days.hasOwnProperty(dateStr)) last7Days[dateStr]++;
    });
    return last7Days;
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

        await ensureTemplatesTable();
        for (const t of metaTemplates) {
            // Upsert logic
            const existing = await dbAdapter.query('SELECT id FROM templates WHERE name = ?', [t.name]);
            if (existing && existing.length > 0) {
                await dbAdapter.query(
                    `UPDATE templates SET category=?, status=?, language=?, body=?, components=?, updated_at=? WHERE name=?`,
                    [t.category, t.status, t.language, '', JSON.stringify(t.components), new Date().toISOString(), t.name]
                );
            } else {
                await dbAdapter.query(
                    `INSERT INTO templates (id, name, category, status, language, body, components, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [t.id || `meta_${Date.now()}_${Math.random()}`, t.name, t.category, t.status, t.language, '', JSON.stringify(t.components), new Date().toISOString()]
                );
            }
        }
        
        // Invalidate cache after template changes
        invalidateCache();

        res.json({ success: true, count: metaTemplates.length });
    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({ error: 'Failed to sync templates from Meta' });
    }
});

async function ensureTemplatesTable() {
    // First ensure table exists
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

    // Defensively add new columns if they don't exist
    const columns = [
        { name: 'status', type: 'TEXT' },
        { name: 'language', type: 'TEXT' },
        { name: 'components', type: 'TEXT' }
    ];

    for (const col of columns) {
        try {
            await dbAdapter.query(`ALTER TABLE templates ADD COLUMN ${col.name} ${col.type}`);
            console.log(`✅ Added column ${col.name} to templates table`);
        } catch (err) {
            // Ignore error if column already exists
            if (!err.message.includes('duplicate column name')) {
                console.log(`ℹ️ Column ${col.name} might already exist or handled by Turso`);
            }
        }
    }
}

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

// Get all automation configs
router.get('/automation', verifyToken, async (req, res) => {
    try {
        await ensureAutomationTable();
        const configs = await dbAdapter.select('automation_config', {}, { orderBy: 'type ASC' });
        res.json({ success: true, configs });
    } catch (error) {
        console.error('Fetch automation error:', error);
        res.status(500).json({ error: 'Failed to fetch automation configs' });
    }
});

// Save/Update automation config
router.post('/automation', verifyToken, async (req, res) => {
    try {
        const { key, type, content, description } = req.body;
        await ensureAutomationTable();

        const configData = {
            key,
            type,
            content: typeof content === 'string' ? content : JSON.stringify(content),
            description: description || '',
            updated_at: new Date().toISOString()
        };

        console.log(`💾 Saving automation: ${key} (${type})`);
        console.log(`📦 Payload:`, configData.content);

        const existing = await dbAdapter.select('automation_config', { key });
        if (existing && existing.length > 0) {
            console.log(`🔄 Updating existing automation: ${key}`);
            await dbAdapter.update('automation_config', configData, { key });
        } else {
            console.log(`🆕 Inserting new automation: ${key}`);
            configData.id = req.body.id || `auto_${Date.now()}`;
            await dbAdapter.insert('automation_config', configData);
        }

        // Invalidate cache after automation changes
        invalidateCache();
        res.json({ success: true });
    } catch (error) {
        console.error('Save automation error:', error);
        res.status(500).json({ error: 'Failed to save automation config' });
    }
});

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
        // Fetch customers with their latest order date
        const sql = `
            SELECT c.*, MAX(o.order_date) as last_order_at
            FROM customers c
            LEFT JOIN orders o ON c.phone = o.customer_phone
            GROUP BY c.phone
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

        res.json({ success: true, segments });
    } catch (error) {
        console.error('Fetch segments error:', error);
        res.status(500).json({ error: 'Failed to fetch customer segments' });
    }
});

// Sync default automation from hardcoded files
router.post('/automation/sync', verifyToken, async (req, res) => {
    try {
        await ensureAutomationTable();
        const faqHandler = require('../handlers/faqHandler');
        const messageHandler = require('../handlers/messageHandler');

        const defaults = [];

        // Add FAQs (Simplified Active Style)
        faqHandler.faqs.forEach(faq => {
            let answer = faq.answer;

            // Custom active return message provided by user
            if (faq.keywords.includes('return')) {
                answer = "To initiate a *Return*, please visit our website.\n\nOur team reviews all return requests within 24–48 hours. 🙏";
            }

            defaults.push({
                id: `auto_faq_${faq.keywords[0]}`,
                key: faq.keywords[0],
                type: 'faq',
                content: JSON.stringify({
                    answer: answer,
                    keywords: faq.keywords
                })
            });
        });

        // Add Welcome/Help (Simplified Active Style)
        defaults.push({
            id: 'auto_welcome',
            key: 'welcome_message',
            type: 'welcome',
            content: JSON.stringify({ 
                answer: "👋 Hi {{name}}! Welcome to OFFCOMFRT.\n\nI'm your personal shopping assistant. I can help you with orders, returns, exchanges and more!\n\nJust send me your *Order ID* to track it instantly! ✨" 
            })
        });

        let syncCount = 0;
        for (const config of defaults) {
            config.updated_at = new Date().toISOString();
            
            // Overwrite existing keys to ensure "active" versions are loaded
            const existing = await dbAdapter.select('automation_config', { key: config.key });
            if (existing && existing.length > 0) {
                await dbAdapter.update('automation_config', config, { key: config.key });
            } else {
                await dbAdapter.insert('automation_config', config);
            }
            syncCount++;
        }
        
        // Invalidate cache after bulk sync
        invalidateCache();

        res.json({ success: true, count: syncCount });
    } catch (error) {
        console.error('❌ Automation sync error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        });
        res.status(500).json({ 
            error: 'Failed to sync automation defaults', 
            details: error.message 
        });
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
        invalidateCache();
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
        invalidateCache();
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
        invalidateCache();
        res.json({ success: true });
    } catch (error) {
        console.error('Template delete error:', error);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// ===================================
// Returns & Exchanges Endpoints
// ===================================

router.get('/returns', verifyToken, async (req, res) => {
    try {
        const exchanges = await dbAdapter.query('SELECT * FROM exchanges ORDER BY created_at DESC');
        res.json({ success: true, exchanges });
    } catch (error) {
        console.error('Error fetching exchanges:', error);
        res.status(500).json({ error: 'Failed to fetch exchanges' });
    }
});

// Status update endpoints
['returns', 'exchanges'].forEach(type => {
    router.post(`/${type}/:id/approve`, verifyToken, async (req, res) => {
        try {
            const result = type === 'returns'
                ? await require('../services/returnService').approveReturn(req.params.id)
                : await require('../services/returnService').approveExchange(req.params.id);
            if (result.success) res.json(result);
            else res.status(400).json({ error: result.error || result.message });
        } catch (error) {
            res.status(500).json({ error: `Failed to approve ${type.slice(0, -1)}` });
        }
    });

    router.post(`/${type}/:id/reject`, verifyToken, async (req, res) => {
        try {
            const result = type === 'returns'
                ? await require('../services/returnService').rejectReturn(req.params.id, req.body.reason)
                : await require('../services/returnService').rejectExchange(req.params.id, req.body.reason);
            if (result.success) res.json(result);
            else res.status(400).json({ error: result.error });
        } catch (error) {
            res.status(500).json({ error: `Failed to reject ${type.slice(0, -1)}` });
        }
    });
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
router.get('/support-tickets', verifyToken, async (req, res) => {
    try {
        const { status, is_read, date_from, date_to, time_from, time_to } = req.query;
        let query = 'SELECT * FROM support_tickets';
        const params = [];
        const conditions = [];

        if (status) {
            conditions.push('status = ?');
            params.push(status);
        }

        if (is_read !== undefined) {
            conditions.push('is_read = ?');
            params.push(is_read === 'true' ? 1 : 0);
        }

        if (date_from) {
            conditions.push('DATE(created_at) >= ?');
            params.push(date_from);
        }

        if (date_to) {
            conditions.push('DATE(created_at) <= ?');
            params.push(date_to);
        }

        if (time_from) {
            conditions.push('TIME(created_at) >= ?');
            params.push(time_from);
        }

        if (time_to) {
            conditions.push('TIME(created_at) <= ?');
            params.push(time_to);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY created_at DESC';

        const tickets = await dbAdapter.query(query, params);
        res.json({ success: true, tickets });
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
            params.push(is_read ? 1 : 0);
        }

        params.push(id);

        await dbAdapter.query(
            `UPDATE support_tickets SET ${updates.join(', ')} WHERE id = ?`,
            params
        );
        
        // Invalidate cache after ticket status change
        invalidateCache();

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
            `UPDATE support_tickets SET is_read = 1 WHERE id = ?`,
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
            `UPDATE support_tickets SET is_read = 1 WHERE id IN (${placeholders})`,
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

        invalidateCache();
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

        await dbAdapter.query(
            `DELETE FROM support_tickets WHERE id = ?`,
            [id]
        );
        
        // Invalidate cache after ticket deletion
        invalidateCache();

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
        invalidateCache();

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
        const { limit = 100, offset = 0, status, search, startDate, endDate, orderIdFrom, orderIdTo, paymentMethod, deliveryType, sortBy } = req.query;
        
        let whereClause = 'WHERE 1=1';
        const params = [];

        if (status && status !== 'all') {
            whereClause += ' AND s.status = ?';
            params.push(status);
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
        const countSql = `SELECT COUNT(DISTINCT s.order_id) as total FROM store_shoppers s ${whereClause}`;
        const countRes = await dbAdapter.query(countSql, params);
        const total = countRes[0]?.total || 0;

        // Use GROUP BY order_id to ensure no duplicates are returned
        // GROUP BY automatically keeps the first row for each order_id
        const sql = `
            SELECT s.*, 
                   (SELECT o.awb FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as awb,
                   (SELECT o.courier_name FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as courier_name,
                   (SELECT IFNULL(s.order_total, o.total) FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as order_total,
                   (SELECT o.status FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as order_status,
                   (SELECT o.tracking_url FROM orders o WHERE o.order_id = s.order_id LIMIT 1) as tracking_url
            FROM store_shoppers s
            ${whereClause} 
            GROUP BY s.order_id
            ${orderByClause}
            LIMIT ? OFFSET ?
        `;
        const shoppers = await dbAdapter.query(sql, [...params, parseInt(limit), parseInt(offset)]);

        // Note: Deduplication removed after cleanup script ran on 2026-04-29
        // If duplicates reappear, re-enable the deduplication logic below

        res.json({
            success: true,
            shoppers,
            total,
            page: Math.floor(offset / limit) + 1
        });
    } catch (error) {
        console.error('Shoppers fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch shoppers' });
    }
});

// Update shopper details (Manual Edit)
router.put('/shoppers/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, order_id, address, items_json, order_total, delivery_type } = req.body;

        const updateData = {
            updated_at: new Date().toISOString()
        };
        if (name !== undefined) updateData.name = name;
        if (phone !== undefined) updateData.phone = phone;
        if (order_id !== undefined) updateData.order_id = order_id;
        if (address !== undefined) updateData.address = address;
        if (items_json !== undefined) updateData.items_json = items_json;
        if (order_total !== undefined) updateData.order_total = order_total;
        if (delivery_type !== undefined) updateData.delivery_type = delivery_type;

        await dbAdapter.update('store_shoppers', updateData, { id });
        
        // Invalidate cache after shopper update
        invalidateCache();
        res.json({ success: true, message: 'Shopper updated successfully' });
    } catch (error) {
        console.error('Shopper update error:', error);
        res.status(500).json({ error: 'Failed to update shopper' });
    }
});

// Update shopper status manually (Confirm/Reject)
router.post('/shoppers/:id/status', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'confirmed', 'cancelled', 'edit_details'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const updateData = { 
            status, 
            updated_at: new Date().toISOString()
        };

        // Track confirmation method for non-pending statuses
        if (['confirmed', 'cancelled', 'edit_details'].includes(status)) {
            updateData.confirmed_by = 'manual';
        }

        await dbAdapter.update('store_shoppers', updateData, { id });

        // Invalidate cache after shopper status change
        invalidateCache();
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (error) {
        console.error('Shopper status update error:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Bulk delete shoppers
router.delete('/shoppers/bulk', verifyToken, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No IDs provided' });
        }

        const placeholders = ids.map(() => '?').join(',');
        const sql = `DELETE FROM store_shoppers WHERE id IN (${placeholders})`;
        await dbAdapter.query(sql, ids);

        // Invalidate cache after bulk shopper deletion
        invalidateCache();
        res.json({ success: true, message: `Successfully deleted ${ids.length} records` });
    } catch (error) {
        console.error('Shoppers bulk delete error:', error);
        res.status(500).json({ error: 'Failed to delete shoppers' });
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

        // Find phones with 2+ orders where at least one pair is within 24 hours (1 day in julianday)
        const multiOrderPhonesSql = `
            SELECT DISTINCT s1.phone
            FROM store_shoppers s1
            JOIN store_shoppers s2 ON s1.phone = s2.phone
                AND s1.id != s2.id
                AND ABS(julianday(s1.created_at) - julianday(s2.created_at)) <= 1
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
router.get('/shoppers/export', verifyToken, async (req, res) => {
    try {
        const { status, search, startDate, endDate, orderIdFrom, orderIdTo, format = 'xlsx', exportType } = req.query;
        
        let whereClause = 'WHERE 1=1';
        const params = [];

        if (status && status !== 'all') {
            whereClause += ' AND s.status = ?';
            params.push(status);
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
                   s.payment_method, s.items_json, s.status, s.created_at, s.customer_message,
                   s.delivery_type, IFNULL(s.order_total, o.total) as order_total,
                   o.awb, o.courier_name
            FROM store_shoppers s
            LEFT JOIN orders o ON s.order_id = o.order_id
            ${whereClause} 
            GROUP BY s.order_id
            ORDER BY MIN(s.created_at) DESC
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
            const ws = xlsx.utils.json_to_sheet(exportData);
            const csv = xlsx.utils.sheet_to_csv(ws);
            const istDate = toIST(new Date(), 'date');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=shoppers_${istDate}.csv`);
            return res.send(csv);
        }

        // Create Excel workbook
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(exportData);
        xlsx.utils.book_append_sheet(wb, ws, exportType === 'daily' ? "Daily Report" : "Shoppers");

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

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
router.get('/inbox/export', verifyToken, async (req, res) => {
    try {
        const { tab = 'confirmed', startDate, endDate, confirmedBy, paymentMethod, deliveryType, search, format = 'xlsx', orderIds, dateField = 'updated_at' } = req.query;

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
                   IFNULL(s.order_total, o.total) as order_total,
                   o.awb, o.courier_name
            FROM store_shoppers s
            LEFT JOIN orders o ON s.order_id = o.order_id
            ${whereClause}
            GROUP BY s.order_id
            ORDER BY MAX(s.updated_at) DESC
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
            const ws = xlsx.utils.json_to_sheet(exportData);
            const csv = xlsx.utils.sheet_to_csv(ws);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=${tabLabel}_${istDate}.csv`);
            return res.send(csv);
        }

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(exportData);
        xlsx.utils.book_append_sheet(wb, ws, 'Inbox Export');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
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

        // Find phones with unread incoming messages (optimized with subqueries)
        // Group by phone to get the latest unread message per customer
        const unreadSql = `
            SELECT m.customer_phone as phone,
                   MAX(m.created_at) as last_message_at,
                   COUNT(*) as unread_count,
                   MAX(m.message_content) as latest_message,
                   (SELECT c.name FROM customers c WHERE c.phone = m.customer_phone LIMIT 1) as name,
                   (SELECT s.id FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as shopper_id,
                   (SELECT s.order_id FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as order_id,
                   (SELECT s.status FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as status,
                   (SELECT s.order_total FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as order_total,
                   (SELECT s.delivery_type FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as delivery_type,
                   (SELECT s.payment_method FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as payment_method,
                   (SELECT s.items_json FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as items_json,
                   (SELECT s.confirmed_by FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as confirmed_by,
                   (SELECT s.created_at FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as created_at,
                   (SELECT s.updated_at FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as updated_at,
                   (SELECT s.last_response_at FROM store_shoppers s WHERE s.phone = m.customer_phone ORDER BY s.created_at DESC LIMIT 1) as last_response_at
            FROM messages m
            WHERE m.message_type = 'incoming'
              AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id)
              ${dateClause}
              ${searchClause}
              ${actionClause}
            GROUP BY m.customer_phone
            ORDER BY MAX(m.created_at) DESC
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

        res.json({
            success: true,
            shoppers,
            total,
            page: Math.floor(offset / limit) + 1
        });
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
router.post('/chat/send', verifyToken, async (req, res) => {
    try {
        const { phone, message, type = 'text' } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }
        
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
                    `INSERT OR IGNORE INTO message_reads (message_id, read_at, read_by) VALUES ${placeholders}`,
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

        const confirmedSql = `
            SELECT s.id, s.phone, s.name, s.order_id, s.status, s.customer_message,
                   s.last_response_at, s.created_at, s.updated_at, s.order_total, s.delivery_type,
                   s.payment_method, s.items_json, s.email, s.address, s.city, s.province, s.zip,
                   s.confirmed_by,
                   o.awb, o.courier_name, o.status as order_status, o.tracking_url,
                   IFNULL(s.order_total, o.total) as order_total
            FROM store_shoppers s
            LEFT JOIN orders o ON s.order_id = o.order_id
            WHERE s.status = 'confirmed'
              ${dateClause}
            GROUP BY s.order_id
            ORDER BY MAX(s.updated_at) DESC
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
        const { startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start date and end date are required' });
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
        `, [startDate + 'T00:00:00Z', endDate + 'T23:59:59Z']);
        
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
        // Get overall stats
        const stats = await dbAdapter.query(`
            SELECT 
                COUNT(DISTINCT phone) as total_shoppers,
                SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_count,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
                SUM(CASE WHEN status = 'edit_details' THEN 1 ELSE 0 END) as edit_requests_count,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN customer_message IS NOT NULL THEN 1 ELSE 0 END) as responded_count,
                AVG(CASE WHEN response_count > 0 THEN response_count END) as avg_response_count
            FROM store_shoppers
            WHERE created_at >= datetime('now', '-30 days')
        `);
        
        // Get daily response stats for the last 7 days
        const dailyStats = await dbAdapter.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total,
                SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) as responded
            FROM store_shoppers
            WHERE created_at >= datetime('now', '-7 days')
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);
        
        res.json({
            success: true,
            overview: stats[0] || {},
            daily: dailyStats
        });
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
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);
        
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
            const ws = xlsx.utils.json_to_sheet(exportData);
            const csv = xlsx.utils.sheet_to_csv(ws);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=follow_up_campaign_${id}.csv`);
            return res.send(csv);
        }
        
        // Excel format
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(exportData);
        xlsx.utils.book_append_sheet(wb, ws, 'Recipients');
        
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
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

        const portal = await dbAdapter.query(
            'SELECT id, name, slug, type, config, created_at FROM support_portals WHERE id = ?',
            [result.lastInsertRowid]
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
            SELECT p.*, COUNT(t.id) as ticket_count
            FROM support_portals p
            LEFT JOIN support_tickets t ON t.portal_id = p.id
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `);

        res.json({
            success: true,
            portals: portals.map(p => ({
                ...p,
                config: p.config ? JSON.parse(p.config) : null,
                url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${p.slug}`
            }))
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

        invalidateCache();
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

        invalidateCache();
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

        invalidateCache();
        res.json({ success: true, message: 'All tickets cleared from portal' });
    } catch (error) {
        console.error('Clear portal tickets error:', error);
        res.status(500).json({ success: false, error: 'Failed to clear tickets' });
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

        // Validate basic parameters
        if (!count || count < 2 || count > 20) {
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
        const maxTickets = portalSettings.maxTickets || null;

        // Create portals based on distribution mode
        if (distributionMode === 'shift_based' && shifts.length > 0) {
            // Create portals for each shift
            for (let i = 0; i < shifts.length; i++) {
                const shift = shifts[i];
                const name = `${shift.name || namePrefix || 'Agent'} ${i + 1}`;
                const slug = generateSlug(name);
                const password = generatePassword();
                const passwordHash = await bcrypt.hash(password, 10);

                const distributionRule = JSON.stringify({
                    shift_start: shift.start,
                    shift_end: shift.end,
                    date_from: filters.dateFrom || null,
                    date_to: filters.dateTo || null,
                    status_filter: filters.statusFilter || ['open']
                });

                const result = await dbAdapter.run(
                    `INSERT INTO support_portals (name, slug, password_hash, type, config, max_tickets, shift_start, shift_end, is_active, distribution_rule, assigned_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [name, slug, passwordHash, 'auto', JSON.stringify({ shift }), maxTickets, shift.start, shift.end, 1, distributionRule, 0]
                );

                createdPortals.push({
                    id: result.lastInsertRowid,
                    name,
                    slug,
                    password,
                    url: `${req.protocol}://${req.get('host')}/portal/support/?slug=${slug}`,
                    shift: shift,
                    maxTickets,
                    ticketCount: 0
                });
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

        if (distributionMode === 'shift_based' && shifts.length > 0) {
            // Shift-based distribution
            for (const ticket of openTickets) {
                const matchedShift = matchTicketToShift(ticket.created_at, shifts);
                if (matchedShift) {
                    const portalIndex = shifts.indexOf(matchedShift);
                    if (portalIndex !== -1 && createdPortals[portalIndex]) {
                        // Check capacity
                        if (!maxTickets || createdPortals[portalIndex].ticketCount < maxTickets) {
                            await dbAdapter.run(
                                'UPDATE support_tickets SET portal_id = ? WHERE id = ?',
                                [createdPortals[portalIndex].id, ticket.id]
                            );
                            createdPortals[portalIndex].ticketCount++;
                        }
                    }
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
            [distributionMode, createdPortals.length, openTickets.length, JSON.stringify({ filters, shifts, portalSettings })]
        );

        invalidateCache();
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

        invalidateCache();
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
            "SELECT id, max_tickets FROM support_portals WHERE type = 'auto' AND is_active = 1" +
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

        invalidateCache();
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
            "SELECT id, name, shift_start, shift_end, is_active, assigned_count, max_tickets FROM support_portals WHERE type = 'auto' AND is_active = 1"
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

module.exports = router;
