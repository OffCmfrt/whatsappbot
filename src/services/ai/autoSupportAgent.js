/**
 * Autonomous AI Support Agent for OFFCOMFRT WhatsApp Bot.
 *
 * LLM-powered intent classification + sentiment analysis replacing the old
 * regex-based pattern matching. Uses a structured system prompt with all 9 SOP
 * scenario rules, detects customer language (English / Hindi / Hinglish),
 * classifies intent + sentiment in a single LLM call, and returns a
 * SOP-compliant reply with confidence scoring.
 *
 * Pipeline:
 *   1. Fetch customer context (recent orders, shopper status)
 *   2. Detect language heuristic (Devanagari = Hindi, mixed = Hinglish)
 *   3. Call LLM with SOP rules + context → JSON { intent, scenario, confidence, reply, sentiment }
 *   4. If confidence < threshold OR sentiment = frustrated → escalate
 *   5. Fallback: search golden SOP learned examples from learning.js
 */

const crypto = require('crypto');
const { dbAdapter } = require('../../database/db');
const { chatCompletion, isConfigured } = require('./aiClient');
const { findSimilarExamples } = require('./learning');
const aiStore = require('./aiStore');
const Settings = require('../../models/Settings');

// Confidence below this → escalate to admin
const CONFIDENCE_THRESHOLD = 0.6;

// ── Short-message skip ──
// Messages under 10 chars that don't match any SOP keyword are too trivial
// to warrant a full LLM call (e.g. "hi", "ok", "thanks", emojis).
const SOP_KEYWORDS = [
    // tracking
    'where', 'track', 'status', 'courier', 'shipped', 'dispatch', 'delivery', 'delivered', 'awb',
    // delayed
    'delay', 'late', 'not received', 'haven\'t received', 'not yet received', 'pod',
    // refund
    'refund', 'money back', 'return money', 'cashback',
    // size/exchange
    'size', 'exchange', 'swap', 'wrong size', 'too small', 'too large', 'bigger', 'smaller',
    // damaged/wrong
    'damaged', 'defective', 'wrong product', 'broken', 'torn', 'stain',
    // address
    'address', 'change address', 'update address', 'new address',
    // COD confusion
    'cod', 'cash on delivery', 'already paid', 'paid online',
    // cancellation
    'cancel', 'don\'t want', 'cancel order',
    // escalation
    'frustrated', 'angry', 'complaint', 'manager', 'callback', 'supervisor'
];

