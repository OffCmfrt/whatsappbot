const whatsappService = require('./whatsappService');
const { dbAdapter } = require('../database/db');
const Customer = require('../models/Customer');
const { caches, cachedQuery, generateQueryKey, invalidateCache } = require('../utils/cache');

class BroadcastService {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.isProcessingQueueThread = false;
        // Base delay fallback (approx 3 seconds)
        this.delayBetweenMessages = 60000 / 20; 
        this.isPaused = false;

        // Auto-resume queue on boot
        setTimeout(() => this.resumeInterruptedQueue(), 5000);
    }

    // Resume queue if server restarted mid-broadcast
    async resumeInterruptedQueue() {
        try {
            await this.ensureQueueSchema();
            const pending = await dbAdapter.query(`SELECT count(id) as count FROM broadcast_queue WHERE status = 'pending'`);
            if (pending[0].count > 0) {
                console.log(`🔄 Resuming interrupted broadcast queue (${pending[0].count} pending messages)`);
                if (!this.isProcessing) this.processQueue();
            }
        } catch (e) {
            console.error('Failed to init broadcast queue:', e.message);
        }
    }

    // Send message to all customers
    async sendToAll(message, createdBy = 'admin') {
        try {
            // Get all customers
            const customers = await this.getAllCustomers();

            if (customers.length === 0) {
                return { success: false, message: 'No customers found' };
            }

            // Create broadcast record
            const broadcast = await this.createBroadcastRecord({
                title: 'Broadcast to All',
                message,
                segment: 'all',
                total_recipients: customers.length,
                created_by: createdBy
            });

            // Add to queue
            const phones = customers.map(c => c.phone);
            await this.addToQueue(phones, message, broadcast.id, null, 3); // Legacy sendToAll always 3s delay

            return {
                success: true,
                broadcastId: broadcast.id,
                totalRecipients: customers.length,
                message: 'Broadcast queued successfully'
            };
        } catch (error) {
            console.error('Error in sendToAll:', error);
            return { success: false, message: error.message };
        }
    }

    // Send message to specific segment
    async sendToSegment(message, segment, createdBy = 'admin', imageUrl = null, delaySeconds = 5) {
        try {
            const customers = await this.getCustomersBySegment(segment);

            if (customers.length === 0) {
                return { success: false, message: 'No customers found in segment' };
            }

            const phones = customers.map(c => c.phone);
            return await this.sendToPhones(phones, message, createdBy, imageUrl, delaySeconds, `Broadcast to ${segment}`);
        } catch (error) {
            console.error('Error in sendToSegment:', error);
            return { success: false, message: error.message };
        }
    }

    // Send to specific list of phones (Excel, Manual, Selected)
    async sendToPhones(phones, message, createdBy = 'admin', imageUrl = null, delaySeconds = 5, title = 'Direct Broadcast') {
        try {
            if (!phones || phones.length === 0) {
                return { success: false, message: 'No recipients provided' };
            }

            const broadcast = await this.createBroadcastRecord({
                title,
                message,
                image_url: imageUrl || '',
                segment: 'custom_list',
                total_recipients: phones.length,
                created_by: createdBy
            });

            await this.addToQueue(phones, message, broadcast.id, imageUrl, delaySeconds);

            return {
                success: true,
                broadcastId: broadcast.id,
                totalRecipients: phones.length,
                message: 'Broadcast queued successfully'
            };
        } catch (error) {
            console.error('Error in sendToPhones:', error);
            return { success: false, message: error.message };
        }
    }

    // New: Send Template to specific list of phones
    async sendTemplateToPhones(templateName, language, phones, createdBy = 'admin', components = [], delaySeconds = 5, title = null) {
        try {
            if (!phones || phones.length === 0) {
                return { success: false, message: 'No recipients provided' };
            }

            const broadcast = await this.createBroadcastRecord({
                title: title || `Template: ${templateName}`,
                message: `[META TEMPLATE: ${templateName}]`,
                segment: 'custom_list',
                total_recipients: phones.length,
                created_by: createdBy
            });

            await this.addToQueue(phones, null, broadcast.id, null, delaySeconds, {
                templateName,
                language,
                components
            });

            return {
                success: true,
                broadcastId: broadcast.id,
                totalRecipients: phones.length,
                message: 'Template broadcast queued successfully'
            };
        } catch (error) {
            console.error('Error in sendTemplateToPhones:', error);
            return { success: false, message: error.message };
        }
    }

    // New method for Template Broadcast
    async sendTemplateToSegment(templateName, language, segment, createdBy = 'admin', components = [], delaySeconds = 5) {
        try {
            const customers = await this.getCustomersBySegment(segment);

            if (customers.length === 0) {
                return { success: false, message: 'No customers found in segment' };
            }

            const phones = customers.map(c => c.phone);
            return await this.sendTemplateToPhones(templateName, language, phones, createdBy, components, delaySeconds, `Template: ${templateName} to ${segment}`);
        } catch (error) {
            console.error('Error in sendTemplateToSegment:', error);
            return { success: false, message: error.message };
        }
    }

    async getCustomersBySegment(segment) {
        let customers = [];
        switch (segment) {
            case 'active':
                customers = await this.getActiveCustomers(7);
                break;
            case 'recent':
                customers = await this.getRecentCustomers(30);
                break;
            case 'first_time':
                customers = await this.getCustomersByOrderCount(1, 1);
                break;
            case 'second_time':
                customers = await this.getCustomersByOrderCount(2, 2);
                break;
            case 'loyal':
                customers = await this.getCustomersByOrderCount(3, 4);
                break;
            case 'vip':
                customers = await this.getCustomersByOrderCount(5, 9999);
                break;
            case 'inactive':
                customers = await this.getInactiveCustomers(60);
                break;
            case 'all':
            default:
                customers = await this.getAllCustomers();
        }
        return customers;
    }

    // Send promotional offer
    async sendOffer(offerData, createdBy = 'admin') {
        try {
            // Create offer record
            const offer = await dbAdapter.insert('offers', {
                title: offerData.title,
                description: offerData.description,
                discount_code: offerData.discountCode,
                message: offerData.message,
                expires_at: offerData.expiresAt
            });

            // Send to all or specific segment
            const result = await this.sendToAll(offerData.message, createdBy);

            // Update offer with sent count
            await dbAdapter.update('offers', { sent_to_count: result.totalRecipients }, { id: offer.id });

            return {
                ...result,
                offerId: offer.id
            };
        } catch (error) {
            console.error('Error sending offer:', error);
            return { success: false, message: error.message };
        }
    }

    // Add messages to queue
    async addToQueue(phones, message, broadcastId, imageUrl = null, delaySeconds = 3, templateInfo = null) {
        try {
            await this.ensureQueueSchema();

            // Add all to persistent DB queue
            for (const phone of phones) {
                await dbAdapter.query(
                    `INSERT INTO broadcast_queue (phone, message, image_url, delay_seconds, broadcast_id, template_data) VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        phone || '', 
                        message || '', 
                        imageUrl || '', 
                        Number(delaySeconds) || 3, 
                        broadcastId ? Number(broadcastId) : 0, 
                        templateInfo ? JSON.stringify(templateInfo) : null
                    ]
                );
            }
        } catch (e) {
            console.error('Queue persistence error, falling back to in-memory:', e.message);
            for (const phone of phones) {
                this.queue.push({ 
                    id: Date.now() + Math.random(), 
                    phone, 
                    message, 
                    imageUrl, 
                    delaySeconds, 
                    broadcastId, 
                    attempts: 0, 
                    templateInfo 
                });
            }
        }

        // Start processing if not already running
        if (!this.isProcessing && !this.isPaused) {
            this.processQueue();
        }
    }

    pause() {
        this.isPaused = true;
        console.log('⏸️ Broadcast queue paused');
    }

    resume() {
        this.isPaused = false;
        console.log('▶️ Broadcast queue resumed');
        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    // Ensure broadcast_queue table exists with all required columns
    async ensureQueueSchema() {
        await dbAdapter.query(`
            CREATE TABLE IF NOT EXISTS broadcast_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT NOT NULL,
                message TEXT,
                image_url TEXT,
                delay_seconds INTEGER DEFAULT 3,
                broadcast_id INTEGER,
                attempts INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                template_data TEXT
            )
        `);

        // Check for missing columns (migration)
        try {
            const tableInfo = await dbAdapter.query("PRAGMA table_info(broadcast_queue)");
            const columns = tableInfo.map(c => c.name);
            
            if (!columns.includes('image_url')) {
                await dbAdapter.query("ALTER TABLE broadcast_queue ADD COLUMN image_url TEXT");
            }
            if (!columns.includes('template_data')) {
                await dbAdapter.query("ALTER TABLE broadcast_queue ADD COLUMN template_data TEXT");
            }
            if (!columns.includes('delay_seconds')) {
                await dbAdapter.query("ALTER TABLE broadcast_queue ADD COLUMN delay_seconds INTEGER DEFAULT 3");
            }
        } catch (e) {
            console.warn('Migration check warning:', e.message);
        }
    }

    // Process message queue with persistent rate limiting
    async processQueue() {
        if (this.isProcessingQueueThread) return;
        this.isProcessingQueueThread = true;
        this.isProcessing = true;
        let item = null;

        try {
            let usingPersistence = false;

            // Try persistent queue first
            try {
                const pending = await dbAdapter.query(`SELECT * FROM broadcast_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1`);
                if (pending && pending.length > 0) {
                    item = pending[0];
                    await dbAdapter.query(`UPDATE broadcast_queue SET status = 'processing' WHERE id = ?`, [item.id]);
                    usingPersistence = true;
                }
            } catch (e) {
                console.error('Failed to read from persistent queue:', e.message);
            }

            // Fallback to in-memory if nothing in DB
            if (!item) {
                item = this.queue.shift();
            }

            // Check if paused or end of queue
            if (!item || this.isPaused) {
                this.isProcessing = false;
                this.isProcessingQueueThread = false;
                if (this.isPaused) console.log('⏸️ Queue process stopped because it is paused');
                return;
            }

            try {
                // Determine sending sequence
                const hasImg = item.image_url && item.image_url.startsWith('http');
                const templateData = item.template_data ? JSON.parse(item.template_data) : (item.templateInfo || null);
                
                // Fetch customer name for replacement mapping (using cached lookup)
                let cName = 'Customer';
                try {
                    const customer = await Customer.findByPhone(item.phone);
                    if (customer && customer.name) cName = customer.name;
                } catch (e) {}
                
                if (templateData) {
                    // Send using Meta Template
                    const payload = {
                        name: templateData.templateName,
                        language: { code: templateData.language || 'en_US' }
                    };

                    // Add components if present, replace {{name}} in any text components
                    if (templateData.components) {
                        payload.components = templateData.components.map(comp => {
                            if (comp.type === 'body' && comp.parameters) {
                                return {
                                    ...comp,
                                    parameters: comp.parameters.map(param => {
                                        if (param.type === 'text') {
                                            return { ...param, text: param.text.replace(/{{name}}/g, cName) };
                                        }
                                        return param;
                                    })
                                };
                            }
                            return comp;
                        });
                    }

                    await whatsappService.sendTemplate(item.phone, payload);
                } else {
                    // Quick var replacement
                    let finalMessage = (item.message || '').replace(/{{name}}/g, cName);

                    if (hasImg) {
                        await whatsappService.sendImage(item.phone, item.image_url, finalMessage);
                    } else {
                        await whatsappService.sendMessage(item.phone, finalMessage);
                    }
                }

                // Log success
                const logMsg = templateData ? `[Template: ${templateData.templateName}]` : item.message;
                await this.logMessage(item.phone, logMsg, 'sent', 'broadcast');

                // Update broadcast stats
                await this.updateBroadcastStats(item.broadcast_id || item.broadcastId, 'sent');

                if (usingPersistence) {
                    await dbAdapter.query(`UPDATE broadcast_queue SET status = 'completed' WHERE id = ?`, [item.id]);
                }

            } catch (error) {
                console.error(`Failed to send to ${item.phone}:`, error.message);

                item.attempts = (item.attempts || 0) + 1;

                // Retry logic
                if (item.attempts < 2) {
                    if (usingPersistence) {
                        await dbAdapter.query(`UPDATE broadcast_queue SET status = 'pending', attempts = ? WHERE id = ?`, [item.attempts, item.id]);
                    } else {
                        this.queue.push(item); // Re-queue in memory
                    }
                } else {
                    // Log failure
                    await this.logMessage(item.phone, item.message, 'failed', 'broadcast');
                    await this.updateBroadcastStats(item.broadcast_id || item.broadcastId, 'failed');

                    if (usingPersistence) {
                        await dbAdapter.query(`UPDATE broadcast_queue SET status = 'failed', attempts = ? WHERE id = ?`, [item.attempts, item.id]);
                    }
                }
            }
        } finally {
            this.isProcessingQueueThread = false;
        }

        // Wait before processing next message using the exact delay set by the Admin in UI
        const waitMs = item && item.delay_seconds ? (item.delay_seconds * 1000) : (item && item.delaySeconds ? item.delaySeconds * 1000 : this.delayBetweenMessages);
        setTimeout(() => this.processQueue(), waitMs);
    }

    // Helper methods
    async getAllCustomers() {
        return await cachedQuery(
            'customers',
            'all_customers',
            async () => await dbAdapter.select('customers'),
            10 * 60 * 1000 // 10 minutes TTL
        );
    }

    async getActiveCustomers(days) {
        const sql = `SELECT phone, name FROM customers WHERE order_count > 0`;
        return await cachedQuery(
            'customers',
            'active_customers',
            async () => (await dbAdapter.query(sql)) || [],
            10 * 60 * 1000 // 10 minutes TTL
        );
    }

    async getRecentCustomers(days) {
        const sql = `SELECT phone, name FROM customers WHERE order_count > 0 AND updated_at >= date('now', '-${days} days')`;
        return await cachedQuery(
            'customers',
            `recent_customers_${days}`,
            async () => (await dbAdapter.query(sql)) || [],
            10 * 60 * 1000 // 10 minutes TTL
        );
    }
    
    async getInactiveCustomers(days) {
        const sql = `
            SELECT c.phone, c.name 
            FROM customers c
            LEFT JOIN (
                SELECT customer_phone, MAX(order_date) as last_order_date
                FROM orders
                GROUP BY customer_phone
            ) o ON c.phone = o.customer_phone
            WHERE 
                (o.last_order_date IS NULL AND c.created_at < date('now', '-${days} days'))
                OR 
                (o.last_order_date < date('now', '-${days} days'))
        `;
        return await cachedQuery(
            'customers',
            `inactive_customers_${days}`,
            async () => (await dbAdapter.query(sql)) || [],
            10 * 60 * 1000 // 10 minutes TTL
        );
    }

    async getCustomersByOrderCount(min, max) {
        const limitStr = max === 9999 ? `>= ${min}` : `BETWEEN ${min} AND ${max}`;
        const sql = `SELECT phone, name FROM customers WHERE order_count ${limitStr}`;
        return await cachedQuery(
            'customers',
            `customers_by_order_count_${min}_${max}`,
            async () => (await dbAdapter.query(sql)) || [],
            10 * 60 * 1000 // 10 minutes TTL
        );
    }

    async getCustomersWithOrders() {
        const sql = `SELECT DISTINCT customer_phone as phone FROM orders WHERE customer_phone IS NOT NULL`;
        return await cachedQuery(
            'customers',
            'customers_with_orders',
            async () => (await dbAdapter.query(sql)) || [],
            10 * 60 * 1000 // 10 minutes TTL
        );
    }

    async createBroadcastRecord(broadcastData) {
        return await dbAdapter.insert('broadcasts', broadcastData);
    }

    async updateBroadcastStats(broadcastId, type) {
        if (!broadcastId) return;

        const field = type === 'sent' ? 'sent_count' : 'failed_count';
        // Atomic increment not supported in basic adapter yet, using SQL directly
        const sql = `UPDATE broadcasts SET ${field} = ${field} + 1 WHERE id = ?`;
        await dbAdapter.query(sql, [broadcastId]);
    }

    async logMessage(phone, message, status, type) {
        await dbAdapter.insert('messages', {
            customer_phone: phone,
            message_type: type,
            message_content: message,
            status,
            created_at: new Date().toISOString()
        });

        // Cleanup: Keep only last 200 messages per customer (auto-delete older messages)
        await this._cleanupOldMessages(phone);
    }

    // Cleanup old messages to keep only last 200 per customer (optimized)
    async _cleanupOldMessages(phone) {
        try {
            // Normalize phone to match DB storage format (with + prefix)
            const cleanPhone = phone.replace(/\D/g, '');
            const formattedPhone = cleanPhone.startsWith('91') ? `+${cleanPhone}` : `+91${cleanPhone}`;
            
            // OPTIMIZED: Only run cleanup if customer has more than 250 messages
            const countResult = await dbAdapter.query(
                'SELECT COUNT(*) as count FROM messages WHERE customer_phone = ?',
                [formattedPhone]
            );
            const messageCount = countResult[0]?.count || 0;
            
            // Only cleanup if significantly over the 200 limit
            if (messageCount <= 250) {
                return; // Skip cleanup - still within acceptable range
            }
            
            // Use a more efficient approach: delete messages older than the 200th most recent
            await dbAdapter.query(
                `DELETE FROM messages 
                 WHERE customer_phone = ? 
                 AND created_at < (
                     SELECT created_at FROM messages 
                     WHERE customer_phone = ? 
                     ORDER BY created_at DESC 
                     LIMIT 1 OFFSET 200
                 )`,
                [formattedPhone, formattedPhone]
            );
        } catch (error) {
            // Silent fail - cleanup is best effort
        }
    }
}

// Export singleton instance
module.exports = new BroadcastService();
