require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { sharedHttpsAgent, sharedHttpAgent, reapIdleSockets } = require('./src/utils/httpAgent');

// Route ALL outbound axios traffic (Meta WhatsApp, Shiprocket, Delhivery,
// Ekart, Shopify, Zoho, AI providers) through the bounded shared agent.
// Node >= 19's keep-alive global agent parks idle TLS sockets forever and
// Render's NAT drops them silently — that native-memory leak is fixed by
// capping + reaping free sockets in httpAgent.js.
axios.defaults.httpsAgent = sharedHttpsAgent;
axios.defaults.httpAgent = sharedHttpAgent;

const messageHandler = require('./src/handlers/messageHandler');
const adminRoutes = require('./src/routes/adminRoutes');
const { testConnection, initializeDatabase } = require('./src/database/db');
const { startCacheStatsLogging, getCacheStats } = require('./src/utils/cache');

// Safety net: keep the process alive on stray async failures (e.g. pg
// connection timeouts inside cron jobs). Log full details for diagnosis.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught exception (recovered):', err && err.stack ? err.stack : err);
});

const app = express();

// Trust proxy for Render deployment to fix express-rate-limit X-Forwarded-For error
app.set('trust proxy', 1);

// Set security HTTP headers
app.use(helmet());

// Apply compression middleware for response payload compression
app.use(compression());

// Monitor response sizes — override res.json to avoid double-serialization
// Hard limit: block responses over 5MB to prevent memory exhaustion
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (data) => {
        // Only serialize once — measure size from the serialized string,
        // then send it directly via res.send() to avoid Express re-serializing
        const serialized = JSON.stringify(data);
        const responseSize = serialized.length;
        const sizeKB = Math.round(responseSize / 1024);
        
        if (responseSize > MAX_RESPONSE_SIZE) {
            console.error(`🚨 BLOCKED RESPONSE: ${req.method} ${req.path} - ${sizeKB}KB exceeds 5MB limit`);
            // Small error response — safe to use originalJson
            return originalJson({ error: 'Response too large. Please use pagination or filters to reduce data size.' });
        }
        
        if (sizeKB > 500) {
            console.warn(`⚠️ LARGE RESPONSE: ${req.method} ${req.path} - ${sizeKB}KB`);
        }
        
        // Send pre-serialized string directly — avoids Express's internal JSON.stringify
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', Buffer.byteLength(serialized));
        return res.send(serialized);
    };
    next();
});


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

// Raw body for GoKwik webhook HMAC verification (parsed after signature check)
app.use('/webhooks/gokwik', express.raw({ type: '*/*' }));

// Raw body for Zoho middleware webhook HMAC verification — must run BEFORE
// the global JSON parser, otherwise req.body is already an Object and the
// HMAC check crashes with ERR_INVALID_ARG_TYPE
app.use('/webhooks/zoho', express.raw({ type: '*/*' }));

// Regular JSON parsing for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Shoppers Hub CSP override — must run before express.static below.
// The hub (migrated from the Shopify theme page) relies on inline event
// handlers and renders product images from Shopify's CDN, so relax only
// script-src-attr and img-src; every other helmet protection stays default.
app.use('/shoppers', helmet({
    contentSecurityPolicy: {
        directives: {
            'script-src-attr': ["'unsafe-inline'"],
            'img-src': ["'self'", 'data:', 'https:']
        }
    }
}));

// Serve static files (admin dashboard)
// HTML must always revalidate so deploys ship fresh markup immediately;
// versioned assets (?v= busters) handle long-lived caching.
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
}));

// Serve support portal
app.use('/portal/support', express.static(path.join(__dirname, 'public', 'portal', 'support')));

// Admin API routes
app.use('/api/admin', adminRoutes);

// Smart login — operator/team management routes (admin only)
const operatorRoutes = require('./src/routes/operatorRoutes');
app.use('/api/admin', operatorRoutes);

// Support Portal Public API routes
const portalRoutes = require('./src/routes/portalRoutes');
app.use('/api/portal', portalRoutes);

// Internal/Public API routes
const apiRoutes = require('./src/routes/apiRoutes');
app.use('/api/internal', apiRoutes);

// Customer-facing support widget API routes
const widgetRoutes = require('./src/routes/widgetRoutes');
app.use('/api/widget', widgetRoutes);

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

