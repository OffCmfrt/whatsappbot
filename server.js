require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const messageHandler = require('./src/handlers/messageHandler');
const adminRoutes = require('./src/routes/adminRoutes');
const { testConnection, initializeDatabase } = require('./src/database/db');
const { startCacheStatsLogging, getCacheStats } = require('./src/utils/cache');

const app = express();

// Trust proxy for Render deployment to fix express-rate-limit X-Forwarded-For error
app.set('trust proxy', 1);

// Set security HTTP headers
app.use(helmet());

// Apply compression middleware for response payload compression
app.use(compression());


// Apply generic rate limiter to all requests (adjust as needed)
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate Limiter for public/unauthenticated routes (2000 requests per 15 minutes per IP)
// NOTE: /api/admin is JWT-protected and exempted here because dashboard chat polling
// (every 8s) would exhaust a low limit in ~13 minutes, breaking manual sends.
const genericLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // limit each IP to 2000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path?.startsWith('/api/admin'),
  message: 'Too many requests, please try again later.'
});
app.use(genericLimiter);

// Dedicated higher limit for authenticated admin API (protected by JWT)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // generous limit for active dashboard usage
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many admin requests, please try again later.'
});
app.use('/api/admin', adminLimiter);

// More strict rate limiter for WhatsApp webhook POST route (500 requests per minute per IP)
// Adjusted for 1000+ orders/day with potential burst traffic from Shopify webhooks
const whatsappLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500, // limit each IP to 500 requests per windowMs (supports burst traffic)
  standardHeaders: true, 
  legacyHeaders: false,
  message: 'Too many webhook requests from this IP, please slow down.'
});
app.use('/webhook', whatsappLimiter);

// Custom middleware to capture raw body for Shopify webhook verification
app.use('/webhooks/shopify', express.raw({ type: '*/*' }));

// Regular JSON parsing for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (admin dashboard)
app.use(express.static(path.join(__dirname, 'public')));

// Serve support portal
app.use('/portal/support', express.static(path.join(__dirname, 'public', 'portal', 'support')));

// Admin API routes
app.use('/api/admin', adminRoutes);

// Support Portal Public API routes
const portalRoutes = require('./src/routes/portalRoutes');
app.use('/api/portal', portalRoutes);

// Internal/Public API routes
const apiRoutes = require('./src/routes/apiRoutes');
app.use('/api/internal', apiRoutes);

// Payment and return webhook routes (specific paths to avoid conflict)
const paymentWebhookRoutes = require('./src/routes/paymentWebhookRoutes');
app.use(paymentWebhookRoutes);

// Shopify Webhooks (Abandoned Cart Recovery)
// Note: This route must receive the raw body from the middleware above for HMAC to work
const shopifyWebhookRoutes = require('./src/routes/shopifyWebhookRoutes');
app.use('/webhooks/shopify', shopifyWebhookRoutes);

// Shiprocket Checkout Webhooks (Abandoned Cart Recovery via SR Checkout)
// OffComfrt uses Shiprocket Checkout as the checkout page, so Shopify's native
// checkout/create & checkout/update webhooks never fire. These routes receive
// Shiprocket's own abandoned-cart events instead.
// Configure in: Shiprocket Dashboard → Solutions → Checkout → Webhooks
const shiprocketCheckoutWebhookRoutes = require('./src/routes/shiprocketCheckoutWebhookRoutes');
app.use('/webhooks/shiprocket', shiprocketCheckoutWebhookRoutes);

// Cron Jobs
const abandonedCartCron = require('./src/services/abandonedCartCron');
const reengagementCron = require('./src/services/reengagementCron');

// WhatsApp webhook verification (Meta Cloud API)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
            console.log('✅ Webhook verified');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// In-memory task queue with increased concurrency for 2000+ customers/day
const taskQueue = [];
let activeTasks = 0;
const MAX_CONCURRENT_TASKS = 25; // Increased to 25 for 2000 customers/day capacity
const MAX_QUEUE_SIZE = 1000; // NEW: Prevent unbounded queue growth

function processQueue() {
  if (!taskQueue.length || activeTasks >= MAX_CONCURRENT_TASKS) {
    return;
  }

  const task = taskQueue.shift();
  activeTasks++;

  setImmediate(async () => {
    try {
      await task();
    } catch (e) {
      console.error('Error in task:', e);
    } finally {
      activeTasks--;
      processQueue();
    }
  });

  processQueue();
}

