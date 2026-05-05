const { dbAdapter } = require('../database/db');
const whatsappService = require('./whatsappService');
const { fromISTtoUTC } = require('../utils/timezone');

/**
 * Follow-Up Service
 * 
 * Manages follow-up campaigns for pending shoppers.
 * Features:
 * - Campaign creation and management
 * - Recipient selection and tracking
 * - Template message sending with retry logic
 * - Response tracking and analytics
 * - Webhook handling for button responses
 */

class FollowUpService {
    constructor() {
        this.activeQueues = new Map(); // campaignId -> timeoutId
        this.isProcessing = new Map(); // campaignId -> boolean
    }

    /**
     * Create a new follow-up campaign
     * @param {Object} data - Campaign data
     * @returns {Promise<Object>} Created campaign
     */
    async createCampaign(data) {
        try {
            const { name, templateName, messageContent, createdBy } = data;
            
            const campaignData = {
                name: name || `Follow-Up Campaign ${new Date().toLocaleDateString()}`,
                template_name: templateName || 'order_follow_up_v1',
                message_content: messageContent || '',
                status: 'draft',
                total_recipients: 0,
                sent_count: 0,
                delivered_count: 0,
                read_count: 0,
                responded_count: 0,
                confirmed_count: 0,
                cancelled_count: 0,
                edit_requested_count: 0,
                failed_count: 0,
                created_by: createdBy || 'system',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            const result = await dbAdapter.insert('follow_up_campaigns', campaignData);
            
            // Get the created campaign
            const campaigns = await dbAdapter.query(
                'SELECT * FROM follow_up_campaigns WHERE id = ?',
                [result.id || result.lastID]
            );
            
            return {
                success: true,
                campaign: campaigns[0]
            };
        } catch (error) {
            console.error('[FollowUpService] Error creating campaign:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get all campaigns with optional filtering
     * @param {Object} filters - Filter options
     * @returns {Promise<Array>} List of campaigns
     */
    async getCampaigns(filters = {}) {
        try {
            let query = 'SELECT * FROM follow_up_campaigns';
            const params = [];
            
            if (filters.status) {
                query += ' WHERE status = ?';
                params.push(filters.status);
            }
            
            query += ' ORDER BY created_at DESC';
            
            if (filters.limit) {
                query += ' LIMIT ?';
                params.push(parseInt(filters.limit));
            }
            
            const campaigns = await dbAdapter.query(query, params);
            return { success: true, campaigns };
        } catch (error) {
            console.error('[FollowUpService] Error fetching campaigns:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get campaign details with recipients
     * @param {number} campaignId - Campaign ID
     * @returns {Promise<Object>} Campaign details
     */
    async getCampaignDetails(campaignId) {
        try {
            // Get campaign
            const campaigns = await dbAdapter.query(
                'SELECT * FROM follow_up_campaigns WHERE id = ?',
                [campaignId]
            );
            
            if (!campaigns || campaigns.length === 0) {
                return { success: false, error: 'Campaign not found' };
            }
            
            const campaign = campaigns[0];
            
            // Get recipients
            const recipients = await dbAdapter.query(
                'SELECT * FROM follow_up_recipients WHERE campaign_id = ? ORDER BY created_at DESC',
                [campaignId]
            );
            
            // Calculate additional stats
            const stats = {
                total: recipients.length,
                pending: recipients.filter(r => r.status === 'pending').length,
                sent: recipients.filter(r => r.status === 'sent').length,
                delivered: recipients.filter(r => r.status === 'delivered').length,
                read: recipients.filter(r => r.status === 'read').length,
                responded: recipients.filter(r => r.status === 'responded').length,
                failed: recipients.filter(r => r.status === 'failed').length,
                confirmed: recipients.filter(r => r.response_type === 'confirmed').length,
                cancelled: recipients.filter(r => r.response_type === 'cancelled').length,
                edit_requested: recipients.filter(r => r.response_type === 'edit_details').length
            };
            
            return {
                success: true,
                campaign,
                recipients,
                stats
            };
        } catch (error) {
            console.error('[FollowUpService] Error fetching campaign details:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Add recipients to a campaign
     * @param {number} campaignId - Campaign ID
     * @param {Array} shoppers - Array of shopper objects
     * @returns {Promise<Object>} Result
     */
    async addRecipients(campaignId, shoppers) {
        try {
            // Check for existing recipients to avoid duplicates
            const existingRecipients = await dbAdapter.query(
                'SELECT order_id FROM follow_up_recipients WHERE campaign_id = ?',
                [campaignId]
            );
            const existingOrderIds = new Set(existingRecipients.map(r => r.order_id));
            
            let addedCount = 0;
            let skippedCount = 0;
            
            for (const shopper of shoppers) {
                // Skip if already in this campaign
                if (existingOrderIds.has(shopper.order_id)) {
                    skippedCount++;
                    continue;
                }
                
                // Check if this order was already in a completed follow-up campaign
                const previousFollowUp = await dbAdapter.query(
                    `SELECT r.id FROM follow_up_recipients r
                     JOIN follow_up_campaigns c ON r.campaign_id = c.id
                     WHERE r.order_id = ? AND c.status = 'completed'
                     LIMIT 1`,
                    [shopper.order_id]
                );
                
                if (previousFollowUp && previousFollowUp.length > 0) {
                    skippedCount++;
                    continue;
                }
                
                await dbAdapter.insert('follow_up_recipients', {
                    campaign_id: campaignId,
                    shopper_id: shopper.id,
                    phone: shopper.phone,
                    order_id: shopper.order_id,
                    status: 'pending',
                    created_at: new Date().toISOString()
                });
                
                addedCount++;
            }
            
            // Update campaign total_recipients
            await dbAdapter.query(
                'UPDATE follow_up_campaigns SET total_recipients = total_recipients + ?, updated_at = ? WHERE id = ?',
                [addedCount, new Date().toISOString(), campaignId]
            );
            
            return {
                success: true,
                added: addedCount,
                skipped: skippedCount
            };
        } catch (error) {
            console.error('[FollowUpService] Error adding recipients:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get pending shoppers for selection
     * @param {Object} filters - Filter options
     * @returns {Promise<Array>} List of pending shoppers
     */
    async getPendingShoppers(filters = {}) {
        try {
            let query = `
                SELECT s.*, o.awb, o.courier_name, o.status as order_status, o.tracking_url
                FROM store_shoppers s
                LEFT JOIN orders o ON s.order_id = o.order_id
                WHERE s.status = 'pending'
            `;
            const params = [];
            
            if (filters.search) {
                query += ' AND (s.name LIKE ? OR s.phone LIKE ? OR s.order_id LIKE ?)';
                const searchParam = `%${filters.search}%`;
                params.push(searchParam, searchParam, searchParam);
            }
            
            if (filters.startDate) {
                // Convert IST date from frontend to UTC for database query
                const utcStartDate = fromISTtoUTC(filters.startDate) || filters.startDate;
                query += ' AND s.created_at >= ?';
                params.push(utcStartDate);
            }
            
            if (filters.endDate) {
                // Convert IST date from frontend to UTC for database query
                const utcEndDate = fromISTtoUTC(filters.endDate) || filters.endDate;
                query += ' AND s.created_at <= ?';
                params.push(utcEndDate);
            }
            
            // Exclude shoppers already in active/completed follow-up campaigns
            query += `
                AND s.order_id NOT IN (
                    SELECT r.order_id 
                    FROM follow_up_recipients r
                    JOIN follow_up_campaigns c ON r.campaign_id = c.id
                    WHERE c.status IN ('running', 'completed')
                )
            `;
            
            query += ' ORDER BY s.created_at DESC';
            
            if (filters.limit) {
                query += ' LIMIT ?';
                params.push(parseInt(filters.limit));
            }
            
            const shoppers = await dbAdapter.query(query, params);
            return { success: true, shoppers };
        } catch (error) {
            console.error('[FollowUpService] Error fetching pending shoppers:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Start sending campaign messages
     * @param {number} campaignId - Campaign ID
     * @returns {Promise<Object>} Result
     */
    async sendCampaign(campaignId) {
        try {
            // Update campaign status
            await dbAdapter.query(
                'UPDATE follow_up_campaigns SET status = ?, started_at = ?, updated_at = ? WHERE id = ?',
                ['running', new Date().toISOString(), new Date().toISOString(), campaignId]
            );
            
            // Start processing queue
            this.processQueue(campaignId);
            
            return { success: true, message: 'Campaign started successfully' };
        } catch (error) {
            console.error('[FollowUpService] Error starting campaign:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Process campaign sending queue
     * @param {number} campaignId - Campaign ID
     */
    async processQueue(campaignId) {
        if (this.isProcessing.get(campaignId)) return;
        this.isProcessing.set(campaignId, true);
        
        try {
            // Get pending recipients
            const recipients = await dbAdapter.query(
                'SELECT * FROM follow_up_recipients WHERE campaign_id = ? AND status = ? LIMIT 1',
                [campaignId, 'pending']
            );
            
            if (!recipients || recipients.length === 0) {
                // No more pending recipients - mark campaign as completed
                await this.completeCampaign(campaignId);
                this.isProcessing.set(campaignId, false);
                return;
            }
            
            const recipient = recipients[0];
            
            // Check if campaign is still running
            const campaignCheck = await dbAdapter.query(
                'SELECT status FROM follow_up_campaigns WHERE id = ?',
                [campaignId]
            );
            
            if (!campaignCheck || campaignCheck[0]?.status !== 'running') {
                this.isProcessing.set(campaignId, false);
                return;
            }
            
            // Send message
            await this.sendFollowUpMessage(campaignId, recipient);
            
            // Schedule next message (3 second delay to respect rate limits)
            const timeoutId = setTimeout(() => {
                this.processQueue(campaignId);
            }, 3000);
            
            this.activeQueues.set(campaignId, timeoutId);
            
        } catch (error) {
            console.error(`[FollowUpService] Error processing queue for campaign ${campaignId}:`, error);
            this.isProcessing.set(campaignId, false);
        }
    }

    /**
     * Send follow-up message to a recipient
     * @param {number} campaignId - Campaign ID
     * @param {Object} recipient - Recipient data
     */
    async sendFollowUpMessage(campaignId, recipient) {
        try {
            // Get campaign details
            const campaigns = await dbAdapter.query(
                'SELECT * FROM follow_up_campaigns WHERE id = ?',
                [campaignId]
            );
            const campaign = campaigns[0];
            
            // Get shopper details for personalization
            const shoppers = await dbAdapter.query(
                'SELECT * FROM store_shoppers WHERE id = ?',
                [recipient.shopper_id]
            );
            const shopper = shoppers[0];
            
            if (!shopper) {
                throw new Error('Shopper not found');
            }
            
            // Format product details
            let productDetails = '';
            try {
                const items = JSON.parse(shopper.items_json || '[]');
                productDetails = items.map(item => {
                    const size = item.size || item.variant_size || '';
                    const sizePart = size ? ` (Size: ${size})` : '';
                    return `${item.title || item.name || 'Product'}${sizePart} x${item.quantity || 1}`;
                }).join(', ');
            } catch (e) {
                productDetails = shopper.items_json || 'Order details';
            }
            
            // Prepare template data
            const firstName = shopper.name ? shopper.name.split(' ')[0] : 'Customer';
            const templateData = {
                name: campaign.template_name,
                language: { code: 'en_US' },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            { type: 'text', text: firstName },
                            { type: 'text', text: shopper.order_id || 'N/A' },
                            { type: 'text', text: String(shopper.order_total || '0') },
                            { type: 'text', text: productDetails.substring(0, 500) }
                        ]
                    }
                ]
            };
            
            // Send template message
            const result = await whatsappService.sendTemplate(recipient.phone, templateData);
            
            // Update recipient status
            const waMessageId = result?.messages?.[0]?.id || null;
            await dbAdapter.query(
                `UPDATE follow_up_recipients 
                 SET status = ?, wa_message_id = ?, sent_at = ? 
                 WHERE id = ?`,
                ['sent', waMessageId, new Date().toISOString(), recipient.id]
            );
            
            // Update campaign stats
            await dbAdapter.query(
                'UPDATE follow_up_campaigns SET sent_count = sent_count + 1 WHERE id = ?',
                [campaignId]
            );
            
            console.log(`[FollowUpService] Sent follow-up to ${recipient.phone} for order ${recipient.order_id}`);
            
        } catch (error) {
            console.error(`[FollowUpService] Error sending to ${recipient.phone}:`, error);
            
            // Update recipient as failed
            await dbAdapter.query(
                `UPDATE follow_up_recipients 
                 SET status = ?, error_message = ? 
                 WHERE id = ?`,
                ['failed', error.message, recipient.id]
            );
            
            // Update campaign failed count
            await dbAdapter.query(
                'UPDATE follow_up_campaigns SET failed_count = failed_count + 1 WHERE id = ?',
                [campaignId]
            );
        }
    }

    /**
     * Mark campaign as completed
     * @param {number} campaignId - Campaign ID
     */
    async completeCampaign(campaignId) {
        try {
            await dbAdapter.query(
                'UPDATE follow_up_campaigns SET status = ?, completed_at = ? WHERE id = ?',
                ['completed', new Date().toISOString(), campaignId]
            );
            console.log(`[FollowUpService] Campaign ${campaignId} completed`);
        } catch (error) {
            console.error('[FollowUpService] Error completing campaign:', error);
        }
    }

    /**
     * Pause a running campaign
     * @param {number} campaignId - Campaign ID
     */
    async pauseCampaign(campaignId) {
        try {
            // Clear any active queue
            const timeoutId = this.activeQueues.get(campaignId);
            if (timeoutId) {
                clearTimeout(timeoutId);
                this.activeQueues.delete(campaignId);
            }
            
            await dbAdapter.query(
                'UPDATE follow_up_campaigns SET status = ? WHERE id = ?',
                ['paused', campaignId]
            );
            
            return { success: true, message: 'Campaign paused' };
        } catch (error) {
            console.error('[FollowUpService] Error pausing campaign:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Resume a paused campaign
     * @param {number} campaignId - Campaign ID
     */
    async resumeCampaign(campaignId) {
        try {
            await dbAdapter.query(
                'UPDATE follow_up_campaigns SET status = ? WHERE id = ?',
                ['running', campaignId]
            );
            
            // Restart queue processing
            this.processQueue(campaignId);
            
            return { success: true, message: 'Campaign resumed' };
        } catch (error) {
            console.error('[FollowUpService] Error resuming campaign:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete a campaign and its recipients
     * @param {number} campaignId - Campaign ID
     */
    async deleteCampaign(campaignId) {
        try {
            // Clear any active queue
            const timeoutId = this.activeQueues.get(campaignId);
            if (timeoutId) {
                clearTimeout(timeoutId);
                this.activeQueues.delete(campaignId);
            }
            
            // Delete recipients first (foreign key constraint)
            await dbAdapter.query(
                'DELETE FROM follow_up_recipients WHERE campaign_id = ?',
                [campaignId]
            );
            
            // Delete campaign
            await dbAdapter.query(
                'DELETE FROM follow_up_campaigns WHERE id = ?',
                [campaignId]
            );
            
            return { success: true, message: 'Campaign deleted' };
        } catch (error) {
            console.error('[FollowUpService] Error deleting campaign:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Handle button response from customer
     * @param {string} phone - Customer phone
     * @param {string} payload - Button payload
     * @param {string} messageId - WhatsApp message ID
     */
    async handleButtonResponse(phone, payload, messageId) {
        try {
            // Find recipient by message ID
            const recipients = await dbAdapter.query(
                'SELECT * FROM follow_up_recipients WHERE wa_message_id = ?',
                [messageId]
            );
            
            if (!recipients || recipients.length === 0) {
                console.log(`[FollowUpService] No recipient found for message ${messageId}`);
                return { success: false, error: 'Recipient not found' };
            }
            
            const recipient = recipients[0];
            
            // Determine response type from payload
            let responseType = null;
            if (payload.includes('confirm') || payload.toLowerCase().includes('confirm')) {
                responseType = 'confirmed';
            } else if (payload.includes('cancel') || payload.toLowerCase().includes('cancel')) {
                responseType = 'cancelled';
            } else if (payload.includes('edit') || payload.toLowerCase().includes('edit')) {
                responseType = 'edit_details';
            }
            
            if (!responseType) {
                return { success: false, error: 'Unknown response type' };
            }
            
            // Update recipient
            await dbAdapter.query(
                `UPDATE follow_up_recipients 
                 SET status = ?, response_type = ?, responded_at = ? 
                 WHERE id = ?`,
                ['responded', responseType, new Date().toISOString(), recipient.id]
            );
            
            // Update campaign stats
            const statField = `${responseType}_count`;
            await dbAdapter.query(
                `UPDATE follow_up_campaigns 
                 SET ${statField} = ${statField} + 1, responded_count = responded_count + 1 
                 WHERE id = ?`,
                [recipient.campaign_id]
            );
            
            // Update shopper status
            await dbAdapter.query(
                'UPDATE store_shoppers SET status = ?, updated_at = ? WHERE id = ?',
                [responseType, new Date().toISOString(), recipient.shopper_id]
            );
            
            console.log(`[FollowUpService] Customer ${phone} responded with ${responseType} for order ${recipient.order_id}`);
            
            return { 
                success: true, 
                responseType,
                orderId: recipient.order_id,
                shopperId: recipient.shopper_id
            };
            
        } catch (error) {
            console.error('[FollowUpService] Error handling button response:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update message status (delivered, read)
     * @param {string} messageId - WhatsApp message ID
     * @param {string} status - New status
     */
    async updateMessageStatus(messageId, status) {
        try {
            const timestamp = new Date().toISOString();
            let updateField = '';
            
            if (status === 'delivered') {
                updateField = 'delivered_at';
            } else if (status === 'read') {
                updateField = 'read_at';
            } else {
                return { success: false, error: 'Invalid status' };
            }
            
            await dbAdapter.query(
                `UPDATE follow_up_recipients SET ${updateField} = ? WHERE wa_message_id = ?`,
                [timestamp, messageId]
            );
            
            // Update campaign stats
            const recipient = await dbAdapter.query(
                'SELECT campaign_id FROM follow_up_recipients WHERE wa_message_id = ?',
                [messageId]
            );
            
            if (recipient && recipient.length > 0) {
                const statField = status === 'delivered' ? 'delivered_count' : 'read_count';
                await dbAdapter.query(
                    `UPDATE follow_up_campaigns SET ${statField} = ${statField} + 1 WHERE id = ?`,
                    [recipient[0].campaign_id]
                );
            }
            
            return { success: true };
        } catch (error) {
            console.error('[FollowUpService] Error updating message status:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get analytics for campaigns
     * @param {Object} filters - Filter options
     * @returns {Promise<Object>} Analytics data
     */
    async getAnalytics(filters = {}) {
        try {
            // Overall stats
            const overallStats = await dbAdapter.query(`
                SELECT 
                    COUNT(*) as total_campaigns,
                    SUM(total_recipients) as total_recipients,
                    SUM(sent_count) as total_sent,
                    SUM(delivered_count) as total_delivered,
                    SUM(read_count) as total_read,
                    SUM(responded_count) as total_responded,
                    SUM(confirmed_count) as total_confirmed,
                    SUM(cancelled_count) as total_cancelled,
                    SUM(edit_requested_count) as total_edit_requested,
                    SUM(failed_count) as total_failed
                FROM follow_up_campaigns
                WHERE status = 'completed'
            `);
            
            // Recent campaigns performance
            let recentQuery = `
                SELECT 
                    id, name, status, total_recipients, sent_count, 
                    delivered_count, read_count, responded_count,
                    confirmed_count, cancelled_count, edit_requested_count,
                    created_at, completed_at
                FROM follow_up_campaigns
            `;
            
            if (filters.status) {
                recentQuery += ` WHERE status = '${filters.status}'`;
            }
            
            recentQuery += ' ORDER BY created_at DESC LIMIT 10';
            
            const recentCampaigns = await dbAdapter.query(recentQuery);
            
            // Daily stats for charts
            const dailyStats = await dbAdapter.query(`
                SELECT 
                    DATE(created_at) as date,
                    COUNT(*) as campaigns,
                    SUM(total_recipients) as recipients,
                    SUM(responded_count) as responses
                FROM follow_up_campaigns
                WHERE created_at >= datetime('now', '-30 days')
                GROUP BY DATE(created_at)
                ORDER BY date DESC
            `);
            
            return {
                success: true,
                overall: overallStats[0] || {},
                recentCampaigns,
                dailyStats
            };
        } catch (error) {
            console.error('[FollowUpService] Error fetching analytics:', error);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
module.exports = new FollowUpService();