// GoKwik Webhooks (checkout partner — order/cart/status sync)
// GoKwik also creates the order in Shopify, so /webhooks/shopify/orders/create
// remains the fallback; dedup happens on order_id + shopper_confirmations.
// Register in GoKwik Dashboard: POST /webhooks/gokwik/events
const gokwikWebhookRoutes = require('./src/routes/gokwikWebhookRoutes');
app.use('/webhooks/gokwik', gokwikWebhookRoutes);

// Zoho Middleware — Shopify → Zoho sync (orders, returns, COD)
// Webhook routes receive raw body for HMAC verification
const zohoWebhookRoutes = require('./src/routes/zohoWebhookRoutes');
app.use('/webhooks/zoho', zohoWebhookRoutes);

// Zoho admin API routes (dashboard data, config, manual actions)
const zohoRoutes = require('./src/routes/zohoRoutes');
app.use('/api/admin/zoho', zohoRoutes);

// Cron Jobs
const abandonedCartCron = require('./src/services/abandonedCartCron');
const reengagementCron = require('./src/services/reengagementCron');
const shipmentSyncCron = require('./src/services/shipmentSyncCron');

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

      // Debug logging — disabled to prevent unbounded file growth / memory pressure
      // if (value?.messages) { ... appendFileSync('debug_webhook.txt') ... }

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

