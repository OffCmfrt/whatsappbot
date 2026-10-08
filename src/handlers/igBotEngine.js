/**
 * igBotEngine.js
 * ─────────────────────────────────────────────────────────────
 * Smart Instagram support bot for OFFCOMFRT.
 *
 * Responsibilities:
 *   - Classify customer intent via igSmartEngine (confidence scoring)
 *   - Manage conversation context (entities, order ID, creator info)
 *   - Handle stateful flows: tracking, return/exchange, support, creator
 *   - Detect intent switches mid-flow and re-route gracefully
 *   - Detect anger/sensitive issues and escalate smartly
 *   - Answer FAQs using the same knowledge base as WhatsApp
 *   - Escalate to human agents (create support ticket)
 *
 * SAFETY:
 *   - Does NOT call any WhatsApp service functions
 *   - Uses instagramService for all outbound messages
 *   - Reuses FAQ data from the existing system (read-only)
 *   - Creates support tickets in the shared table (channel = 'instagram')
 * ─────────────────────────────────────────────────────────────
 */

const instagramService = require('../services/instagramService');
const smartEngine = require('../services/igSmartEngine');
const shiprocketService = require('../services/shiprocketService');
const shopifyService = require('../services/shopifyService');
const { dbAdapter } = require('../database/db');

const STATES = smartEngine.STATES;
const CONFIDENCE = smartEngine.CONFIDENCE;

// Intents that open the creator/collaboration flow
const CREATOR_INTENTS = [
    'creator_collaboration', 'ugc', 'gifting', 'affiliate', 'wholesale', 'business_enquiry'
];

// Intents that are product problems (need order ID + human review)
const PRODUCT_ISSUE_INTENTS = ['delivery_issue', 'damaged_product', 'wrong_product'];

// Maximum number of product candidates shown in ambiguous-product clarification.
// This is the single limit that drives text list, quick-reply buttons, and
// stored pendingProductCandidates — one source of truth.
const MAX_PRODUCT_CHOICES = 3;

// ─── FAQ Answers (Instagram-formatted) ────────────────────────
// Same content as WhatsApp FAQ but without WhatsApp-specific
// markdown (*bold*). Instagram doesn't support markdown in DMs.

const IG_FAQ = {
    return: `OFFCOMFRT — RETURN POLICY

We accept return requests within 2 days of delivery.

How to initiate:
  Visit our returns page on the website.

Process:
  - Submit return request
  - Team reviews within 24-48 hours
  - Pickup at your doorstep
  - Store credit within 5-7 business days

Conditions:
  - Items unused, tags attached
  - Original packaging required`,

    exchange: `OFFCOMFRT — SIZE EXCHANGE

Free size exchanges within 2 days of delivery.

Visit our Exchange page on the website.

Process:
  - Select order and new size
  - We pick up the old item
  - New size shipped after quality check

Subject to stock availability.`,

    refund: `OFFCOMFRT — REFUNDS

Refunds are issued as store credit within 5-7 business days after pickup.

Share your Order ID and I'll check the refund status for you.`,

    shipping: `OFFCOMFRT — SHIPPING & DELIVERY

Metro cities: 2-3 business days
Other cities: 4-6 business days
Remote areas: 6-8 business days

Free shipping on orders above Rs.999
Rs.99 for orders below Rs.999

Send your Order ID for real-time tracking.`,

    payment: `OFFCOMFRT — PAYMENT METHODS

Credit/Debit Cards
UPI (GPay, PhonePe, Paytm)
Net Banking
Digital Wallets
Cash on Delivery (COD)

COD available up to Rs.5,000
Rs.50 COD handling charge`,

    product_info: `OFFCOMFRT — PRODUCT INFO

100% Premium Cotton
Pre-shrunk fabric
Colourfast dyes
OEKO-TEX certified

Care: Machine wash cold, tumble dry low`,

    cancellation: `OFFCOMFRT — CANCELLATION

Before Shipping: Free cancellation
After Shipping: Cannot cancel (return after delivery instead)

Send your Order ID and type "cancel" to proceed.`,

    location: `OFFCOMFRT — STORE LOCATION

We are an online-only store.

Website: offcomfrt.in

WhatsApp Support: Available 24/7

Business Hours:
  Monday to Saturday: 10 AM to 7 PM IST
  Sunday: Closed

We ship across India!`
};

// ─── Instagram-only Hardcoded FAQ List ─────────────────────────
// Used by _matchIGFAQ() — does NOT query automation_config table.
// This ensures Instagram FAQ works even when the table is missing.
// Content is Instagram-formatted (no WhatsApp markdown asterisks).
const IG_FAQ_LIST = [
    {
        keywords: ['return', 'refund', 'money back', 'return policy'],
        answer: IG_FAQ.return
    },
    {
        keywords: ['exchange', 'size change', 'wrong size', 'different size', 'size exchange'],
        answer: IG_FAQ.exchange
    },
    {
        keywords: ['shipping', 'delivery', 'how long', 'when will i get', 'delivery time', 'shipping time'],
        answer: IG_FAQ.shipping
    },
    {
        keywords: ['payment', 'pay', 'cod', 'cash on delivery', 'payment methods', 'upi'],
        answer: IG_FAQ.payment
    },
    {
        keywords: ['quality', 'material', 'fabric', 'cotton', 'what is it made of'],
        answer: IG_FAQ.product_info
    },
    {
        keywords: ['track', 'tracking', 'where is my order', 'order status', 'awb'],
        answer: `Send your Order ID (e.g., 54789) and I'll show you:\n  • Current status\n  • Location\n  • Courier name\n  • Expected delivery date\n  • Tracking link`
    },
    {
        keywords: ['cancel', 'cancellation', 'cancel order', 'dont want'],
        answer: IG_FAQ.cancellation
    },
    {
        keywords: ['discount', 'offer', 'coupon', 'promo code', 'sale'],
        answer: `OFFCOMFRT — CURRENT OFFERS\n\nFirst Order: 10% off (Code: FIRST10)\nOrders above Rs.1999: 15% off\nFree shipping on Rs.999 and above`
    },
    {
        keywords: ['contact', 'customer care', 'phone number', 'support'],
        answer: `CONTACT SUPPORT\n\nWhatsApp: Available 24/7\nResponse Time: Within 24 hours\nBusiness Hours: Mon-Sat 10 AM to 7 PM IST\n\nI can help with:\n  • Order tracking\n  • Returns & exchanges\n  • Product questions\n  • Size guidance`
    },
    {
        keywords: ['location', 'address', 'where are you', 'where is your store', 'store location', 'shop address', 'where located', 'physical store', 'office address', 'where are u'],
        answer: IG_FAQ.location
    }
];

/**
 * Match a message against the Instagram-only hardcoded FAQ list.
 * Does NOT query automation_config — safe even when the table is missing.
 * @param {string} message
 * @returns {object|null} matched FAQ entry or null
 */
function _matchIGFAQ(message) {
    const lower = (message || '').toLowerCase();
    for (const faq of IG_FAQ_LIST) {
        for (const keyword of faq.keywords) {
            if (lower.includes(keyword)) {
                return faq;
            }
        }
    }
    return null;
}

// ─── Bot Engine Class ─────────────────────────────────────────

class IGBotEngine {
    /**
     * Process an incoming Instagram message for a user.
     *
     * @param {string} igUserId - Instagram PSID
     * @param {string} message  - Message text
     * @param {object} options  - { messageId, timestamp, isQuickReply, isPostback, referral, isAttachment }
     */
    async processMessage(igUserId, message, options = {}) {
        try {
            const cleanMessage = (message || '').trim();
            if (!cleanMessage && !options.isAttachment) return;

            // Get current bot state + conversation context
            const botState = await instagramService.getBotState(igUserId);
            const currentState = botState?.state || STATES.IDLE;
            let context = botState?.context || {};

            // Inject current state into context — required for
            // _detectIntentSwitch() to detect intent switching mid-flow.
            // Without this, context.state is undefined and isIntentSwitch
            // is always false, causing the bot to ignore new intents.
            context.state = currentState;

            console.log(`[IG BOT] User ${igUserId} | State: ${currentState} | Msg: "${cleanMessage.substring(0, 50)}"`);

            // Referral entry (ad/link) — greet the user
            if (options.referral) {
                return await this._handleGreeting(igUserId, context);
            }

            // ── 1. Classify via smart engine (context-aware) ──────
            const result = smartEngine.classify(cleanMessage, context);

            // ── 1b. Structured observability logs (safe — no secrets) ──
            const entities = result.entities || {};
            console.log(
                `[IG ENTITY] ` +
                `order=${entities.orderId || entities.bareNumber ? 'present' : 'absent'} ` +
                `awb=${entities.awb ? 'present' : 'absent'} ` +
                `product=${entities.productName ? 'present' : 'absent'} ` +
                `size=${entities.size ? 'present' : 'absent'}`
            );
            console.log(
                `[IG DECISION] ` +
                `intent=${result.intent} ` +
                `state=${currentState} ` +
                `confidence=${result.confidence} ` +
                `intentSwitch=${result.isIntentSwitch || false} ` +
                `sentiment=${result.sentiment || 'neutral'}`
            );

            // ── 2. Update conversation memory ─────────────────────
            context = smartEngine.updateContext(context, {
                intent: result.intent,
                entities: result.entities,
                summaryEntry: cleanMessage.substring(0, 120)
            });

            // ── 2b. Attachment context ─────────────────────────────
            // Store attachment URL for potential product resolution.
            // If the message is ONLY an attachment (no text question),
            // prompt the user to tell us what they want to know.
            if (options.isAttachment && options.attachmentUrl) {
                context.lastAttachment = {
                    url: options.attachmentUrl,
                    type: options.attachmentType || 'image'
                };

                // If the message is just the attachment descriptor with no real question
                if (cleanMessage.startsWith('[attachment:') && !options.quickReplyPayload) {
                    // If we already have product context, acknowledge the new media
                    if (context.lastProduct) {
                        await instagramService.sendMessage(
                            igUserId,
                            `Got the ${options.attachmentType || 'image'}. What would you like to know about ${context.lastProduct.name}? (e.g., price, size, availability)`
                        );
                    } else {
                        await instagramService.sendMessage(
                            igUserId,
                            `Got the ${options.attachmentType || 'image'}. What would you like to know? You can ask about price, size, or availability — or share the product name.`
                        );
                    }
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    return;
                }
            }

            // ── 2c. Product selection from quick-reply or numeric choice ──
            // Intercept structured product-selection events BEFORE classification.
            // Both product_pick_<id> button payloads and numeric selections (1/2/3)
            // are resolved through the same shared resolver to guarantee the
            // displayed candidate and the resolved product are always identical.
            if (!options.isAttachment) {
                if (cleanMessage.startsWith('product_pick_')) {
                    const productId = cleanMessage.replace('product_pick_', '');
                    const handled = await this._resolveProductSelection(igUserId, productId, context, 'by_id');
                    if (handled) return;
                    // Product not found — fall through to normal routing
                } else if (/^[1-9]$/.test(cleanMessage) && context.pendingProductCandidates?.length > 0) {
                    const idx = parseInt(cleanMessage, 10) - 1;
                    const candidate = context.pendingProductCandidates[idx];
                    if (candidate) {
                        const handled = await this._resolveProductSelection(igUserId, String(candidate.id), context, 'by_numeric');
                        if (handled) return;
                    }
                    // Invalid index — fall through to normal routing
                }
            }

            // ── 2d. Quick-reply payload interception ─────────────────
            // Known quick-reply payloads from product answer buttons that
            // classify() cannot route on its own (stock_check, product_link).
            if (options.isQuickReply && context.lastProduct) {
                const knownPayloads = ['stock_check', 'product_link', 'size_question'];
                if (knownPayloads.includes(cleanMessage)) {
                    const qrResult = {
                        intent: 'product_question',
                        entities: {},
                        confidence: 0.9
                    };
                    return await this._handleFollowUpQuestion(igUserId, cleanMessage, qrResult, context);
                }
            }
            // If quick-reply payload targets product but no product context
            if (options.isQuickReply && !context.lastProduct) {
                const productPayloads = ['stock_check', 'product_link', 'size_question'];
                if (productPayloads.includes(cleanMessage)) {
                    await instagramService.sendMessage(
                        igUserId,
                        'Which product are you asking about? Please share the product name.'
                    );
                    return;
                }
            }

            // ── 3. WAITING_FOR_CUSTOMER: team owes this customer a reply ──
            if (currentState === STATES.WAITING_FOR_CUSTOMER) {
                const handled = await this._handleWaitingForCustomer(igUserId, cleanMessage, context, result);
                if (handled) return;
                // Clear new request — resume normal flow below
            }

            // ── 3b. Escalated conversation — bot may still answer automatable intents ──
            // An open support ticket must NOT globally lock the bot. If the user's
            // current message is an automatable intent (product, tracking, FAQ),
            // answer normally. Otherwise append to the ticket + quiet ack.
            if (botState?.isEscalated) {
                const AUTOMATABLE_INTENTS = [
                    'product_question', 'order_tracking', 'provide_order_id',
                    'faq', 'return', 'exchange', 'shipping', 'payment',
                    'cancellation', 'refund', 'greeting', 'positive_message',
                    'size_question', 'stock_check', 'product_link',
                    'already_raised', 'support_problem', 'product_discovery'
                ];
                if (AUTOMATABLE_INTENTS.includes(result.intent) || result.intent === 'unknown') {
                    // Automatable intent OR unknown (which may resolve via catalog
                    // fallback in _handleUnknown) — proceed with normal routing.
                    // Don't touch is_escalated or the ticket.
                    console.log(`[IG BOT] Escalated user ${igUserId} — automatable intent: ${result.intent}`);
                } else {
                    // Same support issue follow-up — append to ticket + quiet ack
                    if (botState.ticketId) {
                        try {
                            await dbAdapter.query(
                                `UPDATE support_tickets
                                 SET message = message || '\n\n---\n' || ?,
                                     is_read = false,
                                     updated_at = CURRENT_TIMESTAMP
                                 WHERE id = ?`,
                                [cleanMessage, botState.ticketId]
                            );
                        } catch (e) { /* best-effort */ }
                    }

                    // Detect if user is repeating the same question —
                    // check if the last few summary entries are similar to current message
                    const recentSummary = (context.summary || []).slice(-3).join(' ').toLowerCase();
                    const currentLower = cleanMessage.toLowerCase();
                    const isRepeating = recentSummary.includes(currentLower.substring(0, 20)) ||
                                        (currentLower.length > 10 && recentSummary.includes(currentLower.substring(0, 15)));

                    // Vary the acknowledgment — never send the same message twice
                    let ackMessage;
                    if (isRepeating) {
                        // User is repeating — politely ask them to wait
                        const waitMessages = [
                            `I understand this is important to you. Our team already has your message and is working on it — they'll respond here very soon.`,
                            `I hear you. Your concern has been shared with our team and they'll get back to you shortly. Thank you for your patience.`,
                            `Got it — I know you've already shared this. Our team is on it and will update you here shortly.`,
                            `I understand your frustration. The team has all the details and will respond here soon — we appreciate your patience.`
                        ];
                        // Pick based on message count to vary
                        const msgCount = (context.messageCount || 0) % waitMessages.length;
                        ackMessage = waitMessages[msgCount];
                    } else {
                        const ackVariations = [
                            `Got it — I've added this to your ticket. Our team will respond here shortly.`,
                            `Thanks for sharing. I've passed this along — the team will update you here soon.`,
                            `Noted. Your message has been added to the conversation — someone will be with you shortly.`,
                            `Understood. Our team has this information and will get back to you here.`
                        ];
                        const msgCount = (context.messageCount || 0) % ackVariations.length;
                        ackMessage = ackVariations[msgCount];
                    }

                    await instagramService.sendMessage(igUserId, ackMessage);
                    return;
                }
            }

            // ── 4. Stateful flows (collecting order ID, creator info, etc.) ──
            // BEFORE state handling: check for conversation intelligence intents
            // that should override the current collecting state.
            // This prevents the bot from ignoring "I already raised it" and
            // re-asking for Order ID, or ignoring "no response on WhatsApp"
            // and treating it as a non-answer.
            const stateHandled = await this._handleStateful(igUserId, cleanMessage, currentState, context, result);
            if (stateHandled) return;

            // ── 5. Intent routing ─────────────────────────────────
            await this._routeIntent(igUserId, cleanMessage, result, context);

            // ── 5b. Multi-intent: handle secondary intent if detected ──
            // Only fires for safe secondaries (product questions, FAQ).
            if (result._secondaryIntent) {
                await this._handleSecondaryIntent(igUserId, cleanMessage, result, context);
            }

        } catch (error) {
            console.error('[IG BOT] processMessage error:', error);
            // Don't let bot errors crash the webhook
            try {
                await instagramService.sendMessage(
                    igUserId,
                    'We encountered an issue processing your message. Please try again or type "support" to reach our team.'
                );
            } catch (e) { /* ignore */ }
        }
    }

