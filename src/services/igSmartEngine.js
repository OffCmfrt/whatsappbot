/**
 * igSmartEngine.js
 * ─────────────────────────────────────────────────────────────
 * Smart Instagram conversation engine — deterministic NLU layer.
 *
 * Responsibilities:
 *   - Classify customer messages into intents with confidence scores
 *   - Extract entities (order ID, AWB, size, product mentions)
 *   - Manage conversation context across messages (memory)
 *   - Detect intent switching mid-conversation
 *   - Detect anger/frustration/sensitivity for smart escalation
 *
 * DESIGN:
 *   - 100% deterministic keyword/pattern scoring — no external AI
 *   - Confidence derived from weighted keyword matches
 *   - Context is a plain JSON object persisted via instagramService
 *     (stored in instagram_conversations.bot_context)
 *
 * SAFETY:
 *   - Read-only over shared data (faqHandler reused by caller)
 *   - Does NOT touch WhatsApp code paths
 * ─────────────────────────────────────────────────────────────
 */

// ─── Intent Definitions ──────────────────────────────────────
// keywords: exact substrings matched against lowercased text.
// weight: how strongly a match signals this intent
//   (multi-word phrases get weight per-word in scoring).

const INTENTS = {
    // ── Support intents ──────────────────────────────────────
    greeting: {
        category: 'support',
        keywords: [
            ['hi', 1], ['hello', 1.5], ['hey', 1.5], ['good morning', 3],
            ['good evening', 3], ['good afternoon', 3], ['namaste', 3],
            ['hii', 1], ['hiii', 1], ['hey there', 2.5], ['hola', 1.5]
        ],
        description: 'User is greeting us'
    },
    order_tracking: {
        category: 'support',
        keywords: [
            ['track', 2], ['tracking', 2.5], ['where is my order', 6],
            ['order status', 5], ['order tracking', 5], ['track order', 5],
            ['track my order', 5.5], ['awb', 4], ['shipment status', 4.5],
            ['delivery status', 4], ['where my order', 5.5],
            ['when will my order', 4.5], ['order update', 3.5],
            ['still not received', 4], ['not received yet', 4],
            ['delivered', 3], ['when was it delivered', 5],
            ['delivery date', 4], ['when did it arrive', 4.5],
            // Hinglish variants
            ['mera order kahan hai', 6], ['order kahan hai', 5.5],
            ['track karo', 5], ['tracking karo', 5],
            ['order ka status', 5], ['order nahi mila', 5],
            ['kab tak milega', 4.5], ['kitna time lagega', 4.5],
            ['mera packet kahan hai', 5.5], ['parcel kahan hai', 5]
        ],
        description: 'User wants to track an order'
    },
    return: {
        category: 'support',
        keywords: [
            ['return', 3], ['returns', 3], ['money back', 4.5],
            ['return policy', 5], ['want to return', 5.5],
            ['initiate return', 5.5], ['send it back', 4],
            ['send back', 3.5], ['return request', 5],
            // Hinglish variants
            ['return karna hai', 5.5], ['wapas karna hai', 5],
            ['return karo', 5], ['wapasi', 4], ['wapas', 3.5]
        ],
        description: 'User wants to return a product'
    },
    exchange: {
        category: 'support',
        keywords: [
            ['exchange', 3], ['size change', 4.5], ['wrong size', 4.5],
            ['different size', 4], ['swap', 3], ['size exchange', 5],
            ['exchange policy', 5], ['want to exchange', 5.5],
            ['replace', 2.5], ['replacement', 3],
            // Hinglish variants
            ['exchange karna hai', 5.5], ['badalna hai', 4.5],
            ['size badalna hai', 5.5], ['exchange karo', 5],
            ['replace karna hai', 5]
        ],
        description: 'User wants to exchange a product'
    },
    refund: {
        category: 'support',
        keywords: [
            ['refund', 4], ['refunded', 4.5], ['money not received', 5],
            ['refund status', 5], ['when refund', 4.5],
            ['credit not received', 4.5], ['my money', 2],
            // Hinglish variants
            ['paisa wapas', 5], ['paise wapas', 5], ['refund karo', 5],
            ['refund nahi aaya', 5.5], ['paisa nahi mila', 5],
            ['money wapas', 4.5]
        ],
        description: 'User asking about refund status'
    },
    delivery_issue: {
        category: 'support',
        keywords: [
            ['delivery issue', 6], ['not delivered', 5], ['late delivery', 5],
            ['delayed', 3], ['delay', 2.5], ['stuck', 2],
            ['no update', 3], ['where is my package', 6],
            ['package lost', 6], ['lost package', 6], ['missing order', 5.5],
            ['never arrived', 5.5], ['not arrived', 5],
            ['late', 3], ['order is late', 5], ['too late', 3.5],
            // Hinglish variants
            ['order nahi aaya', 5.5], ['delivery nahi hui', 5.5],
            ['packet nahi aaya', 5], ['parcel nahi aaya', 5],
            ['abhi tak nahi mila', 5], ['der ho gayi', 4.5]
        ],
        description: 'Delivery problem reported'
    },
    damaged_product: {
        category: 'support',
        keywords: [
            ['damaged', 5], ['torn', 4], ['defective', 5], ['defect', 4.5],
            ['broken', 4], ['stitching came off', 6], ['quality issue', 4.5],
            ['hole', 3], ['stain', 3.5], ['product is damaged', 6.5],
            ['received damaged', 6.5]
        ],
        description: 'Damaged product complaint'
    },
    wrong_product: {
        category: 'support',
        keywords: [
            ['wrong product', 6.5], ['wrong item', 6], ['wrong color', 5.5],
            ['wrong colour', 5.5], ['different product', 5],
            ['not what i ordered', 6.5], ['sent wrong', 5.5],
            ['different item', 5]
        ],
        description: 'Wrong item received'
    },
    shipping: {
        category: 'support',
        keywords: [
            ['shipping', 3], ['shipping cost', 5], ['shipping charge', 5],
            ['delivery time', 5], ['how long', 2.5], ['how many days', 4],
            ['shipping time', 5], ['dispatch', 3.5], ['courier', 2.5],
            ['delivery charge', 4.5], ['free shipping', 4.5],
            // Hinglish variants
            ['kitne din mein milega', 5.5], ['kab tak aayega', 5],
            ['shipping kab hogi', 5], ['delivery kab tak', 5],
            ['kitne din lagenge', 5], ['bhejne mein kitna time', 5]
        ],
        description: 'User asking about shipping'
    },
    payment: {
        category: 'support',
        keywords: [
            ['payment', 3], ['pay', 1.5], ['cod', 4], ['cash on delivery', 5.5],
            ['payment methods', 5.5], ['upi', 3], ['gpay', 3.5],
            ['phonepe', 3.5], ['paytm', 3.5], ['how to pay', 4.5],
            ['net banking', 4], ['card payment', 4]
        ],
        description: 'User asking about payment'
    },
    cancellation: {
        category: 'support',
        keywords: [
            ['cancel', 4], ['cancellation', 4.5], ['cancel order', 5.5],
            ['cancel my order', 6], ["don't want", 4], ['dont want', 4],
            ['stop the order', 5],
            // Hinglish variants
            ['cancel karo', 5.5], ['cancel karna hai', 5.5],
            ['order cancel', 5], ['order mat bhejo', 5],
            ['cancel chahiye', 5]
        ],
        description: 'User wants to cancel'
    },
    product_question: {
        category: 'support',
        keywords: [
            ['material', 3], ['fabric', 3.5], ['quality', 2],
            ['color available', 4.5], ['colour available', 4.5],
            ['colour', 2.5], ['color', 2.5], ['colours', 2.5], ['colors', 2.5],
            ['product details', 5], ['product info', 4.5],
            ['product question', 5], ['product enquiry', 5],
            ['care instructions', 5], ['wash', 1.5], ['cotton', 2.5],
            ['oversized', 2.5], ['fit', 1.5], ['unisex', 3],
            ['price', 3], ['cost', 3], ['how much', 5],
            ['rate', 2.5], ['mrp', 3.5], ['charges', 2.5],
            ['send link', 4.5], ['product link', 5], ['link', 1.5],
            ['available in', 3], ['in stock', 3.5], ['stock', 2],
            // Hinglish variants
            ['product ka price', 5.5], ['kitne ka hai', 5],
            ['price kya hai', 5], ['rate kya hai', 5],
            ['product kaisa hai', 5], ['kapda kaisa hai', 5],
            ['colour mein kya hai', 5], ['size mein kya hai', 5]
        ],
        description: 'Product detail question'
    },
    size_question: {
        category: 'support',
        keywords: [
            ['size chart', 6], ['size guide', 5.5], ['size available', 5.5],
            ['available size', 5.5], ['what size', 4.5], ['which size', 5],
            ['size for', 3.5], ['measurements', 4.5], ['sizing', 3.5]
        ],
        description: 'Size question'
    },
    faq: {
        category: 'support',
        keywords: [
            ['faq', 3], ['policy', 3], ['policies', 3.5],
            ['terms', 2.5], ['information', 1.5]
        ],
        description: 'General FAQ question'
    },

    // ── Business / creator intents ───────────────────────────
    creator_collaboration: {
        category: 'business',
        keywords: [
            ['collaboration', 5], ['collab', 4], ['paid collaboration', 6.5],
            ['brand partnership', 6], ['partnership', 4], ['sponsor', 4.5],
            ['sponsorship', 5], ['creator program', 6], ['brand deal', 5.5],
            ['work with creators', 6], ['do you work with creators', 6.5],
            ['promote your brand', 5.5], ['promote products', 4.5]
        ],
        description: 'Creator wants to collaborate'
    },
    ugc: {
        category: 'business',
        keywords: [
            ['ugc', 6], ['user generated', 4.5], ['content creation', 4.5],
            ['create content', 4.5], ['content creator', 5.5],
            ['shoot for you', 4.5], ['model for you', 5]
        ],
        description: 'UGC / content creation enquiry'
    },
    gifting: {
        category: 'business',
        keywords: [
            ['gifting', 5], ['gifted', 3], ['free products', 4],
            ['pr package', 5.5], ['pr box', 5], ['seeding', 4]
        ],
        description: 'Gifting / PR enquiry'
    },
    affiliate: {
        category: 'business',
        keywords: [
            ['affiliate', 6], ['commission', 3.5], ['affiliate program', 6.5],
            ['earn commission', 5.5], ['promo code', 3.5],
            ['discount code', 3.5], ['referral code', 4]
        ],
        description: 'Affiliate programme enquiry'
    },
    wholesale: {
        category: 'business',
        keywords: [
            ['wholesale', 6], ['bulk', 2.5], ['bulk order', 5.5],
            ['bulk purchase', 5.5], ['reseller', 5], ['reselling', 5],
            ['bulk pricing', 6], ['quantity discount', 5]
        ],
        description: 'Wholesale / bulk enquiry'
    },
    business_enquiry: {
        category: 'business',
        keywords: [
            ['business enquiry', 6], ['business inquiry', 6],
            ['business proposal', 5.5], ['b2b', 4], ['moq', 4],
            ['company profile', 4.5], ['catalog', 2.5]
        ],
        description: 'General business enquiry'
    },

    // ── Human / escalation intents ───────────────────────────
    human_support: {
        category: 'human',
        keywords: [
            ['support', 2], ['agent', 3.5], ['human', 4], ['real person', 5],
            ['talk to someone', 5.5], ['customer care', 5.5],
            ['customer service', 5.5], ['contact support', 5.5],
            ['speak to', 3], ['help me', 2.5], ['need help', 3],
            // Hinglish variants
            ['madad karo', 5], ['help chahiye', 5], ['madad chahiye', 5],
            ['koi hai', 4], ['baat karni hai', 4.5],
            ['insaan se baat', 5.5], ['team se baat', 5]
        ],
        description: 'User wants human support'
    },
    complaint: {
        category: 'human',
        keywords: [
            ['complaint', 5.5], ['worst', 4], ['pathetic', 4.5],
            ['useless', 4.5], ['horrible', 4.5], ['terrible', 4],
            ['disappointed', 4.5], ['disappointing', 4.5], ['unhappy', 3.5],
            ['bad experience', 5], ['bad service', 5], ['poor service', 5],
            ['poor quality', 4.5], ['never buying', 5], ['waste of money', 5.5],
            // Common typo variants — ensure misspellings still match
            ['dissapointed', 4.5], ['dissappointed', 4.5],
            ['dissatisfied', 4], ['unsatisfied', 4],
            ['not happy', 4], ['let down', 4]
        ],
        description: 'Customer complaint'
    },
    sensitive_issue: {
        category: 'human',
        keywords: [
            ['legal action', 7], ['lawyer', 6.5], ['consumer court', 7],
            ['consumer forum', 7], ['fraud', 5], ['scam', 5],
            ['cheated', 5.5], ['police', 4.5], ['sue', 5.5],
            ['legal notice', 6.5]
        ],
        description: 'Sensitive / legal issue — needs human urgently'
    },
    spam: {
        category: 'human',
        keywords: [
            ['buy followers', 7], ['cheap followers', 7], ['promo service', 5],
            ['dm for promo', 6], ['grow your account', 6],
            ['earn money daily', 6], ['click this link', 5.5],
            ['crypto', 4], ['forex', 4], ['make money online', 6],
            ['work from home job', 5.5], ['investment plan', 5.5],
            ['guaranteed profit', 6]
        ],
        description: 'Spam / promotional message'
    },

    // ── Conversation intelligence intents ─────────────────────
    // These detect WHAT the customer is communicating rather than
    // what they want the bot to do. Critical for preventing the bot
    // from ignoring semantic meaning and blindly re-asking for fields.

    already_raised: {
        category: 'status',
        keywords: [
            ['already raised', 6], ['already raised it', 7], ['already done', 6],
            ['already requested', 6.5], ['already submitted', 6.5],
            ['already applied', 6], ['already initiated', 6.5],
            ['raised within', 5], ['raised it within', 6],
            ['already have raised', 7], ['have already raised', 7],
            ['already put in', 5.5], ['already placed', 5],
            ['done already', 5.5], ['request already', 6],
            ['i have raised', 5.5], ['i already raised', 6.5],
            ['i ve raised', 5.5], ['i have already', 5]
        ],
        description: 'Customer is saying the action was already completed'
    },

    support_problem: {
        category: 'status',
        keywords: [
            ['no response', 5.5], ['no reply', 5], ['no one called', 6],
            ['no contact', 5.5], ['no update', 4.5], ['no admin approval', 7],
            ['no response on whatsapp', 8], ['no one responded', 6.5],
            ['no one has called', 6.5], ['no one contacted', 6],
            ['no contact has done', 7], ['still waiting', 4.5],
            ['still no response', 7], ['still no reply', 6.5],
            ['not responding', 5], ['not replying', 5],
            ['no support', 5], ['whatsapp no response', 7.5],
            ['no one reached out', 6.5], ['no callback', 5.5],
            ['ignored', 3.5], ['being ignored', 5.5],
            // Natural language variants — "nobody" forms
            ['nobody replied', 6.5], ['nobody responded', 6.5],
            ['nobody contacted', 6], ['nobody reached out', 6.5],
            ['nobody called', 6], ['nobody has replied', 7],
            ['nobody has responded', 7], ['nobody has contacted', 6.5],
            ['hasnt replied', 5.5], ['havent heard', 5.5],
            ['hasnt responded', 5.5], ['no response yet', 6],
            ['waiting for response', 5.5], ['waiting for reply', 5.5],
            // Hinglish variants
            ['koi jawab nahi', 6.5], ['koi response nahi', 6],
            ['koi call nahi aaya', 6.5], ['koi baat nahi ki', 6],
            ['koi madad nahi', 6], ['koi update nahi', 5.5]
        ],
        description: 'Customer is reporting a support/communication problem'
    },

    product_discovery: {
        category: 'support',
        keywords: [
            ['more products', 5.5], ['other products', 5], ['show products', 5.5],
            ['browse products', 6], ['tell me about products', 7],
            ['show me products', 6], ['what products', 5],
            ['product catalog', 6], ['your products', 4.5],
            ['all products', 5], ['new products', 5],
            ['see products', 5], ['collection', 3.5],
            ['your collection', 4.5], ['full range', 4.5],
            ['what do you sell', 6], ['what all do you have', 5.5],
            ['show me more', 4.5], ['anything else', 3],
            // Hinglish variants
            ['aur products', 5.5], ['aur dikhao', 5], ['koi aur product', 5.5],
            ['saare products', 5], ['aur kya hai', 5],
            ['kya kya hai', 4.5], ['sab dikhao', 5]
        ],
        description: 'Customer wants to browse/discover products'
    }
};