// Serve Shoppers Hub (migrated from the Shopify theme page)
app.get('/shoppers', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'shoppers', 'index.html'));
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
            console.error('❌ Database connection failed. Ensure SUPABASE_DB_URL is set correctly in .env');
            if (process.env.NODE_ENV === 'production') {
                process.exit(1);
            } else {
                console.warn('⚠️ Running in development mode without an active DB connection. DB features will require SUPABASE_DB_URL.');
            }
        }

        // Initialize database tables
        console.log('🔄 Initializing database...');
        await initializeDatabase();

        // One-time repair: shoppers stuck in 'edit_details' even though their order
        // was already shipped (late "Edit Details" clicks flipped them out of the
        // shipped bucket). Restore them to 'confirmed' so they show as shipped again.
        // The shop_edit / follow-up handlers now guard against this going forward.
        try {
            const { dbAdapter } = require('./src/database/db');
            const repair = await dbAdapter.run(
                `UPDATE store_shoppers s
                 SET status = 'confirmed', updated_at = ?
                 WHERE s.status = 'edit_details'
                   AND EXISTS (
                       SELECT 1 FROM orders o
                       WHERE o.order_id = s.order_id
                         AND (o.awb IS NOT NULL OR o.status = 'shipped')
                   )`,
                [new Date().toISOString()]
            );
            if (repair.changes > 0) {
                console.log(`🔧 Repaired ${repair.changes} shipped order(s) stuck in edit_details → restored to confirmed/shipped`);
            }
        } catch (err) {
            console.warn('⚠️ edit_details shipped-repair skipped (non-critical):', err.message);
        }

        // Cache statistics logging — disabled in production to avoid unnecessary allocations
        if (process.env.NODE_ENV !== 'production') {
            startCacheStatsLogging(5 * 60 * 1000);
        }

        // Warm up cache with frequently accessed data (optimized - skip slow message count)
        console.log('🔥 Warming up cache...');
        try {
            const Customer = require('./src/models/Customer');
            const Order = require('./src/models/Order');
            
            // Pre-load fast counts only (skip message count - too slow on large tables)
            await Promise.all([
                Customer.getCount(),
                Order.getCount()
            ]);
            console.log('✅ Cache warmed up successfully');
        } catch (error) {
            console.warn('⚠️ Cache warm-up failed (non-critical):', error.message);
        }

        // Start Cron Jobs
        abandonedCartCron.init();
        reengagementCron.init();
        shipmentSyncCron.init();

        // ── Unified memory watchdog ─────────────────────────────────────
        // One adaptive 60s timer replaces the previous stack of overlapping
        // intervals (queue check, 2-min memory monitor, 2-min pg cleanup,
        // 60s native monitor, 30/10-min cache purges, 5-min settings purge).
        // Every tick: reap idle TLS sockets + drain idle pg clients — the
        // two native-memory growers. Every 5th tick: purge expired cache
        // entries + log memory. Pressure responses scale with RSS so we act
        // well before Render's 512MB OOM limit.
        let watchdogTick = 0;
        setInterval(() => {
            try {
                watchdogTick++;
                const every5 = watchdogTick % 5 === 0;

                // 1. Reap half-dead idle HTTPS sockets (native TLS buffers)
                const reaped = reapIdleSockets();
                if (reaped > 0) console.log(`[MEMORY] Reaped ${reaped} idle TLS socket(s)`);

                // 2. Drain idle pg connections (~5-10MB native TLS each)
                const { pool } = require('./src/database/db');
                if ((pool.idleCount || 0) > 0) {
                    const closed = pool.endIdleClients();
                    if (closed > 0) console.log(`[MEMORY] Closed ${closed} idle pg connection(s) (total=${pool.totalCount})`);
                }

                // 3. Stuck task queue safety valve
                if (taskQueue.length > 100) {
                    console.warn(`[QUEUE] Task queue has ${taskQueue.length} items, clearing to prevent memory buildup`);
                    taskQueue.length = 0;
                }

                // 4. Housekeeping every 5 min: expired cache + settings purge
                if (every5) {
                    const { purgeAllExpired } = require('./src/utils/cache');
                    const purged = purgeAllExpired();
                    if (purged > 0) console.log(`[MEMORY] Purged ${purged} expired cache entrie(s)`);
                    try { require('./src/models/Settings').clearOldCache(); } catch (e) { /* ignore */ }
                }

                // 5. Memory pressure response (scaled by RSS)
                const used = process.memoryUsage();
                const memoryMB = Math.round(used.rss / 1024 / 1024);
                const heapMB = Math.round(used.heapUsed / 1024 / 1024);
                const limitMB = 512;
                const usagePercent = Math.round((memoryMB / limitMB) * 100);

                if (every5) {
                    console.log(`[MEMORY] RSS: ${memoryMB}MB | Heap: ${heapMB}MB | ${usagePercent}% of ${limitMB}MB`);
                }

                // High: clear caches + GC to reclaim headroom (lowered from
                // 400MB — native TLS buffers accumulate steadily)
                if (memoryMB > 300) {
                    console.warn(`⚠️ MEMORY HIGH (${memoryMB}MB > 300MB) — running GC + cache cleanup...`);
                    const { invalidateCache, purgeAllExpired } = require('./src/utils/cache');
                    invalidateCache();
                    purgeAllExpired();
                    try { require('./src/models/Settings')._cache.clear(); } catch (e) { /* ignore */ }

                    // Clear followUpService Maps (timeout handles can leak)
                    try {
                        const followUpService = require('./src/services/followUpService');
                        for (const [id, timeoutId] of followUpService.activeQueues.entries()) {
                            clearTimeout(timeoutId);
                            followUpService.activeQueues.delete(id);
                        }
                        followUpService.isProcessing.clear();
                    } catch (e) { /* ignore */ }

                    try { require('./src/services/shiprocketService').orderCache.clear(); } catch (e) { /* ignore */ }

                    if (typeof global.gc === 'function') {
                        global.gc();
                        console.log(`[MEMORY] GC done. Heap now: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
                    } else {
                        console.log(`[MEMORY] Cache cleanup done. Heap: ${heapMB}MB (GC not available)`);
                    }
                }

                // Critical: last-resort sweep before OOM kill
                if (usagePercent > 80) {
                    console.error(`🔥 CRITICAL RSS: ${memoryMB}MB / ${limitMB}MB (${usagePercent}%) — risk of OOM kill`);
                    if (typeof global.gc === 'function') global.gc();
                    try {
                        require('./src/utils/cache').invalidateCache();
                        taskQueue.length = 0;
                    } catch (e) { /* ignore */ }
                    try {
                        const closed = pool.endIdleClients();
                        if (closed > 0) console.log(`[MEMORY] Emergency: closed ${closed} idle pg connections`);
                    } catch (e) { /* ignore */ }
                }
            } catch (e) {
                // The watchdog must never take the server down with it
                console.error('[WATCHDOG] tick failed:', e.message);
            }
        }, 60 * 1000);

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
        if (error.message.includes('TURSO_') || error.message.includes('SUPABASE_')) {
            console.error('ℹ️ Hint: Check your Supabase PostgreSQL database credentials (SUPABASE_DB_URL).');
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
