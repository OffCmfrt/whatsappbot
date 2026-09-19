/**
 * instagramWebhookRoutes.js
 * ─────────────────────────────────────────────────────────────
 * Instagram webhook endpoint for receiving DMs and comment events.
 *
 * Routes:
 *   GET  /webhook/instagram  — Meta webhook verification
 *   POST /webhook/instagram  — Incoming Instagram messages + comments
 *
 * SAFETY:
 *   - Completely separate from the WhatsApp /webhook endpoint
 *   - Uses its own verify token (INSTAGRAM_VERIFY_TOKEN)
 *   - Idempotency protection prevents duplicate processing
 *   - Comment events are routed to igCommentService (idempotent pipeline)
 *   - Does NOT modify any WhatsApp webhook logic
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const instagramService = require('../services/instagramService');
const igCommentService = require('../services/igCommentService');
const { dbAdapter } = require('../database/db');

// ─── Webhook Verification (GET) ─────────────────────────────
// Meta sends a GET request to verify the webhook URL.
// We compare the verify_token with our INSTAGRAM_VERIFY_TOKEN.

router.get('/webhook/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log(`[IG WEBHOOK] Verification request: mode=${mode}`);

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
            console.log('✅ [IG WEBHOOK] Verification successful');
            return res.status(200).send(challenge);
        } else {
            console.warn('❌ [IG WEBHOOK] Verification failed — token mismatch');
            return res.sendStatus(403);
        }
    }

    return res.sendStatus(400);
});

// ─── Incoming Webhook Events (POST) ─────────────────────────
// Meta sends POST requests when users send DMs, react, etc.
// We must respond 200 within 20 seconds or Meta retries.

router.post('/webhook/instagram', async (req, res) => {
    // Always respond 200 immediately to prevent Meta retries
    res.sendStatus(200);

    try {
        const body = req.body;

        // ── DIAGNOSTIC LOGGING (safe, non-sensitive) ────────────────
        console.log(`[IG WEBHOOK] Received | object=${body?.object} | entries=${body?.entry?.length || 0}`);

        // Verify this is an Instagram webhook
        if (body.object !== 'instagram') {
            console.log('[IG WEBHOOK] Non-instagram object:', body.object);
            return;
        }

        const entries = body.entry || [];

        for (const entry of entries) {
            // ── DIAGNOSTIC: Log entry structure ─────────────────────
            const hasMessaging = !!entry.messaging;
            const hasComments = !!entry.comments;
            const hasChanges = !!entry.changes;
            const messagingCount = entry.messaging?.length || 0;
            console.log(`[IG WEBHOOK] Entry | messaging=${hasMessaging}(${messagingCount}) | comments=${hasComments} | changes=${hasChanges}`);

            // Handle messaging events (DMs)
            const messagingEvents = entry.messaging || [];

            for (const event of messagingEvents) {
                // ── DIAGNOSTIC: Log event type ──────────────────────
                const senderId = event.sender?.id;
                const hasMessage = !!event.message;
                const eventType = hasMessage ? 'message' : (event.referral ? 'referral' : (event.postback ? 'postback' : 'unknown'));
                console.log(`[IG WEBHOOK] DM event | type=${eventType} | sender=${senderId ? String(senderId).substring(0, 8) + '...' : 'none'}`);

                // Process in background to avoid blocking the response
                processInstagramEvent(event).catch(err => {
                    console.error('[IG WEBHOOK] Event processing error:', err.message);
                });
            }

            // Handle comment events — two payload shapes exist:
            //   - entry.comments[] (direct comment objects)
            //   - entry.changes[] with field 'comments' (Graph webhook format)
            // FIX: Added null-safety check (c && c.field) to prevent throws on null entries
            const commentEvents = [
                ...(entry.comments || []),
                ...(entry.changes || [])
                    .filter(c => c && c.field === 'comments')  // ← FIXED: null-safe
                    .map(c => c.value)
            ].filter(Boolean);

            for (const comment of commentEvents) {
                if (!comment?.id) continue;
                // ── DIAGNOSTIC: Log comment event ───────────────────
                console.log(`[IG WEBHOOK] Comment event | id=${comment.id.substring(0, 12)}... | from=${comment.from?.username || 'unknown'}`);
                // Process in background — pipeline dedups, classifies,
                // private-replies and records the comment
                igCommentService.processCommentEvent(comment).catch(err => {
                    console.error('[IG WEBHOOK] Comment processing error:', err.message);
                });
            }
        }
    } catch (error) {
        console.error('[IG WEBHOOK] Processing error:', error.message);
    }
});

// ─── Event Processing ───────────────────────────────────────

/**
 * Process a single Instagram messaging event.
 * Handles: text messages, quick replies, attachments, referrals.
 */