// ─── Entity Extraction Patterns ──────────────────────────────

const ENTITY_PATTERNS = {
    // ORD-2024-001, ORD12345, order 51023, #ORD-889, ORDER-123
    orderId: [
        /(?:ord|order)[\s\-#]*([a-z0-9][a-z0-9\-]{3,24})/i,
        /#(ord[a-z0-9\-]{3,24})/i
    ],
    // Bare 4-8 digit number (common short order ids like "51023")
    bareNumber: /\b(\d{4,8})\b/,
    // AWB: 8-15 alphanumeric (DTDC, Delhivery, Ekart formats)
    awb: /\b([a-z0-9]{8,15})\b/i,
    // Sizes: XS/S/M/L/XL/XXL or numeric sizes 28-44
    size: /\b(?:size[\s-]*)?(xxs|xs|s|m|l|xl|xxl|3xl|xxxl|\d{2})\b/i,
    // @profile handle for creator flows
    profileHandle: /@([a-z0-9._]{2,30})/i
};

// ─── Escalation / Sentiment Signals ──────────────────────────

const ANGER_SIGNALS = [
    'worst', 'pathetic', 'useless', 'horrible', 'terrible', 'fed up',
    'angry', 'frustrated', 'ridiculous', 'nonsense', 'fool',
    'cheated', 'scam', 'fraud', 'how dare', 'enough',
    'furious', 'outraged', 'livid'
];

// Disappointment signals — not full anger but clearly dissatisfied.
// Includes common typos so "dissapointed" still registers.
const DISAPPOINTMENT_SIGNALS = [
    'disappointed', 'dissapointed', 'dissappointed', 'dissapointed',
    'dissatisfied', 'unsatisfied', 'unhappy', 'let down',
    'not happy', 'not good', 'poor experience', 'bad experience',
    'disappointing', 'disappointing experience'
];

const SENSITIVE_SIGNALS = [
    'legal action', 'lawyer', 'consumer court', 'consumer forum',
    'police', 'sue', 'legal notice', 'harassment'
];

const POSITIVE_SIGNALS = [
    'love', 'great', 'awesome', 'amazing', 'nice', 'good',
    'excellent', 'beautiful', 'perfect', 'thanks', 'thank you',
    'best', 'superb', 'wonderful'
];

// ─── State Definitions ───────────────────────────────────────

const STATES = {
    GREETING: 'greeting',
    IDENTIFYING_INTENT: 'identifying_intent',
    COLLECTING_ORDER_ID: 'awaiting_order_id',
    AWAITING_RETURN_ORDER_ID: 'awaiting_return_order_id',
    TRACKING: 'tracking',
    RETURN_FLOW: 'return_flow',
    EXCHANGE_FLOW: 'exchange_flow',
    CREATOR_FLOW: 'creator_flow',
    COLLECTING_CREATOR_PROFILE: 'awaiting_creator_profile',
    FAQ: 'faq',
    AWAITING_SUPPORT_DESCRIPTION: 'awaiting_support_description',
    WAITING_FOR_CUSTOMER: 'waiting_for_customer',
    ESCALATED: 'escalated',
    RESOLVED: 'resolved',
    IDLE: 'idle'
};

// Confidence thresholds
const CONFIDENCE = {
    HIGH: 0.7,      // proceed automatically
    MEDIUM: 0.4,    // ask a targeted clarification
    LOW: 0.4        // below this — clarify or escalate
};

// ─── Smart Engine Class ──────────────────────────────────────

class IGSmartEngine {

    // Cache of compiled word-boundary regexes for short keywords
    _shortKeywordCache = new Map();

    // ── Classification ───────────────────────────────────────

    /**
     * Classify a customer message.
     *
     * @param {string} message  - raw message text
     * @param {object} context  - current conversation context (optional)
     * @returns {object} { intent, category, confidence, entities,
     *                     sentiment, isIntentSwitch, needsClarification }
     */
    classify(message, context = {}) {
        const text = (message || '').trim().toLowerCase();

        if (!text) {
            return {
                intent: 'unknown', category: 'human', confidence: 0,
                entities: {}, sentiment: 'neutral',
                isIntentSwitch: false, needsClarification: true
            };
        }

        // 1. Extract entities first (order IDs influence routing)
        const entities = this.extractEntities(text);

        // 2. Special-case: bare order ID / AWB in a collecting state
        if (context.state && this._isCollectingState(context.state)) {
            if (entities.orderId || entities.awb || entities.bareNumber) {
                return {
                    intent: 'provide_order_id',
                    category: 'support',
                    confidence: 0.95,
                    entities,
                    sentiment: this._detectSentiment(text),
                    isIntentSwitch: false,
                    needsClarification: false
                };
            }
        }

        // 3. Special-case: creator flow collecting profile info
        if (context.state === STATES.COLLECTING_CREATOR_PROFILE) {
            const creatorInfo = this._extractCreatorInfo(text);
            return {
                intent: 'provide_creator_info',
                category: 'business',
                confidence: 0.9,
                entities: { ...entities, creatorInfo },
                sentiment: this._detectSentiment(text),
                isIntentSwitch: false,
                needsClarification: false
            };
        }

        // 4. Score all intents
        const scores = this._scoreIntents(text);

        // 5. Sentiment detection (anger can override low scores)
        const sentiment = this._detectSentiment(text);
        const isSensitive = this._isSensitive(text);

        // 6. Pick winner with confidence
        let bestIntent = 'unknown';
        let bestScore = 0;
        for (const [intentName, score] of Object.entries(scores)) {
            if (score > bestScore) {
                bestScore = score;
                bestIntent = intentName;
            }
        }

        // Anger override: strong frustration with no dominant intent → complaint
        if (sentiment === 'angry' && bestScore < 6) {
            bestIntent = 'complaint';
            bestScore = Math.max(bestScore, 5);
        }

        // Sensitive override always wins (needs human urgently)
        if (isSensitive) {
            bestIntent = 'sensitive_issue';
            bestScore = Math.max(bestScore, 8);
        }

        // Spam: spam keywords dominate
        if (scores.spam >= 5) {
            bestIntent = 'spam';
            bestScore = scores.spam;
        }

        // 6b. Composite support signal override —
        // When multiple support signals are present (complaint + problem +
        // raised + dispute) and the winning intent is a routine action,
        // override to complaint so the bot acknowledges the support issue
        // instead of just showing a policy FAQ.
        if (bestIntent !== 'sensitive_issue' && bestIntent !== 'spam') {
            const supportSignals = this.detectSupportSignals(text);
            if (supportSignals.supportRequired &&
                ['return', 'exchange', 'refund', 'cancellation',
                 'delivery_issue', 'damaged_product', 'wrong_product',
                 'human_support', 'unknown'].includes(bestIntent)) {
                bestIntent = 'complaint';
                bestScore = Math.max(bestScore, 6);
            }
        }

        // 6c. Deterministic explicit-support override —
        // When the message contains unambiguous human-support language
        // combined with a complaint/problem signal, force complaint intent
        // with high confidence regardless of keyword scoring.
        // This prevents "I'm disappointed with support" from falling through
        // as low-confidence human_support without ticket creation.
        if (bestIntent !== 'sensitive_issue' && bestIntent !== 'spam') {
            const explicitSupport = this._detectExplicitSupport(text);
            if (explicitSupport) {
                bestIntent = 'complaint';
                bestScore = Math.max(bestScore, 7);
            }
        }

        const confidence = this._scoreToConfidence(bestScore, text);

        // 7. Intent switch detection
        const isIntentSwitch = this._detectIntentSwitch(bestIntent, context, confidence);

        // 8. Positive-only message (e.g. "love this") → no strong intent
        if (bestIntent === 'unknown' && sentiment === 'positive') {
            return {
                intent: 'positive_message',
                category: 'human',
                confidence: 0.6,
                entities, sentiment,
                isIntentSwitch: false,
                needsClarification: false
            };
        }

        const result = {
            intent: bestIntent,
            category: INTENTS[bestIntent]?.category || 'human',
            confidence,
            entities,
            sentiment,
            isIntentSwitch,
            needsClarification:
                confidence < CONFIDENCE.MEDIUM && bestIntent === 'unknown'
        };

        // 9. Multi-intent detection — find a secondary intent if present.
        //    Example: "My order is wrong and I want an exchange. Also is the
        //    black one available?" → primary: exchange, secondary: product_question
        const secondary = this._detectSecondaryIntent(text, bestIntent, entities);
        if (secondary) {
            result._secondaryIntent = secondary.intent;
            result._secondaryConfidence = secondary.confidence;
        }

        return result;
    }

    /**
     * Detect a secondary intent in the same message after the primary intent
     * has been chosen. Strips primary intent keywords and re-scores.
     *
     * Only returns a secondary if:
     *   - Confidence >= MEDIUM
     *   - Different category from primary (or clearly distinct intent)
     *   - Not unknown/spam/greeting (those are never useful secondaries)
     *
     * @returns {{ intent: string, confidence: number } | null}
     */
    _detectSecondaryIntent(text, primaryIntent, primaryEntities) {
        // Strip primary intent's matched keywords from text to isolate
        // the remaining semantic content for secondary scoring.
        const primaryKeywords = INTENTS[primaryIntent]?.keywords || [];
        let stripped = text;
        for (const [kw] of primaryKeywords) {
            stripped = stripped.replace(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
        }

        // Also strip common connector/filler words that don't carry intent
        stripped = stripped
            .replace(/\b(also|and|plus|additionally|another|one more|as well|too|moreover|besides)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Need at least 4 characters of remaining text to be meaningful
        if (stripped.length < 4) return null;

        // Re-score the stripped text
        const scores = this._scoreIntents(stripped);

        // Find the best secondary (excluding the primary and non-useful intents)
        const EXCLUDE_SECONDARY = new Set([
            primaryIntent, 'unknown', 'spam', 'greeting', 'positive_message',
            'sensitive_issue', 'complaint' // complaint is handled by composite override
        ]);

        let bestSecondary = null;
        let bestScore = 0;
        for (const [intentName, score] of Object.entries(scores)) {
            if (EXCLUDE_SECONDARY.has(intentName)) continue;
            if (score > bestScore && score >= 2) { // minimum threshold (lowered for multi-word messages)
                bestScore = score;
                bestSecondary = intentName;
            }
        }

        if (!bestSecondary) return null;

        const conf = this._scoreToConfidence(bestScore, stripped);
        if (conf < CONFIDENCE.MEDIUM) return null;

        return { intent: bestSecondary, confidence: conf };
    }

    // ── Entity Extraction ────────────────────────────────────

    /**
     * Extract structured entities from a message.
     * @returns {object} { orderId, awb, bareNumber, size, profileHandle }
     */
    extractEntities(text) {
        const entities = {};

        // Order ID (explicit patterns)
        for (const pattern of ENTITY_PATTERNS.orderId) {
            const m = text.match(pattern);
            if (m) {
                entities.orderId = m[1].toUpperCase();
                break;
            }
        }

        // Bare number — candidate order id in collecting states
        if (!entities.orderId) {
            const m = text.match(ENTITY_PATTERNS.bareNumber);
            if (m) entities.bareNumber = m[1];
        }

        // AWB: standalone alphanumeric token when order id absent
        if (!entities.orderId) {
            const tokens = text.split(/\s+/);
            for (const t of tokens) {
                if (/^[a-z0-9]{8,15}$/i.test(t) && /\d/.test(t) && /[a-z]/i.test(t)) {
                    entities.awb = t.toUpperCase();
                    break;
                }
            }
        }

        // Size
        const sizeMatch = text.match(ENTITY_PATTERNS.size);
        if (sizeMatch) {
            const s = sizeMatch[1].toUpperCase();
            // Only treat as size if it is a known size token
            if (/^(XXS|XS|S|M|L|XL|XXL|3XL|XXXL)$/.test(s) || (parseInt(s) >= 26 && parseInt(s) <= 46)) {
                entities.size = s;
            }
        }

        // @profile handle
        const handleMatch = text.match(ENTITY_PATTERNS.profileHandle);
        if (handleMatch) entities.profileHandle = handleMatch[1];

        return entities;
    }

    /**
     * Extract creator/partnership info from free text.
     */
    _extractCreatorInfo(text) {
        const info = {};
        const handleMatch = text.match(ENTITY_PATTERNS.profileHandle);
        if (handleMatch) info.profile = handleMatch[0];

        if (/media\s*kits?/.test(text)) info.mediaKit = true;
        if (/instagram\s*(profile|handle|page)/.test(text) && !handleMatch) {
            info.profileRequested = true;
        }

        if (/paid\s*(collab|collaboration|partnership)/.test(text)) info.type = 'paid_collab';
        else if (/barter|gifting|gifted/.test(text)) info.type = 'barter';
        else if (/ugc|content/.test(text)) info.type = 'ugc';
        else if (/affiliate/.test(text)) info.type = 'affiliate';

        // Follower count mention
        const followerMatch = text.match(/(\d+(?:\.\d+)?)\s*[km]?\s*(?:followers|k\b)/i);
        if (followerMatch) info.followerMention = followerMatch[0];

        return info;
    }

    // ── Context Management ───────────────────────────────────

    /**
     * Merge new information into the conversation context.
     * Preserves previously collected entities (never lose data).
     *
     * @param {object} prevContext - previous bot_context
     * @param {object} update      - { intent, entities, state, lastQuestion }
     * @returns {object} new context
     */
    updateContext(prevContext = {}, update = {}) {
        const ctx = { ...prevContext };

        // Persist collected entities — merge, don't overwrite with undefined
        ctx.entities = { ...(prevContext.entities || {}) };
        for (const [key, value] of Object.entries(update.entities || {})) {
            if (value !== undefined && value !== null) {
                ctx.entities[key] = value;
            }
        }

        if (update.intent !== undefined) ctx.lastIntent = update.intent;
        if (update.state !== undefined) ctx.state = update.state;
        if (update.lastQuestion !== undefined) ctx.lastQuestion = update.lastQuestion;

        // Rolling summary — keep last 6 exchanges compact
        if (update.summaryEntry) {
            ctx.summary = [...(prevContext.summary || []), update.summaryEntry].slice(-6);
        }

        // Creator info accumulates
        if (update.creatorInfo) {
            ctx.creatorInfo = { ...(prevContext.creatorInfo || {}), ...update.creatorInfo };
        }

        ctx.updatedAt = new Date().toISOString();
        ctx.messageCount = (prevContext.messageCount || 0) + 1;

        return ctx;
    }

    /**
     * Detect whether the user switched topics mid-flow.
     * Only counts as a switch when we were inside a flow state and a
     * DIFFERENT high-confidence intent arrives.
     */
    _detectIntentSwitch(newIntent, context, confidence) {
        const state = context?.state;
        if (!state) return false;

        const flowStates = [
            STATES.COLLECTING_ORDER_ID,
            STATES.AWAITING_RETURN_ORDER_ID,
            STATES.AWAITING_SUPPORT_DESCRIPTION,
            STATES.CREATOR_FLOW,
            STATES.COLLECTING_CREATOR_PROFILE
        ];

        if (!flowStates.includes(state)) return false;
        if (confidence < CONFIDENCE.HIGH) return false;

        // Intent different from what the flow expects?
        const expectedForState = {
            [STATES.COLLECTING_ORDER_ID]: ['provide_order_id', 'order_id'],
            [STATES.AWAITING_RETURN_ORDER_ID]: ['provide_order_id', 'order_id'],
            [STATES.AWAITING_SUPPORT_DESCRIPTION]: ['provide_support_description'],
            [STATES.COLLECTING_CREATOR_PROFILE]: ['provide_creator_info'],
            [STATES.CREATOR_FLOW]: ['provide_creator_info', 'creator_collaboration', 'ugc', 'gifting', 'affiliate']
        };

        const expected = expectedForState[state] || [];
        return !expected.includes(newIntent);
    }

    // ── Scoring internals ────────────────────────────────────

    /**
     * Score every intent against the text.
     * Multi-word phrase matches score higher than single words.
     * @returns {object} map of intent → score
     */
    _scoreIntents(text) {
        const scores = {};

        for (const [intentName, def] of Object.entries(INTENTS)) {
            let score = 0;
            for (const [keyword, weight] of def.keywords) {
                if (keyword.includes(' ')) {
                    // Multi-word phrases: substring match is safe
                    if (text.includes(keyword)) {
                        score += weight + 1.5;
                    }
                } else if (keyword.length <= 3) {
                    // Short keywords need word boundaries
                    // ('hi' must not match inside 'this', 'pay' inside 'payment')
                    if (this._getShortKeywordRegex(keyword).test(text)) {
                        score += weight;
                    }
                } else if (text.includes(keyword)) {
                    // Longer keyword = more specific = bigger contribution
                    score += weight;
                }
            }
            if (score > 0) scores[intentName] = score;
        }

        return scores;
    }

    /**
     * Compile (and cache) a word-boundary regex for a short keyword.
     */
    _getShortKeywordRegex(keyword) {
        let re = this._shortKeywordCache.get(keyword);
        if (!re) {
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            re = new RegExp(`\\b${escaped}\\b`);
            this._shortKeywordCache.set(keyword, re);
        }
        return re;
    }

    /**
     * Convert raw score to normalized confidence (0..1).
     * Uses a saturating curve so very strong matches approach 1.
     */
    _scoreToConfidence(score, text) {
        if (score <= 0) return 0;
        // Saturating: score 3 → ~0.55, 6 → ~0.78, 9+ → ~0.9
        const raw = 1 - Math.exp(-score / 4);
        // Very short texts get slight penalty (less signal)
        const words = text.split(/\s+/).length;
        const lengthFactor = words <= 1 ? 0.85 : 1;
        return Math.min(0.97, Math.round(raw * lengthFactor * 100) / 100);
    }

    /**
     * Sentiment detection: positive / neutral / angry.
     */
    _detectSentiment(text) {
        let angerCount = 0;
        for (const signal of ANGER_SIGNALS) {
            if (text.includes(signal)) angerCount++;
        }

        // CAPS rage heuristic: 3+ consecutive uppercase words of 3+ letters
        const capsRage = /\b[A-Z]{3,}\s+[A-Z]{3,}\s+[A-Z]{3,}\b/.test(text);
        if (capsRage) angerCount += 2;

        if (angerCount >= 2) return 'angry';
        if (angerCount === 1) return 'frustrated';

        // Disappointment check — includes typo variants.
        // Returns 'frustrated' so escalation handlers treat it seriously.
        for (const signal of DISAPPOINTMENT_SIGNALS) {
            if (text.includes(signal)) return 'frustrated';
        }

        for (const signal of POSITIVE_SIGNALS) {
            if (text.includes(signal)) return 'positive';
        }

        return 'neutral';
    }

    /**
     * Sensitive issue detection (legal threats etc.)
     */
    _isSensitive(text) {
        // Use word-boundary matching for short signals (<=4 chars) to prevent
        // false positives like "sue" matching inside "issue" or "resume".
        return SENSITIVE_SIGNALS.some(signal => {
            if (signal.length <= 4) {
                return new RegExp(`\\b${signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
            }
            return text.includes(signal);
        });
    }

    /**
     * Composite support signal detection.
     * Scans for multiple support signals across 4 categories:
     *   1. complaint  — explicit dissatisfaction
     *   2. problem    — support/communication failure
     *   3. raised     — action already taken
     *   4. dispute    — policy disagreement
     *
     * Returns supportRequired: true when 2+ categories fire,
     * OR when 1 category fires AND sentiment is angry/frustrated.
     */
    detectSupportSignals(text) {
        const signals = { complaint: false, problem: false, raised: false, dispute: false };

        // 1. Complaint signals — explicit dissatisfaction (includes typo variants)
        const complaintKw = [
            'disappointed', 'dissapointed', 'dissappointed',
            'dissatisfied', 'unsatisfied', 'unhappy', 'not acceptable',
            'not good enough', 'terrible experience', 'worst experience',
            'very poor', 'really bad', 'unfair', 'not happy', 'let down'
        ];
        if (complaintKw.some(k => text.includes(k))) signals.complaint = true;

        // 2. Support problem signals — communication failure
        const problemKw = [
            'no response', 'no reply', 'no one called', 'no contact',
            'not responding', 'not replying', 'no one reached',
            'no one contacted', 'ignored', 'being ignored', 'no support',
            'nobody responded', 'nobody replied', 'no update'
        ];
        if (problemKw.some(k => text.includes(k))) signals.problem = true;

        // 3. Already raised signals — action already completed
        const raisedKw = [
            'already raised', 'already done', 'already requested',
            'already applied', 'already submitted', 'i have raised',
            'i already raised', 'already initiated', 'already contacted'
        ];
        if (raisedKw.some(k => text.includes(k))) signals.raised = true;

        // 4. Policy dispute signals — disagreement with rules
        const disputeKw = [
            'window is over', '2-day limit', 'two day limit',
            'not fair', 'unfair policy', 'should allow', 'should be allowed',
            'unreasonable', 'look into this', 'please look', 'please check',
            'need help with', 'please help'
        ];
        if (disputeKw.some(k => text.includes(k))) signals.dispute = true;

        const activeCount = Object.values(signals).filter(Boolean).length;
        const sentiment = this._detectSentiment(text);
        const supportRequired = activeCount >= 2 ||
            (activeCount >= 1 && (sentiment === 'angry' || sentiment === 'frustrated'));

        return { supportRequired, signals, activeCount };
    }

    /**
     * Detect explicit, unambiguous human-support phrases that should
     * ALWAYS trigger escalation regardless of keyword scoring.
     *
     * Returns true when the message contains BOTH:
     *   (a) an explicit support/help request phrase, AND
     *   (b) a complaint/problem/disappointment signal
     *
     * This catches messages like:
     *   - "I'm disappointed with support"
     *   - "nobody is responding to my issue"
     *   - "I need help, customer service isn't helping"
     *   - "I'm frustrated with your service"
     *
     * Typo-tolerant for common misspellings.
     */
    _detectExplicitSupport(text) {
        const t = text.toLowerCase();

        // Explicit support request phrases
        const supportPhrases = [
            'need support', 'need help', 'contact support', 'talk to someone',
            'speak to someone', 'connect me to support', 'customer service',
            'customer care', 'i need assistance', 'need assistance',
            'reach your team', 'speak to your team', 'talk to your team',
            'need to talk to', 'want to speak', 'want to talk'
        ];

        // Complaint/problem/disappointment signals (with typo variants)
        const complaintSignals = [
            'disappointed', 'dissapointed', 'dissappointed',
            'dissatisfied', 'unhappy', 'frustrated', 'angry',
            'not happy', 'bad experience', 'poor service',
            'no response', 'no reply', 'nobody replied', 'nobody responded',
            'no one responded', 'no one replied', 'still waiting',
            'not responding', 'ignored', 'no support', 'no help',
            'waste of money', 'terrible', 'horrible', 'worst'
        ];

        const hasSupportPhrase = supportPhrases.some(p => t.includes(p));
        const hasComplaintSignal = complaintSignals.some(s => t.includes(s));

        // Both must be present — support phrase alone is just a request,
        // complaint alone is just a complaint. Together = explicit escalation.
        return hasSupportPhrase && hasComplaintSignal;
    }

    _isCollectingState(state) {
        return [
            STATES.COLLECTING_ORDER_ID,
            STATES.AWAITING_RETURN_ORDER_ID
        ].includes(state);
    }

    /**
     * Targeted clarification question based on what we know.
     * Never says "I don't understand" — asks something useful.
     */
    getClarificationQuestion(context = {}) {
        const entities = context.entities || {};

        if (entities.size && !entities.orderId) {
            return 'Got it — could you share your Order ID so I can check that size for you?';
        }
        if (context.lastIntent === 'order_tracking' || context.lastIntent === 'provide_order_id') {
            return 'Could you share your Order ID or AWB number so I can check the latest status?';
        }
        if (context.lastIntent === 'return' || context.lastIntent === 'exchange') {
            return 'Sure — which order is this for? Please share the Order ID.';
        }
        if (context.lastIntent === 'product_question' || context.lastIntent === 'size_question') {
            return 'Which product are you asking about? A product name or link would help.';
        }
        // Generic — still useful, references their message
        return 'Could you tell me a bit more — is this about an order, a return/exchange, or a product question?';
    }

    /**
     * Build a compact human-readable conversation summary
     * for escalation hand-off.
     */
    buildEscalationSummary(context = {}) {
        const parts = [];
        const entities = context.entities || {};

        if (context.lastIntent) parts.push(`Last intent: ${context.lastIntent}`);
        if (entities.orderId) parts.push(`Order ID: ${entities.orderId}`);
        if (entities.awb) parts.push(`AWB: ${entities.awb}`);
        if (entities.size) parts.push(`Size mentioned: ${entities.size}`);
        if (context.creatorInfo && Object.keys(context.creatorInfo).length > 0) {
            parts.push(`Creator info: ${JSON.stringify(context.creatorInfo)}`);
        }
        if (context.summary && context.summary.length > 0) {
            parts.push(`Recent: ${context.summary.slice(-3).join(' | ')}`);
        }
        if (context.messageCount) parts.push(`Messages: ${context.messageCount}`);

        return parts.join('\n');
    }
}

module.exports = new IGSmartEngine();
module.exports.STATES = STATES;
module.exports.CONFIDENCE = CONFIDENCE;
