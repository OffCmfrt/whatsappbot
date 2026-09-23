/**
 * instagramService.js
 * ─────────────────────────────────────────────────────────────
 * Handles all Instagram Graph API messaging operations for the
 * OFFCOMFRT support platform.
 *
 * Capabilities:
 *   - Send text messages to Instagram users (DMs)
 *   - Send image/media messages
 *   - Send quick-reply buttons
 *   - Fetch Instagram user profile (username, profile pic)
 *   - Comment operations: public reply, private reply, fetch comment/media
 *   - 24-hour messaging window tracking
 *   - Rate-limit aware error handling
 *   - Message logging to shared messages table
 *
 * SAFETY:
 *   - Does NOT modify or call any WhatsApp service functions
 *   - Uses separate env vars (INSTAGRAM_*) from WhatsApp (WHATSAPP_*)
 *   - All Instagram messages are logged with channel = 'instagram'
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { dbAdapter } = require('../database/db');

class InstagramService {
    constructor() {
        this.accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
        this.appId = process.env.INSTAGRAM_APP_ID;
        this.apiVersion = 'v21.0';

        // Validate configuration
        const isPlaceholder = (val) => !val || val.includes('your_') || val.includes('YOUR_');

        if (isPlaceholder(this.accessToken)) {
            console.warn('⚠️ [IG] INSTAGRAM_ACCESS_TOKEN is missing or placeholder — Instagram disabled');
            this._enabled = false;
        } else {
            this._enabled = true;
        }

        // Instagram messaging endpoint (official host: graph.instagram.com)
        this.messagesURL = `https://graph.instagram.com/${this.apiVersion}/me/messages`;

        // Rate-limit tracking: Instagram allows ~500 calls/hour
        this._callCount = 0;
        this._callWindowStart = Date.now();
        this._rateLimitHits = 0;

        if (this._enabled) {
            console.log('📸 Instagram Service Initialized');
        }
    }

    // ─── Configuration ────────────────────────────────────────

    /**
     * Check if Instagram service is properly configured
     */
    get isEnabled() {
        return this._enabled;
    }

    /**
     * Re-check configuration (useful after env reload)
     */
    refreshConfig() {
        const isPlaceholder = (val) => !val || val.includes('your_') || val.includes('YOUR_');
        this.accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
        this.appId = process.env.INSTAGRAM_APP_ID;
        this._enabled = !isPlaceholder(this.accessToken);
        if (this._enabled) {
            console.log('📸 Instagram Service re-enabled');
        }
    }

    // ─── Rate Limit Tracking ──────────────────────────────────

    _trackCall() {
        const now = Date.now();
        // Reset window every hour
        if (now - this._callWindowStart > 3600000) {
            this._callCount = 0;
            this._callWindowStart = now;
        }
        this._callCount++;

        if (this._callCount > 450) {
            console.warn(`⚠️ [IG] Rate limit warning: ${this._callCount}/500 calls this hour`);
        }
    }

    // ─── Send Text Message ────────────────────────────────────

    /**
     * Send a plain text message to an Instagram user.
     *
     * @param {string} igUserId  - Instagram PSID (page-scoped ID)
     * @param {string} text      - Message text (supports basic formatting)
     * @param {string} logType   - Message type for DB logging (default: 'outgoing')
     * @returns {object|null}    - API response or null on failure
     */
    async sendMessage(igUserId, text, logType = 'outgoing') {
        if (!this._enabled) {
            console.warn('[IG] Service disabled — cannot send message');
            return null;
        }

        if (!igUserId || !text) {
            console.error('[IG] sendMessage: igUserId and text are required');
            return null;
        }

        // Check 24-hour window before sending
        const windowOk = await this.isWithinMessagingWindow(igUserId);
        if (!windowOk) {
            console.warn(`[IG] 24h window expired for user ${igUserId} — message blocked`);
            return { blocked: true, reason: '24h_window_expired' };
        }

        this._trackCall();

        try {
            const response = await axios.post(
                this.messagesURL,
                {
                    recipient: { id: igUserId },
                    message: { text: text }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            // Log to database
            await this._logOutgoing(igUserId, text, logType, response.data?.message_id || null);

            console.log(`[IG] ✅ Sent text to ${igUserId}: "${text.substring(0, 50)}..."`);
            return response.data;

        } catch (error) {
            return this._handleError(error, igUserId, 'sendMessage');
        }
    }

    // ─── Send Image Message ───────────────────────────────────

    /**
     * Send an image message to an Instagram user.
     *
     * @param {string} igUserId  - Instagram PSID
     * @param {string} imageUrl  - Public URL of the image
     * @param {string} caption   - Optional caption text
     * @returns {object|null}
     */
    async sendImage(igUserId, imageUrl, caption = null) {
        if (!this._enabled) return null;

        const windowOk = await this.isWithinMessagingWindow(igUserId);
        if (!windowOk) {
            return { blocked: true, reason: '24h_window_expired' };
        }

        this._trackCall();

        try {
            const payload = {
                recipient: { id: igUserId },
                message: {
                    attachment: {
                        type: 'image',
                        payload: {
                            url: imageUrl,
                            is_reusable: false
                        }
                    }
                }
            };

            // Instagram supports caption for images in some contexts
            // but the standard send API doesn't have a separate caption field.
            // Send caption as a separate text message if provided.

            const response = await axios.post(this.messagesURL, payload, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            await this._logOutgoing(igUserId, `[Image: ${imageUrl}]`, 'outgoing', response.data?.message_id || null);

            // Send caption as separate message if provided
            if (caption) {
                await this.sendMessage(igUserId, caption, 'outgoing');
            }

            console.log(`[IG] ✅ Sent image to ${igUserId}`);
            return response.data;

        } catch (error) {
            return this._handleError(error, igUserId, 'sendImage');
        }
    }

    // ─── Send Quick Replies ───────────────────────────────────

    /**
     * Send a text message with quick-reply buttons.
     * Instagram supports up to 13 quick reply buttons.
     *
     * @param {string} igUserId   - Instagram PSID
     * @param {string} text       - Message text
     * @param {Array}  replies    - Array of { title, payload } objects
     * @returns {object|null}
     */
    async sendQuickReplies(igUserId, text, replies = []) {
        if (!this._enabled) return null;

        const windowOk = await this.isWithinMessagingWindow(igUserId);
        if (!windowOk) {
            return { blocked: true, reason: '24h_window_expired' };
        }

        this._trackCall();

        try {
            // Instagram quick_replies format
            const payload = {
                recipient: { id: igUserId },
                message: {
                    text: text,
                    quick_replies: replies.slice(0, 13).map(r => ({
                        content_type: 'text',
                        title: r.title.substring(0, 20), // IG limit: 20 chars
                        payload: r.payload || r.title
                    }))
                }
            };

            const response = await axios.post(this.messagesURL, payload, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            await this._logOutgoing(igUserId, text, 'outgoing', response.data?.message_id || null);

            console.log(`[IG] ✅ Sent quick replies to ${igUserId}: ${replies.length} options`);
            return response.data;

        } catch (error) {
            return this._handleError(error, igUserId, 'sendQuickReplies');
        }
    }

    // ─── Comment Operations ───────────────────────────────────

    /**
     * Reply publicly to a comment on our media.
     * Instagram API: POST /{comment_id}/replies
     *
     * @param {string} commentId - Instagram comment ID
     * @param {string} text      - Reply text (max 2200 chars)
     * @returns {object|null}    - { id } of the reply comment or null on failure
     */
    async sendCommentReply(commentId, text) {
        if (!this._enabled) return null;

        if (!commentId || !text) {
            console.error('[IG] sendCommentReply: commentId and text are required');
            return null;
        }

        this._trackCall();

        try {
            const response = await axios.post(
                `https://graph.instagram.com/${this.apiVersion}/${commentId}/replies`,
                { message: text.substring(0, 2200) },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            console.log(`[IG] ✅ Public reply posted for comment ${commentId}`);
            return response.data;

        } catch (error) {
            return this._handleError(error, commentId, 'sendCommentReply');
        }
    }

    /**
     * Send a private reply (DM) to the author of a comment.
     * Instagram API: POST /me/messages with recipient.comment_id
     * Opens a 24-hour messaging window with the commenter.
     *
     * @param {string} commentId - Instagram comment ID
     * @param {string} text      - Private reply text
     * @returns {object|null}    - { recipient_id, message_id } or null
     */
    async sendPrivateReply(commentId, text) {
        if (!this._enabled) return null;

        if (!commentId || !text) {
            console.error('[IG] sendPrivateReply: commentId and text are required');
            return null;
        }

        this._trackCall();

        try {
            const response = await axios.post(
                this.messagesURL,
                {
                    recipient: { comment_id: commentId },
                    message: { text: text }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            // Log the outgoing DM + ensure customer record exists.
            // recipient_id is the IG PSID of the commenter (returned by the API).
            const recipientId = response.data?.recipient_id;
            if (recipientId) {
                await this._logOutgoing(recipientId, text, 'outgoing', response.data?.message_id || null);
            }

            console.log(`[IG] ✅ Private reply sent for comment ${commentId}`);
            return response.data;

        } catch (error) {
            return this._handleError(error, commentId, 'sendPrivateReply');
        }
    }

    /**
     * Fetch a single comment's details.
     *
     * @param {string} commentId - Instagram comment ID
     * @returns {object|null}    - { id, text, username, timestamp, media_id, ... }
     */
    async fetchComment(commentId) {
        if (!this._enabled) return null;

        this._trackCall();

        try {
            const response = await axios.get(
                `https://graph.instagram.com/${this.apiVersion}/${commentId}`,
                {
                    params: {
                        fields: 'id,text,username,timestamp,media_id,permalink,like_count,from{id,username}',
                        access_token: this.accessToken
                    },
                    timeout: 10000
                }
            );
            return response.data;

        } catch (error) {
            console.error(`[IG] Failed to fetch comment ${commentId}:`, error.message);
            return null;
        }
    }

    /**
     * Fetch media (post) details for context in the Comments Center.
     *
     * @param {string} mediaId - Instagram media ID
     * @returns {object|null}  - { id, caption, media_type, media_url, thumbnail_url, permalink, timestamp }
     */
    async fetchMediaInfo(mediaId) {
        if (!this._enabled) return null;

        this._trackCall();

        try {
            const response = await axios.get(
                `https://graph.instagram.com/${this.apiVersion}/${mediaId}`,
                {
                    params: {
                        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
                        access_token: this.accessToken
                    },
                    timeout: 10000
                }
            );
            return response.data;

        } catch (error) {
            console.error(`[IG] Failed to fetch media ${mediaId}:`, error.message);
            return null;
        }
    }

    /**
     * Get this account's own Instagram user ID (cached for 24h).
     * Used to detect and skip the bot's own comments so outbound
     * replies are never re-processed as inbound events.
     */
    async getOwnUserId() {
        if (this._ownUserId && this._ownUserIdFetchedAt &&
            (Date.now() - this._ownUserIdFetchedAt) < 24 * 60 * 60 * 1000) {
            return this._ownUserId;
        }

        if (!this._enabled) return null;

        this._trackCall();

        try {
            const response = await axios.get(
                `https://graph.instagram.com/${this.apiVersion}/me`,
                {
                    params: {
                        fields: 'id,username',
                        access_token: this.accessToken
                    },
                    timeout: 10000
                }
            );

            this._ownUserId = response.data?.id || null;
            this._ownUserIdFetchedAt = Date.now();
            return this._ownUserId;

        } catch (error) {
            console.error('[IG] Failed to fetch own user ID:', error.message);
            return null;
        }
    }

    // ─── Fetch User Profile ───────────────────────────────────

    /**
     * Fetch Instagram user profile information.
     *
     * @param {string} igUserId - Instagram PSID
     * @returns {object} - { id, username, profile_pic, name }
     */
    async getUserProfile(igUserId) {
        if (!this._enabled) return null;

        this._trackCall();

        try {
            const response = await axios.get(
                `https://graph.instagram.com/${this.apiVersion}/${igUserId}`,
                {
                    params: {
                        fields: 'id,username,profile_pic,name',
                        access_token: this.accessToken
                    },
                    timeout: 10000
                }
            );

            const profile = {
                id: response.data.id,
                username: response.data.username || null,
                profile_pic: response.data.profile_pic || null,
                name: response.data.name || response.data.username || 'Instagram User'
            };

            console.log(`[IG] 👤 Fetched profile: @${profile.username || profile.id}`);
            return profile;

        } catch (error) {
            console.error(`[IG] Failed to fetch profile for ${igUserId}:`, error.message);
            return { id: igUserId, username: null, profile_pic: null, name: 'Instagram User' };
        }
    }

    // ─── 24-Hour Window Check ─────────────────────────────────

    /**
     * Check if we're within the 24-hour messaging window for a user.
     * Instagram only allows business replies within 24 hours of the
     * last customer message.
     *
     * @param {string} igUserId - Instagram PSID
     * @returns {boolean}
     */
    async isWithinMessagingWindow(igUserId) {
        try {
            const rows = await dbAdapter.query(
                'SELECT window_expires_at FROM instagram_conversations WHERE ig_user_id = ? LIMIT 1',
                [igUserId]
            );

            if (!rows || rows.length === 0) {
                // No conversation record — window is expired
                // (will be created when a new customer message arrives)
                return false;
            }

            const expiresAt = new Date(rows[0].window_expires_at);
            return new Date() < expiresAt;

        } catch (error) {
            console.error('[IG] Window check failed:', error.message);
            // Fail open: allow the send attempt; Instagram will reject if truly expired
            return true;
        }
    }

    /**
     * Update the 24-hour messaging window for a user.
     * Called whenever a customer sends a message (resets the window).
     *
     * @param {string} igUserId   - Instagram PSID
     * @param {string} igUsername - Optional username
     * @param {number} customerId - Optional linked customer ID
     */
    async updateMessagingWindow(igUserId, igUsername = null, customerId = null) {
        try {
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24 hours

            await dbAdapter.query(
                `INSERT INTO instagram_conversations (ig_user_id, ig_username, customer_id, last_customer_message_at, window_expires_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(ig_user_id) DO UPDATE SET
                    ig_username = COALESCE(?, instagram_conversations.ig_username),
                    customer_id = COALESCE(?, instagram_conversations.customer_id),
                    last_customer_message_at = ?,
                    window_expires_at = ?,
                    updated_at = ?`,
                [
                    igUserId, igUsername, customerId,
                    now.toISOString(), expiresAt.toISOString(),
                    igUsername, customerId,
                    now.toISOString(), expiresAt.toISOString(), now.toISOString()
                ]
            );
        } catch (error) {
            console.error('[IG] Failed to update messaging window:', error.message);
        }
    }

    // ─── Message Logging ──────────────────────────────────────

    /**
     * Log an outgoing Instagram message to the shared messages table.
     */
    async _logOutgoing(igUserId, messageContent, messageType = 'outgoing', externalId = null) {
        try {
            // Find or create customer record for this IG user
            const customer = await this._ensureCustomer(igUserId);
            if (!customer) return;

            // Use raw IG user ID as customer_phone (no prefix).
            // The channel column distinguishes IG from WhatsApp.
            const phone = customer.phone || igUserId;

            await dbAdapter.insert('messages', {
                customer_phone: phone,
                message_type: messageType,
                message_content: typeof messageContent === 'string'
                    ? messageContent.substring(0, 4000)
                    : '[Non-text message]',
                status: 'sent',
                channel: 'instagram',
                external_message_id: externalId,
                created_at: new Date().toISOString()
            });
        } catch (err) {
            console.error('[IG] Failed to log outgoing message:', err.message);
        }
    }

    /**
     * Log an incoming Instagram message to the shared messages table.
     */
    async logIncoming(igUserId, messageContent, externalId = null) {
        try {
            const customer = await this._ensureCustomer(igUserId);
            if (!customer) return;

            // Use raw IG user ID as customer_phone (no prefix).
            // The channel column distinguishes IG from WhatsApp.
            const phone = customer.phone || igUserId;

            await dbAdapter.insert('messages', {
                customer_phone: phone,
                message_type: 'incoming',
                message_content: typeof messageContent === 'string'
                    ? messageContent.substring(0, 4000)
                    : '[Non-text message]',
                status: 'received',
                channel: 'instagram',
                external_message_id: externalId,
                created_at: new Date().toISOString()
            });
        } catch (err) {
            console.error('[IG] Failed to log incoming message:', err.message);
        }
    }

    // ─── Customer Management ──────────────────────────────────

    /**
     * Ensure a customer record exists for this Instagram user.
     * Creates one if it doesn't exist; links IG profile data.
     *
     * @param {string} igUserId - Instagram PSID
     * @returns {object|null}   - Customer record
     */
    async _ensureCustomer(igUserId) {
        try {
            // Check if customer exists by IG PSID
            const existing = await dbAdapter.query(
                'SELECT * FROM customers WHERE ig_psid = ? LIMIT 1',
                [igUserId]
            );

            if (existing && existing.length > 0) {
                return existing[0];
            }

            // Try to fetch profile from Instagram
            let profile = { username: null, profile_pic: null, name: 'Instagram User' };
            try {
                if (this._enabled) {
                    profile = await this.getUserProfile(igUserId);
                }
            } catch (e) {
                // Profile fetch failed — create with defaults
            }

            // Create new customer with IG identity
            const result = await dbAdapter.insert('customers', {
                phone: null, // IG users don't have phone numbers
                name: profile.name || profile.username || 'Instagram User',
                ig_psid: igUserId,
                ig_username: profile.username || null,
                ig_profile_pic: profile.profile_pic || null,
                primary_channel: 'instagram',
                preferred_language: 'en',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            if (result) {
                console.log(`[IG] 👤 New customer created for @${profile.username || igUserId}`);
                // Re-fetch to get full record with ID
                const created = await dbAdapter.query(
                    'SELECT * FROM customers WHERE ig_psid = ? LIMIT 1',
                    [igUserId]
                );
                return created?.[0] || result;
            }

            return null;
        } catch (error) {
            // Race condition: another request created the customer simultaneously
            if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
                const retry = await dbAdapter.query(
                    'SELECT * FROM customers WHERE ig_psid = ? LIMIT 1',
                    [igUserId]
                );
                return retry?.[0] || null;
            }
            console.error('[IG] _ensureCustomer error:', error.message);
            return null;
        }
    }

    /**
     * Find a customer by Instagram username.
     */
    async findByUsername(igUsername) {
        try {
            const rows = await dbAdapter.query(
                'SELECT * FROM customers WHERE ig_username = ? LIMIT 1',
                [igUsername]
            );
            return rows?.[0] || null;
        } catch (error) {
            return null;
        }
    }

    // ─── Bot State Management ─────────────────────────────────

    /**
     * Get the current bot conversation state for an IG user.
     */
    async getBotState(igUserId) {
        try {
            const rows = await dbAdapter.query(
                'SELECT bot_state, bot_context, is_escalated, support_ticket_id FROM instagram_conversations WHERE ig_user_id = ? LIMIT 1',
                [igUserId]
            );
            if (!rows || rows.length === 0) return null;

            return {
                state: rows[0].bot_state || 'idle',
                context: (() => { try { return JSON.parse(rows[0].bot_context || '{}'); } catch (e) { return {}; } })(),
                isEscalated: rows[0].is_escalated || false,
                ticketId: rows[0].support_ticket_id || null
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Update the bot conversation state for an IG user.
     */
    async setBotState(igUserId, state, context = null) {
        try {
            if (context !== null) {
                await dbAdapter.query(
                    `UPDATE instagram_conversations
                     SET bot_state = ?, bot_context = ?, updated_at = ?
                     WHERE ig_user_id = ?`,
                    [state, JSON.stringify(context), new Date().toISOString(), igUserId]
                );
            } else {
                await dbAdapter.query(
                    `UPDATE instagram_conversations
                     SET bot_state = ?, updated_at = ?
                     WHERE ig_user_id = ?`,
                    [state, new Date().toISOString(), igUserId]
                );
            }
        } catch (error) {
            console.error('[IG] Failed to set bot state:', error.message);
        }
    }

    /**
     * Mark a conversation as escalated to human support.
     */
    async escalateToHuman(igUserId, ticketId) {
        try {
            await dbAdapter.query(
                `UPDATE instagram_conversations
                 SET is_escalated = true, support_ticket_id = ?, bot_state = 'escalated', updated_at = ?
                 WHERE ig_user_id = ?`,
                [ticketId, new Date().toISOString(), igUserId]
            );
            console.log(`[IG] 🔺 Escalated ${igUserId} to ticket #${ticketId}`);
        } catch (error) {
            console.error('[IG] Failed to escalate:', error.message);
        }
    }

    // ─── Error Handling ───────────────────────────────────────

    /**
     * Centralized error handler for Instagram API calls.
     */
    async _handleError(error, igUserId, methodName) {
        const status = error.response?.status;
        const igError = error.response?.data?.error;

        // Rate limit hit
        if (status === 429 || igError?.code === 4) {
            this._rateLimitHits++;
            console.error(`[IG] ⏳ Rate limit hit (${this._rateLimitHits} total) in ${methodName}`);
            // Don't throw — return null so caller can handle gracefully
            return null;
        }

        // 24-hour window expired
        if (igError?.error_subcode === 2018160 || igError?.message?.includes('24 hour')) {
            console.warn(`[IG] ⏰ 24h window expired for ${igUserId} in ${methodName}`);
            return { blocked: true, reason: '24h_window_expired' };
        }

        // Invalid recipient
        if (igError?.error_subcode === 2018158) {
            console.warn(`[IG] ❌ Invalid recipient ${igUserId} in ${methodName}`);
            return null;
        }

        // Auth failure
        if (status === 401 || status === 403) {
            console.error(`[IG] 🔑 Auth error in ${methodName}: ${igError?.message || error.message}`);
            return null;
        }

        // Generic error
        console.error(`[IG] ❌ ${methodName} failed for ${igUserId}:`, igError?.message || error.message);
        return null;
    }
}

module.exports = new InstagramService();