async function processInstagramEvent(event) {
    const senderId = event.sender?.id;
    const recipientId = event.recipient?.id;
    const timestamp = event.timestamp;

    if (!senderId) {
        console.warn('[IG EVENT] No sender ID in event');
        return;
    }

    // ── 1. Idempotency check ──────────────────────────────
    const message = event.message;
    const messageId = message?.mid;

    if (messageId) {
        const isDuplicate = await checkIdempotency(messageId);
        if (isDuplicate) {
            console.log(`[IG EVENT] Duplicate message ${messageId} — skipping`);
            return;
        }
    }

    // ── 2. Handle different event types ───────────────────

    // Text message (including quick reply payloads)
    if (message?.text) {
        await handleTextMessage(senderId, message, timestamp);
        return;
    }

    // Attachment (image, video, file, etc.)
    if (message?.attachments) {
        await handleAttachment(senderId, message, timestamp);
        return;
    }

    // Referral (user opened the conversation via an ad or link)
    if (event.referral) {
        await handleReferral(senderId, event.referral, timestamp);
        return;
    }

    // Postback (user tapped a Get Started button or similar)
    if (event.postback) {
        await handlePostback(senderId, event.postback, timestamp);
        return;
    }

    // Reaction (emoji reaction to a message)
    if (message?.reactions) {
        console.log(`[IG EVENT] Reaction from ${senderId} — ignoring`);
        return;
    }

    console.log(`[IG EVENT] Unhandled event type from ${senderId}`);
}

// ─── Text Message Handler ─────────────────────────────────────

/**
 * Handle an incoming text message from Instagram.
 * Updates the 24h window, logs the message, and routes to the bot engine.
 */
async function handleTextMessage(senderId, message, timestamp) {
    const text = message.text;
    const messageId = message.mid;

    // Check for quick reply payload
    const quickReply = message.quick_reply;
    const messageText = quickReply?.payload || text;

    console.log(`📸 [IG DM] From ${senderId}: "${messageText.substring(0, 80)}"`);

    // Update the 24-hour messaging window (reset it)
    await instagramService.updateMessagingWindow(senderId);

    // Log the incoming message
    await instagramService.logIncoming(senderId, messageText, messageId);

    // Check if this conversation is escalated to a human agent
    const botState = await instagramService.getBotState(senderId);

    if (botState?.isEscalated) {
        // Conversation is being handled by a human — don't auto-respond
        // The message is already logged; the human agent will see it in the portal
        console.log(`[IG] 🔺 User ${senderId} is escalated — message logged for human agent`);

        // Append to existing support ticket
        if (botState.ticketId) {
            await dbAdapter.query(
                `UPDATE support_tickets
                 SET message = message || '\n\n---\n' || ?,
                     is_read = false,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [messageText, botState.ticketId]
            );
        }
        return;
    }

    // Route to bot engine (Phase 5 will implement this)
    // For now, import and call if available
    try {
        const botEngine = require('../handlers/igBotEngine');
        await botEngine.processMessage(senderId, messageText, {
            messageId,
            timestamp,
            isQuickReply: !!quickReply
        });
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            // Bot engine not yet implemented — send a default response
            console.log('[IG] Bot engine not yet available — sending default response');
            await instagramService.sendMessage(
                senderId,
                `Thanks for reaching out to OffComfrt!

Our team will get back to you shortly.

For urgent queries, please WhatsApp us.`
            );
        } else {
            throw err;
        }
    }
}

// ─── Attachment Handler ───────────────────────────────────────

/**
 * Handle incoming media (images, files, etc.) from Instagram.
 */
async function handleAttachment(senderId, message, timestamp) {
    const messageId = message.mid;
    const attachments = message.attachments || [];

    console.log(`📸 [IG DM] Attachment from ${senderId}: ${attachments.length} item(s)`);

    // Update 24h window
    await instagramService.updateMessagingWindow(senderId);

    // Log as incoming message
    const attachmentDesc = attachments.map(a => `[${a.type || 'file'}]`).join(', ');
    await instagramService.logIncoming(senderId, attachmentDesc, messageId);

    // If escalated, append to ticket
    const botState = await instagramService.getBotState(senderId);
    if (botState?.isEscalated && botState.ticketId) {
        await dbAdapter.query(
            `UPDATE support_tickets
             SET message = message || '\n\n---\n' || ?,
                 is_read = false,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [`[Sent ${attachmentDesc}]`, botState.ticketId]
        );
        return;
    }

    // For non-escalated: ask user to describe their issue
    try {
        const botEngine = require('../handlers/igBotEngine');
        await botEngine.processMessage(senderId, `[attachment: ${attachmentDesc}]`, {
            messageId,
            timestamp,
            isAttachment: true
        });
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            await instagramService.sendMessage(
                senderId,
                'Thanks for the image! Our support team will review it shortly.'
            );
        } else {
            throw err;
        }
    }
}

