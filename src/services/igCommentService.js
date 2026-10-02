/**
 * igCommentService.js
 * ─────────────────────────────────────────────────────────────
 * Instagram comment automation pipeline.
 *
 * Responsibilities:
 *   - Receive comment webhook events (from instagramWebhookRoutes)
 *   - Deduplicate via ig_comment_idempotency (separate from DM idempotency)
 *   - Classify comment intent via igSmartEngine (deterministic, no AI API)
 *   - Decision engine: private reply / ignore / flag for review
 *   - Execute via instagramService (Instagram Graph API)
 *   - Persist every comment to instagram_comments for the Comments Center
 *
 * DECISION RULES (automation):
 *   - Praise / plain greeting    → no action (recorded only)
 *   - Price / product / shipping → private reply with info
 *   - Return / exchange / issue  → private reply with support path
 *   - Complaint / sensitive      → private reply + flag for human
 *   - Creator / collab           → private reply with collab path
 *   - Spam                       → filtered, never replied
 *   - Low confidence             → flagged for manual review
 *
 * SAFETY:
 *   - Automation NEVER posts public replies (manual admin action only)
 *   - Own comments / threaded replies are ignored (prevents loops)
 *   - Private reply failure → comment flagged for review (no public fallback)
 *   - Does NOT touch any WhatsApp code paths
 * ─────────────────────────────────────────────────────────────
 */

const instagramService = require('./instagramService');
const smartEngine = require('./igSmartEngine');
const shopifyService = require('./shopifyService');
const { dbAdapter } = require('../database/db');

// ─── Configuration ───────────────────────────────────────────

const CONFIDENCE = smartEngine.CONFIDENCE || { HIGH: 0.7, MEDIUM: 0.4 };

// Creator / business intents routed to the collaboration flow
const CREATOR_INTENTS = [
    'creator_collaboration', 'ugc', 'gifting', 'affiliate', 'wholesale', 'business_enquiry'
];

// Valid status values for instagram_comments.status
const STATUSES = [
    'new', 'auto_replied', 'dm_started', 'needs_review', 'needs_human',
    'ticket_created', 'resolved', 'ignored', 'spam'
];

// Map smart-engine support intents → reply template keys
const INTENT_TEMPLATES = {
    order_tracking: 'tracking',
    return: 'return',
    exchange: 'exchange',
    refund: 'refund',
    delivery_issue: 'productIssue',
    damaged_product: 'productIssue',
    wrong_product: 'productIssue',
    shipping: 'shipping',
    payment: 'payment',
    cancellation: 'cancellation',
    product_question: 'productInfo',
    size_question: 'productInfo',
    faq: 'genericHelp'
};

// ─── Private Reply Templates ─────────────────────────────────
// Plain text only — Instagram DMs don't render markdown.

function handle(username) {
    return username ? `@${username}` : 'there';
}

