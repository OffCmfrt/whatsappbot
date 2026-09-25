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

Send your Order ID and type "cancel" to proceed.`
};

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
                return await this._handleGreeting(igUserId);
            }

            // ── 1. Classify via smart engine (context-aware) ──────
            const result = smartEngine.classify(cleanMessage, context);

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

            // ── 2c. Product selection from quick-reply (product_pick_<id>) ──
            // Intercept structured product-selection events BEFORE classification.
            // These are generated by the product clarification picker and must
            // NOT be processed as ordinary natural-language text.
            if (cleanMessage.startsWith('product_pick_') && !options.isAttachment) {
                const productId = cleanMessage.replace('product_pick_', '');
                const catalog = await shopifyService.getProductCatalog();
                const product = catalog?.find(p => String(p.id) === String(productId));
                if (product) {
                    context.lastProduct = {
                        id: product.id,
                        name: product.title,
                        handle: product.handle || null
                    };
                    delete context.pendingProductCandidates;
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    await this._sendProductAnswer(igUserId, product,
                        { intent: 'product_question', entities: {} }, product.title);
                    return;
                }
                // Product not found in catalog — fall through to normal routing
                console.log(`[IG BOT] product_pick: product ${productId} not in catalog`);
            }

            // ── 2d. Quick-reply payload interception ─────────────────
            // Known quick-reply payloads from product answer buttons that
            // classify() cannot route on its own (stock_check, product_link).
            if (options.isQuickReply && context.lastProduct) {
                const knownPayloads = ['stock_check', 'product_link'];
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

            // ── 4. Stateful flows (collecting order ID, creator info, etc.) ──
            const stateHandled = await this._handleStateful(igUserId, cleanMessage, currentState, context, result);
            if (stateHandled) return;

            // ── 5. Intent routing ─────────────────────────────────
            await this._routeIntent(igUserId, cleanMessage, result, context);

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
        const isClearNewRequest =
            result.isIntentSwitch ||
            (result.confidence >= CONFIDENCE.HIGH &&
             result.intent !== 'greeting' &&
             result.intent !== 'positive_message');

        if (isClearNewRequest) {
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            return false; // resume normal routing
        }

        // Follow-up while waiting — log to the linked ticket if any
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

        await instagramService.sendMessage(
            igUserId,
            'Got it — our team has this conversation and will update you right here shortly.'
        );
        return true; // handled — stay waiting
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
                    if (result.isIntentSwitch) await this._acknowledgeSwitch(igUserId);
                    await this._routeIntent(igUserId, message, result, context);
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
                    if (result.isIntentSwitch) await this._acknowledgeSwitch(igUserId);
                    await this._routeIntent(igUserId, message, result, context);
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
                    if (result.isIntentSwitch) await this._acknowledgeSwitch(igUserId);
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
                if (productSignals.test(cleanMessage)) {
                    // Re-classify WITHOUT the creator state forcing provide_creator_info
                    const freshContext = { ...context, state: STATES.IDLE };
                    const freshResult = smartEngine.classify(cleanMessage, freshContext);
                    if (this._isNewIntent(freshResult) && freshResult.intent !== 'provide_creator_info') {
                        if (freshResult.isIntentSwitch) await this._acknowledgeSwitch(igUserId);
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
     */
    async _acknowledgeSwitch(igUserId) {
        await instagramService.sendMessage(igUserId, "No problem — let's take care of that instead.");
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

    // ─── Intent Routing ─────────────────────────────────────────

    async _routeIntent(igUserId, message, result, context) {
        const { intent } = result;

        switch (intent) {
            case 'greeting':
                return await this._handleGreeting(igUserId);

            case 'order_tracking':
                // If they already included an order ID, track right away
                if (result.entities.orderId || result.entities.awb) {
                    return await this._handleOrderTracking(
                        igUserId,
                        result.entities.orderId || result.entities.awb
                    );
                }
                return await this._askForOrderId(igUserId, 'tracking');

            case 'provide_order_id':
                return await this._handleOrderTracking(
                    igUserId,
                    result.entities.orderId || result.entities.awb || result.entities.bareNumber || message
                );

            case 'return':
                return await this._handleReturn(igUserId);

            case 'exchange':
                return await this._handleExchange(igUserId);

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

            case 'delivery_issue':
            case 'damaged_product':
            case 'wrong_product':
                return await this._handleProductIssue(igUserId, intent, context);

            case 'human_support':
                return await this._handleHumanSupport(igUserId);

            case 'complaint':
            case 'sensitive_issue':
                return await this._handleSmartEscalation(igUserId, result, context, message);

            case 'faq':
                return await this._handleUnknown(igUserId, message, context);

            default:
                if (CREATOR_INTENTS.includes(intent)) {
                    return await this._startCreatorFlow(igUserId, intent, context);
                }
                if (intent === 'spam') return; // silently ignore spam
                if (intent === 'positive_message') {
                    return await instagramService.sendMessage(
                        igUserId,
                        "Thank you so much! It means a lot. If you ever need anything, we're right here."
                    );
                }
                return await this._handleUnknown(igUserId, message, context);
        }
    }

    // ─── Greeting Handler ───────────────────────────────────────

    async _handleGreeting(igUserId) {
        // Fetch customer profile for personalization
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const name = customer?.[0]?.name || customer?.[0]?.ig_username || '';
        const greeting = name ? `Hi ${name}!` : 'Hi there!';

        await instagramService.sendQuickReplies(
            igUserId,
            `${greeting} Welcome to OffComfrt!