// ─── Referral Handler ─────────────────────────────────────────

/**
 * Handle Instagram referral events (user opens conversation from ad/link).
 */
async function handleReferral(senderId, referral, timestamp) {
    console.log(`📸 [IG REFERRAL] From ${senderId}: ref=${referral.ref || 'unknown'}`);

    // Update 24h window
    await instagramService.updateMessagingWindow(senderId);

    // Treat as a greeting — bot engine will handle
    try {
        const botEngine = require('../handlers/igBotEngine');
        await botEngine.processMessage(senderId, 'referral', {
            referral: referral,
            timestamp
        });
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            await instagramService.sendMessage(
                senderId,
                'Welcome to OffComfrt! How can we help you today?'
            );
        } else {
            throw err;
        }
    }
}

// ─── Postback Handler ─────────────────────────────────────────

/**
 * Handle Instagram postback events (Get Started button, etc.).
 */
async function handlePostback(senderId, postback, timestamp) {
    const payload = postback.payload || 'get_started';
    console.log(`📸 [IG POSTBACK] From ${senderId}: ${payload}`);

    // Update 24h window
    await instagramService.updateMessagingWindow(senderId);

    try {
        const botEngine = require('../handlers/igBotEngine');
        await botEngine.processMessage(senderId, payload, {
            isPostback: true,
            timestamp
        });
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            await instagramService.sendMessage(
                senderId,
                `Welcome to OffComfrt!

I can help you with:

• Track your order
• Returns & Exchanges
• FAQs
• Contact support

How can I help you?`
            );
        } else {
            throw err;
        }
    }
}

// ─── Idempotency ──────────────────────────────────────────────

/**
 * Check if an Instagram message has already been processed.
 * Returns true if duplicate, false if new.
 * Records the message ID for future checks.
 */
async function checkIdempotency(messageId) {
    try {
        // Check if we've already seen this message ID
        const existing = await dbAdapter.query(
            'SELECT id FROM ig_webhook_idempotency WHERE ig_message_id = ? LIMIT 1',
            [messageId]
        );

        if (existing && existing.length > 0) {
            return true; // Duplicate
        }

        // Record this message ID
        await dbAdapter.query(
            'INSERT INTO ig_webhook_idempotency (ig_message_id, processed_at) VALUES (?, ?)',
            [messageId, new Date().toISOString()]
        );

        return false; // New message

    } catch (error) {
        // If unique constraint violation, it's a duplicate
        if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
            return true;
        }
        // On other errors, allow processing (fail open)
        console.error('[IG IDEM] Idempotency check failed:', error.message);
        return false;
    }
}

// ─── Cleanup Old Idempotency Records ──────────────────────────

/**
 * Remove idempotency records older than 7 days.
 * Safe to run periodically — old messages won't be re-processed.
 */
async function cleanupIdempotencyRecords() {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const result = await dbAdapter.run(
            'DELETE FROM ig_webhook_idempotency WHERE processed_at < ?',
            [sevenDaysAgo]
        );
        if (result.changes > 0) {
            console.log(`[IG] Cleaned up ${result.changes} old idempotency records`);
        }
    } catch (error) {
        console.error('[IG] Idempotency cleanup failed:', error.message);
    }
}

// Run cleanup every 6 hours
setInterval(cleanupIdempotencyRecords, 6 * 60 * 60 * 1000);

module.exports = router;