function isTrivialMessage(text) {
    const t = String(text || '').trim();
    if (t.length >= 10) return false;
    const lower = t.toLowerCase();
    return !SOP_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Result cache (phone + message hash) ──
// If the same customer sends the same message twice, return the cached result
// instead of paying for another LLM call. Entries expire after 30 minutes.
const AUTO_CACHE_TTL_MS = 30 * 60 * 1000;
const AUTO_CACHE_MAX = 200;
const autoCache = new Map(); // key -> { result, at }

function autoCacheKey(phone, messageText) {
    const normalized = String(messageText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const hash = crypto.createHash('md5').update(normalized).digest('hex').substring(0, 12);
    return `${String(phone).replace(/\D/g, '').slice(-10)}:${hash}`;
}

function getCachedResult(phone, messageText) {
    const key = autoCacheKey(phone, messageText);
    const entry = autoCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > AUTO_CACHE_TTL_MS) {
        autoCache.delete(key);
        return null;
    }
    return entry.result;
}

function setCachedResult(phone, messageText, result) {
    const key = autoCacheKey(phone, messageText);
    if (autoCache.size >= AUTO_CACHE_MAX) {
        // Evict oldest entry
        autoCache.delete(autoCache.keys().next().value);
    }
    autoCache.set(key, { result, at: Date.now() });
}

// ── Language detection heuristic ──

function detectLanguage(text) {
    const t = String(text || '');
    // Devanagari Unicode range → Hindi
    if (/[\u0900-\u097F]/.test(t)) return 'hindi';
    // Mixed Latin + common Hindi/Hinglish tokens
    const hinglishTokens = /\b(kya|hai|kahan|kab|mera|meri|nahi|nahin|bhaiya|ji|lagta|kardo|bhejo|paisa|kitna|kab tak|bhai|yaar|please|thoda|jaldi|galti|galat|dhoka|fraud|late|delay|nahi mila|order kahan)\b/i;
    if (hinglishTokens.test(t)) return 'hinglish';
    return 'english';
}

// ── SOP System Prompt ──

function buildSystemPrompt(language) {
    const langInstruction =
        language === 'hindi'
            ? 'Respond in Hindi (Devanagari script). Keep the tone warm and professional.'
            : language === 'hinglish'
                ? 'Respond in Hinglish (Latin script, Hindi-English mix). Keep the tone warm and professional.'
                : 'Respond in English. Keep the tone warm and professional.';

    return `You are the OFFCOMFRT AI Support Agent for WhatsApp. You classify customer messages into one of 9 SOP scenarios and generate a policy-compliant reply.

${langInstruction}

## SOP SCENARIOS (classify into exactly one):

1. **tracking** — "Where is my order?" / track / status / courier / shipped
   RULE: Check partner sequence: Shiprocket → Delhivery One → Ekart (prepaid only). If "Edit Details" clicked without follow-up info: calling executive contacts customer. COD: hold until response. Prepaid: ship as-is after 24h. If the order is not yet shipped or still processing / has no tracking info: check the Shoppers Hub status — if the order is pending confirmation, tell the customer "Please confirm your order via the template message sent to you." If the order IS confirmed in Shoppers Hub, state "Your order will be shipped within 24 to 48 hours." NEVER say "hasn't been shipped yet" or "tracking not available".

2. **delayed_pod** — Order delayed / not received / delivered but not in hand
   RULE: If tracking shows "Delivered": ask customer to check with neighbours/security. Notify delivery partner, request Proof of Delivery (POD). Wait 24h for POD.

3. **refund_policy** — Refund / money back / return money
   RULE: Original payment method refund (5-7 days) ONLY for: (a) damaged on arrival, (b) wrong product, (c) prepaid cancelled at confirmation, (d) RTO without receipt. ALL other returns = store credit only. Never promise cash refund for size/preference returns.

4. **size_exchange** — Size change / exchange / wrong size
   RULE: Pre-dispatch: use "Edit Details" on Shoppers Hub confirmation. Post-delivery: direct to offcomfrt.in → Support → Return/Exchange portal.

5. **damaged_wrong_item** — Damaged / defective / wrong product received
   RULE: Always ask for proof: wrong product = unboxing video (mandatory); damaged = photos. Submit via offcomfrt.in → Support → Return/Exchange. Qualifies for refund.

6. **address_change** — Change / update delivery address
   RULE: Pre-dispatch: "Edit Details" on Shoppers Hub. Post-dispatch: cannot change active shipment. Prepaid RTO: wait for return then reship, or cancel in-transit for fresh order. COD: dispatch fresh order immediately.

7. **cod_confusion** — Already paid online but courier asking for COD cash
   RULE: Root cause: "Edit Details" converted order to COD without re-applying discount. Customer pays cash at door; OFFCOMFRT refunds that amount separately.

8. **cancellation** — Cancel order / don't want
   RULE: Actioned via Shoppers Hub confirmation text (Confirm/Cancel/Edit Details). Prepaid post-ship: cancel in-transit + refund. COD post-ship: refuse delivery.

9. **escalation** — Frustrated / want callback / manager / supervisor
   RULE: Do NOT offer phone callback. Resolve over chat first. Consult admin for best solution. Try to resolve before escalating.

## OUTPUT FORMAT (strict JSON):
{
  "intent": "<short description of what customer wants>",
  "scenario": "<one of: tracking, delayed_pod, refund_policy, size_exchange, damaged_wrong_item, address_change, cod_confusion, cancellation, escalation, general>",
  "confidence": <0.0 to 1.0>,
  "reply": "<SOP-compliant reply text, concise WhatsApp style, max 300 words>",
  "sentiment": "<positive | neutral | negative | frustrated>"
}

## RULES:
- NEVER invent order numbers, tracking data, or policies not listed above.
- If the message doesn't match any scenario, use scenario "general" with confidence 0.3.
- If sentiment is "frustrated", still classify the scenario but set confidence to max 0.5.
- Reply in the SAME LANGUAGE as the customer's message.
- Keep replies SHORT — WhatsApp chat style, 2-5 sentences max.
- Use the order context provided (if any) to personalize the reply.
- Do NOT include emoji headers like the old format. Write naturally.`;
}

// ── Main entry point ──

/**
 * Process a customer message through the LLM-powered support agent.
 * @param {string} phone — Customer phone number
 * @param {string} messageText — Inbound customer message
 * @param {string} customerName — Customer name
 * @param {object} [options] — Optional: { recentMessages: string[] }
 * @returns {{ handled: boolean, reply?: string, scenario?: string, confidence?: number, sentiment?: string, reason?: string }}
 */
async function processCustomerMessage(phone, messageText, customerName = 'Customer', options = {}) {
    try {
        const text = String(messageText || '').trim();
        const lowerText = text.toLowerCase();
        const digits = String(phone).replace(/\D/g, '');
        const phonePattern = `%${digits.slice(-10)}`;

        // ── Gate 1: Skip trivial messages ──
        // Very short messages without SOP keywords don't need AI classification.
        // Returns handled:false so the caller creates/updates the ticket normally.
        if (isTrivialMessage(text)) {
            return {
                handled: false,
                reason: 'Trivial message — skipped AI classification',
                scenario: 'general',
                confidence: 0,
                sentiment: 'neutral',
                skipped: true
            };
        }

        // ── Gate 2: Cache hit ──
        // Same customer + same message text → reuse the previous result.
        const cached = getCachedResult(digits, text);
        if (cached) {
            return { ...cached, cached: true };
        }

        // ── Gate 3: Daily cap ──
        // Shared pool (all auto-support calls count under actor 'auto_support').
        if (isConfigured()) {
            const dailyLimit = parseInt(await Settings.get(
                'ai_auto_support_daily_limit',
                process.env.AI_AUTO_SUPPORT_DAILY_LIMIT || '500'
            )) || 500;
            const usedToday = await aiStore.getTodayUsageCount('auto_support', 'auto_support');
            if (usedToday >= dailyLimit) {
                console.warn(`[AUTO AI] Daily limit reached (${usedToday}/${dailyLimit}). Falling back to golden examples.`);
                const examples = await findSimilarExamples(text, 1);
                if (examples && examples.length > 0 && examples[0].uses >= 5) {
                    return {
                        handled: true,
                        reply: examples[0].a,
                        scenario: 'golden_sop',
                        confidence: 0.7,
                        sentiment: 'neutral',
                        limitReached: true
                    };
                }
                return {
                    handled: false,
                    reason: `Daily AI limit reached (${dailyLimit}/day)`,
                    scenario: 'general',
                    confidence: 0,
                    sentiment: 'neutral',
                    limitReached: true
                };
            }
        }

        // 1. Fetch customer context
        let orders = [];
        let shoppers = [];
        try {
            [orders, shoppers] = await Promise.all([
                dbAdapter.query(
                    `SELECT order_id, status, awb, courier_name, total, payment_method, expected_delivery, created_at
                     FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 3`,
                    [phonePattern]
                ),
                dbAdapter.query(
                    `SELECT order_id, status, delivery_type, customer_message FROM store_shoppers
                     WHERE phone = ? ORDER BY created_at DESC LIMIT 1`,
                    [digits]
                )
            ]);
        } catch (dbErr) {
            console.warn('[AUTO AI] Database query unavailable:', dbErr.message);
        }

        const latestOrder = orders[0] || null;
        const latestShopper = shoppers[0] || null;

        // 2. Detect language
        const language = detectLanguage(text);

        // 3. Build context string for the LLM
        let contextStr = '';
        if (latestOrder) {
            contextStr += `Latest Order: ID #${latestOrder.order_id}, Status: ${latestOrder.status || 'Processing'}`;
            if (latestOrder.awb) contextStr += `, AWB: ${latestOrder.awb}`;
            if (latestOrder.courier_name) contextStr += `, Courier: ${latestOrder.courier_name}`;
            if (latestOrder.payment_method) contextStr += `, Payment: ${latestOrder.payment_method}`;
            if (latestOrder.expected_delivery) contextStr += `, Expected: ${latestOrder.expected_delivery}`;
            contextStr += '\n';
        }
        if (latestShopper) {
            contextStr += `Shoppers Hub: Order #${latestShopper.order_id}, Status: ${latestShopper.status || 'unknown'}`;
            if (latestShopper.customer_message) contextStr += `, Edit Message: "${latestShopper.customer_message.substring(0, 100)}"`;
            contextStr += '\n';
        }

        // Include recent messages for multi-turn context if provided
        if (options.recentMessages && options.recentMessages.length) {
            contextStr += '\nRecent conversation:\n';
            for (const msg of options.recentMessages.slice(-3)) {
                contextStr += `- ${msg}\n`;
            }
        }

        // 4. Call LLM for intent classification + reply generation
        if (isConfigured()) {
            try {
                const systemPrompt = buildSystemPrompt(language);

                const userMessage = contextStr
                    ? `Customer name: ${customerName}\nCustomer message: "${text}"\n\nContext:\n${contextStr}`
                    : `Customer name: ${customerName}\nCustomer message: "${text}"`;

                const { message, usage, model } = await chatCompletion({
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage }
                    ],
                    temperature: 0.3,
                    maxTokens: 600,
                    responseFormat: { type: 'json_object' }
                });

                // Parse the JSON response
                let parsed;
                try {
                    parsed = JSON.parse(message.content || '{}');
                } catch {
                    // Fallback: try to extract JSON from the response
                    const jsonMatch = (message.content || '').match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        parsed = JSON.parse(jsonMatch[0]);
                    }
                }

                if (parsed && parsed.scenario) {
                    const confidence = parseFloat(parsed.confidence) || 0.5;
                    const sentiment = parsed.sentiment || 'neutral';
                    const scenario = parsed.scenario || 'general';
                    const reply = parsed.reply || '';

                    // Build result, log usage, and cache — all paths share this
                    let result;

                    // Auto-escalate if frustrated or very low confidence
                    if (sentiment === 'frustrated' || confidence < CONFIDENCE_THRESHOLD) {
                        const reason = sentiment === 'frustrated'
                            ? 'Customer is frustrated — auto-escalating to admin'
                            : `Low confidence (${confidence.toFixed(2)}) — needs human review`;

                        if (reply && confidence >= 0.3) {
                            result = { handled: false, reply, scenario, confidence, sentiment, reason };
                        } else {
                            result = { handled: false, scenario, confidence, sentiment, reason };
                        }
                    } else {
                        result = { handled: true, reply, scenario, confidence, sentiment };
                    }

                    // Log usage for daily cap tracking
                    await aiStore.logUsage({
                        actor: 'auto_support',
                        kind: 'auto_support',
                        model,
                        promptTokens: usage?.prompt_tokens || 0,
                        completionTokens: usage?.completion_tokens || 0
                    });

                    // Cache the result so the same message from the same customer is free
                    setCachedResult(digits, text, result);

                    return result;
                }
            } catch (aiErr) {
                console.warn('[AUTO AI] LLM classification failed:', aiErr.message);
                // Fall through to golden examples fallback
            }
        }

        // 5. Fallback: Search Golden SOP learned examples
        const examples = await findSimilarExamples(text, 1);
        if (examples && examples.length > 0 && examples[0].uses >= 5) {
            const reply = examples[0].a;
            return {
                handled: true,
                reply,
                scenario: 'golden_sop',
                confidence: 0.7,
                sentiment: 'neutral'
            };
        }

        // 6. Cannot handle automatically → Escalate
        return {
            handled: false,
            reason: 'Complex or unhandled query requires human admin review',
            scenario: 'general',
            confidence: 0,
            sentiment: 'neutral'
        };
    } catch (error) {
        console.error('[AUTO AI] Error in autoSupportAgent:', error.message);
        return {
            handled: false,
            reason: error.message,
            scenario: 'general',
            confidence: 0,
            sentiment: 'neutral'
        };
    }
}

module.exports = { processCustomerMessage, detectLanguage };