I can help you with:

• Track your order
• Returns & Exchanges
• FAQs
• Contact support

What would you like help with?`,
            [
                { title: 'Track Order', payload: 'track_order' },
                { title: 'Return', payload: 'return' },
                { title: 'Exchange', payload: 'exchange' },
                { title: 'Support', payload: 'support' }
            ]
        );

        await instagramService.setBotState(igUserId, STATES.IDLE);
    }

    // ─── Order Tracking ─────────────────────────────────────────

    async _askForOrderId(igUserId, flow) {
        await instagramService.sendMessage(
            igUserId,
            `Track Your Order

Please send your Order ID (e.g., ORD-2024-001) or AWB number.

You can also find it in your order confirmation email.`
        );
        await instagramService.setBotState(igUserId, STATES.COLLECTING_ORDER_ID);
    }

    async _handleOrderTracking(igUserId, orderId) {
        // Reset state
        await instagramService.setBotState(igUserId, STATES.IDLE);

        const cleanOrderId = (orderId || '').toString().trim();
        if (!cleanOrderId) {
            await this._askForOrderId(igUserId, 'tracking');
            return;
        }

        // ── 1. Try local DB first ──────────────────────────────────
        let order = null;
        try {
            const orders = await dbAdapter.query(
                `SELECT * FROM orders
                 WHERE order_id ILIKE ? OR awb ILIKE ?
                 ORDER BY created_at DESC LIMIT 1`,
                [`%${cleanOrderId}%`, `%${cleanOrderId}%`]
            );
            order = orders?.[0] || null;
        } catch (e) {
            console.error('[IG BOT] Local order lookup error:', e.message);
        }

        // ── 2. If local DB found it, show complete status ──────────
        if (order) {
            await this._sendCompleteOrderStatus(igUserId, order);
            return;
        }

        // ── 3. Local DB miss → try Shiprocket API (same as WhatsApp) ──
        try {
            const srOrder = await shiprocketService.getOrderStatus(cleanOrderId);
            if (srOrder) {
                await this._sendShiprocketOrderStatus(igUserId, srOrder);
                // Also save to local DB for future fast lookups
                await this._saveOrderToDB(srOrder);
                return;
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

    async _handleReturn(igUserId) {
        await instagramService.sendMessage(
            igUserId,
            IG_FAQ.return + '\n\nTo start a return, please send your Order ID.'
        );
        await instagramService.setBotState(igUserId, STATES.AWAITING_RETURN_ORDER_ID, { flow: 'return' });
    }

    async _handleExchange(igUserId) {
        await instagramService.sendMessage(
            igUserId,
            IG_FAQ.exchange + '\n\nTo start an exchange, please send your Order ID.'
        );
        await instagramService.setBotState(igUserId, STATES.AWAITING_RETURN_ORDER_ID, { flow: 'exchange' });
    }

    async _handleReturnExchange(igUserId, orderId, context) {
        const flow = context?.flow || 'return';
        await instagramService.setBotState(igUserId, STATES.IDLE);

        const cleanOrderId = (orderId || '').toString().trim();

        // Look up the order (local DB first)
        let order = null;
        try {
            const orders = await dbAdapter.query(
                `SELECT * FROM orders WHERE order_id ILIKE ? OR awb ILIKE ? ORDER BY created_at DESC LIMIT 1`,
                [`%${cleanOrderId}%`, `%${cleanOrderId}%`]
            );
            order = orders?.[0] || null;
        } catch (e) {
            console.error('[IG BOT] Return/exchange order lookup error:', e.message);
        }

        // If not found locally, try Shiprocket
        if (!order) {
            try {
                const srOrder = await shiprocketService.getOrderStatus(cleanOrderId);
                if (srOrder) {
                    await this._sendShiprocketOrderStatus(igUserId, srOrder);
                    await this._saveOrderToDB(srOrder);
                    // Fetch the saved order for window check
                    const savedOrders = await dbAdapter.query(
                        `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
                        [srOrder.channelOrderId || String(srOrder.orderId)]
                    );
                    order = savedOrders?.[0] || null;
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

        // Look up the order
        let order = null;
        try {
            const orders = await dbAdapter.query(
                `SELECT * FROM orders WHERE order_id ILIKE ? OR awb ILIKE ? ORDER BY created_at DESC LIMIT 1`,
                [`%${cleanOrderId}%`, `%${cleanOrderId}%`]
            );
            order = orders?.[0] || null;
        } catch (e) {
            console.error('[IG BOT] Product issue order lookup error:', e.message);
        }

        // If order not found locally, try Shiprocket
        if (!order) {
            try {
                const srOrder = await shiprocketService.getOrderStatus(cleanOrderId);
                if (srOrder) {
                    await this._sendShiprocketOrderStatus(igUserId, srOrder);
                    await this._saveOrderToDB(srOrder);
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
        context = { ...context, flow: 'product_issue_resolution' };
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

    async _handleHumanSupport(igUserId) {
        // Check if there's already an open ticket
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            await instagramService.sendMessage(
                igUserId,
                `You already have an open ticket: ${existingTicket[0].ticket_number}

Our team is reviewing it and will respond here shortly.

If you have additional information, just send it as a message.`
            );
            await instagramService.escalateToHuman(igUserId, existingTicket[0].id);
            await instagramService.setBotState(igUserId, STATES.IDLE);
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
                `I can help you with that.

I see your recent order: ${recentOrder.order_id}
Status: ${statusLabel || recentOrder.status || 'Processing'}

Is your issue related to this order? If so, just tell me what's wrong and I'll try to help.

If it's about something else, please describe your issue and I'll connect you with our team.`
            );
        } else {
            // No recent order — ask for description
            await instagramService.sendMessage(
                igUserId,
                `I'm here to help.

Please describe your issue and I'll do my best to resolve it. If I can't, I'll connect you with our team.`
            );
        }

        await instagramService.setBotState(igUserId, STATES.AWAITING_SUPPORT_DESCRIPTION, { flow: 'human_support' });
    }

    async _createSupportTicket(igUserId, description, context = {}) {
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
            `OFFCOMFRT — SUPPORT

Thank you, ${customerName}.

Your ticket has been created.

Ticket Number: ${ticketNumber}

Our team will respond within 24 hours.

You can continue messaging us here for updates.`
        );

        console.log(`[IG BOT] Created support ticket ${ticketNumber} for IG user ${igUserId}`);
    }

    // ─── Smart Escalation (anger / sensitive) ───────────────────

    /**
     * Complaint, anger or sensitive (legal) issue detected —
     * escalate immediately with the full conversation summary.
     */
    async _handleSmartEscalation(igUserId, result, context, message) {
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
                `We hear you, and we're truly sorry.

Your open ticket ${existingTicket[0].ticket_number} has been marked as priority — a senior team member will respond here shortly.`
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
            `[PRIORITY — ${result.intent}${result.sentiment !== 'neutral' ? ` | sentiment: ${result.sentiment}` : ''}]`,
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
            `We hear you, and we're truly sorry about this experience.

I've flagged this as a priority — ticket ${ticketNumber}.

A senior team member will respond right here shortly.`
        );

        console.log(`[IG BOT] Smart escalation ${ticketNumber} for ${igUserId} (${result.intent}, sentiment: ${result.sentiment})`);
    }

    // ─── Creator / Business Flow ────────────────────────────────

    /**
     * Start the creator/collaboration flow — a separate mini
     * state machine that collects profile + collab details.
     */
    async _startCreatorFlow(igUserId, intent, context) {
        context = smartEngine.updateContext(context, {
            creatorInfo: { type: this._creatorTypeFor(intent) }
        });

        await instagramService.sendQuickReplies(
            igUserId,
            `Awesome — we'd love to work with you!

To get you to the right person, tell us a bit about yourself:
• Your Instagram handle
• Follower count
• The kind of collab you have in mind (paid collab / barter / UGC / affiliate)`,
            [
                { title: 'Paid Collab', payload: 'creator_paid' },
                { title: 'Barter / Gifting', payload: 'creator_barter' },
                { title: 'UGC', payload: 'creator_ugc' },
                { title: 'Affiliate', payload: 'creator_affiliate' }
            ]
        );

        await instagramService.setBotState(igUserId, STATES.COLLECTING_CREATOR_PROFILE, context);
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

    // ─── Unknown / Fallback ─────────────────────────────────────

    async _handleUnknown(igUserId, message, context = {}) {
        // Try to match against the existing FAQ database first
        const faqMatch = await this._tryFAQMatch(message, igUserId);
        if (faqMatch) return;

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
     * Try to match the message against the existing FAQ handler.
     * Reuses the same FAQ knowledge base as WhatsApp (read-only).
     */
    async _tryFAQMatch(message, igUserId) {
        try {
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
            const candidates = searchResult.candidates;
            const options = candidates.map((p, i) => `${i + 1}. ${p.title}`).join('\n');
            await instagramService.sendQuickReplies(
                igUserId,
                `I found multiple products matching "${productName}". Which one?\n\n${options}`,
                candidates.slice(0, 3).map((p, i) => ({
                    title: p.title.length > 20 ? p.title.substring(0, 18) + '…' : p.title,
                    payload: `product_pick_${p.id}`
                }))
            );
            // Store candidates so the next message can pick one
            context.pendingProductCandidates = candidates.map(p => ({ id: p.id, name: p.title }));
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

        // Size question — show available sizes from variants
        if (result?.intent === 'size_question' || entities.size || /size|which size|available in/.test(text)) {
            const sizes = variants
                .map(v => v.title)
                .filter(t => t && t.length > 0 && t !== 'Default Title');
            if (sizes.length > 0) {
                msg += `\nAvailable sizes: ${sizes.join(', ')}`;
            }
        }

        // Colour — extract from variant titles if present
        if (/colour|color/.test(text)) {
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

        // Product image
        if (product.image) {
            msg += `\n\nImage: ${product.image}`;
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
     */
    _extractProductName(message, context) {
        if (!message) return null;

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