const TEMPLATES = {
    tracking: (u) => `Hi ${handle(u)}!

Send me your Order ID (e.g., ORD-2024-001) or AWB number and I'll check the latest status right away.

You can also track anytime here: https://offcomfrt.in/pages/track-order`,

    return: (u) => `Hi ${handle(u)}!

We accept return requests within 2 days of delivery:
https://www.offcomfrt.in/pages/return

Items must be unused with tags attached. Store credit is processed within 5-7 business days after pickup.

Share your Order ID here and I'll help you start the return.`,

    exchange: (u) => `Hi ${handle(u)}!

Free size exchanges within 2 days of delivery:
https://www.offcomfrt.in/pages/exchange

Share your Order ID and the size you need, and I'll help you set it up.`,

    refund: (u) => `Hi ${handle(u)}!

Refunds are issued as store credit within 5-7 business days after pickup.

Share your Order ID and I'll check the refund status for you.`,

    productIssue: (u) => `Hi ${handle(u)}, we're really sorry about this.

Please share your Order ID and a photo of what you received — our team will make it right within 24 hours.`,

    shipping: (u) => `Hi ${handle(u)}!

Metro cities: 2-3 business days
Other cities: 4-6 business days
Remote areas: 6-8 business days

Free shipping on orders above Rs.999.
Track anytime: https://offcomfrt.in/pages/track-order`,

    payment: (u) => `Hi ${handle(u)}!

We accept Cards, UPI (GPay/PhonePe/Paytm), Net Banking and Cash on Delivery (up to Rs.5,000).

Is there something specific about payment I can help with?`,

    cancellation: (u) => `Hi ${handle(u)}!

Orders can be cancelled free of charge before shipping. After dispatch, you can request a return instead.

Share your Order ID and I'll check if it's still cancellable.`,

    productInfo: (u, product = null) => {
        if (product && product.handle) {
            const price = product.variants?.length > 0
                ? Math.min(...product.variants.map(v => v.price).filter(p => p > 0))
                : null;
            const priceLine = price ? `Price: Rs.${price}` : '';
            return `Hi ${handle(u)}!

${product.title}
${priceLine}

Check it out here: https://offcomfrt.in/products/${product.handle}

Tell me your usual size and I'll help you pick the right one.`;
        }
        return `Hi ${handle(u)}!

All our tees are 100% premium cotton, pre-shrunk, with a unisex fit. Available in sizes S to XXL.

Full collection and size chart: https://offcomfrt.in

Tell me your usual size and I'll help you pick the right one.`;
    },

    genericHelp: (u) => `Hi ${handle(u)}!

We can help with orders, tracking, returns, exchanges, sizing and shipping. What would you like to know?`,

    complaint: (u) => `Hi ${handle(u)}, we're truly sorry for the trouble.

This has been flagged to our team as a priority. Someone will reach out shortly — meanwhile, could you share your Order ID here so we can pull up your details right away?`,

    humanSupport: (u) => `Hi ${handle(u)}!

Our team has been notified and will message you here shortly.

If it's about an order, please share your Order ID so we can help faster.`,

    creator: (u) => `Hi ${handle(u)}! Thanks for reaching out — we'd love to collaborate!

Tell us a bit about yourself: your Instagram handle, follower count, and the kind of collab you have in mind (paid collab / barter / UGC / affiliate).

Our team will review and get back to you right here.`,

    clarify: (u) => `Hi ${handle(u)}! Thanks for reaching out.

Could you tell me a bit more — is this about an order, a return/exchange, or a product question?`
};

// ─── Comment Service ─────────────────────────────────────────

class IGCommentService {

    // ═══════════════════════════════════════════════════════
    //  WEBHOOK ENTRY POINT
    // ═══════════════════════════════════════════════════════