function enqueueTask(task) {
  // NEW: Drop oldest task if queue is full to prevent memory buildup
  if (taskQueue.length >= MAX_QUEUE_SIZE) {
    console.warn(`⚠️ Task queue full (${MAX_QUEUE_SIZE}), dropping oldest task`);
    taskQueue.shift(); // Remove oldest
  }
  taskQueue.push(task);
  processQueue();
}

app.post('/webhook', (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const metadata = value?.metadata;

      // Handle status updates (delivered, read, sent, failed)
      if (value?.statuses && value.statuses.length > 0) {
        handleStatusUpdate(value.statuses);
        res.sendStatus(200);
        return;
      }

      // Debug logging
      if (value?.messages) {
        const fs = require('fs');
        const debugData = `\n--- 📨 INCOMING WEBHOOK @ ${new Date().toISOString()} ---\nMsg Count: ${value.messages.length}\nFull Body: ${JSON.stringify(body)}\n`;
        fs.appendFileSync('debug_webhook.txt', debugData);
      }

      if (value?.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const from = message.from;
        const senderName = value.contacts?.[0]?.profile?.name;

        let messageBody = null;

        // 1. Check for interactive button/list replies
        if (message.interactive) {
          const interactiveData = message.interactive.button_reply || message.interactive.list_reply;
          if (interactiveData) {
            messageBody = handleButtonResponse(interactiveData.id);
          }
        } 
        // 2. Check for Quick Reply template button clicks
        else if (message.type === 'button' && message.button?.payload) {
          messageBody = handleButtonResponse(message.button.payload);
        } 
        // 3. Fallback to regular text
        else if (message.text?.body) {
          messageBody = message.text.body;
        }

        if (messageBody) {
          console.log(`📨 Webhook message from ${from}: "${messageBody}" [queued]`);
          
          // Respond to Meta immediately to prevent timeout/retry
          res.sendStatus(200);
          
          // Process message asynchronously
          enqueueTask(() => messageHandler.processMessage(from, messageBody, senderName));
        } else {
          res.sendStatus(200);
        }
      } else {
        // Empty messages array
        res.sendStatus(200);
      }
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.sendStatus(500);
  }
});

// Helper function to handle WhatsApp status updates (sent, delivered, read, failed)
async function handleStatusUpdate(statuses) {
  const { dbAdapter } = require('./src/database/db');
  const followUpService = require('./src/services/followUpService');
  
  for (const status of statuses) {
    const waMessageId = status.id;
    const whatsappStatus = status.status; // sent, delivered, read, failed
    const recipientId = status.recipient_id; // Phone number of recipient
    const errors = status.errors; // Meta error details if failed
    
    // Map WhatsApp statuses to our DB statuses
    const statusMap = {
      'sent': 'sent',
      'delivered': 'delivered',
      'read': 'read',
      'failed': 'failed'
    };
    
    const dbStatus = statusMap[whatsappStatus];
    if (!dbStatus) continue;
    
    // Log failed messages with detailed error info
    if (whatsappStatus === 'failed' && errors?.length > 0) {
      console.error(`❌ [STATUS] Message FAILED to ${recipientId || 'unknown'} (wamid: ${waMessageId}):`);
      for (const err of errors) {
        console.error(`   Code: ${err.code}, Message: ${err.message}, Title: ${err.title || 'N/A'}`);
        // Common failure codes:
        // 131047: Rate limit hit
        // 131030: Recipient not in allowed list (test numbers)
        // 131052: Media download error
        // 131013: Template parameter mismatch
      }
    }
    
    try {
      // Update the message status in the database using wa_message_id
      const result = await dbAdapter.run(
        `UPDATE messages SET status = ? WHERE wa_message_id = ?`,
        [dbStatus, waMessageId]
      );
      
      if (result.changes > 0) {
        console.log(`[STATUS] Message ${waMessageId} → ${dbStatus}`);
      }
      
      // Also update follow-up recipient status if applicable
      if (whatsappStatus === 'delivered' || whatsappStatus === 'read') {
        await followUpService.updateMessageStatus(waMessageId, whatsappStatus);
      }
    } catch (err) {
      console.error(`[STATUS] Failed to update status for ${waMessageId}:`, err.message);
    }
  }
}

