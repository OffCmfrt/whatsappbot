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

            // 3. Atomic claim — prevents duplicate processing from concurrent
            //    webhook deliveries (only ONE delivery may proceed)
            if (await this._claimOnce(commentId)) {
                console.log(`[IG COMMENT] duplicate_skipped | comment=${commentId}`);
                return { skipped: 'duplicate' };
            }

            // 4. Classify (comments have no prior conversation context)
            const classification = smartEngine.classify(text, {});

            // 4b. Resolve product from media caption for product-related intents
            const mediaId = comment.media?.id || comment.media_id || null;
            let resolvedProduct = null;
            const PRODUCT_INTENTS = ['product_question', 'size_question'];
            if (PRODUCT_INTENTS.includes(classification.intent) && mediaId) {
                resolvedProduct = await this._resolveProductFromCaption(mediaId, text);
                // Structured product resolution log (safe — no secrets)
                console.log(
                    `[IG COMMENT PRODUCT] ` +
                    `comment=${commentId} ` +
                    `media=${mediaId} ` +
                    `product=${resolvedProduct?.id || 'none'} ` +
                    `handle=${resolvedProduct?.handle || 'none'} ` +
                    `url=${resolvedProduct?.handle ? 'https://offcomfrt.in/products/' + resolvedProduct.handle : 'none'} ` +
                    `source=${resolvedProduct?._matchSource || 'none'}`
                );
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

            // 8. Already claimed atomically at step 3 (no separate mark needed)

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
     * Resolve a Shopify product from an Instagram post/reel's caption
     * and/or the comment text itself.
     *
     * Strategy:
     *   1. Fetch media caption
     *   2. Get Shopify catalog
     *   3. Search caption for product title matches (primary signal)
     *   4. If caption yields 0 or 2+ matches, also search the comment text
     *      (users often name the product they're asking about)
     *   5. Return match ONLY when exactly ONE product is identified across
     *      both sources — never guesses
     *
     * @param {string} mediaId   - Instagram media/post ID
     * @param {string} commentText - The comment text (optional, used as fallback)
     * @returns {object|null} Matched product with _mediaCaption/_mediaPermalink, or null
     */
    async _resolveProductFromCaption(mediaId, commentText = '') {
        try {
            // 1. Fetch media info (caption, permalink)
            const mediaInfo = await instagramService.fetchMediaInfo(mediaId);
            const caption = (mediaInfo?.caption || '').trim();

            // Diagnostic: log what we fetched (safe — no secrets)
            console.log(
                `[IG COMMENT PRODUCT DIAG] ` +
                `media=${mediaId} ` +
                `caption_len=${caption.length} ` +
                `caption_preview="${caption.substring(0, 100)}" ` +
                `comment_len=${(commentText || '').length} ` +
                `comment_preview="${(commentText || '').substring(0, 80)}" ` +
                `has_permalink=${!!mediaInfo?.permalink}`
            );

            if (!caption && !commentText) return null;

            // 2. Get Shopify catalog
            const catalog = await shopifyService.getProductCatalog();
            if (!catalog || catalog.length === 0) {
                console.log(`[IG COMMENT PRODUCT DIAG] catalog empty or unavailable`);
                return null;
            }

            console.log(
                `[IG COMMENT PRODUCT DIAG] ` +
                `catalog_size=${catalog.length} ` +
                `titles=${catalog.map(p => p.title).join(', ')}`
            );

            const commentLower = (commentText || '').toLowerCase();

            // 3. Search caption for product title matches (primary)
            const captionMatches = caption
                ? this._matchProductsInText(caption.toLowerCase(), catalog)
                : [];

            // 4. If caption is ambiguous (0 or 2+), also search comment text
            let finalMatches = captionMatches;
            if (captionMatches.length !== 1 && commentLower) {
                const commentMatches = this._matchProductsInText(commentLower, catalog);
                // Diagnostic: log match counts
                console.log(
                    `[IG COMMENT PRODUCT DIAG] ` +
                    `caption_matches=${captionMatches.length} ` +
                    `comment_matches=${commentMatches.length} ` +
                    `comment_matches_titles=${commentMatches.map(p => p.title).join(', ') || 'none'}`
                );
                // Merge: prefer caption matches; if caption had 0, use comment matches
                if (captionMatches.length === 0) {
                    finalMatches = commentMatches;
                } else if (captionMatches.length >= 2) {
                    // Caption is ambiguous — check if comment narrows it down
                    const overlap = captionMatches.filter(cp =>
                        commentMatches.some(cm => cm.id === cp.id)
                    );
                    if (overlap.length === 1) {
                        finalMatches = overlap;
                    }
                    // If overlap is still 0 or 2+, keep caption matches (ambiguous)
                }
            } else {
                console.log(
                    `[IG COMMENT PRODUCT DIAG] ` +
                    `caption_matches=${captionMatches.length} ` +
                    `caption_matches_titles=${captionMatches.map(p => p.title).join(', ') || 'none'}`
                );
            }

            // 5. Only return if exactly ONE product matched (deterministic)
            if (finalMatches.length === 1) {
                const product = finalMatches[0];
                product._mediaCaption = caption.substring(0, 500);
                product._mediaPermalink = mediaInfo?.permalink || null;
                // Tag how the match was found (for structured log)
                if (captionMatches.length === 1) {
                    product._matchSource = 'caption_exact';
                } else if (captionMatches.length === 0 && commentLower) {
                    product._matchSource = 'comment_text';
                } else {
                    product._matchSource = 'caption_comment_overlap';
                }
                return product;
            }

            // 5b. Multiple matches — check if all from the same product family
            // e.g. "SLUB - 002" matches "SLUB - 002 ( B )" + "SLUB - 002 ( COMBO )"
            // → same base product, just different variants → pick first
            if (finalMatches.length >= 2) {
                const bases = finalMatches.map(p => this._extractProductBase(p.title));
                const allSameBase = bases.every(b => b === bases[0]);
                if (allSameBase) {
                    const product = finalMatches[0];
                    product._mediaCaption = caption.substring(0, 500);
                    product._mediaPermalink = mediaInfo?.permalink || null;
                    product._matchSource = captionMatches.length >= 2
                        ? 'caption_family'
                        : (captionMatches.length === 0 ? 'comment_family' : 'family_overlap');
                    return product;
                }
            }

            // 0 or 2+ truly different matches → cannot determine → return null
            return null;

        } catch (error) {
            console.error('[IG COMMENT] Product resolution from caption failed:', error.message);
            return null;
        }
    }

    /**
     * Normalize text for product matching: lowercase, strip parentheses,
     * remove non-alphanumeric chars (except spaces), collapse whitespace.
     * This ensures "HENLEY - 001 ( ACID WASH )" and "HENLEY - 001 ( Acid Wash )"
     * produce the same normalized form: "henley 001 acid wash".
     */
    _normalizeForMatch(text) {
        return (text || '')
            .toLowerCase()
            .replace(/[()\[\]{}]/g, '')           // strip brackets
            .replace(/[^a-z0-9\s]/g, ' ')         // non-alphanum → space
            .replace(/\s+/g, ' ')                  // collapse whitespace
            .trim();
    }

    /**
     * Extract the base product name (before variant parentheses).
     * "SLUB - 002 ( B )" → "slub 002"
     * "HENLEY - 001 ( ACID WASH )" → "henley 001"
     * Used to detect when multiple matches are variants of the same product.
     */
    _extractProductBase(title) {
        return (title || '')
            .toLowerCase()
            .split('(')[0]                          // take only before first '('
            .replace(/[^a-z0-9\s]/g, ' ')          // non-alphanum → space
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Match catalog products against a given text string.
     * Returns array of matching products (may be 0, 1, or many).
     *
     * Strategy — match against the product BASE NAME (the part before
     * variant parentheses):
     *   Tier 1 — Exact normalized match:
     *            normalized full title === normalized text → unique answer
     *   Tier 2 — Base-name match:
     *            Extract base from each title (before parentheses).
     *            Match when normalized base appears in normalized text
     *            AND base has ≥2 words AND all base words appear in text.
     *            This ensures "SLUB - 002" matches ALL SLUB-002 variants
     *            while "henley" (1 word) matches nothing.
     *
     * The caller (_resolveProductFromCaption) handles disambiguation:
     *   - 1 match → return it
     *   - 2+ matches, all same base → pick first (same product family)
     *   - 2+ matches, different bases → null (truly ambiguous)
     *   - 0 matches → null
     */
    _matchProductsInText(textLower, catalog) {
        const normText = this._normalizeForMatch(textLower);

        // ── Tier 1: Exact normalized full-title match ────────────
        const exactMatches = [];
        for (const product of catalog) {
            const titleLower = (product.title || '').toLowerCase();
            if (!titleLower) continue;
            const normTitle = this._normalizeForMatch(titleLower);
            if (normTitle && normTitle === normText) {
                exactMatches.push(product);
            }
        }
        if (exactMatches.length >= 1) return exactMatches;

        // ── Tier 2: Base-name match ─────────────────────────────
        // Extract the base name from each title (before parentheses).
        // Match when:
        //   (a) base has ≥2 significant words (prevents bare "henley" matching)
        //   (b) ALL base words appear in the normalized text
        //       (ensures "slub 002" matches base "slub 002" but not "slub 001")
        const baseMatches = [];
        for (const product of catalog) {
            const base = this._extractProductBase(product.title);
            if (!base) continue;

            const baseWords = base.split(/\s+/).filter(w => w.length > 0);
            if (baseWords.length < 2) continue; // need ≥2 words in base

            // ALL base words must appear in the text
            const allWordsPresent = baseWords.every(w => normText.includes(w));
            if (allWordsPresent) {
                baseMatches.push(product);
            }
        }
        return baseMatches;
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
     * Atomically claim this comment for processing.
     * Uses INSERT ON CONFLICT + a unique per-attempt token to guarantee
     * exactly-once execution even under concurrent webhook deliveries.
     *
     * How it works:
     *   1. Generate a unique token for THIS attempt
     *   2. INSERT … ON CONFLICT DO NOTHING (only the first delivery creates the row)
     *   3. SELECT the stored token — if it matches ours, we own the claim
     *
     * @returns {boolean} true = already claimed (skip), false = claimed now (proceed)
     */
    async _claimOnce(commentId) {
        try {
            // Unique token identifies THIS delivery's attempt
            const myToken = `proc:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

            // Try to insert our claim (no-op if row already exists)
            await dbAdapter.query(
                `INSERT INTO ig_comment_idempotency (ig_comment_id, processed_at, handler_result)
                 VALUES (?, ?, ?)
                 ON CONFLICT (ig_comment_id) DO NOTHING`,
                [commentId, new Date().toISOString(), myToken]
            );

            // Read back the stored token — if it matches ours, we created the row
            const rows = await dbAdapter.query(
                'SELECT handler_result FROM ig_comment_idempotency WHERE ig_comment_id = ? LIMIT 1',
                [commentId]
            );

            if (rows?.[0]?.handler_result === myToken) {
                return false; // Our token is stored → we claimed it → proceed
            }
            return true; // Different token is stored → someone else claimed it → skip
        } catch (error) {
            // UNIQUE constraint violation = concurrent claim by another delivery
            if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
                return true;
            }
            console.error('[IG COMMENT] Claim check failed:', error.message);
            // Fail open — let the comment through rather than blocking all comments
            return false;
        }
    }

    /**
     * Check if this comment was already processed (webhook redelivery).
     * @deprecated Use _claimOnce() for atomic claim — this method has a TOCTOU race.
     *             Kept for backwards compatibility only.
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

    /**
     * @deprecated Replaced by _claimOnce(). Kept for backwards compatibility.
     */
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