    // ─── Waiting For Customer ───────────────────────────────────

    /**
     * Customer replied while a flow was handed off to the team
     * (e.g., creator enquiry under review).
     *
     *   - Low-signal follow-ups: append to ticket + quiet ack, stay waiting
     *   - Clear new requests (high confidence / intent switch): resume flow
     *
     * @returns {boolean} true if handled (stay waiting), false to resume flow
     */
    async _handleWaitingForCustomer(igUserId, message, context, result) {
        // An open support ticket must NOT globally lock the bot.
        // Resume normal flow for EVERY intent except when the user is
        // actively describing a support issue for the human team.
        //
        // The existing routing below handles product, tracking, FAQ,
        // greeting, catalog-aware unknown, etc. — all safely.

        if (result.intent === 'provide_support_description') {
            // User is actively describing a support issue — append to ticket
            if (context.ticketId) {
                try {
                    await dbAdapter.query(
                        `UPDATE support_tickets
                         SET message = message || '\n\n---\n' || ?,
                             is_read = false,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [message, context.ticketId]
                    );
                } catch (e) { /* best-effort */ }
            }

            // Detect repetition — check if user is saying the same thing
            const recentSummary = (context.summary || []).slice(-3).join(' ').toLowerCase();
            const currentLower = message.toLowerCase();
            const isRepeating = recentSummary.includes(currentLower.substring(0, 20)) ||
                                (currentLower.length > 10 && recentSummary.includes(currentLower.substring(0, 15)));

            // Vary the acknowledgment
            let ackMessage;
            if (isRepeating) {
                const waitMessages = [
                    `I understand — our team already has this and will respond here very soon.`,
                    `I hear you. The team is working on it and will update you shortly.`,
                    `Got it — I know you've shared this. The team will be with you soon.`
                ];
                ackMessage = waitMessages[(context.messageCount || 0) % waitMessages.length];
            } else {
                const ackVariations = [
                    `Got it — our team has this conversation and will update you right here shortly.`,
                    `Thanks for the details. The team will respond here soon.`,
                    `Noted — I've added this to your ticket. Someone will be with you shortly.`
                ];
                ackMessage = ackVariations[(context.messageCount || 0) % ackVariations.length];
            }

            await instagramService.sendMessage(igUserId, ackMessage);
            return true; // handled — stay waiting
        }

        // Everything else — resume normal bot routing.
        // Don't touch is_escalated or the ticket.
        await instagramService.setBotState(igUserId, STATES.IDLE, context);
        return false; // resume normal routing below
    }

    // ─── Stateful Flow Handling ─────────────────────────────────

    /**
     * Handle stateful conversation flows. Returns true if handled.
     */
    async _handleStateful(igUserId, message, state, context, result) {
        switch (state) {

            // ── Awaiting order ID for tracking or product issue ──
            case STATES.COLLECTING_ORDER_ID:
                if (result.intent === 'provide_order_id') {
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    const id = result.entities.orderId || result.entities.awb || result.entities.bareNumber;

                    // Check if this is a product issue flow
                    if (context.flow === 'product_issue') {
                        await this._handleProductIssueWithOrder(igUserId, id || message, context);
                        return true;
                    }

                    // Normal tracking flow
                    await this._handleOrderTracking(igUserId, id || message);
                    return true;
                }
                // New intent detected — switch instead of re-asking
                if (this._isNewIntent(result)) {
                    if (result.isIntentSwitch) await this._acknowledgeSwitch(igUserId, context);
                    await this._routeIntent(igUserId, message, result, context);
                    return true;
                }
                // Catalog-aware escape: bare product names, tracking keywords, FAQ
                if (await this._tryEscapeCollection(igUserId, message, context, result)) {
                    return true;
                }
                await this._askForOrderId(igUserId, 'tracking');
                return true;

            // ── Awaiting order ID for return/exchange ──
            case STATES.AWAITING_RETURN_ORDER_ID:
                if (result.intent === 'provide_order_id') {
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    const id = result.entities.orderId || result.entities.bareNumber;
                    await this._handleReturnExchange(igUserId, id || message, context);
                    return true;
                }
                // New intent detected — switch instead of re-asking
                if (this._isNewIntent(result)) {
                    if (result.isIntentSwitch) await this._acknowledgeSwitch(igUserId, context);
                    await this._routeIntent(igUserId, message, result, context);
                    return true;
                }
                // Catalog-aware escape: bare product names, tracking keywords, FAQ
                if (await this._tryEscapeCollection(igUserId, message, context, result)) {
                    return true;
                }
                await instagramService.sendMessage(
                    igUserId,
                    'Please share the Order ID for your return/exchange (e.g., ORD-2024-001).'
                );
                return true;

            // ── Awaiting issue description for support ticket ──
            case STATES.AWAITING_SUPPORT_DESCRIPTION:
                // New intent detected — switch instead of treating as description
                if (this._isNewIntent(result)) {
                    if (result.isIntentSwitch) await this._acknowledgeSwitch(igUserId, context);
                    await this._routeIntent(igUserId, message, result, context);
                    return true;
                }
                if (message.length >= 3) {
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);

                    // Try FAQ match first before creating ticket
                    const faqResolved = await this._tryFAQMatch(message, igUserId);
                    if (faqResolved) {
                        // FAQ answered - ask if they need more help
                        await instagramService.sendMessage(
                            igUserId,
                            `Does this help? If you still need assistance, just let me know.`
                        );
                        return true;
                    }

                    // For product issue resolution flow - provide guidance
                    if (context.flow === 'product_issue_resolution' && context.issueType) {
                        const guidance = this._getProductIssueGuidance(context.issueType);
                        if (guidance) {
                            await instagramService.sendMessage(igUserId, guidance);
                            await instagramService.sendMessage(
                                igUserId,
                                `If this doesn't resolve your issue, type "support" and I'll connect you with our team.`
                            );
                            return true;
                        }
                    }

                    // Unable to resolve - create ticket
                    await this._createSupportTicket(igUserId, message, context);
                    return true;
                }
                await instagramService.sendMessage(
                    igUserId,
                    'Please describe your issue in a few words so I can help you.'
                );
                return true;

            // ── Collecting creator collaboration details ──
            case STATES.COLLECTING_CREATOR_PROFILE:
                // classify() special-cases this state → provide_creator_info for ALL
                // messages. But if the message contains product/order keywords, it's
                // clearly NOT creator info — bypass the forced classification and let
                // normal intent scoring handle it.
                const productSignals = /\b(price|cost|how much|colour|color|size|link|stock|available|order|track|tracking|return|exchange|refund|damaged|wrong|delivery|product|henley|waffle|polo|shirt|tee)\b/i;
                if (productSignals.test(message)) {
                    // Re-classify WITHOUT the creator state forcing provide_creator_info
                    const freshContext = { ...context, state: STATES.IDLE };
                    const freshResult = smartEngine.classify(message, freshContext);
                    if (this._isNewIntent(freshResult) && freshResult.intent !== 'provide_creator_info') {
                        if (freshResult.isIntentSwitch) await this._acknowledgeSwitch(igUserId, context);
                        await this._routeIntent(igUserId, message, freshResult, context);
                        return true;
                    }
                }
                // Genuine creator info — complete the flow
                await this._completeCreatorFlow(igUserId, context, message, result);
                return true;

            default:
                return false;
        }
    }

    /**
     * Brief acknowledgment when the user switches topics mid-flow.
     * Varies the message to avoid repetition.
     */
    async _acknowledgeSwitch(igUserId, context = {}) {
        const variations = [
            "No problem — let's take care of that instead.",
            "Sure — let me help you with that.",
            "Understood — switching gears.",
            "Got it — let's handle that for you."
        ];
        const idx = (context.messageCount || 0) % variations.length;
        await instagramService.sendMessage(igUserId, variations[idx]);
    }

