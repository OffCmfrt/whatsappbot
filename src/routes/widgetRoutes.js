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
        const { sessionId, message } = req.body;

        if (!sessionId || !message) {
            return res.status(400).json({ error: 'sessionId and message are required' });
        }

        if (String(message).length > 1000) {
            return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
        }

        const result = await runCustomerAgent({ sessionId, message });

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

// ---------- POST /api/widget/context ----------
// Silently records an exchange handled outside the AI chat (e.g. the direct
// tracking card) into the AI session, so follow-up AI turns keep context.

router.post('/context', (req, res) => {
    try {
        const { sessionId, userMessage, botMessage, entities } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        appendSessionExchange({ sessionId, userMessage, botMessage, entities });
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

        // Remember the order ID in the AI session even though this request
        // bypasses the AI chat — so follow-ups like "where is my order"
        // already know which order the customer means.
        if (sessionId && orderId) {
            const cleanOrderId = String(orderId).replace(/^#/, '').trim();
            if (/^\d{3,6}$/.test(cleanOrderId)) {
                noteSessionContext({ sessionId, entities: { orderId: cleanOrderId } });
            }
        }

        let trackingResult = null;
        let carrierUsed = null;
        let resolvedAwb = awb || null;

        // Case 1: AWB provided — try all carriers in sequence
        if (awb) {
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
                    const result = await adapter.track(awb);
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
        if (!trackingResult && orderId) {
            const orderName = String(orderId).replace(/^#/, '').trim();

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
                        trackingResult = {
                            orderId: orderName,
                            fulfillmentStatus: shopperRows[0].status,
                            note: shopperRows[0].status === 'delivered'
                                ? 'Your order has been delivered.'
                                : 'Your order is being processed and will ship soon. Tracking will appear here once it ships.'
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
                                    note: 'Tracking not yet available. Please check back later or contact support.'
                                };
                                carrierUsed = 'shopify';
                            }
                        } else {
                            // No AWB yet — return order status
                            trackingResult = {
                                orderId: order.name,
                                fulfillmentStatus: order.fulfillment_status,
                                financialStatus: order.financial_status,
                                createdAt: order.created_at,
                                note: order.fulfillment_status === 'unfulfilled'
                                    ? 'Your order is being prepared and will ship soon.'
                                    : 'Tracking information is not yet available.'
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
            ? rawTimeline.map(t => ({
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

// ---------- POST /api/widget/ticket ----------
// Create a support ticket from the widget (escalation)

router.post('/ticket', async (req, res) => {
    try {
        const { name, phone, email, message, orderId } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        if (!phone && !email) {
            return res.status(400).json({ error: 'Phone or email is required' });
        }

        const result = await createWidgetTicket({ name, phone, email, message, orderId });

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

module.exports = router;