// Helper function to convert button IDs to commands
function handleButtonResponse(buttonId) {
    const buttonMap = {
        // Main menu
        'track_order': 'status',
        'order_history': 'history',
        'menu_return': 'return',
        'menu_exchange': 'exchange',

        'menu_language': 'language',
        'menu_contact_support': 'menu_contact_support',
        // Legacy / help
        'get_help': 'help',
        'contact_support': 'help',
        // Language list rows
        'lang_1': 'lang_en',
        'lang_2': 'lang_hi',
        'lang_3': 'lang_ta',
        'lang_4': 'lang_te',
        'lang_5': 'lang_kn',
        'lang_6': 'lang_ml',

        // Shopper Hub responses
        'confirm_order': 'shop_confirm',
        'cancel_order': 'shop_cancel',
        'edit_order_details': 'shop_edit',

        // Human readable template buttons (Meta v4)
        'Confirm Order': 'shop_confirm',
        'Cancel Order': 'shop_cancel',
        'Edit Details': 'shop_edit',
        'Edit Details(Size, Add.)': 'shop_edit'  // Updated button text with size/add options
    };

    return buttonMap[buttonId] || buttonId;
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Serve admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Start server
async function startServer() {
    try {
        // Test database connection
        console.log('🔄 Testing database connection...');
        const dbConnected = await testConnection();

        if (!dbConnected) {
            console.error('❌ Database connection failed. Ensure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set correctly.');
            process.exit(1);
        }

        // Initialize database tables
        console.log('🔄 Initializing database...');
        await initializeDatabase();

        // Start cache statistics logging (every 5 minutes)
        console.log('📊 Initializing cache statistics logging...');
        startCacheStatsLogging(5 * 60 * 1000);

        // Warm up cache with frequently accessed data
        console.log('🔥 Warming up cache...');
        try {
            const Customer = require('./src/models/Customer');
            const Order = require('./src/models/Order');
            const Message = require('./src/models/Message');
            
            // Pre-load counts
            await Promise.all([
                Customer.getCount(),
                Order.getCount(),
                Message.getCount()
            ]);
            console.log('✅ Cache warmed up successfully');
        } catch (error) {
            console.warn('⚠️ Cache warm-up failed (non-critical):', error.message);
        }

        // Start Cron Jobs
        abandonedCartCron.init();
        reengagementCron.init();

        // NEW: Memory monitoring - log every 5 minutes
        setInterval(() => {
            const used = process.memoryUsage();
            const memoryMB = Math.round(used.rss / 1024 / 1024);
            const limitMB = 512;
            const usagePercent = Math.round((memoryMB / limitMB) * 100);
            
            console.log(`[MEMORY] Usage: ${memoryMB}MB / ${limitMB}MB (${usagePercent}%)`);
            
            if (usagePercent > 70) {
                console.warn(`⚠️ WARNING: Memory usage at ${usagePercent}%!`);
            }
            
            if (usagePercent > 85) {
                console.error('🚨 CRITICAL: Memory usage too high! Triggering cleanup...');
                // Clear caches
                const Settings = require('./src/models/Settings');
                Settings._cache.clear();
                console.log('[MEMORY] Emergency cache cleanup triggered');
            }
        }, 5 * 60 * 1000); // Every 5 minutes

        // NEW: Clear Settings cache every hour to prevent memory buildup
        setInterval(() => {
            const Settings = require('./src/models/Settings');
            Settings.clearOldCache();
        }, 60 * 60 * 1000); // Every hour

        // Start Express server
        app.listen(PORT, () => {
            console.log('');
            console.log('🚀 WhatsApp Order Bot Server Started!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`📡 Server running on port ${PORT}`);
            console.log(`🌐 Webhook URL: ${process.env.WEBHOOK_URL || `http://localhost:${PORT}`}/webhook`);
            console.log(`👨‍💼 Admin Dashboard: http://localhost:${PORT}/admin`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('');
        });
    } catch (error) {
        console.error('❌ Failed to start server!');
        console.error('Error Details:', error.message);
        if (error.stack) console.error('Stack Trace:', error.stack);
        
        // Specific checks for common failures
        if (error.message.includes('WHATSAPP_')) {
            console.error('ℹ️ Hint: Check your WhatsApp Meta API environment variables.');
        }
        if (error.message.includes('TURSO_')) {
            console.error('ℹ️ Hint: Check your Turso/libSQL database credentials.');
        }
        
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    process.exit(0);
});

// Start the server
startServer();
