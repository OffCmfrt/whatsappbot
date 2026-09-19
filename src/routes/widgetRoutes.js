/**
 * Widget API routes — customer-facing support widget endpoints.
 *
 * POST /api/widget/chat        — AI-powered conversation
 * POST /api/widget/context     — Record non-AI exchanges into the AI session
 * POST /api/widget/track-order — Multi-carrier order tracking
 * POST /api/widget/ticket      — Create support ticket (escalation)
 * GET  /api/widget/session     — Initialize session, return brand config
 */

const express = require('express');
const router = express.Router();
const { runCustomerAgent, createWidgetTicket, noteSessionContext, appendSessionExchange } = require('../services/ai/customerAgent');
const { getAdapter, getConfiguredCarriers } = require('../services/carriers');

function normalizeExternalRequest(request) {
    return {
        request_id: request.request_id || request.requestId || request.id || null,
        order_number: request.order_number || request.orderNumber || request.order_id || null,
        type: request.type || 'return',
        status: request.status || 'Pending',
        reason: request.reason || null,
        items: Array.isArray(request.items) ? request.items : [],
        created_at: request.created_at || request.createdAt || null
    };
}

async function findExternalReturnRequests(query) {
    const baseUrl = process.env.RETURNS_SERVER_URL;
    if (!baseUrl) return [];

    const axios = require('axios');
    const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/ai-data`, {
        params: { resource: 'requests', query, limit: 20 },
        headers: { 'x-internal-token': process.env.WHATSAPP_INTERNAL_TOKEN || '' },
        timeout: 15000
    });

    return Array.isArray(response.data?.requests)
        ? response.data.requests.map(normalizeExternalRequest)
        : [];
}

// ---------- Rate limiter for widget endpoints ----------

const widgetLimiter = require('express-rate-limit')({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again in a minute.' }
});

router.use(widgetLimiter);

// ---------- GET /api/widget/session ----------
// Returns brand config and WhatsApp number for the widget to use

router.get('/session', (req, res) => {
    try {
        const businessNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
        res.json({
            brandName: 'OFFCOMFRT',
            tagline: 'How can we help you today?',
            whatsappNumber: businessNumber,
            carriers: getConfiguredCarriers().map(c => ({ key: c.key, name: c.name }))
        });
    } catch (error) {
        console.error('[widget] session error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- POST /api/widget/chat ----------
// AI-powered conversation for the customer widget

router.post('/chat', async (req, res) => {
    try {
        const { sessionId, message, visitorId } = req.body;

        if (!sessionId || !message) {
            return res.status(400).json({ error: 'sessionId and message are required' });
        }

        if (String(message).length > 1000) {
            return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
        }

        const result = await runCustomerAgent({ sessionId, message, visitorId });

        res.json({
            reply: result.reply,
            suggestedAction: result.suggestedAction,
            cardType: result.cardType || null,
            cardData: result.cardData || null
        });
    } catch (error) {
        console.error('[widget] chat error:', error.message);

        // Graceful fallback — never show raw errors to customers
        if (error.code === 'AI_RATE_LIMIT') {
            return res.status(429).json({
                reply: 'I am a bit busy right now. Please try again in a moment, or reach out on WhatsApp for immediate help.',
                suggestedAction: null
            });
        }

        res.status(500).json({
            reply: 'Sorry, something went wrong. Please try again or contact us on WhatsApp.',
            suggestedAction: null
        });
    }
});

// ---------- POST /api/widget/event ----------
// Persists client-rendered widget events (menu messages and rich cards) that
// do not run through the AI agent, so the admin can replay the full chat.
router.post('/event', async (req, res) => {
    try {
        const { sessionId, visitorId, sender, content, richContent } = req.body || {};
        if (!sessionId || !['customer', 'bot'].includes(sender) || !String(content || '').trim()) {
            return res.status(400).json({ error: 'sessionId, sender, and content are required' });
        }
        if (String(content).length > 5000 || (richContent && JSON.stringify(richContent).length > 30000)) {
            return res.status(400).json({ error: 'Widget event is too large' });
        }

        const now = new Date().toISOString();
        const { dbAdapter } = require('../database/db');
        await dbAdapter.run(
            `INSERT INTO widget_chats (session_id, sender, content, rich_content, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [sessionId, sender, String(content), richContent ? JSON.stringify(richContent) : null, now]
        );
        await dbAdapter.run(
            `INSERT INTO widget_chat_sessions (session_id, message_count, last_message_at, visitor_id, created_at)
             VALUES ($1, 1, $2, $3, $2)
             ON CONFLICT (session_id) DO UPDATE SET
               message_count = widget_chat_sessions.message_count + 1,
               last_message_at = $2,
               visitor_id = COALESCE($3, widget_chat_sessions.visitor_id)`,
            [sessionId, now, visitorId || null]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error('[widget] event persist error:', error.message);
        res.status(500).json({ error: 'Unable to save widget event' });
    }
});