    /**
     * Process an incoming comment webhook event.
     * Called by instagramWebhookRoutes for every `comments` entry.
     *
     * @param {object} comment - { id, text, from: {id, username}, media, parent_id, timestamp }
     * @returns {object} result summary
     */
    async processCommentEvent(comment) {
        const commentId = comment?.id;
        const text = (comment?.text || '').trim();

        if (!commentId) return { skipped: 'no_comment_id' };
        if (!text) return { skipped: 'empty_comment' };

        try {
            // 0. Service must be configured
            if (!instagramService.isEnabled) {
                return { skipped: 'service_disabled' };
            }

            // 1. Never process threaded replies — this covers the bot's own
            //    replies and user-to-user comment threads (prevents loops)
            if (comment.parent_id) {
                return { skipped: 'threaded_reply' };
            }

            // 2. Never process our own comments (belt & braces with parent_id)
            const ownId = await instagramService.getOwnUserId();
            if (ownId && comment.from?.id && String(comment.from.id) === String(ownId)) {
                return { skipped: 'self_comment' };
            }

            // 3. Deduplicate webhook redeliveries
            if (await this._isDuplicate(commentId)) {
                return { skipped: 'duplicate' };
            }

            // 4. Classify (comments have no prior conversation context)
            const classification = smartEngine.classify(text, {});

            // 4b. Resolve product from media caption for product-related intents
            const mediaId = comment.media?.id || comment.media_id || null;
            let resolvedProduct = null;
            const PRODUCT_INTENTS = ['product_question', 'size_question'];
            if (PRODUCT_INTENTS.includes(classification.intent) && mediaId) {
                resolvedProduct = await this._resolveProductFromCaption(mediaId);
            }

            // 5. Decide what automation should do
            const decision = this._decideAutomation(classification);

            // 6. Execute private reply (automation never posts publicly)
            let finalStatus = decision.status;
            let automationAction = decision.action;

            if (decision.action === 'private_reply') {
                const templateFn = TEMPLATES[decision.template] || TEMPLATES.clarify;
                // Pass resolved product to productInfo template
                const replyText = decision.template === 'productInfo'
                    ? templateFn(comment.from?.username || null, resolvedProduct)
                    : templateFn(comment.from?.username || null);

                const replyResult = await instagramService.sendPrivateReply(commentId, replyText);

                if (!replyResult || replyResult.blocked) {
                    // Private reply failed — flag for manual review.
                    // Deliberately NO public fallback (safe default).
                    finalStatus = 'needs_review';
                    automationAction = 'private_reply_failed';
                    // Structured log for debugging — no secrets, no sensitive data
                    console.log(
                        `[IG COMMENT] private_reply_failed | ` +
                        `comment=${commentId} ` +
                        `media=${mediaId || 'none'} ` +
                        `intent=${classification.intent} ` +
                        `product=${resolvedProduct?.title || 'none'} ` +
                        `handle=${resolvedProduct?.handle || 'none'} ` +
                        `reason=${replyResult?.reason || 'api_error'}`
                    );
                }
            }

            // 7. Persist to instagram_comments
            const record = await this._persistComment({
                commentId,
                mediaId: comment.media?.id || comment.media_id || null,
                igUserId: comment.from?.id || comment.ig_user_id || null,
                igUsername: comment.from?.username || comment.username || null,
                text,
                timestamp: comment.timestamp || null,
                classification,
                automationAction,
                privateReplySent: automationAction === 'private_reply',
                finalStatus,
                mediaCaption: resolvedProduct?._mediaCaption || null,
                mediaPermalink: resolvedProduct?._mediaPermalink || null,
                resolvedProductId: resolvedProduct?.id || null,
                resolvedProductHandle: resolvedProduct?.handle || null
            });

            // 8. Mark processed (prevents reprocessing on webhook retries)
            await this._markProcessed(commentId, automationAction);

            console.log(`[IG COMMENT] ${automationAction} | ${classification.intent} (${classification.confidence}) | @${record?.ig_username || commentId}`);
            if (resolvedProduct) {
                console.log(`[IG COMMENT PRODUCT] media=${mediaId} product=${resolvedProduct.id} handle=${resolvedProduct.handle}`);
            }

            return {
                ok: true,
                id: record?.id,
                intent: classification.intent,
                action: automationAction,
                status: finalStatus
            };

        } catch (error) {
            console.error('[IG COMMENT] Processing error:', error.message);
            return { ok: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════
    //  DECISION ENGINE
    // ═══════════════════════════════════════════════════════

    /**
     * Decide what automation should do with a classified comment.
     * @returns {object} { action, status, template }
     */
    _decideAutomation(classification) {
        const { intent, category, confidence, sentiment } = classification;

        // Spam — never reply
        if (intent === 'spam') {
            return { action: 'spam_filtered', status: 'spam', template: null };
        }

        // Sensitive (legal threats etc.) — private reply + urgent human flag
        if (intent === 'sensitive_issue') {
            return { action: 'private_reply', status: 'needs_human', template: 'complaint' };
        }

        // Complaints / anger — private reply + human flag (never public)
        if (intent === 'complaint' || sentiment === 'angry') {
            return { action: 'private_reply', status: 'needs_human', template: 'complaint' };
        }

        if (intent === 'human_support') {
            return { action: 'private_reply', status: 'needs_human', template: 'humanSupport' };
        }

        // Positive praise / plain greetings — no action needed
        if (intent === 'positive_message' || intent === 'greeting') {
            return { action: 'none', status: 'ignored', template: null };
        }

        // Creator / business enquiries → collaboration path
        if (category === 'business' || CREATOR_INTENTS.includes(intent)) {
            return { action: 'private_reply', status: 'dm_started', template: 'creator' };
        }

        // Support intents with a known template
        if (INTENT_TEMPLATES[intent] && confidence >= CONFIDENCE.MEDIUM) {
            return { action: 'private_reply', status: 'dm_started', template: INTENT_TEMPLATES[intent] };
        }

        // Medium-confidence unknown — ask a targeted clarification
        if (confidence >= CONFIDENCE.MEDIUM) {
            return { action: 'private_reply', status: 'dm_started', template: 'clarify' };
        }

        // Low confidence — manual review
        return { action: 'none', status: 'needs_review', template: null };
    }

    // ═══════════════════════════════════════════════════════
    //  PRODUCT RESOLUTION FROM MEDIA CAPTION
    // ═══════════════════════════════════════════════════════

    /**
     * Resolve a Shopify product from an Instagram post/reel's caption.
     * Fetches media info, extracts caption, searches catalog for product
     * titles mentioned in the caption.
     *
     * Returns the matched product (with _mediaCaption/_mediaPermalink attached)
     * or null if no deterministic match is found.
     *
     * SAFETY: Never guesses. If 0 or 2+ products match, returns null.
     */
    async _resolveProductFromCaption(mediaId) {
        try {
            // 1. Fetch media info (caption, permalink)
            const mediaInfo = await instagramService.fetchMediaInfo(mediaId);
            const caption = (mediaInfo?.caption || '').trim();
            if (!caption) return null;

            // 2. Get Shopify catalog
            const catalog = await shopifyService.getProductCatalog();
            if (!catalog || catalog.length === 0) return null;

            // 3. Search for product titles in the caption (case-insensitive)
            const captionLower = caption.toLowerCase();
            const matches = [];

            for (const product of catalog) {
                const titleLower = (product.title || '').toLowerCase();
                if (!titleLower) continue;

                // Check if the product title appears in the caption
                if (captionLower.includes(titleLower)) {
                    matches.push(product);
                    continue;
                }

                // Check individual words from the title (for multi-word titles)
                const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
                if (titleWords.length > 0) {
                    const matchCount = titleWords.filter(w => captionLower.includes(w)).length;
                    // If most title words appear in caption, consider it a match
                    if (matchCount >= Math.ceil(titleWords.length * 0.6)) {
                        matches.push(product);
                    }
                }
            }

            // 4. Only return if exactly ONE product matched (deterministic)
            if (matches.length === 1) {
                const product = matches[0];
                product._mediaCaption = caption.substring(0, 500);
                product._mediaPermalink = mediaInfo?.permalink || null;
                return product;
            }

            // 0 or 2+ matches → cannot determine → return null (safe fallback)
            return null;

        } catch (error) {
            console.error('[IG COMMENT] Product resolution from caption failed:', error.message);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════
    //  PERSISTENCE + IDEMPOTENCY
    // ═══════════════════════════════════════════════════════

    async _persistComment(data) {
        try {
            // Best-effort conversation link (private replies create DM threads)
            let conversationId = null;
            try {
                if (data.igUserId) {
                    const conv = await dbAdapter.query(
                        'SELECT id FROM instagram_conversations WHERE ig_user_id = ? LIMIT 1',
                        [data.igUserId]
                    );
                    conversationId = conv?.[0]?.id || null;
                }
            } catch (e) { /* best-effort */ }

            await dbAdapter.query(
                `INSERT INTO instagram_comments
                 (comment_id, media_id, ig_user_id, ig_username, comment_text,
                  comment_timestamp, detected_intent, confidence, sentiment,
                  automation_action, public_reply_sent, private_reply_sent, dm_started,
                  status, conversation_id, media_caption, media_permalink,
                  created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (comment_id) DO NOTHING`,
                [
                    data.commentId, data.mediaId, data.igUserId, data.igUsername, data.text,
                    data.timestamp, data.classification.intent, data.classification.confidence,
                    data.classification.sentiment, data.automationAction, false,
                    data.privateReplySent, data.privateReplySent, data.finalStatus,
                    conversationId,
                    data.mediaCaption || null,
                    data.mediaPermalink || null,
                    new Date().toISOString(), new Date().toISOString()
                ]
            );

            const rows = await dbAdapter.query(
                'SELECT * FROM instagram_comments WHERE comment_id = ? LIMIT 1',
                [data.commentId]
            );
            return rows?.[0] || null;

        } catch (error) {
            console.error('[IG COMMENT] Failed to persist comment:', error.message);
            return null;
        }
    }

    /**
     * Check if this comment was already processed (webhook redelivery).
     */
    async _isDuplicate(commentId) {
        try {
            const existing = await dbAdapter.query(
                'SELECT id FROM ig_comment_idempotency WHERE ig_comment_id = ? LIMIT 1',
                [commentId]
            );
            return !!(existing && existing.length > 0);
        } catch (error) {
            if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
                return true;
            }
            console.error('[IG COMMENT] Idempotency check failed:', error.message);
            // Fail open — the unique constraint on instagram_comments still guards
            return false;
        }
    }

    async _markProcessed(commentId, result) {
        try {
            await dbAdapter.query(
                `INSERT INTO ig_comment_idempotency (ig_comment_id, processed_at, handler_result)
                 VALUES (?, ?, ?)
                 ON CONFLICT (ig_comment_id) DO NOTHING`,
                [commentId, new Date().toISOString(), String(result || '').substring(0, 50)]
            );
        } catch (error) {
            console.error('[IG COMMENT] Failed to mark idempotency:', error.message);
        }
    }

    /**
     * Update fields on a stored comment. Never throws.
     */
    async _touch(id, fields) {
        const sets = [];
        const params = [];
        for (const [key, value] of Object.entries(fields)) {
            sets.push(`${key} = ?`);
            params.push(value);
        }
        sets.push('updated_at = CURRENT_TIMESTAMP');
        try {
            await dbAdapter.run(
                `UPDATE instagram_comments SET ${sets.join(', ')} WHERE id = ?`,
                [...params, id]
            );
        } catch (error) {
            console.error('[IG COMMENT] Update failed:', error.message);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  ADMIN API (Comments Center)
    // ═══════════════════════════════════════════════════════

    /**
     * List comments with filters / search / pagination.
     *
     * @param {object} filters - { status, intent, mediaId, search, dateFrom, dateTo, page, limit }
     */
    async listComments(filters = {}) {
        try {
            const page = Math.max(1, parseInt(filters.page) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(filters.limit) || 50));
            const offset = (page - 1) * limit;

            const where = [];
            const params = [];

            if (filters.status && filters.status !== 'all') {
                where.push('c.status = ?');
                params.push(filters.status);
            }
            if (filters.intent && filters.intent !== 'all') {
                where.push('c.detected_intent = ?');
                params.push(filters.intent);
            }
            if (filters.mediaId) {
                where.push('c.media_id = ?');
                params.push(filters.mediaId);
            }
            if (filters.dateFrom) {
                where.push('c.created_at >= ?');
                params.push(filters.dateFrom);
            }
            if (filters.dateTo) {
                where.push('c.created_at <= ?');
                params.push(filters.dateTo);
            }
            if (filters.search) {
                where.push(`(c.ig_username ILIKE ? OR c.comment_text ILIKE ?
                             OR c.comment_id ILIKE ? OR st.ticket_number ILIKE ?)`);
                const s = `%${filters.search}%`;
                params.push(s, s, s, s);
            }

            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

            const countRows = await dbAdapter.query(
                `SELECT COUNT(*) AS total
                 FROM instagram_comments c
                 LEFT JOIN support_tickets st ON st.id = c.ticket_id
                 ${whereSql}`,
                params
            );

            const rows = await dbAdapter.query(
                `SELECT c.*, st.ticket_number, st.status AS ticket_status
                 FROM instagram_comments c
                 LEFT JOIN support_tickets st ON st.id = c.ticket_id
                 ${whereSql}
                 ORDER BY c.created_at DESC
                 LIMIT ${limit} OFFSET ${offset}`,
                params
            );

            return {
                comments: rows || [],
                total: parseInt(countRows?.[0]?.total || 0),
                page,
                limit
            };
        } catch (error) {
            console.error('[IG COMMENT] listComments error:', error.message);
            return { comments: [], total: 0, page: 1, limit: 50 };
        }
    }

    /**
     * Get a single comment (with ticket info) by DB id.
     */
    async getCommentById(id) {
        try {
            const rows = await dbAdapter.query(
                `SELECT c.*, st.ticket_number, st.status AS ticket_status
                 FROM instagram_comments c
                 LEFT JOIN support_tickets st ON st.id = c.ticket_id
                 WHERE c.id = ? LIMIT 1`,
                [id]
            );
            return rows?.[0] || null;
        } catch (error) {
            console.error('[IG COMMENT] getCommentById error:', error.message);
            return null;
        }
    }

    /**
     * Admin action: post a public reply to the comment.
     */
    async adminPublicReply(id, text, adminName) {
        const comment = await this.getCommentById(id);
        if (!comment) return { ok: false, error: 'not_found' };
        if (!text || !text.trim()) return { ok: false, error: 'empty_reply' };

        const result = await instagramService.sendCommentReply(comment.comment_id, text.trim());
        if (!result || result.blocked) return { ok: false, error: 'api_failed' };

        await this._touch(id, {
            public_reply_sent: true,
            handled_by: adminName || 'admin'
        });

        console.log(`[IG COMMENT] Public reply by ${adminName || 'admin'} on comment ${comment.comment_id}`);
        return { ok: true, replyId: result.id || null };
    }

    /**
     * Admin action: send a private reply (DM) to the commenter.
     */
    async adminPrivateReply(id, text, adminName) {
        const comment = await this.getCommentById(id);
        if (!comment) return { ok: false, error: 'not_found' };
        if (!text || !text.trim()) return { ok: false, error: 'empty_reply' };

        const result = await instagramService.sendPrivateReply(comment.comment_id, text.trim());
        if (!result || result.blocked) return { ok: false, error: 'api_failed' };

        await this._touch(id, {
            private_reply_sent: true,
            dm_started: true,
            handled_by: adminName || 'admin'
        });

        console.log(`[IG COMMENT] Private reply by ${adminName || 'admin'} on comment ${comment.comment_id}`);
        return { ok: true, messageId: result.message_id || null };
    }

    /**
     * Admin action: mark comment ignored.
     */
    async ignoreComment(id) {
        await this._touch(id, { status: 'ignored' });
        return { ok: true };
    }

    /**
     * Admin action: mark comment as spam.
     */
    async markSpam(id) {
        await this._touch(id, { status: 'spam' });
        return { ok: true };
    }

    /**
     * Admin action: mark comment resolved.
     */
    async resolveComment(id) {
        await this._touch(id, { status: 'resolved' });
        return { ok: true };
    }

    /**
     * Admin action: create a support ticket from a comment.
     * Duplicate-safe: a comment can only ever have one ticket.
     */
    async createTicket(id, adminName) {
        const comment = await this.getCommentById(id);
        if (!comment) return { ok: false, error: 'not_found' };

        // Duplicate prevention
        if (comment.ticket_id) {
            return {
                ok: true,
                existing: true,
                ticketId: comment.ticket_id,
                ticketNumber: comment.ticket_number
            };
        }

        const ticketNumber = await this._generateTicketNumber();
        const customerName = comment.ig_username ? `@${comment.ig_username}` : 'Instagram Customer';

        const ticketMessage = [
            `[IG Comment from ${customerName}]`,
            `"${comment.comment_text}"`,
            '',
            `Detected intent: ${comment.detected_intent || 'unknown'} (confidence: ${comment.confidence ?? 'n/a'})`,
            `Sentiment: ${comment.sentiment || 'neutral'}`,
            comment.media_id ? `Media ID: ${comment.media_id}` : null,
            `Automation: ${comment.automation_action || 'none'} | Status was: ${comment.status}`,
            adminName
                ? `Created via Comments Center by ${adminName}`
                : 'Created automatically from Instagram comment'
        ].filter(line => line !== null).join('\n');

        try {
            await dbAdapter.query(
                `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
                 VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
                [ticketNumber, comment.ig_user_id, customerName, ticketMessage, comment.ig_user_id, comment.ig_username]
            );

            const ticketRows = await dbAdapter.query(
                'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
                [ticketNumber]
            );
            const ticketId = ticketRows?.[0]?.id || null;

            await this._touch(id, {
                ticket_id: ticketId,
                status: 'ticket_created',
                handled_by: adminName || 'admin'
            });

            console.log(`[IG COMMENT] Ticket ${ticketNumber} created for comment ${comment.comment_id}`);
            return { ok: true, ticketId, ticketNumber };

        } catch (error) {
            console.error('[IG COMMENT] createTicket error:', error.message);
            return { ok: false, error: error.message };
        }
    }

    /**
     * Admin action: open a DM conversation with the commenter.
     * Prefers a normal DM when the messaging window is open,
     * falls back to a private reply on the comment (sanctioned path).
     */
    async openDM(id, text, adminName) {
        const comment = await this.getCommentById(id);
        if (!comment) return { ok: false, error: 'not_found' };

        const dmText = (text && text.trim())
            ? text.trim()
            : 'Hi! Following up on your comment — how can we help you today?';

        let result = null;
        let via = null;

        // Prefer a normal DM when an active messaging window exists
        if (comment.ig_user_id) {
            const windowOk = await instagramService.isWithinMessagingWindow(comment.ig_user_id);
            if (windowOk) {
                result = await instagramService.sendMessage(comment.ig_user_id, dmText);
                if (result && !result.blocked) via = 'dm';
            }
        }

        // Fall back to a private reply on the comment
        if (!result || result.blocked) {
            result = await instagramService.sendPrivateReply(comment.comment_id, dmText);
            if (result && !result.blocked) via = 'private_reply';
        }

        if (!result || result.blocked) {
            return { ok: false, error: 'dm_blocked' };
        }

        // Refresh conversation link
        let conversationId = comment.conversation_id || null;
        try {
            if (comment.ig_user_id) {
                const conv = await dbAdapter.query(
                    'SELECT id FROM instagram_conversations WHERE ig_user_id = ? LIMIT 1',
                    [comment.ig_user_id]
                );
                conversationId = conv?.[0]?.id || conversationId;
            }
        } catch (e) { /* best-effort */ }

        await this._touch(id, {
            dm_started: true,
            conversation_id: conversationId,
            handled_by: adminName || 'admin'
        });

        console.log(`[IG COMMENT] DM opened (${via}) by ${adminName || 'admin'} for comment ${comment.comment_id}`);
        return { ok: true, via };
    }

    /**
     * Aggregate stats for the Comments Center header.
     */
    async getStats() {
        try {
            const statusRows = await dbAdapter.query(
                'SELECT status, COUNT(*) AS count FROM instagram_comments GROUP BY status'
            );
            const todayRows = await dbAdapter.query(
                'SELECT COUNT(*) AS count FROM instagram_comments WHERE created_at >= CURRENT_DATE'
            );

            const byStatus = {};
            let total = 0;
            for (const row of statusRows || []) {
                byStatus[row.status || 'unknown'] = parseInt(row.count);
                total += parseInt(row.count);
            }

            return {
                total,
                today: parseInt(todayRows?.[0]?.count || 0),
                byStatus,
                needsAttention: (byStatus.needs_human || 0) + (byStatus.needs_review || 0)
            };
        } catch (error) {
            console.error('[IG COMMENT] getStats error:', error.message);
            return { total: 0, today: 0, byStatus: {}, needsAttention: 0 };
        }
    }

    // ─── Helpers ─────────────────────────────────────────────

    /**
     * Generate a unique ticket number (same pattern as igBotEngine: IG-YYMMDD-XXXX).
     */
    async _generateTicketNumber() {
        const now = new Date();
        const yy = String(now.getFullYear()).slice(-2);
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const candidate = `IG-${yy}${mm}${dd}-${Math.floor(Math.random() * 9000 + 1000)}`;

        const existing = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [candidate]
        );
        if (!existing || existing.length === 0) return candidate;

        return `IG-${yy}${mm}${dd}-${Math.floor(Math.random() * 9000 + 1000)}`;
    }
}

module.exports = new IGCommentService();
module.exports.STATUSES = STATUSES;
module.exports.CREATOR_INTENTS = CREATOR_INTENTS;