    /**
     * Determine whether a classified message represents a new intent
     * that should override the current collecting/flow state.
     *
     * Returns true for:
     *   - High-confidence intent switches (from _detectIntentSwitch)
     *   - Greetings (never treat "hi" as an order ID)
     *   - Any recognized intent with at least MEDIUM confidence
     *
     * This prevents the bot from endlessly re-asking for an Order ID
     * when the customer clearly wants to talk about something else.
     */
    _isNewIntent(result) {
        // High-confidence intent switch (detected by smart engine)
        if (result.isIntentSwitch) return true;

        // Greetings always override — "hi" is never an order ID
        if (result.intent === 'greeting') return true;

        // Human support requests always override
        if (result.intent === 'human_support') return true;

        // Any recognized intent with at least MEDIUM confidence
        // (excludes unknown, positive_message, and very low-confidence guesses)
        if (result.intent !== 'unknown' &&
            result.intent !== 'positive_message' &&
            result.confidence >= CONFIDENCE.MEDIUM) {
            return true;
        }

        return false;
    }

    /**
     * Catalog-aware escape for data-collection states.
     * When _isNewIntent() returns false (bare product names, low-confidence
     * tracking, FAQ questions), this provides a second chance to escape
     * the collection state and route to the correct flow.
     *
     * Checks (in order):
     *   1. Product catalog match — bare product names like "Waffle", "Henley"
     *   2. Tracking keywords — "track", "where is my order", etc.
     *   3. FAQ/general questions — "what is the return policy", etc.
     *
     * Returns true if the message was routed to a new flow.
     * Returns false if the caller should continue with the collection prompt.
     */
    async _tryEscapeCollection(igUserId, message, context, result) {
        // 1. Product catalog check — bare product names
        const extractedName = this._extractProductName(message, context);
        if (extractedName) {
            const searchResult = await this._searchProducts(extractedName);
            if (searchResult && searchResult.type === 'match') {
                // Product found — escape to product flow
                await instagramService.setBotState(igUserId, STATES.IDLE, context);
                await this._routeIntent(igUserId, message,
                    { intent: 'product_question', entities: {}, confidence: 0.5 },
                    context);
                return true;
            }
            if (searchResult && searchResult.type === 'ambiguous') {
                // Multiple products — show clarification
                await instagramService.setBotState(igUserId, STATES.IDLE, context);
                await this._routeIntent(igUserId, message,
                    { intent: 'product_question', entities: {}, confidence: 0.5 },
                    context);
                return true;
            }
        }

        // 2. Tracking keywords — low-confidence order_tracking
        if (/\b(track|tracking|where.*order|order.*status|where.*is.*my|shipment|dispatched|shipped|delivered|courier|awb)\b/i.test(message)) {
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            await this._routeIntent(igUserId, message,
                { intent: 'order_tracking', entities: result.entities || {}, confidence: 0.5 },
                context);
            return true;
        }

        // 3. FAQ/general questions — return policy, shipping policy, etc.
        if (/\b(policy|policies|what is|what's|tell me about|about|faq|help|hours|timing|store)\b/i.test(message) &&
            !/\b(return|exchange)\b.*\b(order|id|#)\b/i.test(message)) {
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            // Try FAQ match first
            const faqMatch = await this._tryFAQMatch(message, igUserId);
            if (faqMatch) return true;
            // Fall through to unknown handling
            await this._handleUnknown(igUserId, message, context);
            return true;
        }

        // 4. Positive message / acknowledgment — just stay in state
        // (don't escape for "ok", "sure", "yes" — these don't indicate a new flow)

        return false;
    }

    // ─── Intent Routing ─────────────────────────────────────────

    async _routeIntent(igUserId, message, result, context) {
        const { intent } = result;

        switch (intent) {
            case 'greeting':
                return await this._handleGreeting(igUserId, context);

            case 'order_tracking':
                // Resolve order ID: explicit entity → pronoun → verifiedOrderId → ask
                {
                    const resolvedOrderId = this._resolveKnownOrder(result, context, null);
                    if (resolvedOrderId) {
                        return await this._handleOrderTracking(igUserId, resolvedOrderId, context);
                    }
                    // Check if we have a verified order and message references it
                    if (context.verifiedOrderId && /\b(it|the order|this order|my order|that order|same order|status|track)\b/i.test(message)) {
                        return await this._handleOrderTracking(igUserId, context.verifiedOrderId, context);
                    }
                    return await this._askForOrderId(igUserId, 'tracking', context);
                }

            case 'provide_order_id':
                {
                    const resolvedId = this._resolveKnownOrder(result, context,
                        result.entities.orderId || result.entities.awb || result.entities.bareNumber || message);
                    return await this._handleOrderTracking(igUserId, resolvedId, context);
                }

            case 'return':
                return await this._handleReturn(igUserId, context);

            case 'exchange':
                return await this._handleExchange(igUserId, context);

            case 'refund':
                return await this._sendFAQ(igUserId, 'refund');

            case 'shipping':
                return await this._sendFAQ(igUserId, 'shipping');

            case 'payment':
                return await this._sendFAQ(igUserId, 'payment');

            case 'cancellation':
                return await this._sendFAQ(igUserId, 'cancellation');

            case 'product_question':
            case 'size_question':
                return await this._handleProductQuestion(igUserId, message, result, context);

            case 'product_discovery':
                return await this._handleProductDiscovery(igUserId, message, context);

            case 'delivery_issue':
            case 'damaged_product':
            case 'wrong_product':
                return await this._handleProductIssue(igUserId, intent, context);

            case 'human_support':
                return await this._handleHumanSupport(igUserId, message, result, context);

            case 'complaint':
            case 'sensitive_issue':
                return await this._handleSmartEscalation(igUserId, result, context, message);

            case 'already_raised':
                return await this._handleAlreadyRaised(igUserId, message, context);

            case 'support_problem':
                return await this._handleSupportProblem(igUserId, message, context);

            case 'faq':
                return await this._handleUnknown(igUserId, message, context);

            default:
                if (CREATOR_INTENTS.includes(intent)) {
                    return await this._startCreatorFlow(igUserId, intent, context);
                }
                if (intent === 'spam') return; // silently ignore spam
                if (intent === 'positive_message') {
                    // Context-aware positive response — check satisfaction
                    const hasOpenTicket = context?.openTicketId || context?.openTicketNumber;
                    if (hasOpenTicket) {
                        return await instagramService.sendMessage(
                            igUserId,
                            `Thank you! We really appreciate that.\n\nYour ticket *${context.openTicketNumber}* is still open and our team will follow up here shortly. Is there anything else I can help with in the meantime?`
                        );
                    }
                    // Warm satisfaction response
                    const satisfactionVariations = [
                        "Thank you so much! We're glad we could help. If you need anything else, we're right here.",
                        "That means a lot, thank you! Don't hesitate to reach out if you need anything else.",
                        "We really appreciate that! Happy to help anytime. Just message us if you need anything."
                    ];
                    const idx = (context?.messageCount || 0) % satisfactionVariations.length;
                    return await instagramService.sendMessage(igUserId, satisfactionVariations[idx]);
                }
                return await this._handleUnknown(igUserId, message, context);
        }

        // ── Multi-intent: handle secondary intent after primary ──
        // Only safe secondaries are handled (product questions, FAQ).
        // Support/escalation secondaries are skipped (primary already handled).
    }

    /**
     * Handle a secondary intent detected by the classifier.
     * Only safe, non-destructive secondaries are handled:
     *   - product_question / size_question → answer product
     *   - product_discovery → show products
     *   - faq → try FAQ match
     *
     * Called after the primary intent handler completes.
     */
    async _handleSecondaryIntent(igUserId, message, result, context) {
        const secondary = result._secondaryIntent;
        if (!secondary) return;

        const SAFE_SECONDARIES = ['product_question', 'size_question', 'product_discovery', 'faq'];
        if (!SAFE_SECONDARIES.includes(secondary)) return;

        // Small delay so the secondary response doesn't feel instant
        await new Promise(r => setTimeout(r, 300));

        console.log(`[IG BOT] Secondary intent: ${secondary} (from multi-intent message)`);

        switch (secondary) {
            case 'product_question':
            case 'size_question':
                await this._handleProductQuestion(igUserId, message, result, context);
                break;
            case 'product_discovery':
                await this._handleProductDiscovery(igUserId, message, context);
                break;
            case 'faq':
                await this._tryFAQMatch(message, igUserId);
                break;
        }
    }

    // ─── Greeting Handler ───────────────────────────────────────

    async _handleGreeting(igUserId, context) {
        // Fetch customer profile for personalization
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const name = customer?.[0]?.name || customer?.[0]?.ig_username || '';
        const greeting = name ? `Hi ${name}!` : 'Hi there!';

        // Context-aware greeting — if user has an open ticket, acknowledge it
        const openTicket = context?.openTicketNumber;
        const verifiedOrder = context?.verifiedOrderId;

        if (openTicket) {
            // User has an open support ticket — greet warmly and reassure
            await instagramService.sendMessage(
                igUserId,
                `${greeting} Welcome back to OffComfrt!\n\nYour ticket *${openTicket}* is still being reviewed by our team and they'll respond here shortly.\n\nIn the meantime, is there anything else I can help you with?`
            );
        } else if (verifiedOrder) {
            // User has a verified order — greet with order context
            await instagramService.sendQuickReplies(
                igUserId,
                `${greeting} Welcome back!\n\nI see your order *${verifiedOrder}*. How can I help you today?`,
                [
                    { title: 'Track Order', payload: 'track_order' },
                    { title: 'Return', payload: 'return' },
                    { title: 'Exchange', payload: 'exchange' },
                    { title: 'Need Help', payload: 'support' }
                ]
            );
        } else {
            // Standard greeting
            await instagramService.sendQuickReplies(
                igUserId,
                `${greeting} Welcome to OffComfrt!\n\nI can help you with:\n\n• Track your order\n• Returns & Exchanges\n• Product questions\n• FAQs\n• Contact support\n\nWhat would you like help with?`,
                [
                    { title: 'Track Order', payload: 'track_order' },
                    { title: 'Return', payload: 'return' },
                    { title: 'Exchange', payload: 'exchange' },
                    { title: 'Support', payload: 'support' }
                ]
            );
        }

        await instagramService.setBotState(igUserId, STATES.IDLE, context || {});
    }

    /**
     * Resolve the order ID for the current request.
     * Priority:
     *   1. Explicit order ID from entity extraction (customer just said it)
     *   2. Pronoun reference ("it", "the order") → context.verifiedOrderId
     *   3. Fallback value (raw message text, etc.)
     *
     * Returns null if no order reference can be resolved.
     */
    _resolveKnownOrder(result, context, fallback) {
        // 1. Explicit order ID from current message entities
        const explicitId = result?.entities?.orderId || result?.entities?.awb || result?.entities?.bareNumber;
        if (explicitId) return explicitId;

        // 2. Pronoun / anaphora resolution — "it", "the order", "this order"
        //    → use the last verified order from context memory
        const msg = (fallback || '').toLowerCase().trim();
        const pronounPatterns = [
            /\b(it|the order|this order|that order|my order|the same|same order)\b/i,
            /^(it|this|that|the order|my order)$/i
        ];
        if (context?.verifiedOrderId && pronounPatterns.some(re => re.test(msg))) {
            return context.verifiedOrderId;
        }

        // 3. Fallback (raw message text — used by some callers)
        return fallback || null;
    }

    // ─── Order Tracking ─────────────────────────────────────────

    async _askForOrderId(igUserId, flow, context = {}) {
        // Quality gate: if we already have a verified order, don't ask again
        if (context.verifiedOrderId) {
            return context.verifiedOrderId;
        }

        const variations = [
            `Please send your Order ID (e.g., 54789) or AWB number.\n\nYou can find it in your order confirmation email.`,
            `Share your Order ID so I can look that up for you.\n\nIt's in your confirmation email — looks like 54789 or an AWB number.`,
            `I'll need your Order ID to check that.\n\nYou'll find it in your order confirmation email.`
        ];
        const idx = (context.messageCount || 0) % variations.length;
        await instagramService.sendMessage(igUserId, variations[idx]);
        await instagramService.setBotState(igUserId, STATES.COLLECTING_ORDER_ID);
    }

    async _handleOrderTracking(igUserId, orderId, context = {}) {
        // Reset state
        await instagramService.setBotState(igUserId, STATES.IDLE);

        const cleanOrderId = (orderId || '').toString().trim();
        if (!cleanOrderId) {
            await this._askForOrderId(igUserId, 'tracking');
            return;
        }

        // ── 1. Try local DB first — EXACT match for explicit Order ID ──
        // SAFETY: When customer provides an explicit Order ID, we MUST
        // use exact match. Never use ILIKE wildcards that could return
        // the wrong order (e.g., customer says "55310" but we return "58432").
        let order = null;
        try {
            const orders = await dbAdapter.query(
                `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
                [cleanOrderId]
            );
            order = orders?.[0] || null;
        } catch (e) {
            console.error('[IG BOT] Local order lookup error:', e.message);
        }

        // ── 1b. If exact match failed, try AWB lookup (separate path) ──
        if (!order && /^[A-Z0-9]{8,15}$/i.test(cleanOrderId)) {
            try {
                const awbOrders = await dbAdapter.query(
                    `SELECT * FROM orders WHERE awb = ? LIMIT 1`,
                    [cleanOrderId]
                );
                order = awbOrders?.[0] || null;
            } catch (e) {
                console.error('[IG BOT] AWB lookup error:', e.message);
            }
        }

        // ── 1c. Identity safety assertion ──
        // If we found an order, verify it matches the requested Order ID.
        // This prevents returning the wrong order due to data issues.
        if (order && order.order_id !== cleanOrderId && order.awb !== cleanOrderId) {
            console.error(`[IG BOT] ORDER ID MISMATCH: requested=${cleanOrderId}, returned=${order.order_id} — blocking response`);
            order = null; // Block the response — don't show wrong order
        }

        // ── 2. If local DB found it, show complete status ──────────
        if (order) {
            // Store verified order in context for pronoun resolution
            context.verifiedOrderId = order.order_id;
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            await this._sendCompleteOrderStatus(igUserId, order);
            return;
        }

        // ── 3. Local DB miss → try Shiprocket API (same as WhatsApp) ──
        try {
            const srOrder = await shiprocketService.getOrderStatus(cleanOrderId);
            if (srOrder) {
                // SAFETY: Verify Shiprocket returned the correct order
                const srOrderId = srOrder.channelOrderId || String(srOrder.orderId);
                if (srOrderId !== cleanOrderId) {
                    console.error(`[IG BOT] SHIPROCKET ORDER ID MISMATCH: requested=${cleanOrderId}, returned=${srOrderId} — blocking response`);
                } else {
                    await this._sendShiprocketOrderStatus(igUserId, srOrder);
                    // Also save to local DB for future fast lookups
                    await this._saveOrderToDB(srOrder);
                    // Store verified order in context for pronoun resolution
                    context.verifiedOrderId = srOrderId;
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    return;
                }
            }
        } catch (e) {
            console.error('[IG BOT] Shiprocket order lookup error:', e.message);
        }

        // ── 4. Nothing found → allow retry, no auto-ticket ─────────
        await instagramService.sendMessage(
            igUserId,
            `I couldn't find an order with that ID or AWB.

Please check the Order ID and try again.

You can find it in your order confirmation email.`
        );
    }

    /**
     * Send complete order status from local DB data.
     * Shows all available fields (up to 12).
     */
    async _sendCompleteOrderStatus(igUserId, order) {
        const statusLabel = this._getStatusText(order.status);

        let msg = `ORDER STATUS

Order: ${order.order_id}`;

        // Product info
        if (order.product_name) {
            msg += `\nItem: ${order.product_name}`;
        }
        if (order.total) {
            msg += `\nOrder total: Rs.${parseFloat(order.total).toLocaleString('en-IN')}`;
        }
        if (order.payment_method) {
            msg += `\nPayment: ${order.payment_method}`;
        }
        if (order.created_at) {
            msg += `\nOrder date: ${new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        }

        // Shipment info
        msg += `\nStatus: ${statusLabel || order.status || 'Processing'}`;
        if (order.courier_name) {
            msg += `\nCourier: ${order.courier_name}`;
        }
        if (order.awb) {
            msg += `\nAWB: ${order.awb}`;
        }

        // Try live tracking from Shiprocket if AWB exists
        if (order.awb) {
            try {
                const trackingData = await shiprocketService.getTrackingByAWB(order.awb);
                if (trackingData?.tracking_data) {
                    const trackInfo = trackingData.tracking_data.shipment_track?.[0] || trackingData.tracking_data;
                    if (trackInfo.current_status) {
                        msg += `\nTracking status: ${trackInfo.current_status}`;
                    }
                    if (trackInfo.current_location) {
                        msg += `\nCurrent location: ${trackInfo.current_location}`;
                    }
                    // Latest tracking event
                    const activities = trackingData.tracking_data.shipment_track_activities;
                    if (activities && activities.length > 0) {
                        const latest = activities[0];
                        msg += `\nLatest update: ${latest.activity}`;
                        if (latest.date) msg += ` (${latest.date})`;
                    }
                    if (trackInfo.edd) {
                        msg += `\nEstimated delivery: ${trackInfo.edd}`;
                    }
                }
            } catch (e) {
                // Best-effort — local data is already shown
                console.error('[IG BOT] Live tracking fetch error:', e.message);
            }
        } else if (order.expected_delivery) {
            msg += `\nEstimated delivery: ${new Date(order.expected_delivery).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        }

        if (order.tracking_url) {
            msg += `\nTrack: ${order.tracking_url}`;
        }

        msg += `\n\nNeed help? Just tell me what's wrong with this order.`;

        await instagramService.sendMessage(igUserId, msg);
    }

    /**
     * Send order status from Shiprocket API response.
     * Formats the Shiprocket data into customer-friendly message.
     */
    async _sendShiprocketOrderStatus(igUserId, srOrder) {
        const productName = srOrder.products?.[0]?.name || 'Item';
        const productCount = srOrder.products?.length || 1;
        const otherItems = productCount > 1 ? ` +${productCount - 1} others` : '';
        const statusLabel = (srOrder.status || 'Processing').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

        let msg = `ORDER STATUS

Order: ${srOrder.channelOrderId || srOrder.orderId}
Item: ${productName}${otherItems}`;

        if (srOrder.total) {
            msg += `\nOrder total: Rs.${parseFloat(srOrder.total).toLocaleString('en-IN')}`;
        }
        if (srOrder.paymentMethod) {
            msg += `\nPayment: ${srOrder.paymentMethod}`;
        }
        if (srOrder.orderDate) {
            msg += `\nOrder date: ${new Date(srOrder.orderDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        }

        msg += `\nStatus: ${statusLabel}`;
        if (srOrder.courierName) msg += `\nCourier: ${srOrder.courierName}`;
        if (srOrder.awb) msg += `\nAWB: ${srOrder.awb}`;

        // Try live tracking if AWB exists
        if (srOrder.awb) {
            try {
                const trackingData = await shiprocketService.getTrackingByAWB(srOrder.awb);
                if (trackingData?.tracking_data) {
                    const trackInfo = trackingData.tracking_data.shipment_track?.[0] || trackingData.tracking_data;
                    if (trackInfo.current_status) msg += `\nTracking status: ${trackInfo.current_status}`;
                    if (trackInfo.current_location) msg += `\nCurrent location: ${trackInfo.current_location}`;
                    const activities = trackingData.tracking_data.shipment_track_activities;
                    if (activities && activities.length > 0) {
                        const latest = activities[0];
                        msg += `\nLatest update: ${latest.activity}`;
                        if (latest.date) msg += ` (${latest.date})`;
                    }
                    if (trackInfo.edd) msg += `\nEstimated delivery: ${trackInfo.edd}`;
                }
            } catch (e) {
                console.error('[IG BOT] Live tracking fetch error (SR):', e.message);
            }
        } else if (srOrder.expectedDelivery) {
            msg += `\nEstimated delivery: ${new Date(srOrder.expectedDelivery).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        }

        msg += `\n\nNeed help? Just tell me what's wrong with this order.`;

        await instagramService.sendMessage(igUserId, msg);
    }

    /**
     * Best-effort save of Shiprocket order to local DB for faster future lookups.
     */
    async _saveOrderToDB(srOrder) {
        try {
            const existing = await dbAdapter.query(
                'SELECT id FROM orders WHERE order_id = ? LIMIT 1',
                [srOrder.channelOrderId || String(srOrder.orderId)]
            );
            if (existing?.length > 0) return; // already exists

            await dbAdapter.query(
                `INSERT INTO orders (order_id, shiprocket_order_id, awb, status, courier_name, product_name, total, payment_method, expected_delivery, tracking_url)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    srOrder.channelOrderId || String(srOrder.orderId),
                    String(srOrder.orderId),
                    srOrder.awb || null,
                    srOrder.status || null,
                    srOrder.courierName || null,
                    srOrder.products?.[0]?.name || null,
                    srOrder.total || null,
                    srOrder.paymentMethod || null,
                    srOrder.expectedDelivery || null,
                    null // tracking_url not in SR response
                ]
            );
        } catch (e) {
            console.error('[IG BOT] Save order to DB error:', e.message);
        }
    }

    // ─── Return / Exchange ──────────────────────────────────────

    async _handleReturn(igUserId, context = {}) {
        // If we already have a verified order, skip asking for Order ID
        if (context.verifiedOrderId) {
            await this._handleReturnExchange(igUserId, context.verifiedOrderId, { ...context, flow: 'return' });
            return;
        }
        // Vary the prompt to avoid repetition
        const prompts = [
            IG_FAQ.return + '\n\nTo start your return, please share your Order ID.',
            IG_FAQ.return + '\n\nShare your Order ID and I\'ll get the return started.',
            IG_FAQ.return + '\n\nWhat\'s your Order ID? I\'ll help you with the return.'
        ];
        const idx = (context.messageCount || 0) % prompts.length;
        await instagramService.sendMessage(igUserId, prompts[idx]);
        await instagramService.setBotState(igUserId, STATES.AWAITING_RETURN_ORDER_ID, { flow: 'return' });
    }

    async _handleExchange(igUserId, context = {}) {
        // If we already have a verified order, skip asking for Order ID
        if (context.verifiedOrderId) {
            await this._handleReturnExchange(igUserId, context.verifiedOrderId, { ...context, flow: 'exchange' });
            return;
        }
        // Vary the prompt to avoid repetition
        const prompts = [
            IG_FAQ.exchange + '\n\nTo start your exchange, please share your Order ID.',
            IG_FAQ.exchange + '\n\nShare your Order ID and I\'ll get the exchange started.',
            IG_FAQ.exchange + '\n\nWhat\'s your Order ID? I\'ll help you with the exchange.'
        ];
        const idx = (context.messageCount || 0) % prompts.length;
        await instagramService.sendMessage(igUserId, prompts[idx]);
        await instagramService.setBotState(igUserId, STATES.AWAITING_RETURN_ORDER_ID, { flow: 'exchange' });
    }

    async _handleReturnExchange(igUserId, orderId, context) {
        const flow = context?.flow || 'return';
        await instagramService.setBotState(igUserId, STATES.IDLE);

        const cleanOrderId = (orderId || '').toString().trim();

        // Look up the order — EXACT match (never wildcard)
        let order = null;
        try {
            const orders = await dbAdapter.query(
                `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
                [cleanOrderId]
            );
            order = orders?.[0] || null;
        } catch (e) {
            console.error('[IG BOT] Return/exchange order lookup error:', e.message);
        }

        // AWB fallback (separate path)
        if (!order && /^[A-Z0-9]{8,15}$/i.test(cleanOrderId)) {
            try {
                const awbOrders = await dbAdapter.query(
                    `SELECT * FROM orders WHERE awb = ? LIMIT 1`,
                    [cleanOrderId]
                );
                order = awbOrders?.[0] || null;
            } catch (e) {
                console.error('[IG BOT] Return/exchange AWB lookup error:', e.message);
            }
        }

        // Identity safety assertion
        if (order && order.order_id !== cleanOrderId && order.awb !== cleanOrderId) {
            console.error(`[IG BOT] RETURN ORDER ID MISMATCH: requested=${cleanOrderId}, returned=${order.order_id} — blocking`);
            order = null;
        }

        // If not found locally, try Shiprocket
        if (!order) {
            try {
                const srOrder = await shiprocketService.getOrderStatus(cleanOrderId);
                if (srOrder) {
                    const srOrderId = srOrder.channelOrderId || String(srOrder.orderId);
                    if (srOrderId !== cleanOrderId) {
                        console.error(`[IG BOT] SHIPROCKET RETURN MISMATCH: requested=${cleanOrderId}, returned=${srOrderId} — blocking`);
                    } else {
                        await this._sendShiprocketOrderStatus(igUserId, srOrder);
                        await this._saveOrderToDB(srOrder);
                        // Fetch the saved order for window check
                        const savedOrders = await dbAdapter.query(
                            `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
                            [srOrder.channelOrderId || String(srOrder.orderId)]
                        );
                        order = savedOrders?.[0] || null;
                    }
                }
            } catch (e) {
                console.error('[IG BOT] Shiprocket lookup for return/exchange:', e.message);
            }
        }

        if (!order) {
            await instagramService.sendMessage(
                igUserId,
                `I couldn't find that order. Please check the Order ID and try again.`
            );
            return;
        }

        // Store verified order in context for pronoun resolution
        context = { ...(context || {}), verifiedOrderId: order.order_id };
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        // Show order details first
        await this._sendCompleteOrderStatus(igUserId, order);

        // Check if within 2-day return window
        const orderDate = new Date(order.created_at || order.order_date || Date.now());
        const daysSinceOrder = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);
        const flowLabel = flow === 'exchange' ? 'Exchange' : 'Return';

        if (daysSinceOrder > 2) {
            await instagramService.sendMessage(
                igUserId,
                `The ${flowLabel.toLowerCase()} window (2 days from delivery) has expired for this order.

If you have a special case, type "support" and our team will review it.`
            );
            return;
        }

        // Guide through the self-service process
        if (flow === 'exchange') {
            await instagramService.sendMessage(
                igUserId,
                `Here's how to exchange your item:

1. Visit offcomfrt.in/pages/exchange
2. Select your order and the new size you want
3. We'll pick up the old item from your doorstep
4. New size ships after quality check

The exchange is free within the 2-day window.

Need help with the exchange process? Type "support" and our team will assist you.`
            );
        } else {
            await instagramService.sendMessage(
                igUserId,
                `Here's how to return your item:

1. Visit offcomfrt.in/pages/return
2. Submit your return request
3. Our team reviews within 24-48 hours
4. Pickup at your doorstep
5. Store credit within 5-7 business days

Conditions: Items unused, tags attached, original packaging.

Need help with the return process? Type "support" and our team will assist you.`
            );
        }
    }

    // ─── Product Issues (delivery / damaged / wrong item) ───────

    /**
     * Product issue reported: apologize, collect Order ID first,
     * check order status, then attempt resolution before creating ticket.
     */
    async _handleProductIssue(igUserId, intent, context) {
        const issueLabel = {
            delivery_issue: 'delivery issue',
            damaged_product: 'damaged product',
            wrong_product: 'wrong item'
        }[intent] || 'issue';

        // If we already have a verified order, skip asking for Order ID
        if (context?.verifiedOrderId) {
            await this._handleProductIssueWithOrder(igUserId, context.verifiedOrderId, context);
            return;
        }

        await instagramService.sendMessage(
            igUserId,
            `We're really sorry about the ${issueLabel}.

Please share your Order ID so I can check your order details first.`
        );

        // Remember the issue type and set flow to product_issue
        context = { ...context, issueType: intent, flow: 'product_issue' };
        await instagramService.setBotState(igUserId, STATES.COLLECTING_ORDER_ID, context);
    }

    /**
     * Product issue with Order ID received: show order status,
     * then ask for issue description to attempt resolution.
     */
    async _handleProductIssueWithOrder(igUserId, orderId, context) {
        const cleanOrderId = (orderId || '').toString().trim();

        // Look up the order — EXACT match (never wildcard)
        let order = null;
        try {
            const orders = await dbAdapter.query(
                `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
                [cleanOrderId]
            );
            order = orders?.[0] || null;
        } catch (e) {
            console.error('[IG BOT] Product issue order lookup error:', e.message);
        }

        // AWB fallback (separate path)
        if (!order && /^[A-Z0-9]{8,15}$/i.test(cleanOrderId)) {
            try {
                const awbOrders = await dbAdapter.query(
                    `SELECT * FROM orders WHERE awb = ? LIMIT 1`,
                    [cleanOrderId]
                );
                order = awbOrders?.[0] || null;
            } catch (e) {
                console.error('[IG BOT] Product issue AWB lookup error:', e.message);
            }
        }

        // Identity safety assertion
        if (order && order.order_id !== cleanOrderId && order.awb !== cleanOrderId) {
            console.error(`[IG BOT] PRODUCT ISSUE ORDER ID MISMATCH: requested=${cleanOrderId}, returned=${order.order_id} — blocking`);
            order = null;
        }

        // If order not found locally, try Shiprocket
        if (!order) {
            try {
                const srOrder = await shiprocketService.getOrderStatus(cleanOrderId);
                if (srOrder) {
                    const srOrderId = srOrder.channelOrderId || String(srOrder.orderId);
                    if (srOrderId !== cleanOrderId) {
                        console.error(`[IG BOT] SHIPROCKET PRODUCT ISSUE MISMATCH: requested=${cleanOrderId}, returned=${srOrderId} — blocking`);
                    } else {
                        await this._sendShiprocketOrderStatus(igUserId, srOrder);
                        await this._saveOrderToDB(srOrder);
                    }
                }
            } catch (e) {
                console.error('[IG BOT] Shiprocket lookup for product issue:', e.message);
            }
        } else {
            // Show order status from local DB
            await this._sendCompleteOrderStatus(igUserId, order);
        }

        // Now ask for the issue description
        const issueLabel = {
            delivery_issue: 'delivery issue',
            damaged_product: 'damaged product',
            wrong_product: 'wrong item'
        }[context.issueType] || 'issue';

        await instagramService.sendMessage(
            igUserId,
            `Now please describe the ${issueLabel} in a few words so I can help resolve it.`
        );

        // Set state to await description, with product_issue_resolution flow
        // Store verified order in context for pronoun resolution
        context = { ...context, flow: 'product_issue_resolution', verifiedOrderId: cleanOrderId };
        await instagramService.setBotState(igUserId, STATES.AWAITING_SUPPORT_DESCRIPTION, context);
    }

    // ─── FAQ ────────────────────────────────────────────────────

    async _sendFAQ(igUserId, topic) {
        const answer = IG_FAQ[topic];
        if (answer) {
            await instagramService.sendMessage(igUserId, answer);
        } else {
            await instagramService.sendMessage(
                igUserId,
                'I don\'t have that information right now. Type "support" to talk to our team.'
            );
        }
    }

    // ─── Human Support / Escalation ─────────────────────────────

    async _handleHumanSupport(igUserId, message, result, context) {
        // Check if there's already an open ticket — append, don't duplicate
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            // Append the new message to the existing ticket
            try {
                await dbAdapter.query(
                    `UPDATE support_tickets
                     SET message = message || '\n\n---\n' || ?,
                         is_read = false,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [message || 'Customer requested support', existingTicket[0].id]
                );
            } catch (e) { /* best-effort append */ }

            await instagramService.sendMessage(
                igUserId,
                `I see you already have an open ticket: *${existingTicket[0].ticket_number}*\n\nOur team is reviewing it and will respond here shortly.\n\nI've added your latest message to the ticket.`
            );
            await instagramService.escalateToHuman(igUserId, existingTicket[0].id);
            // Store ticket context so the bot remembers
            context = {
                ...(context || {}),
                openTicketId: existingTicket[0].id,
                openTicketNumber: existingTicket[0].ticket_number,
                supportRequired: true,
                issueStatus: 'ticket_appended'
            };
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            return;
        }

        // No existing ticket — use context to understand the situation
        const verifiedOrderId = context?.verifiedOrderId;
        const lastProduct = context?.lastProduct;
        const issueSummary = context?.issueSummary;

        // If we have strong context (verified order + complaint/problem signal),
        // create a ticket immediately — don't make the user repeat themselves
        const hasOrderContext = verifiedOrderId || context?.relevantOrderId;
        const hasExplicitNeed = (result?.confidence >= 0.6) ||
            (result?.sentiment === 'frustrated' || result?.sentiment === 'angry');

        if (hasOrderContext && hasExplicitNeed) {
            // We know the order and the user clearly needs help — create ticket
            const description = message || 'Customer needs support';
            await this._createSupportTicket(igUserId, description, context);

            const ticketNum = context?.openTicketNumber || 'being created';
            const orderRef = verifiedOrderId || context?.relevantOrderId;
            await instagramService.sendMessage(
                igUserId,
                `I understand you need help${orderRef ? ` with order *${orderRef}*` : ''}.\n\nI've created a support ticket so our team can look into this personally. They'll respond here shortly.`
            );
            return;
        }

        // Check for recent orders to offer quick help
        let recentOrder = null;
        try {
            const customer = await dbAdapter.query(
                'SELECT phone FROM customers WHERE ig_psid = ? LIMIT 1',
                [igUserId]
            );
            if (customer?.[0]?.phone) {
                const orders = await dbAdapter.query(
                    `SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 1`,
                    [customer[0].phone]
                );
                recentOrder = orders?.[0] || null;
            }
        } catch (e) {
            console.error('[IG BOT] Recent order lookup for support:', e.message);
        }

        if (recentOrder) {
            // Show recent order and offer quick resolution
            const statusLabel = this._getStatusText(recentOrder.status);
            await instagramService.sendMessage(
                igUserId,
                `I'm here to help.\n\nI see your recent order: *${recentOrder.order_id}*\nStatus: ${statusLabel || recentOrder.status || 'Processing'}\n\nIs your issue related to this order? Tell me what's wrong and I'll try to resolve it right away. If you'd rather speak to our team, just say so.`
            );
        } else if (lastProduct?.name) {
            // We have product context — use it
            await instagramService.sendMessage(
                igUserId,
                `I'm here to help.\n\nI see you were looking at *${lastProduct.name}*. Is your issue related to this product?\n\nTell me what's going on and I'll do my best to sort it out.`
            );
        } else {
            // No context at all — ask warmly
            await instagramService.sendMessage(
                igUserId,
                `I'm here to help.\n\nCould you tell me a bit more about what you need? For example:\n• An order issue (tracking, return, refund)\n• A product question\n• Something else\n\nJust describe it in your own words and I'll take care of it.`
            );
        }

        await instagramService.setBotState(igUserId, STATES.AWAITING_SUPPORT_DESCRIPTION, {
            flow: 'human_support',
            verifiedOrderId: verifiedOrderId || null
        });
    }

    async _createSupportTicket(igUserId, description, context = {}) {
        // Guard: if user is already escalated, they already have an open ticket.
        // Don't create a duplicate — the escalation handler in processMessage
        // appends follow-ups to the existing ticket.
        if (context.isEscalated) {
            await instagramService.sendMessage(
                igUserId,
                'Your issue is already being reviewed by our team. We\'ll get back to you shortly.'
            );
            return;
        }

        await instagramService.setBotState(igUserId, STATES.IDLE);

        if (!description || description.length < 3) {
            await instagramService.sendMessage(
                igUserId,
                'Please describe your issue in a few words so our team can help you.'
            );
            return;
        }

        const ticketNumber = await this._generateTicketNumber();
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const customerName = customer?.[0]?.name || customer?.[0]?.ig_username || 'Instagram Customer';

        // Label the ticket with the issue type (product issues route here)
        const issuePrefix = context.issueType
            ? `[${String(context.issueType).replace(/_/g, ' ')}] `
            : '';

        // Smart escalation summary gives agents instant context
        const smartSummary = smartEngine.buildEscalationSummary(context);
        const fullMessage = smartSummary
            ? `${issuePrefix}${description}\n\n--- Conversation context ---\n${smartSummary}`
            : `${issuePrefix}${description}`;

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [
                ticketNumber,
                igUserId,
                customerName,
                fullMessage,
                igUserId,
                customer?.[0]?.ig_username || null
            ]
        );

        // Get ticket ID and escalate
        const ticketRows = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNumber]
        );
        if (ticketRows?.[0]?.id) {
            await instagramService.escalateToHuman(igUserId, ticketRows[0].id);
        }

        await instagramService.sendMessage(
            igUserId,
            `OFFCOMFRT — SUPPORT\n\nThank you, ${customerName}.\n\nYour ticket has been created.\n\nTicket Number: ${ticketNumber}\n\nOur team will respond within 24 hours.\n\nYou can continue messaging us here for updates.`
        );

        // Store ticket context so the bot remembers after ticket creation
        const issueSummary = this._buildIssueSummary(
            { intent: context.flow || 'support', sentiment: 'neutral' },
            context,
            description
        );
        context = {
            ...(context || {}),
            openTicketId: ticketRows?.[0]?.id || null,
            openTicketNumber: ticketNumber,
            supportRequired: true,
            issueStatus: 'ticket_created',
            issueSummary: issueSummary,
            relevantOrderId: context?.verifiedOrderId || null
        };
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        console.log(`[IG BOT] Created support ticket ${ticketNumber} for IG user ${igUserId}`);
    }

    // ─── Smart Escalation (anger / sensitive) ───────────────────

    /**
     * Complaint, anger or sensitive (legal) issue detected —
     * sentiment-aware escalation:
     *   - Angry/frustrated → immediate priority escalation
     *   - Neutral/mild → acknowledge, try to help directly, offer
     *     human support if still unresolved (resolution-first)
     *   - Sensitive (legal) → always escalate immediately
     */
    async _handleSmartEscalation(igUserId, result, context, message) {
        // Sensitive issues (legal threats) — always escalate immediately
        if (result.intent === 'sensitive_issue') {
            return await this._createEscalationTicket(igUserId, result, context, message, true);
        }

        // Angry or frustrated — immediate priority escalation
        if (result.sentiment === 'angry' || result.sentiment === 'frustrated') {
            return await this._createEscalationTicket(igUserId, result, context, message, false);
        }

        // ── Resolution-first for neutral/mild complaint ──
        // The customer is unhappy but not aggressive. Try to help
        // directly before creating a ticket.
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        // Check for existing open ticket first
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            await instagramService.sendMessage(
                igUserId,
                `I'm sorry to hear that. Your ticket ${existingTicket[0].ticket_number} is still open and our team is working on it.

They'll respond here shortly. Is there anything else I can help you with right now?`
            );
            return;
        }

        // Try FAQ resolution first
        const faqResolved = await this._tryFAQMatch(message, igUserId);
        if (faqResolved) {
            await instagramService.sendMessage(
                igUserId,
                `I understand your concern. Does this help? If you still need assistance, just type "support" and I'll connect you with our team.`
            );
            return;
        }

        // Can't resolve — create ticket but with normal priority
        await this._createEscalationTicket(igUserId, result, context, message, false);
    }

    /**
     * Create or append to an escalation ticket.
     * @param {boolean} isPriority - true for angry/sensitive, false for mild
     */
    async _createEscalationTicket(igUserId, result, context, message, isPriority) {
        // Duplicate prevention: reuse an open ticket if one exists
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            await instagramService.escalateToHuman(igUserId, existingTicket[0].id);
            await instagramService.sendMessage(
                igUserId,
                isPriority
                    ? `We hear you, and we're truly sorry.\n\nYour open ticket ${existingTicket[0].ticket_number} has been marked as priority — a senior team member will respond here shortly.`
                    : `I'm sorry we couldn't resolve this. Your ticket ${existingTicket[0].ticket_number} has been flagged for our team.\n\nThey'll respond here shortly.`
            );
            return;
        }

        const ticketNumber = await this._generateTicketNumber();
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const customerName = customer?.[0]?.name || customer?.[0]?.ig_username || 'Instagram Customer';

        const smartSummary = smartEngine.buildEscalationSummary(context);
        const ticketMessage = [
            `[${isPriority ? 'PRIORITY' : 'STANDARD'} — ${result.intent}${result.sentiment !== 'neutral' ? ` | sentiment: ${result.sentiment}` : ''}]`,
            `Customer: "${(message || '').substring(0, 500)}"`,
            '',
            smartSummary ? `--- Conversation context ---\n${smartSummary}` : null
        ].filter(Boolean).join('\n');

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [ticketNumber, igUserId, customerName, ticketMessage, igUserId, customer?.[0]?.ig_username || null]
        );

        const ticketRows = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNumber]
        );
        if (ticketRows?.[0]?.id) {
            await instagramService.escalateToHuman(igUserId, ticketRows[0].id);
        }