// ---------- POST /api/widget/context ----------
// Silently records an exchange handled outside the AI chat (e.g. the direct
// tracking card) into the AI session, so follow-up AI turns keep context.

router.post('/context', async (req, res) => {
    try {
        const { sessionId, userMessage, botMessage, entities } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        await appendSessionExchange({ sessionId, userMessage, botMessage, entities });
        res.json({ ok: true });
    } catch (error) {
        console.error('[widget] context error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- POST /api/widget/track-order ----------
// Multi-carrier order tracking (Delhivery -> Ekart -> Shiprocket)

router.post('/track-order', async (req, res) => {
    try {
        const { orderId, awb, phone, sessionId } = req.body;

        if (!orderId && !awb && !phone) {
            return res.status(400).json({ error: 'Provide an order ID or phone number' });
        }

        let cleanAwb = awb ? String(awb).trim() : null;
        let cleanOrderId = null;

        if (orderId) {
            const raw = String(orderId).trim();
            // AWB: 10-16 digit numbers
            const awbMatch = raw.match(/\b(\d{10,16})\b/);
            if (awbMatch && !cleanAwb) {
                cleanAwb = awbMatch[1];
            }
            // Order ID: #53388, ORD-53388, 53388 order status, or standalone 4-6 digits
            const orderMatch = raw.match(/#(\d{4,6})/i)
                || raw.match(/\b(?:ORD|ORDER)[-_ #]?(\d{4,6})\b/i)
                || raw.match(/\b(\d{4,6})\b/)
                || raw.match(/(\d{4,6})/);
            if (orderMatch) {
                cleanOrderId = orderMatch[1];
            } else {
                cleanOrderId = raw.replace(/^#/, '').replace(/\s/g, '');
            }
        }

        // Remember the order ID in the AI session
        if (sessionId && cleanOrderId) {
            if (/^\d{3,6}$/.test(cleanOrderId)) {
                await noteSessionContext({ sessionId, entities: { orderId: cleanOrderId } });
            }
        }

        let trackingResult = null;
        let carrierUsed = null;
        let resolvedAwb = cleanAwb || null;

        // Case 1: AWB provided — try all carriers in sequence
        if (cleanAwb) {
            const carriers = getConfiguredCarriers().map(c => c.key);
            // Prefer Delhivery -> Ekart -> Shiprocket order
            const preferredOrder = ['delhivery', 'ekart', 'shiprocket'];
            const orderedCarriers = preferredOrder.filter(c => carriers.includes(c));
            // Add any remaining carriers not in preferred list
            carriers.forEach(c => { if (!orderedCarriers.includes(c)) orderedCarriers.push(c); });

            for (const carrierKey of orderedCarriers) {
                try {
                    const adapter = getAdapter(carrierKey);
                    if (!adapter || !adapter.isConfigured()) continue;
                    const result = await adapter.track(cleanAwb);
                    if (result && result.success !== false && result.data) {
                        trackingResult = result.data;
                        carrierUsed = carrierKey;
                        break;
                    }
                } catch (e) {
                    // Try next carrier
                    continue;
                }
            }
        }

        // Case 2: Order ID provided — resolve AWB internally (customer never needs one)
        if (!trackingResult && cleanOrderId) {
            const orderName = cleanOrderId;

            // 2a. Shoppers Hub shipment data — shipments/orders tables carry the booked AWB
            try {
                const { dbAdapter } = require('../database/db');
                let shipmentAwb = null;
                let shipmentCarrier = null;

                const shipRows = await dbAdapter.query(
                    `SELECT carrier, awb FROM shipments
                     WHERE order_id = ? AND awb IS NOT NULL
                     ORDER BY CASE WHEN status NOT IN ('cancelled', 'failed') THEN 0 ELSE 1 END, id DESC
                     LIMIT 1`,
                    [orderName]
                );
                if (shipRows && shipRows.length > 0) {
                    shipmentAwb = shipRows[0].awb;
                    shipmentCarrier = shipRows[0].carrier;
                }

                if (!shipmentAwb) {
                    const orderRows = await dbAdapter.query(
                        'SELECT awb, courier_name FROM orders WHERE order_id = ? LIMIT 1',
                        [orderName]
                    );
                    shipmentAwb = orderRows?.[0]?.awb || null;
                }

                if (shipmentAwb) {
                    resolvedAwb = shipmentAwb;
                    const carriers = getConfiguredCarriers().map(c => c.key);
                    const orderedCarriers = shipmentCarrier && carriers.includes(shipmentCarrier)
                        ? [shipmentCarrier, ...carriers.filter(c => c !== shipmentCarrier)]
                        : carriers;

                    for (const carrierKey of orderedCarriers) {
                        try {
                            const adapter = getAdapter(carrierKey);
                            if (!adapter || !adapter.isConfigured()) continue;
                            const result = await adapter.track(shipmentAwb);
                            if (result && result.success !== false && result.data) {
                                trackingResult = result.data;
                                carrierUsed = carrierKey;
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }

                    // AWB exists but no live tracking yet — still report the order
                    if (!trackingResult) {
                        trackingResult = {
                            awb: shipmentAwb,
                            orderId: orderName,
                            note: 'Your order has been shipped. Live tracking updates will appear here shortly.'
                        };
                        carrierUsed = shipmentCarrier || 'shopify';
                    }
                } else {
                    // No AWB yet — check if the order exists in Shoppers Hub and report its stage
                    const shopperRows = await dbAdapter.query(
                        'SELECT status FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
                        [orderName]
                    );
                    if (shopperRows && shopperRows.length > 0) {
                        const shopperStatus = (shopperRows[0].status || '').toLowerCase();
                        let note;
                        if (shopperStatus === 'delivered') {
                            note = 'Your order has been delivered.';
                        } else if (shopperStatus === 'confirmed') {
                            note = 'Your order will be shipped within 24 to 48 hours.';
                        } else {
                            note = 'Please confirm your order via the template message sent to you.';
                        }
                        trackingResult = {
                            orderId: orderName,
                            fulfillmentStatus: shopperRows[0].status,
                            note: note
                        };
                        carrierUsed = 'shopify';
                    }
                }
            } catch (hubErr) {
                console.warn('[widget] Shoppers Hub lookup failed:', hubErr.message);
            }

            // 2b. Fallback: Shopify fulfillment lookup
            if (!trackingResult) {
            try {
                const axios = require('axios');
                const shop = process.env.SHOPIFY_STORE;
                const token = process.env.SHOPIFY_ACCESS_TOKEN;

                if (shop && token) {
                    const orderName = String(orderId).replace(/^#/, '');
                    const url = `https://${shop}/admin/api/2024-01/orders.json?name=${encodeURIComponent(orderName)}&status=any`;
                    const response = await axios.get(url, {
                        headers: { 'X-Shopify-Access-Token': token },
                        timeout: 10000
                    });

                    const order = response.data?.orders?.[0];
                    if (order) {
                        // Try to get fulfillment tracking info
                        const fulfillment = order.fulfillments?.[0];
                        const trackingInfo = fulfillment?.tracking_info?.[0] || fulfillment?.tracking_info;
                        const orderAwb = trackingInfo?.number || trackingInfo?.tracking_number;

                        if (orderAwb) {
                            resolvedAwb = orderAwb;
                            // Now track this AWB across carriers
                            const carriers = getConfiguredCarriers().map(c => c.key);
                            const preferredOrder = ['delhivery', 'ekart', 'shiprocket'];
                            const orderedCarriers = preferredOrder.filter(c => carriers.includes(c));

                            for (const carrierKey of orderedCarriers) {
                                try {
                                    const adapter = getAdapter(carrierKey);
                                    if (!adapter || !adapter.isConfigured()) continue;
                                    const result = await adapter.track(orderAwb);
                                    if (result && result.success !== false && result.data) {
                                        trackingResult = result.data;
                                        carrierUsed = carrierKey;
                                        break;
                                    }
                                } catch (e) {
                                    continue;
                                }
                            }

                            // If no carrier had tracking, return order info at least
                            if (!trackingResult) {
                                trackingResult = {
                                    awb: orderAwb,
                                    orderId: order.name,
                                    fulfillmentStatus: order.fulfillment_status,
                                    financialStatus: order.financial_status,
                                    createdAt: order.created_at,
                                    note: 'Your order will be shipped within 24 to 48 hours.'
                                };
                                carrierUsed = 'shopify';
                            }
                        } else {
                            // No AWB yet — return order status
                            const isUnfulfilled = !order.fulfillment_status || order.fulfillment_status === 'unfulfilled';
                            let note;
                            if (!isUnfulfilled) {
                                note = 'Your order will be shipped within 24 to 48 hours.';
                            } else {
                                // Re-check Shoppers Hub for accurate pending vs confirmed messaging
                                let hubNote = null;
                                try {
                                    const { dbAdapter } = require('../database/db');
                                    const hubRows = await dbAdapter.query(
                                        'SELECT status FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
                                        [order.name]
                                    );
                                    if (hubRows && hubRows.length > 0) {
                                        const hs = (hubRows[0].status || '').toLowerCase();
                                        hubNote = hs === 'confirmed'
                                            ? 'Your order will be shipped within 24 to 48 hours.'
                                            : 'Please confirm your order via the template message sent to you.';
                                    }
                                } catch (e) { /* best-effort */ }
                                note = hubNote || 'Please confirm your order via the template message sent to you.';
                            }
                            trackingResult = {
                                orderId: order.name,
                                fulfillmentStatus: order.fulfillment_status,
                                financialStatus: order.financial_status,
                                createdAt: order.created_at,
                                note: note
                            };
                            carrierUsed = 'shopify';
                        }
                    }
                }
            } catch (shopifyErr) {
                console.warn('[widget] Shopify lookup failed:', shopifyErr.message);
            }
            }
        }

        if (!trackingResult) {
            return res.status(404).json({
                error: 'No tracking data found. Please verify your order number and try again.',
                triedCarriers: getConfiguredCarriers().map(c => c.name)
            });
        }

        // Format the response for the widget UI.
        // Carrier adapters return the normalized shape
        //   { currentStatus, expectedDelivery, timeline: [{date, location, activity, status}] }
        // while raw Shiprocket payloads use shipment_track[0] with snake_case keys —
        // support both so the card never renders empty.
        const trackData = trackingResult.shipment_track?.[0] || trackingResult;

        const rawTimeline = trackingResult.timeline
            || trackData.timeline
            || trackData.track_status
            || trackingResult.shipment_track_activities
            || trackData.shipment_track_activities
            || null;

        const timeline = Array.isArray(rawTimeline)
            ? rawTimeline.filter(Boolean).map(t => ({
                date: t.date || t.ScanDateTime || null,
                location: t.location || t.ScannedLocation || '',
                activity: t.activity || t.description || t.Instructions || t.status || '',
                status: t.status || ''
            }))
            : null;

        // Most recent scan (by date) gives us the current location
        let latestScan = null;
        if (timeline && timeline.length) {
            latestScan = timeline.reduce((a, b) => {
                const da = Date.parse(a?.date || '') || 0;
                const db = Date.parse(b?.date || '') || 0;
                return db > da ? b : a;
            });
        }

        res.json({
            carrier: carrierUsed,
            carrierName: carrierUsed === 'shopify' ? 'Shopify' : (getConfiguredCarriers().find(c => c.key === carrierUsed)?.name || carrierUsed),
            awb: trackData.awb_code || trackData.awb || resolvedAwb || null,
            orderId: orderId ? String(orderId).replace(/^#/, '').trim() : null,
            status: trackData.currentStatus || trackData.current_status || trackData.fulfillmentStatus || 'Unknown',
            location: trackData.current_location || latestScan?.location || null,
            shippedDate: trackData.shipped_date || null,
            expectedDelivery: trackData.expectedDelivery || trackData.edd || trackData.etd || null,
            deliveredDate: trackData.delivered_date || null,
            trackingUrl: trackData.tracking_url || null,
            note: trackData.note || null,
            timeline: timeline
        });

    } catch (error) {
        console.error('[widget] track-order error:', error.message);
        res.status(500).json({ error: 'Failed to fetch tracking information. Please try again.' });
    }
});

// ---------- POST /api/widget/lookup-order ----------
// Look up customer details (name, phone, email) from order number

router.post('/lookup-order', async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ error: 'Order ID is required' });
        }

        const { dbAdapter } = require('../database/db');
        const cleanOrderId = String(orderId).replace(/^#/, '').trim();

        // Look up customer details from store_shoppers table
        const shopperRows = await dbAdapter.query(
            `SELECT name, phone, email FROM store_shoppers
             WHERE order_id = ?
             ORDER BY created_at DESC LIMIT 1`,
            [cleanOrderId]
        );

        if (shopperRows && shopperRows.length > 0) {
            const row = shopperRows[0];
            // Only return first name for friendly greeting (e.g. "Thanks, Ketan.")
            // Never expose phone number or email over public unauthenticated endpoint
            const firstName = (row.name || '').trim().split(/\s+/)[0] || null;

            res.json({
                success: true,
                name: firstName,
                phone: null,
                email: null
            });
        } else {
            res.json({
                success: false,
                name: null,
                phone: null,
                email: null
            });
        }
    } catch (error) {
        console.error('[widget] lookup-order error:', error.message);
        res.status(500).json({ error: 'Failed to lookup order details' });
    }
});

// ---------- POST /api/widget/ticket ----------
// Create a support ticket from the widget (escalation)

router.post('/ticket', async (req, res) => {
    try {
        const { name, phone, email, message, orderId, source, sessionId, visitorId } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const result = await createWidgetTicket({ name, phone, email, message, orderId, source, sessionId, visitorId });

        res.json({
            success: true,
            ticketNumber: result.ticketNumber,
            whatsappLink: result.whatsappLink
        });
    } catch (error) {
        console.error('[widget] ticket error:', error.message);
        res.status(500).json({ error: 'Failed to create support ticket. Please try again.' });
    }
});

// ---------- POST /api/widget/track-request ----------
// Track return/exchange requests from external returns server + local tables

router.post('/track-request', async (req, res) => {
    try {
        const { orderId, requestId } = req.body;
        if (!orderId && !requestId) {
            return res.status(400).json({ error: 'Order ID or Request ID is required' });
        }

        const { dbAdapter } = require('../database/db');

        // --- Request ID lookup (REQ-XXXX) ---
        if (requestId) {
            const reqId = String(requestId).trim().toUpperCase();
            const bareId = reqId.replace(/^REQ-/, '');

            // Check local returns table
            const returnRows = await dbAdapter.query(
                `SELECT return_id, order_id, reason, status, pickup_scheduled_date, refund_amount, created_at
                 FROM returns WHERE return_id = ? OR return_id = ? ORDER BY created_at DESC LIMIT 5`,
                [reqId, bareId]
            );
            // Check local exchanges table
            const exchangeRows = await dbAdapter.query(
                `SELECT exchange_id, order_id, reason, status, pickup_scheduled_date, created_at
                 FROM exchanges WHERE exchange_id = ? OR exchange_id = ? ORDER BY created_at DESC LIMIT 5`,
                [reqId, bareId]
            );

            const localReturns = returnRows.map(r => ({
                request_id: r.return_id,
                order_number: r.order_id,
                type: 'return',
                status: r.status,
                reason: r.reason,
                items: [],
                created_at: r.created_at
            }));
            const localExchanges = exchangeRows.map(r => ({
                request_id: r.exchange_id,
                order_number: r.order_id,
                type: 'exchange',
                status: r.status,
                reason: r.reason,
                items: [],
                created_at: r.created_at
            }));

            // Search the returns system directly. The inventory-open-requests feed is
            // intentionally limited and can omit active exchanges or older requests.
            let externalRequests = [];
            try {
                externalRequests = (await findExternalReturnRequests(reqId)).filter(r => {
                    const externalId = String(r.request_id || '').toUpperCase();
                    return externalId === reqId || externalId === bareId;
                });
            } catch (err) {
                console.warn('[widget] returns server request search failed:', err.message);
            }

            const allRequests = [
                ...externalRequests.map(r => ({
                    request_id: r.request_id,
                    order_number: r.order_number,
                    type: r.type,
                    status: r.status,
                    reason: r.reason || null,
                    items: Array.isArray(r.items) ? r.items : [],
                    created_at: r.created_at
                })),
                ...localReturns,
                ...localExchanges
            ];

            // Deduplicate by request_id
            const seen = new Set();
            const deduped = allRequests.filter(r => {
                const key = String(r.request_id).toUpperCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            return res.json({
                requestId: reqId,
                requests: deduped,
                count: deduped.length
            });
        }

        // --- Order ID lookup ---
        const rawOrder = orderId ? String(orderId).trim() : '';
        const orderMatch = rawOrder.match(/#(\d{4,6})/i)
            || rawOrder.match(/\b(?:ORD|ORDER)[-_ #]?(\d{4,6})\b/i)
            || rawOrder.match(/\b(\d{4,6})\b/)
            || rawOrder.match(/(\d{4,6})/);
        const cleanOrderId = orderMatch ? orderMatch[1] : rawOrder.replace(/^#/, '').trim();

        // Search by order number rather than using the limited inventory feed.
        // This includes active, completed, and historical portal requests.
        let requests = [];
        try {
            requests = (await findExternalReturnRequests(cleanOrderId)).filter(r =>
                String(r.order_number || '').replace(/^#/, '').trim() === cleanOrderId
            );
        } catch (err) {
            console.warn('[widget] returns server request search failed:', err.message);
        }

        // Check local tables — match with and without # prefix
        const returnRows = await dbAdapter.query(
            `SELECT return_id, order_id, reason, status, pickup_scheduled_date, refund_amount, created_at
             FROM returns WHERE (order_id = ? OR order_id = ? OR order_id LIKE ?) ORDER BY created_at DESC LIMIT 5`,
            [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`]
        );
        const exchangeRows = await dbAdapter.query(
            `SELECT exchange_id, order_id, reason, status, pickup_scheduled_date, created_at
             FROM exchanges WHERE (order_id = ? OR order_id = ? OR order_id LIKE ?) ORDER BY created_at DESC LIMIT 5`,
            [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`]
        );

        const localReturns = returnRows.map(r => ({
            request_id: r.return_id,
            order_number: r.order_id,
            type: 'return',
            status: r.status,
            reason: r.reason,
            items: [],
            created_at: r.created_at
        }));
        const localExchanges = exchangeRows.map(r => ({
            request_id: r.exchange_id,
            order_number: r.order_id,
            type: 'exchange',
            status: r.status,
            reason: r.reason,
            items: [],
            created_at: r.created_at
        }));

        const allRequests = [
            ...requests.map(r => ({
                request_id: r.request_id,
                order_number: r.order_number,
                type: r.type,
                status: r.status,
                reason: r.reason || null,
                items: Array.isArray(r.items) ? r.items : [],
                created_at: r.created_at
            })),
            ...localReturns,
            ...localExchanges
        ];

        // Deduplicate by request_id
        const seen = new Set();
        const deduped = allRequests.filter(r => {
            const key = String(r.request_id || '').toUpperCase() + '|' + (r.order_number || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        res.json({
            orderId: cleanOrderId,
            requests: deduped,
            count: deduped.length
        });
    } catch (error) {
        console.error('[widget] track-request error:', error.message);
        res.status(500).json({ error: 'Failed to fetch request data' });
    }
});

// ---------- GET /api/widget/poll ----------
// Widget polls this to check for admin override messages since a given message ID.
// Returns any new messages (admin or otherwise) the widget hasn't seen yet.

router.get('/poll', async (req, res) => {
    try {
        const { sessionId, afterId } = req.query;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        const { dbAdapter } = require('../database/db');
        let query = 'SELECT id, sender, content, created_at FROM widget_chats WHERE session_id = $1';
        const params = [sessionId];

        if (afterId) {
            query += ' AND id > $2';
            params.push(parseInt(afterId) || 0);
        }
        query += ' ORDER BY created_at ASC LIMIT 20';

        const messages = await dbAdapter.query(query, params);

        // Also check if admin is active on this session
        const sessRows = await dbAdapter.query(
            'SELECT admin_active FROM widget_chat_sessions WHERE session_id = $1',
            [sessionId]
        );
        const adminActive = sessRows?.[0]?.admin_active || false;

        res.json({ messages: messages || [], adminActive });
    } catch (error) {
        console.error('[widget] poll error:', error.message);
        res.status(500).json({ error: 'Poll failed' });
    }
});

module.exports = router;