        await instagramService.sendMessage(
            igUserId,
            isPriority
                ? `We hear you, and we're truly sorry about this experience.\n\nI've flagged this as a priority — ticket ${ticketNumber}.\n\nA senior team member will respond right here shortly.`
                : `I'm sorry about this experience. I've created ticket ${ticketNumber} so our team can look into it.\n\nThey'll respond here shortly.`
        );

        // Store ticket context so the bot remembers the issue after escalation
        const issueSummary = this._buildIssueSummary(result, context, message);
        context = {
            ...(context || {}),
            openTicketId: ticketRows?.[0]?.id || null,
            openTicketNumber: ticketNumber,
            supportRequired: true,
            issueStatus: 'escalated',
            issueSummary: issueSummary,
            relevantOrderId: context?.verifiedOrderId || null
        };
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        console.log(`[IG BOT] Escalation ${ticketNumber} for ${igUserId} (${result.intent}, sentiment: ${result.sentiment}, priority: ${isPriority})`);
    }

    /**
     * Build a human-readable issue summary from the escalation context.
     * Used in ticket acknowledgment and stored in context for continuity.
     */
    _buildIssueSummary(result, context, message) {
        const parts = [];
        if (context?.verifiedOrderId) parts.push(`Order ${context.verifiedOrderId}`);
        if (result?.intent) parts.push(result.intent.replace(/_/g, ' '));
        if (result?.sentiment && result.sentiment !== 'neutral') parts.push(`${result.sentiment} customer`);
        if (message) parts.push(`"${message.substring(0, 80)}${message.length > 80 ? '...' : ''}"`);
        return parts.join(' · ') || 'General support issue';
    }

    // ─── Creator / Business Flow ────────────────────────────────

    /**
     * Start the creator/collaboration flow — a separate mini
     * state machine that collects profile + collab details.
     */
    async _startCreatorFlow(igUserId, intent, context) {
        // Creator/business collaborations → direct to email.
        // No support ticket created, no state change — user stays in IDLE
        // and can continue asking product questions normally.
        await instagramService.sendMessage(
            igUserId,
            `For collaborations and business enquiries, please reach out to us at:\n\nsupport@offcomfrt.in\n\nWe'd love to work with you!`
        );
    }

    /**
     * Complete the creator flow: capture details + create a
     * business-enquiry ticket, then hand off to the team.
     */
    async _completeCreatorFlow(igUserId, context, rawMessage, result = {}) {
        // Capture structured creator info from their message
        context = smartEngine.updateContext(context, {
            creatorInfo: result.entities?.creatorInfo || {}
        });
        if (rawMessage) {
            context.creatorInfo = {
                ...(context.creatorInfo || {}),
                rawNote: String(rawMessage).substring(0, 500)
            };
        }

        // Create a business-enquiry ticket with the collected details
        const ticketNumber = await this._generateTicketNumber();
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const customerName = customer?.[0]?.name || customer?.[0]?.ig_username || 'Instagram Customer';
        const ci = context.creatorInfo || {};

        const ticketMessage = [
            `[Creator/Business enquiry — ${ci.type || 'general'}]`,
            `Customer: ${customerName}`,
            ci.profile ? `Profile: ${ci.profile}` : null,
            ci.followerMention ? `Followers: ${ci.followerMention}` : null,
            ci.rawNote ? `Message: "${ci.rawNote}"` : null
        ].filter(Boolean).join('\n');

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [ticketNumber, igUserId, customerName, ticketMessage, igUserId, customer?.[0]?.ig_username || null]
        );

        const ticketRows = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNumber]
        );
        const ticketId = ticketRows?.[0]?.id || null;

        // Hand off to the team — wait for the customer across sessions
        context = smartEngine.updateContext(context, {
            state: STATES.WAITING_FOR_CUSTOMER,
            summaryEntry: `Creator enquiry ticket ${ticketNumber}`
        });
        context.ticketId = ticketId;
        context.waitingSince = new Date().toISOString();
        await instagramService.setBotState(igUserId, STATES.WAITING_FOR_CUSTOMER, context);

        await instagramService.sendMessage(
            igUserId,
            `Thank you! Your details are with our partnerships team.

Ticket: ${ticketNumber}

They'll review and reply right here within 24-48 hours.`
        );

        console.log(`[IG BOT] Creator enquiry ${ticketNumber} for ${igUserId} (${ci.type || 'general'})`);
    }

    _creatorTypeFor(intent) {
        return {
            creator_collaboration: 'paid_collab',
            ugc: 'ugc',
            gifting: 'barter',
            affiliate: 'affiliate',
            wholesale: 'wholesale',
            business_enquiry: 'business'
        }[intent] || 'general';
    }

    // ─── Conversation Intelligence Handlers ─────────────────────

    /**
     * Handle "already_raised" intent — customer is saying the action
     * (return/exchange/request) was already completed.
     * DO NOT restart the flow. Acknowledge and offer to check status.
     */
    async _handleAlreadyRaised(igUserId, message, context) {
        // Reset any collecting state
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        // Check if we have an Order ID in context to check status
        const orderId = context.verifiedOrderId || context.entities?.orderId || context.entities?.bareNumber;

        if (orderId) {
            // We have an Order ID — check the status
            await instagramService.sendMessage(
                igUserId,
                `Got it — your request has already been raised. Let me check the latest status for Order ${orderId}.`
            );
            await this._handleOrderTracking(igUserId, orderId, context);
            return;
        }

        // Check for open support ticket
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            await instagramService.sendMessage(
                igUserId,
                `I can see your request is already being reviewed under ticket ${existingTicket[0].ticket_number}.\n\nOur team will respond here within 24-48 hours. You don't need to raise it again.`
            );
            return;
        }

        // No Order ID and no ticket — acknowledge and ask for it to check status
        await instagramService.sendMessage(
            igUserId,
            `Got it — your request has already been raised. I can check the latest status for you.

Please share the Order ID and I'll look it up right away.`
        );
        // Don't set a collecting state — just wait for the Order ID
        // If they send it, it will be classified as provide_order_id
    }

    /**
     * Handle "support_problem" intent — customer is reporting a support
     * communication problem (no response, no contact, etc.).
     * DO NOT ignore this and re-ask for the same field.
     */
    async _handleSupportProblem(igUserId, message, context) {
        // Reset any collecting state
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        // Check if there's an existing open ticket — append, don't duplicate
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            // Append the new message to the existing ticket
            try {
                await dbAdapter.query(
                    `UPDATE support_tickets
                     SET message = message || '\n\n---\n' || ?,
                         is_read = false,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [message || 'Customer reporting support problem', existingTicket[0].id]
                );
            } catch (e) { /* best-effort */ }

            await instagramService.sendMessage(
                igUserId,
                `I understand your concern. Your ticket *${existingTicket[0].ticket_number}* is still open and our team is reviewing it.\n\nI've added your message to the ticket. They'll respond here shortly.`
            );
            // Update context with ticket info
            context = {
                ...(context || {}),
                openTicketId: existingTicket[0].id,
                openTicketNumber: existingTicket[0].ticket_number,
                supportRequired: true,
                issueStatus: 'ticket_appended'
            };
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            return;
        }

        // No existing ticket — the user is reporting a communication failure.
        // This IS a support issue that needs a ticket.
        const orderId = context?.verifiedOrderId || context?.entities?.orderId || context?.entities?.bareNumber;

        if (orderId) {
            // We have an Order ID — try to help directly with order status
            await instagramService.sendMessage(
                igUserId,
                `I'm sorry about the delay. Let me check your Order *${orderId}* status right now.`
            );
            await this._handleOrderTracking(igUserId, orderId, context);
            // Also create a ticket since they reported a support problem
            await this._createSupportTicket(igUserId, message || 'Support problem reported', context);
            return;
        }

        // No ticket, no Order ID — create a ticket for the support problem
        // The user explicitly reported a communication failure; don't just
        // ask them to "let me know" — actually create the ticket.
        await this._createSupportTicket(igUserId, message || 'Customer reported a support problem', context);
        await instagramService.sendMessage(
            igUserId,
            `I'm sorry about the experience. I've created a support ticket so our team can follow up with you directly.\n\nThey'll respond here shortly. If you have an Order ID related to this issue, sharing it will help us resolve things faster.`
        );
    }

    /**
     * Handle "product_discovery" intent — customer wants to browse products.
     * Show featured products from the Shopify catalog.
     */
    async _handleProductDiscovery(igUserId, message, context) {
        try {
            const catalog = await shopifyService.getProductCatalog();
            if (!catalog || catalog.length === 0) {
                await instagramService.sendMessage(
                    igUserId,
                    'Our catalog is being updated right now. Please check back in a few minutes, or visit offcomfrt.in to browse all products.'
                );
                return;
            }

            // Show first 4 products as a sample
            const featured = catalog.slice(0, 4);
            let msg = `Here are some of our products:\n\n`;
            featured.forEach((p, i) => {
                const price = p.variants?.[0]?.price;
                const priceStr = price ? ` — Rs.${price}` : '';
                msg += `${i + 1}. ${p.title}${priceStr}\n`;
            });
            msg += `\nWant to know more about any product? Just type the name!`;

            await instagramService.sendQuickReplies(
                igUserId,
                msg,
                featured.map(p => ({
                    title: p.title.length > 20 ? p.title.substring(0, 18) + '…' : p.title,
                    payload: `product_pick_${p.id}`
                }))
            );

            // Store as candidates so numeric selection works
            context.pendingProductCandidates = featured.map(p => ({ id: p.id, name: p.title }));
            await instagramService.setBotState(igUserId, STATES.IDLE, context);

        } catch (error) {
            console.error('[IG BOT] Product discovery error:', error.message);
            await instagramService.sendMessage(
                igUserId,
                'Please visit offcomfrt.in to browse our full collection. Or type a product name like "Henley" or "Polo" and I\'t tell you more about it.'
            );
        }
    }

    // ─── Unknown / Fallback ─────────────────────────────────────

    async _handleUnknown(igUserId, message, context = {}) {
        // Try to match against the existing FAQ database first
        const faqMatch = await this._tryFAQMatch(message, igUserId);
        if (faqMatch) return;

        // ── Catalog-aware fallback: bare product names ──
        // When the user types just a product name (e.g. "henley", "waffle"),
        // classify() returns unknown because there are no intent keywords.
        // Before showing generic quick replies, try matching against the
        // Shopify catalog. If a product is found, show full details.
        const extractedName = this._extractProductName(message, context);
        if (extractedName) {
            const searchResult = await this._searchProducts(extractedName);
            if (searchResult) {
                if (searchResult.type === 'match') {
                    const product = searchResult.product;
                    context.lastProduct = {
                        id: product.id,
                        name: product.title,
                        handle: product.handle || null
                    };
                    delete context.pendingProductCandidates;
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    await this._sendProductAnswer(igUserId, product,
                        { intent: 'product_question', entities: {} }, product.title);
                    console.log(`[IG BOT] _handleUnknown: resolved "${extractedName}" → ${product.title}`);
                    return;
                }
                if (searchResult.type === 'ambiguous') {
                    // Single source of truth: slice immediately so text, buttons,
                    // and stored candidates all use the SAME array.
                    const displayCandidates = searchResult.candidates.slice(0, MAX_PRODUCT_CHOICES);
                    const options = displayCandidates.map((p, i) => `${i + 1}. ${p.title}`).join('\n');
                    await instagramService.sendQuickReplies(
                        igUserId,
                        `I found multiple products matching "${extractedName}". Which one?\n\n${options}`,
                        displayCandidates.map((p, i) => ({
                            title: p.title.length > 20 ? p.title.substring(0, 18) + '…' : p.title,
                            payload: `product_pick_${p.id}`
                        }))
                    );
                    context.pendingProductCandidates = displayCandidates.map(p => ({ id: p.id, name: p.title }));
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    console.log(`[IG BOT] _handleUnknown: ambiguous "${extractedName}" → ${displayCandidates.length} choices shown`);
                    return;
                }
            }
        }

        // Targeted clarification from the smart engine
        // (never a bare "I don't understand")
        const clarification = smartEngine.getClarificationQuestion(context);

        await instagramService.sendQuickReplies(
            igUserId,
            clarification,
            [
                { title: 'Track Order', payload: 'track_order' },
                { title: 'Return', payload: 'return' },
                { title: 'Exchange', payload: 'exchange' },
                { title: 'Shipping', payload: 'shipping' },
                { title: 'Payment', payload: 'payment' },
                { title: 'Support', payload: 'support' }
            ]
        );
    }

    /**
     * Try to match the message against the Instagram-only FAQ list.
     * Uses hardcoded IG_FAQ_LIST first (no DB query) — safe even when
     * automation_config table is missing.
     *
     * Only falls back to faqHandler.matchFAQ() if IG list has no match,
     * and even then, the DB error is caught silently.
     */
    async _tryFAQMatch(message, igUserId) {
        try {
            // 1. Instagram-only hardcoded FAQ (no DB query)
            const igMatch = _matchIGFAQ(message);
            if (igMatch) {
                await instagramService.sendMessage(igUserId, igMatch.answer);
                return true;
            }

            // 2. Fallback to shared FAQ handler (may hit DB — caught if fails)
            const faqHandler = require('./faqHandler');
            const match = await faqHandler.matchFAQ(message);
            if (match) {
                // Convert WhatsApp-formatted answer to Instagram-friendly
                let igAnswer = match.answer || match.content || '';
                // Remove WhatsApp markdown asterisks
                igAnswer = igAnswer.replace(/\*/g, '');
                await instagramService.sendMessage(igUserId, igAnswer);
                return true;
            }
            return false;
        } catch (e) {
            // FAQ handler errors (including automation_config missing) are
            // caught silently — Instagram FAQ still works via IG_FAQ_LIST above.
            return false;
        }
    }

    // ─── Product Lookup (Shopify catalog) ───────────────────────

    /**
     * Handle product/size questions by searching the Shopify catalog.
     * Uses product context for follow-ups (e.g., "size?" after "price?").
     * Never invents product, price, stock, or URL — Shopify is the source of truth.
     */
    async _handleProductQuestion(igUserId, message, result, context) {
        // Extract product name from the message
        const productName = this._extractProductName(message, context);

        // If we have a product context from a previous message, use it for follow-ups
        if (!productName && context.lastProduct) {
            return await this._handleFollowUpQuestion(igUserId, message, result, context);
        }

        if (!productName) {
            // No product identified — check if there's an attachment context
            const hasAttachment = context.lastAttachment?.url;
            if (hasAttachment) {
                await instagramService.sendMessage(
                    igUserId,
                    `I can see the ${context.lastAttachment.type || 'image'} you shared. Could you tell me the product name so I can look it up?`
                );
            } else {
                await instagramService.sendMessage(
                    igUserId,
                    'Which product are you asking about? Please share the product name or a keyword.'
                );
            }
            return;
        }

        // Search Shopify catalog
        const searchResult = await this._searchProducts(productName);

        if (!searchResult) {
            // Product not found — ask for clarification
            await instagramService.sendMessage(
                igUserId,
                `I couldn't find a product matching "${productName}".\n\nCould you share the exact product name? You can also check our website for the full catalog.`
            );
            return;
        }

        // Handle ambiguous results — ask for clarification
        if (searchResult.type === 'ambiguous') {
            // Single source of truth: slice immediately so text, buttons,
            // and stored candidates all use the SAME array.
            const displayCandidates = searchResult.candidates.slice(0, MAX_PRODUCT_CHOICES);
            const options = displayCandidates.map((p, i) => `${i + 1}. ${p.title}`).join('\n');
            await instagramService.sendQuickReplies(
                igUserId,
                `I found multiple products matching "${productName}". Which one?\n\n${options}`,
                displayCandidates.map((p, i) => ({
                    title: p.title.length > 20 ? p.title.substring(0, 18) + '…' : p.title,
                    payload: `product_pick_${p.id}`
                }))
            );
            // Store candidates so the next message can pick one
            context.pendingProductCandidates = displayCandidates.map(p => ({ id: p.id, name: p.title }));
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            return;
        }

        // Single confident match
        const product = searchResult.product;

        // Store product context for follow-up questions
        context.lastProduct = {
            id: product.id,
            name: product.title,
            handle: product.handle || null
        };
        // Clear any pending candidates
        delete context.pendingProductCandidates;
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        // Format and send the product answer
        await this._sendProductAnswer(igUserId, product, result, message);
    }

    /**
     * Handle follow-up questions about a previously identified product.
     * E.g., "size?" or "available in M?" after "price of Henley".
     */
    async _handleFollowUpQuestion(igUserId, message, result, context) {
        const lastProduct = context.lastProduct;

        // Search for the product again using the stored name
        const searchResult = await this._searchProducts(lastProduct.name);
        if (!searchResult || searchResult.type !== 'match') {
            await instagramService.sendMessage(
                igUserId,
                `I lost track of that product — could you tell me the name again?`
            );
            return;
        }

        const product = searchResult.product;
        // Refresh product context (handle may have been updated)
        context.lastProduct = {
            id: product.id,
            name: product.title,
            handle: product.handle || lastProduct.handle || null
        };
        await instagramService.setBotState(igUserId, STATES.IDLE, context);

        await this._sendProductAnswer(igUserId, product, result, message);
    }

    /**
     * Shared product-selection resolver.
     * Used by BOTH product_pick_<id> button payloads AND numeric selections (1/2/3).
     *
     * Verifies:
     *   1. The product exists in the Shopify catalog.
     *   2. If pendingProductCandidates exists, the product ID matches a stored candidate.
     *   3. Only then sets lastProduct and sends the product answer.
     *
     * Returns true if the selection was resolved (or handled with an error message).
     * Returns false if the caller should fall through to normal routing.
     */
    async _resolveProductSelection(igUserId, productId, context, source) {
        const catalog = await shopifyService.getProductCatalog();
        const product = catalog?.find(p => String(p.id) === String(productId));

        if (!product) {
            // Product not in catalog — don't guess
            console.log(`[IG BOT] product selection (${source}): product ${productId} not in catalog`);
            if (source === 'by_numeric') {
                // Numeric selection pointed to a stale candidate
                delete context.pendingProductCandidates;
                await instagramService.setBotState(igUserId, STATES.IDLE, context);
                await instagramService.sendMessage(igUserId,
                    'Sorry, that selection is no longer available. Please type the product name to search again.');
                return true;
            }
            return false; // product_pick_ with unknown ID — fall through
        }

        // Identity safety guard: if pending candidates exist, verify the
        // selected product is one of the displayed choices.
        if (context.pendingProductCandidates?.length > 0) {
            const isExpectedCandidate = context.pendingProductCandidates.some(
                c => String(c.id) === String(productId)
            );
            if (!isExpectedCandidate) {
                console.log(`[IG BOT] product selection (${source}): product ${productId} NOT in pending candidates — identity mismatch`);
                delete context.pendingProductCandidates;
                await instagramService.setBotState(igUserId, STATES.IDLE, context);
                await instagramService.sendMessage(igUserId,
                    'Sorry, I couldn\'t confirm that selection. Please type the product name to search again.');
                return true;
            }
        }

        // All checks passed — resolve the product
        context.lastProduct = {
            id: product.id,
            name: product.title,
            handle: product.handle || null
        };
        delete context.pendingProductCandidates;
        await instagramService.setBotState(igUserId, STATES.IDLE, context);
        await this._sendProductAnswer(igUserId, product,
            { intent: 'product_question', entities: {} }, product.title);
        console.log(`[IG BOT] product selection (${source}): resolved → ${product.title}`);
        return true;
    }

    /**
     * Format and send a product answer from Shopify catalog data.
     * Only shows verified information — never invents data.
     */
    async _sendProductAnswer(igUserId, product, result, message) {
        const text = (message || '').toLowerCase();
        const entities = result?.entities || {};

        let msg = `${product.title}`;

        // Price — always from Shopify, never invented
        const variants = product.variants || [];
        if (variants.length > 0) {
            const prices = variants.map(v => v.price).filter(p => p > 0);
            if (prices.length > 0) {
                const minPrice = Math.min(...prices);
                const maxPrice = Math.max(...prices);

                // Compare-at / MRP — show sale price when available
                const compareAtPrices = variants
                    .map(v => v.compare_at_price)
                    .filter(p => p !== null && p > 0);
                const maxCompareAt = compareAtPrices.length > 0 ? Math.max(...compareAtPrices) : null;

                if (maxCompareAt && maxCompareAt > minPrice) {
                    // On sale — show both MRP and sale price
                    if (minPrice === maxPrice) {
                        msg += `\nPrice: Rs.${minPrice} (MRP: Rs.${maxCompareAt})`;
                    } else {
                        msg += `\nPrice: Rs.${minPrice} – Rs.${maxPrice} (MRP up to Rs.${maxCompareAt})`;
                    }
                } else if (minPrice === maxPrice) {
                    msg += `\nPrice: Rs.${minPrice}`;
                } else {
                    msg += `\nPrice: Rs.${minPrice} – Rs.${maxPrice}`;
                }
            }
        }

        // Size — show for size questions OR general product enquiries
        if (result?.intent === 'size_question' || result?.intent === 'product_question' || entities.size || /size|which size|available in/.test(text)) {
            const sizes = variants
                .map(v => v.title)
                .filter(t => t && t.length > 0 && t !== 'Default Title');
            if (sizes.length > 0) {
                msg += `\nAvailable sizes: ${sizes.join(', ')}`;
            }
        }

        // Colour/variants — show for colour questions OR general product enquiries
        if (result?.intent === 'product_question' || /colour|color/.test(text)) {
            const colours = variants
                .map(v => v.title)
                .filter(t => t && t.length > 0 && t !== 'Default Title');
            if (colours.length > 0) {
                const unique = [...new Set(colours)];
                msg += `\nAvailable options: ${unique.join(', ')}`;
            }
        }

        // Availability / stock
        const totalStock = variants.reduce((sum, v) => sum + (v.inventory || 0), 0);
        if (totalStock > 0) {
            msg += `\nIn stock`;
        } else {
            msg += `\nCurrently out of stock`;
        }

        // Product link — only if we have a verified handle
        if (product.handle) {
            msg += `\n\nView: offcomfrt.in/products/${product.handle}`;
        }

        // Product image — send as actual media message, not a raw URL
        if (product.image) {
            try {
                await instagramService.sendImage(igUserId, product.image);
            } catch (imgErr) {
                console.log(`[IG BOT] Failed to send product image: ${imgErr.message}`);
                // Fallback: include image URL as text if media send fails
                msg += `\n\nImage: ${product.image}`;
            }
        }

        await instagramService.sendQuickReplies(
            igUserId,
            msg,
            [
                { title: 'Size?', payload: 'size_question' },
                { title: 'Available?', payload: 'product_question' },
                { title: 'Send link', payload: 'product_question' }
            ]
        );
    }

    /**
     * Extract a product name from the customer message.
     * Strips question words and price-related keywords to isolate
     * the product reference.
     *
     * IMPORTANT: Generic words (hello, faq, help, return, exchange, etc.)
     * must NEVER become product entities. They are filtered by the blocklist.
     */
    _extractProductName(message, context) {
        if (!message) return null;

        // ── Blocklist: words that must NEVER be treated as product names ──
        // These are greetings, meta-words, intent keywords, and generic terms
        // that should never trigger a Shopify catalog search.
        const PRODUCT_BLOCKLIST = new Set([
            // Greetings
            'hello', 'hi', 'hey', 'hellooo', 'heyy', 'hii', 'hiii', 'yo', 'sup',
            // FAQ / meta
            'faq', 'help', 'support', 'menu', 'options', 'start', 'begin',
            // Intent words (never products)
            'return', 'exchange', 'refund', 'tracking', 'track', 'cancel', 'cancellation',
            'shipping', 'delivery', 'payment', 'location', 'address', 'contact',
            'order', 'orders', 'status', 'issue', 'problem', 'complaint',
            // Generic conversational
            'thanks', 'thank', 'ok', 'okay', 'sure', 'yes', 'no', 'nope', 'yep', 'yeah',
            'please', 'sorry', 'cool', 'great', 'nice', 'good', 'bad', 'worst', 'best',
            // Question words that might survive stripping
            'who', 'when', 'where', 'why', 'which', 'what', 'how'
        ]);

        // Strip common question patterns to get the product name
        let cleaned = message
            .replace(/\b(how much|what is|what's|price of|cost of|rate of|tell me about|about|send|share|give)\b/gi, '')
            .replace(/\?(.*)/g, '')
            .replace(/\b(this|that|it|the|a|an|is|are|do|does|can|you|your|me|my|in|of|on|at|to|for|with|which|what|how)\b/gi, '')
            .trim();

        // Strip intent-only keywords — these signal WHAT the user wants to know,
        // not WHICH product. Without this, "price" → searches Shopify for "price".
        cleaned = cleaned
            .replace(/\b(price|cost|rate|mrp|charges|link|stock|available|availability|colour|color|colours|colors|size|sizes|details|info|information|enquiry|question|product|products)\b/gi, '')
            .replace(/[?,.!]/g, '')
            .trim();

        // Strip remaining conversational verbs — common action words that are
        // NOT product names. "check", "tell", "show" etc. are request verbs,
        // not product identifiers. Without this, "Can you check the price?"
        // leaves "check" which the bot then searches Shopify for.
        cleaned = cleaned
            .replace(/\b(check|tell|show|give|find|know|want|need|look|see|get|help|please|kindly|something|any|anyone)\b/gi, '')
            .trim();

        // ── Blocklist check: if the cleaned text is a single blocked word, return null ──
        const cleanedLower = cleaned.toLowerCase().trim();
        if (PRODUCT_BLOCKLIST.has(cleanedLower)) {
            // Fall back to context if available
            if (context?.lastProduct) {
                return context.lastProduct.name;
            }
            return null;
        }

        // Also check if the cleaned text is a single word that matches a blocklist entry
        // (handles cases like "Hello" → "hello" after cleaning)
        const words = cleanedLower.split(/\s+/).filter(w => w.length > 0);
        if (words.length === 1 && PRODUCT_BLOCKLIST.has(words[0])) {
            if (context?.lastProduct) {
                return context.lastProduct.name;
            }
            return null;
        }

        // If nothing meaningful left after stripping, try context
        if (cleaned.length < 2 && context?.lastProduct) {
            return context.lastProduct.name;
        }

        return cleaned.length >= 2 ? cleaned : null;
    }

    /**
     * Search the Shopify product catalog for a product matching the query.
     * Uses the cached catalog (10-min TTL) — no extra API calls per message.
     *
     * Returns:
     *   { type: 'match', product }       — single confident match
     *   { type: 'ambiguous', candidates } — multiple plausible matches (≤4)
     *   null                              — no match at all
     *
     * Match priority: exact title → title contains → word overlap → fuzzy (Levenshtein).
     */
    async _searchProducts(query) {
        try {
            const catalog = await shopifyService.getProductCatalog();
            if (!catalog || catalog.length === 0) return null;

            const q = query.toLowerCase().trim();
            if (!q) return null;

            // 1. Exact title match (highest priority)
            const exact = catalog.find(p =>
                p.title.toLowerCase() === q
            );
            if (exact) return { type: 'match', product: exact };

            // 2. Title contains the query
            const contains = catalog.filter(p =>
                p.title.toLowerCase().includes(q)
            );
            if (contains.length === 1) return { type: 'match', product: contains[0] };
            if (contains.length > 1) {
                // Multiple "contains" matches — check if one is clearly dominant
                // (e.g., "Henley" matches "Henley Tee" and "Acid Wash Henley" equally)
                const scored = contains.map(p => {
                    const title = p.title.toLowerCase();
                    let score = 0;
                    if (title === q) score += 100;
                    else if (title.startsWith(q)) score += 50;
                    else score += 10;
                    return { product: p, score };
                }).sort((a, b) => b.score - a.score);

                if (scored[0].score > scored[1].score * 1.5) {
                    return { type: 'match', product: scored[0].product };
                }
                return { type: 'ambiguous', candidates: scored.slice(0, 4).map(s => s.product) };
            }

            // 3. Any word in the query matches words in the title
            const queryWords = q.split(/\s+/).filter(w => w.length >= 3);
            if (queryWords.length > 0) {
                const scored = [];
                for (const product of catalog) {
                    const titleWords = product.title.toLowerCase().split(/\s+/);
                    let score = 0;
                    for (const qw of queryWords) {
                        for (const tw of titleWords) {
                            if (tw === qw) score += 3;       // exact word match
                            else if (tw.includes(qw)) score += 2; // contains
                            else if (qw.length >= 4 && this._levenshtein(qw, tw) <= 2) score += 1.5; // fuzzy
                        }
                    }
                    if (score > 0) scored.push({ product, score });
                }
                scored.sort((a, b) => b.score - a.score);

                if (scored.length > 0 && scored[0].score >= 3) {
                    // Check for ambiguity: if top 2+ products have similar scores
                    const topScore = scored[0].score;
                    const close = scored.filter(s => s.score >= topScore * 0.7);
                    if (close.length > 1 && close[0].score < close[1].score * 1.3) {
                        return { type: 'ambiguous', candidates: close.slice(0, 4).map(s => s.product) };
                    }
                    return { type: 'match', product: scored[0].product };
                }

                // 4. Fuzzy fallback — Levenshtein on full title vs query
                if (q.length >= 3) {
                    let bestFuzzy = null;
                    let bestDist = Infinity;
                    for (const product of catalog) {
                        const title = product.title.toLowerCase();
                        // Compare query against each word in the title
                        const titleWords = title.split(/\s+/);
                        for (const tw of titleWords) {
                            if (tw.length < 3) continue;
                            const dist = this._levenshtein(q, tw);
                            if (dist < bestDist && dist <= 2) {
                                bestDist = dist;
                                bestFuzzy = product;
                            }
                        }
                    }
                    if (bestFuzzy) return { type: 'match', product: bestFuzzy };
                }
            }

            return null;
        } catch (error) {
            console.error('[IG BOT] Product search error:', error.message);
            return null;
        }
    }

    /**
     * Levenshtein distance between two strings.
     * Used for fuzzy product name matching (typos like "henely" → "henley").
     */
    _levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const d = Array.from({ length: m + 1 }, (_, i) => {
            const row = new Array(n + 1);
            row[0] = i;
            return row;
        });
        for (let j = 0; j <= n; j++) d[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                d[i][j] = Math.min(
                    d[i - 1][j] + 1,
                    d[i][j - 1] + 1,
                    d[i - 1][j - 1] + cost
                );
            }
        }
        return d[m][n];
    }

    // ─── Helpers ────────────────────────────────────────────────

    async _generateTicketNumber() {
        const now = new Date();
        const yy = String(now.getFullYear()).slice(-2);
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const prefix = `IG-${yy}${mm}${dd}`;
        const MAX_ATTEMPTS = 10;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const random = Math.floor(Math.random() * 9000 + 1000);
            const candidate = `${prefix}-${random}`;

            const existing = await dbAdapter.query(
                'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
                [candidate]
            );
            if (!existing || existing.length === 0) return candidate;
        }

        // Fallback: append millisecond timestamp to guarantee uniqueness
        return `${prefix}-${Date.now() % 100000}`;
    }

    _getStatusText(status) {
        const statusMap = {
            'pending': 'Pending',
            'confirmed': 'Confirmed',
            'shipped': 'Shipped',
            'in_transit': 'In Transit',
            'delivered': 'Delivered',
            'cancelled': 'Cancelled',
            'returned': 'Returned'
        };
        return statusMap[status?.toLowerCase()] || '';
    }

    /**
     * Get guidance message for product issues based on issue type.
     * Returns null if no guidance available (should create ticket).
     */
    _getProductIssueGuidance(issueType) {
        const guidance = {
            delivery_issue: `For delivery issues:

• If your order shows "in transit" — it's still on the way. Please allow 1-2 more business days.
• If delivery is delayed beyond the estimated date — we can investigate.

Would you like us to check your shipment status?`,

            damaged_product: `For damaged products:

• Please keep the product and packaging as-is (photos help).
• Visit our returns page on offcomfrt.in to initiate a replacement.
• We'll arrange a pickup and send a replacement after quality check.

Need help with the return process?`,

            wrong_product: `For wrong items:

• We'll arrange a free pickup of the wrong item.
• Visit our exchange page on offcomfrt.in to request the correct size/product.
• The correct item will be shipped after we receive the returned item.

Need help with the exchange process?`
        };
        return guidance[issueType] || null;
    }
}

module.exports = new IGBotEngine();
