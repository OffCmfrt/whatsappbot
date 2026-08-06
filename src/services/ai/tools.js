/**
 * AI Copilot tool registry (whatsappbot).
 *
 * Each tool: { name, description, parameters (JSON Schema), requiresConfirmation,
 *              summary(args) — human-readable action description,
 *              execute(args, ctx) — runs the tool and returns a JSON-serializable result }
 *
 * Tools marked requiresConfirmation are NEVER executed directly by the agent loop;
 * they are stored as pending actions and executed only after an explicit admin confirm.
 */

const axios = require('axios');
const { dbAdapter } = require('../../database/db');
const Settings = require('../../models/Settings');

const MAX_ROWS = 100;

function truncateRows(rows, limit = MAX_ROWS) {
    if (!Array.isArray(rows)) return rows;
    return rows.length > limit ? rows.slice(0, limit) : rows;
}

// ---------- SELECT-only SQL guard ----------

const SQL_BLOCKLIST = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|do|call|execute|prepare|listen|notify|set|reset|comment|refresh|reindex|cluster|lock|merge)\b/i;

function validateReadOnlySql(sql) {
    if (!sql || typeof sql !== 'string') return 'SQL query is required';
    const trimmed = sql.trim();
    if (trimmed.includes(';')) return 'Multiple statements / semicolons are not allowed';
    const noComments = trimmed.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!/^(select|with)\b/i.test(noComments)) return 'Only SELECT queries are allowed';
    if (SQL_BLOCKLIST.test(noComments)) return 'Query contains a blocked keyword — only read-only SELECT queries are allowed';
    return null;
}

// ---------- Tool definitions ----------

const tools = [
    {
        name: 'query_stats',
        description: 'Get high-level dashboard statistics: total customers, orders, messages, open support tickets, pending abandoned carts.',
        parameters: { type: 'object', properties: {}, required: [] },
        requiresConfirmation: false,
        async execute() {
            const [customers, orders, messages, tickets, carts] = await Promise.all([
                dbAdapter.query('SELECT COUNT(*)::int AS c FROM customers'),
                dbAdapter.query('SELECT COUNT(*)::int AS c FROM orders'),
                dbAdapter.query('SELECT COUNT(*)::int AS c FROM messages'),
                dbAdapter.query(`SELECT COUNT(*)::int AS c FROM support_tickets WHERE status = 'open'`),
                dbAdapter.query(`SELECT COUNT(*)::int AS c FROM abandoned_carts WHERE status = 'pending'`)
            ]);
            return {
                totalCustomers: customers[0]?.c || 0,
                totalOrders: orders[0]?.c || 0,
                totalMessages: messages[0]?.c || 0,
                openTickets: tickets[0]?.c || 0,
                pendingAbandonedCarts: carts[0]?.c || 0
            };
        }
    },
    {
        name: 'search_customers',
        description: 'Search customers by name, phone or email (partial match). Returns up to 20 matches with order counts.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name, phone digits or email fragment to search for' }
            },
            required: ['query']
        },
        requiresConfirmation: false,
        async execute({ query }) {
            const q = `%${String(query).trim()}%`;
            const rows = await dbAdapter.query(
                `SELECT phone, name, email, order_count, created_at FROM customers
                 WHERE phone ILIKE ? OR name ILIKE ? OR email ILIKE ?
                 ORDER BY updated_at DESC NULLS LAST LIMIT 20`,
                [q, q, q]
            );
            return { count: rows.length, customers: rows };
        }
    },
    {
        name: 'search_messages',
        description: 'Get the recent WhatsApp conversation (incoming and outgoing messages) for a customer phone number.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Customer phone number (any format)' },
                limit: { type: ['integer', 'string'], description: 'Number of recent messages (default 20, max 50)' }
            },
            required: ['phone']
        },
        requiresConfirmation: false,
        async execute({ phone, limit }) {
            const digits = String(phone).replace(/\D/g, '');
            const n = Math.min(parseInt(limit) || 20, 50);
            const rows = await dbAdapter.query(
                `SELECT message_type, message_content, status, created_at FROM messages
                 WHERE customer_phone LIKE ? ORDER BY id DESC LIMIT ?`,
                [`%${digits.slice(-10)}`, n]
            );
            return { count: rows.length, messages: rows.reverse() };
        }
    },
    {
        name: 'list_tickets',
        description: 'List support tickets, optionally filtered by status (open/resolved/closed) or customer phone.',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', description: 'Filter by status: open, resolved, closed' },
                phone: { type: 'string', description: 'Filter by customer phone' },
                limit: { type: ['integer', 'string'], description: 'Max tickets to return (default 20, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ status, phone, limit }) {
            const params = [];
            let sql = 'SELECT id, ticket_number, customer_phone, customer_name, message, status, portal_id, created_at, updated_at FROM support_tickets WHERE 1=1';
            if (status) { sql += ' AND status = ?'; params.push(status); }
            if (phone) { sql += ' AND customer_phone LIKE ?'; params.push(`%${String(phone).replace(/\D/g, '').slice(-10)}`); }
            sql += ' ORDER BY created_at DESC LIMIT ?';
            params.push(Math.min(parseInt(limit) || 20, 50));
            const rows = await dbAdapter.query(sql, params);
            return { count: rows.length, tickets: rows };
        }
    },
    {
        name: 'search_learned_replies',
        description: 'Find approved replies our support team previously sent for similar customer questions. Use when drafting a reply to match proven wording and policies.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The customer question or topic to match' }
            },
            required: ['question']
        },
        requiresConfirmation: false,
        async execute({ question }) {
            const { findSimilarExamples } = require('./learning');
            const examples = await findSimilarExamples(question, 3);
            return { count: examples.length, examples };
        }
    },
    {
        name: 'update_ticket',
        description: 'Update a support ticket status (open, resolved, closed). Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                ticketId: { type: ['integer', 'string'], description: 'Support ticket ID' },
                status: { type: 'string', enum: ['open', 'resolved', 'closed'], description: 'New status' }
            },
            required: ['ticketId', 'status']
        },
        requiresConfirmation: true,
        summary: (args) => `Update support ticket #${args.ticketId} status to "${args.status}"`,
        async execute({ ticketId, status }) {
            const rows = await dbAdapter.query('SELECT id, status, customer_phone FROM support_tickets WHERE id = ?', [ticketId]);
            if (!rows.length) throw new Error(`Ticket ${ticketId} not found`);
            await dbAdapter.update('support_tickets', { status, updated_at: new Date().toISOString() }, { id: ticketId });
            // Outcome signal for AI learning: resolution means recent replies worked
            if ((status === 'resolved' || status === 'closed') && rows[0].customer_phone) {
                const { boostFromResolvedTicket } = require('./learning');
                boostFromResolvedTicket(rows[0].customer_phone).catch(() => {});
            }
            return { ticketId, previousStatus: rows[0].status, newStatus: status };
        }
    },
    {
        name: 'get_abandoned_carts',
        description: 'List abandoned checkout carts, optionally filtered by status (pending/recovered/expired).',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', description: 'Filter: pending, recovered, expired' },
                limit: { type: ['integer', 'string'], description: 'Max carts (default 20, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ status, limit }) {
            const params = [];
            let sql = 'SELECT checkout_id, customer_phone, customer_name, total_amount, currency, status, created_at, recovered_at FROM abandoned_carts WHERE 1=1';
            if (status) { sql += ' AND status = ?'; params.push(status); }
            sql += ' ORDER BY created_at DESC LIMIT ?';
            params.push(Math.min(parseInt(limit) || 20, 50));
            const rows = await dbAdapter.query(sql, params);
            return { count: rows.length, carts: rows };
        }
    },
    {
        name: 'shopify_search_orders',
        description: 'Search Shopify orders by order name/number (e.g. "#1234") or fetch recent orders. Returns live data from the Shopify Admin API.',
        parameters: {
            type: 'object',
            properties: {
                orderName: { type: 'string', description: 'Order name like #1234 (omit to list recent orders)' },
                limit: { type: ['integer', 'string'], description: 'Max orders when listing recent (default 10, max 25)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderName, limit }) {
            const shop = process.env.SHOPIFY_STORE;
            const token = process.env.SHOPIFY_ACCESS_TOKEN;
            if (!shop || !token) throw new Error('Shopify is not configured on this server');
            const fields = 'id,name,created_at,total_price,currency,financial_status,fulfillment_status,customer,line_items,shipping_address';
            let url;
            if (orderName) {
                const name = String(orderName).replace(/^#/, '');
                url = `https://${shop}/admin/api/2024-01/orders.json?name=${encodeURIComponent(name)}&status=any&fields=${fields}`;
            } else {
                const n = Math.min(parseInt(limit) || 10, 25);
                url = `https://${shop}/admin/api/2024-01/orders.json?status=any&limit=${n}&fields=${fields}`;
            }
            const response = await axios.get(url, {
                headers: { 'X-Shopify-Access-Token': token },
                timeout: 15000
            });
            const orders = (response.data?.orders || []).map(o => ({
                id: o.id,
                name: o.name,
                createdAt: o.created_at,
                total: o.total_price,
                currency: o.currency,
                financialStatus: o.financial_status,
                fulfillmentStatus: o.fulfillment_status,
                customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : null,
                phone: o.customer?.phone || o.shipping_address?.phone || null,
                items: (o.line_items || []).map(li => `${li.title} x${li.quantity}`)
            }));
            return { count: orders.length, orders };
        }
    },
    {
        name: 'track_awb',
        description: 'Track a shipment by AWB / waybill number using the configured carrier (Delhivery or Shiprocket). Returns the tracking timeline.',
        parameters: {
            type: 'object',
            properties: {
                awb: { type: 'string', description: 'AWB / waybill number' },
                carrier: { type: 'string', enum: ['delhivery', 'shiprocket'], description: 'Carrier (default: try Delhivery first, then Shiprocket)' }
            },
            required: ['awb']
        },
        requiresConfirmation: false,
        async execute({ awb, carrier }) {
            const { getAdapter, getConfiguredCarriers } = require('../carriers');
            const order = carrier ? [carrier] : getConfiguredCarriers().map(c => c.key);
            const errors = [];
            for (const key of order) {
                try {
                    const adapter = getAdapter(key);
                    if (!adapter || !adapter.isConfigured()) continue;
                    const result = await adapter.track(awb);
                    if (result && result.success !== false) {
                        return { carrier: key, tracking: result.data || result };
                    }
                    errors.push(`${key}: ${result?.error || 'no data'}`);
                } catch (e) {
                    errors.push(`${key}: ${e.message}`);
                }
            }
            return { error: `No tracking data found for AWB ${awb}`, attempts: errors };
        }
    },
    {
        name: 'track_order_by_id',
        description: 'Track a shipment using ONLY the OFFCOMFRT order ID (the 4-5 digit order number, e.g. "42000" or "#42000"). Resolves the AWB internally from Shoppers Hub shipment data and returns live carrier tracking. Customers never need to provide an AWB — always prefer this tool over track_awb for customer queries.',
        parameters: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Order ID / order number (e.g. "42000" or "#42000")' }
            },
            required: ['orderId']
        },
        requiresConfirmation: false,
        async execute({ orderId }) {
            const name = String(orderId || '').replace(/^#/, '').trim();
            if (!name) return { error: 'Order ID is required' };

            // 1. Shoppers Hub shipment record — carries the AWB + carrier we booked with
            let shipment = null;
            try {
                const rows = await dbAdapter.query(
                    `SELECT order_id, carrier, awb, courier_name, status, tracking_url, created_at
                     FROM shipments
                     WHERE order_id = ? AND awb IS NOT NULL
                     ORDER BY CASE WHEN status NOT IN ('cancelled', 'failed') THEN 0 ELSE 1 END, id DESC
                     LIMIT 1`,
                    [name]
                );
                shipment = rows[0] || null;
            } catch (e) { /* shipments table may not exist yet */ }

            // 2. Fallback: cached orders table
            let orderRow = null;
            try {
                const rows = await dbAdapter.query(
                    `SELECT order_id, status, awb, courier_name, expected_delivery, created_at
                     FROM orders WHERE order_id = ? LIMIT 1`,
                    [name]
                );
                orderRow = rows[0] || null;
            } catch (e) { /* ignore */ }

            const awb = shipment?.awb || orderRow?.awb || null;

            // 3. Live carrier tracking — try the booking carrier first, then the rest
            if (awb) {
                const { getAdapter, getConfiguredCarriers } = require('../carriers');
                const preferred = shipment?.carrier ? [shipment.carrier] : [];
                const carrierOrder = [
                    ...preferred,
                    ...getConfiguredCarriers().map(c => c.key).filter(k => !preferred.includes(k))
                ];
                const errors = [];
                for (const key of carrierOrder) {
                    try {
                        const adapter = getAdapter(key);
                        if (!adapter || !adapter.isConfigured()) continue;
                        const result = await adapter.track(awb);
                        if (result && result.success !== false) {
                            return { carrier: key, orderId: name, awb, tracking: result.data || result };
                        }
                        errors.push(`${key}: ${result?.error || 'no data'}`);
                    } catch (e) {
                        errors.push(`${key}: ${e.message}`);
                    }
                }
                return {
                    orderId: name,
                    awb,
                    shipmentStatus: shipment?.status || orderRow?.status || null,
                    note: 'Shipment found but live tracking is not available yet. Please check back later.',
                    attempts: errors
                };
            }

            // 4. No AWB yet — report what Shoppers Hub knows about the order
            let shopper = null;
            try {
                const rows = await dbAdapter.query(
                    `SELECT order_id, status, product_name, delivery_type
                     FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
                    [name]
                );
                shopper = rows[0] || null;
            } catch (e) { /* ignore */ }

            if (shipment || shopper || orderRow) {
                return {
                    orderId: name,
                    awb: null,
                    shipmentStatus: shipment?.status || null,
                    shopperStatus: shopper?.status || null,
                    orderStatus: orderRow?.status || null,
                    note: 'This order has not been handed to a courier yet, so live tracking is not available. Tracking will appear here as soon as it ships.'
                };
            }

            return { error: `No order found with ID ${name}` };
        }
    },
    {
        name: 'check_serviceability',
        description: 'Check whether a delivery pincode is serviceable (COD / prepaid availability) with the configured carriers.',
        parameters: {
            type: 'object',
            properties: {
                pincode: { type: 'string', description: '6-digit delivery pincode' },
                paymentMode: { type: 'string', enum: ['COD', 'Prepaid'], description: 'Payment mode (default Prepaid)' }
            },
            required: ['pincode']
        },
        requiresConfirmation: false,
        async execute({ pincode, paymentMode }) {
            const { getConfiguredCarriers, getAdapter } = require('../carriers');
            const ctx = {
                consignee: { pincode: String(pincode) },
                payment: { mode: paymentMode || 'Prepaid' }
            };
            const results = {};
            for (const c of getConfiguredCarriers()) {
                try {
                    const adapter = getAdapter(c.key);
                    const r = await adapter.checkServiceability(ctx);
                    results[c.key] = r.success === false ? { error: r.error } : (r.data || r);
                } catch (e) {
                    results[c.key] = { error: e.message };
                }
            }
            return results;
        }
    },
    {
        name: 'list_shipments',
        description: 'List shipments created via the Shopper Hub shipping module, optionally filtered by order ID or status.',
        parameters: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Filter by order ID' },
                status: { type: 'string', description: 'Filter by shipment status' },
                limit: { type: ['integer', 'string'], description: 'Max results (default 20, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, status, limit }) {
            const shippingService = require('../shippingService');
            const rows = await shippingService.listShipments({ orderId, status, limit: Math.min(parseInt(limit) || 20, 50) });
            return { count: rows.length, shipments: truncateRows(rows, 50) };
        }
    },
    {
        name: 'book_shipment',
        description: 'Create a shipment (book a courier) for a confirmed shopper order via the shipping module. Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                shopperId: { type: 'string', description: 'Shopper record ID (from store_shoppers)' },
                carrier: { type: 'string', enum: ['delhivery', 'shiprocket'], description: 'Carrier to use' },
                courierId: { type: 'string', description: 'Courier ID (Shiprocket only, optional)' }
            },
            required: ['shopperId', 'carrier']
        },
        requiresConfirmation: true,
        summary: (args) => `Book a ${args.carrier} shipment for shopper order ${args.shopperId}`,
        async execute({ shopperId, carrier, courierId }) {
            const shippingService = require('../shippingService');
            const result = await shippingService.ship({ shopperId, carrier, courierId, shippedBy: 'ai-copilot' });
            return result;
        }
    },
    {
        name: 'schedule_pickup',
        description: 'Schedule a courier pickup for an existing shipment. Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                shipmentId: { type: ['integer', 'string'], description: 'Internal shipment ID (from list_shipments)' },
                pickupDate: { type: 'string', description: 'Pickup date YYYY-MM-DD' }
            },
            required: ['shipmentId', 'pickupDate']
        },
        requiresConfirmation: true,
        summary: (args) => `Schedule pickup for shipment #${args.shipmentId} on ${args.pickupDate}`,
        async execute({ shipmentId, pickupDate }) {
            const shippingService = require('../shippingService');
            return await shippingService.schedulePickup(shipmentId, pickupDate);
        }
    },
    {
        name: 'send_whatsapp_message',
        description: 'Send a WhatsApp text message to a customer. Requires admin confirmation. Note: free-form messages only deliver inside the 24h customer service window.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Customer phone number' },
                message: { type: 'string', description: 'Message text to send' }
            },
            required: ['phone', 'message']
        },
        requiresConfirmation: true,
        summary: (args) => `Send WhatsApp message to ${args.phone}: "${String(args.message).substring(0, 120)}${String(args.message).length > 120 ? '…' : ''}"`,
        async execute({ phone, message }) {
            const whatsappService = require('../whatsappService');
            const result = await whatsappService.sendMessage(phone, message);
            if (result === false) throw new Error('Message rejected by Meta (recipient not in allowed test list)');
            return { sent: true, messageId: result?.messages?.[0]?.id || null };
        }
    },
    {
        name: 'create_broadcast_draft',
        description: 'Create a DRAFT broadcast campaign record (title, message, segment). It is NOT sent — an admin must review and send it from the Broadcasts page. Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Broadcast title' },
                message: { type: 'string', description: 'Broadcast message text' },
                segment: { type: 'string', description: 'Target segment: all, pending_orders, delivered, etc. (default all)' }
            },
            required: ['title', 'message']
        },
        requiresConfirmation: true,
        summary: (args) => `Create draft broadcast "${args.title}" for segment "${args.segment || 'all'}" (will NOT be sent automatically)`,
        async execute({ title, message, segment }) {
            const row = await dbAdapter.insert('broadcasts', {
                title: `[DRAFT] ${title}`,
                message,
                segment: segment || 'all',
                total_recipients: 0,
                sent_count: 0,
                failed_count: 0,
                created_by: 'ai-copilot',
                created_at: new Date().toISOString()
            });
            return { draftId: row?.id || null, title: `[DRAFT] ${title}`, note: 'Draft saved. Review and send it manually from the Broadcasts page.' };
        }
    },
    {
        name: 'run_sql_read',
        description: 'Run a read-only SQL SELECT query against the bot database (PostgreSQL). Tables: customers, orders, messages, support_tickets, support_portals, broadcasts, abandoned_carts, store_shoppers, shipments, returns, exchanges, follow_up_campaigns, follow_up_recipients, system_settings. Only SELECT is allowed; results capped at 100 rows.',
        parameters: {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'A single SELECT statement (no semicolons)' }
            },
            required: ['sql']
        },
        requiresConfirmation: false,
        async execute({ sql }) {
            const validationError = validateReadOnlySql(sql);
            if (validationError) throw new Error(validationError);
            const wrapped = `SELECT * FROM (${sql.trim()}) AS ai_sub LIMIT ${MAX_ROWS}`;
            const rows = await dbAdapter.query(wrapped, []);
            return { rowCount: rows.length, rows: truncateRows(rows), truncatedAt: MAX_ROWS };
        }
    },
    {
        name: 'query_returns_system',
        description: 'Query the exchange/return tracking system (separate server) for return/exchange requests, influencer stats or marketing data. Ask a resource: requests, request_stats, influencers, settings.',
        parameters: {
            type: 'object',
            properties: {
                resource: { type: 'string', enum: ['requests', 'request_stats', 'influencers'], description: 'What to fetch from the returns system' },
                query: { type: 'string', description: 'Optional filter, e.g. order number or status' },
                limit: { type: ['integer', 'string'], description: 'Max rows (default 20)' }
            },
            required: ['resource']
        },
        requiresConfirmation: false,
        async execute({ resource, query, limit }) {
            const baseUrl = process.env.RETURNS_SERVER_URL;
            const token = process.env.WHATSAPP_INTERNAL_TOKEN;
            if (!baseUrl) throw new Error('RETURNS_SERVER_URL is not configured on this server');
            const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/ai-data`, {
                params: { resource, query: query || '', limit: Math.min(parseInt(limit) || 20, 50) },
                headers: { 'x-internal-token': token || '' },
                timeout: 15000
            });
            return response.data;
        }
    },
    // ---------- Batch / bulk tools ----------
    {
        name: 'batch_update_tickets',
        description: 'Update multiple support tickets at once (resolve, close, or reopen). Requires admin confirmation. Returns count of affected tickets.',
        parameters: {
            type: 'object',
            properties: {
                ticketIds: { type: 'string', description: 'Comma-separated ticket IDs, e.g. "12,15,18"' },
                status: { type: 'string', enum: ['open', 'resolved', 'closed'], description: 'New status for all selected tickets' },
                filterStatus: { type: 'string', description: 'Alternatively, update ALL tickets matching this status (open/resolved/closed)' },
                filterPortalId: { type: ['integer', 'string'], description: 'Limit filter to a specific support portal ID' }
            },
            required: ['status']
        },
        requiresConfirmation: true,
        summary: (args) => {
            if (args.ticketIds) return `Update ${String(args.ticketIds).split(',').length} ticket(s) to "${args.status}"`;
            return `Update all "${args.filterStatus || 'open'}" tickets to "${args.status}"`;
        },
        async execute({ ticketIds, status, filterStatus, filterPortalId }) {
            let ids = [];
            if (ticketIds) {
                ids = String(ticketIds).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
            } else if (filterStatus) {
                let sql = 'SELECT id FROM support_tickets WHERE status = ?';
                const params = [filterStatus];
                if (filterPortalId) { sql += ' AND portal_id = ?'; params.push(filterPortalId); }
                sql += ' LIMIT 100';
                const rows = await dbAdapter.query(sql, params);
                ids = rows.map(r => r.id);
            }
            if (!ids.length) throw new Error('No tickets matched the criteria');
            const now = new Date().toISOString();
            for (const id of ids) {
                await dbAdapter.update('support_tickets', { status, updated_at: now }, { id });
            }
            return { updated: ids.length, ticketIds: ids, newStatus: status };
        }
    },
    {
        name: 'bulk_send_whatsapp',
        description: 'Send the same WhatsApp message to multiple customers. Requires admin confirmation. Max 50 recipients per call. Free-form messages only deliver inside the 24h service window.',
        parameters: {
            type: 'object',
            properties: {
                phones: { type: 'string', description: 'Comma-separated phone numbers, or a segment keyword: "all_customers", "open_tickets", "pending_carts"' },
                message: { type: 'string', description: 'Message text to send to all recipients' }
            },
            required: ['phones', 'message']
        },
        requiresConfirmation: true,
        summary: (args) => {
            const count = /^all_customers|open_tickets|pending_carts$/i.test(args.phones) ? args.phones : String(args.phones).split(',').length;
            return `Send WhatsApp to ${count} recipient(s): "${String(args.message).substring(0, 80)}…"`;
        },
        async execute({ phones, message }) {
            const whatsappService = require('../whatsappService');
            let recipients = [];
            const segment = String(phones).trim();
            if (/^all_customers$/i.test(segment)) {
                const rows = await dbAdapter.query('SELECT phone FROM customers LIMIT 50');
                recipients = rows.map(r => r.phone);
            } else if (/^open_tickets$/i.test(segment)) {
                const rows = await dbAdapter.query('SELECT DISTINCT customer_phone FROM support_tickets WHERE status = \'open\' LIMIT 50');
                recipients = rows.map(r => r.customer_phone);
            } else if (/^pending_carts$/i.test(segment)) {
                const rows = await dbAdapter.query('SELECT DISTINCT customer_phone FROM abandoned_carts WHERE status = \'pending\' LIMIT 50');
                recipients = rows.map(r => r.customer_phone);
            } else {
                recipients = segment.split(',').map(p => p.trim()).filter(Boolean).slice(0, 50);
            }
            if (!recipients.length) throw new Error('No recipients found');
            const results = { sent: 0, failed: 0, errors: [] };
            for (const phone of recipients) {
                try {
                    const r = await whatsappService.sendMessage(phone, message);
                    if (r === false) results.failed++;
                    else results.sent++;
                } catch (e) {
                    results.failed++;
                    results.errors.push(`${phone}: ${e.message}`);
                }
            }
            return { ...results, totalRecipients: recipients.length };
        }
    },
    {
        name: 'batch_book_shipments',
        description: 'Book shipments for multiple shopper orders at once. Requires admin confirmation. Max 25 per batch.',
        parameters: {
            type: 'object',
            properties: {
                shopperIds: { type: 'string', description: 'Comma-separated shopper record IDs' },
                carrier: { type: 'string', enum: ['delhivery', 'shiprocket'], description: 'Carrier to use for all shipments' }
            },
            required: ['shopperIds', 'carrier']
        },
        requiresConfirmation: true,
        summary: (args) => `Book ${String(args.shopperIds).split(',').length} ${args.carrier} shipment(s)`,
        async execute({ shopperIds, carrier }) {
            const shippingService = require('../shippingService');
            const ids = String(shopperIds).split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
            if (!ids.length) throw new Error('No shopper IDs provided');
            const results = { booked: 0, failed: 0, errors: [] };
            for (const shopperId of ids) {
                try {
                    await shippingService.ship({ shopperId, carrier, shippedBy: 'ai-copilot-batch' });
                    results.booked++;
                } catch (e) {
                    results.failed++;
                    results.errors.push(`${shopperId}: ${e.message}`);
                }
            }
            return { ...results, carrier };
        }
    },
    {
        name: 'smart_triage_tickets',
        description: 'AI-powered analysis of open support tickets: groups them by topic, estimates priority, and suggests portal assignment. Read-only — does not modify tickets.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: ['integer', 'string'], description: 'Max tickets to analyze (default 30, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ limit }) {
            const n = Math.min(parseInt(limit) || 30, 50);
            const rows = await dbAdapter.query(
                `SELECT id, ticket_number, customer_phone, customer_name, message, status, portal_id, created_at
                 FROM support_tickets WHERE status = 'open' ORDER BY created_at ASC LIMIT ?`,
                [n]
            );
            // Simple keyword-based triage (no extra AI call needed)
            const categories = {
                'Order Status': /\b(where|status|track|when|deliver|arriv|ship)\b/i,
                'Return/Exchange': /\b(return|exchange|refund|replace|size|wrong)\b/i,
                'Payment': /\b(payment|pay|cod|prepaid|refund|upi|card|money)\b/i,
                'Product Query': /\b(product|stock|available|size|color|material|fabric)\b/i,
                'Complaint': /\b(complain|bad|worst|damage|defect|broken|poor)\b/i,
                'General': /./
            };
            const triaged = rows.map(t => {
                let category = 'General';
                for (const [cat, pattern] of Object.entries(categories)) {
                    if (pattern.test(t.message || '')) { category = cat; break; }
                }
                const ageHours = Math.round((Date.now() - new Date(t.created_at).getTime()) / 3600000);
                const priority = ageHours > 48 ? 'high' : ageHours > 24 ? 'medium' : 'low';
                return { id: t.id, ticket_number: t.ticket_number, customer_name: t.customer_name, message: String(t.message || '').substring(0, 120), category, priority, ageHours, portal_id: t.portal_id };
            });
            const summary = {};
            triaged.forEach(t => { summary[t.category] = (summary[t.category] || 0) + 1; });
            return { total: triaged.length, categorySummary: summary, tickets: triaged };
        }
    },
    {
        name: 'get_pending_shipments',
        description: 'List shopper orders that are confirmed but not yet shipped. Shows order details ready for batch shipment booking.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: ['integer', 'string'], description: 'Max results (default 25, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ limit }) {
            const n = Math.min(parseInt(limit) || 25, 50);
            const rows = await dbAdapter.query(
                `SELECT id, customer_name, customer_phone, product_name, total_amount, status, created_at
                 FROM store_shoppers
                 WHERE status IN ('confirmed', 'processing')
                 ORDER BY created_at ASC LIMIT ?`,
                [n]
            );
            return { count: rows.length, pendingShipment: rows };
        }
    },
    // ---------- Customer-facing tools ----------
    {
        name: 'search_orders_by_phone',
        description: 'Look up a customer\'s recent orders using their phone number. Returns order IDs, status, and basic details.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Customer phone number (with or without country code)' }
            },
            required: ['phone']
        },
        requiresConfirmation: false,
        async execute({ phone }) {
            const digits = String(phone || '').replace(/\D/g, '');
            const phonePattern = `%${digits.slice(-10)}`;
            const rows = await dbAdapter.query(
                `SELECT order_id, status, awb, courier_name, total, payment_method, expected_delivery, created_at
                 FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 5`,
                [phonePattern]
            );
            return { count: rows.length, orders: rows };
        }
    },
    {
        name: 'faq_lookup',
        description: 'Search the knowledge base of learned FAQ replies for answers to common customer questions about OFFCOMFRT policies, shipping, returns, etc.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'Customer question to find a matching FAQ answer for' }
            },
            required: ['question']
        },
        requiresConfirmation: false,
        async execute({ question }) {
            const { findSimilarExamples } = require('./learning');
            const examples = await findSimilarExamples(question, 3);
            return {
                count: examples.length,
                answers: examples.map(e => ({ question: e.q, answer: e.a, relevance: e.uses }))
            };
        }
    },
    {
        name: 'check_return_eligibility',
        description: 'Check if an order is eligible for return/exchange based on delivery date (within 2-day window).',
        parameters: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Order ID to check eligibility for' }
            },
            required: ['orderId']
        },
        requiresConfirmation: false,
        async execute({ orderId }) {
            const name = String(orderId || '').replace(/^#/, '');
            const rows = await dbAdapter.query(
                `SELECT order_id, status, created_at, expected_delivery
                 FROM orders WHERE order_id = ? LIMIT 1`,
                [name]
            );
            if (!rows.length) return { eligible: false, reason: 'Order not found' };
            const order = rows[0];
            // Check if order is delivered and within 2-day return window
            const deliveredDate = order.status?.toLowerCase().includes('delivered')
                ? new Date(order.created_at)
                : null;
            if (!deliveredDate) return { eligible: false, reason: 'Order not yet delivered', status: order.status };
            const daysSinceDelivery = (Date.now() - deliveredDate.getTime()) / (1000 * 60 * 60 * 24);
            const eligible = daysSinceDelivery <= 2;
            return {
                eligible,
                orderId: order.order_id,
                status: order.status,
                daysSinceDelivery: Math.round(daysSinceDelivery * 10) / 10,
                reason: eligible ? 'Within 2-day return window' : 'Return window expired (more than 2 days since delivery)',
                portalUrl: 'offcomfrt.in → Support → Return/Exchange'
            };
        }
    },
    {
        name: 'check_return_exchange_status',
        description: 'Look up the customer\'s actual return and exchange requests (live status from the returns system). Use when a customer asks about the status of a return, exchange, refund, or pickup — e.g. "has my return been approved", "when is the pickup", "where is my refund". Accepts a request ID with REQ- prefix (e.g. "REQ-12345"), an order ID (preferred), or a phone number.',
        parameters: {
            type: 'object',
            properties: {
                requestId: { type: 'string', description: 'Return/exchange request ID with REQ- prefix (e.g. "REQ-12345")' },
                orderId: { type: 'string', description: 'Order ID the return/exchange was filed for (e.g. "42000")' },
                phone: { type: 'string', description: 'Customer phone number — fallback lookup if no order ID is known' }
            }
        },
        requiresConfirmation: false,
        async execute({ requestId, orderId, phone }) {
            const reqId = String(requestId || '').trim().toUpperCase();
            const name = String(orderId || '').replace(/^#/, '').trim();
            const digits = String(phone || '').replace(/\D/g, '');

            // Direct request-ID match first (REQ- prefix IDs from the returns portal)
            if (reqId) {
                const bareId = reqId.replace(/^REQ-/, '');
                const returnRows = await dbAdapter.query(
                    `SELECT return_id, order_id, reason, status, pickup_scheduled_date,
                            refund_amount, refund_status, created_at, updated_at
                     FROM returns WHERE return_id = ? OR return_id = ? ORDER BY created_at DESC LIMIT 3`,
                    [reqId, bareId]
                );
                const exchangeRows = await dbAdapter.query(
                    `SELECT exchange_id, order_id, old_items, new_items, reason, status,
                            price_difference, payment_status, pickup_scheduled_date, created_at, updated_at
                     FROM exchanges WHERE exchange_id = ? OR exchange_id = ? ORDER BY created_at DESC LIMIT 3`,
                    [reqId, bareId]
                );
                if (returnRows.length || exchangeRows.length) {
                    const safeParse = (v) => {
                        if (!v || typeof v !== 'string') return v;
                        try { return JSON.parse(v); } catch { return v; }
                    };
                    return {
                        found: true,
                        returns: returnRows.map(r => ({ ...r, items: safeParse(r.items) })),
                        exchanges: exchangeRows.map(e => ({ ...e, old_items: safeParse(e.old_items), new_items: safeParse(e.new_items) }))
                    };
                }
                // Fall through to order/phone lookup in case the customer mixed up IDs
            }

            const clauses = [];
            const params = [];
            if (name) { clauses.push('order_id = ?'); params.push(name); }
            if (digits.length >= 10) { clauses.push('customer_phone LIKE ?'); params.push(`%${digits.slice(-10)}`); }
            if (!clauses.length) {
                return { error: 'Provide a REQ- request ID, orderId, or phone number to look up return/exchange requests' };
            }
            const where = `(${clauses.join(' OR ')})`;

            const returnRows = await dbAdapter.query(
                `SELECT return_id, order_id, reason, status, pickup_scheduled_date,
                        refund_amount, refund_status, created_at, updated_at
                 FROM returns WHERE ${where} ORDER BY created_at DESC LIMIT 3`,
                params
            );

            const exchangeRows = await dbAdapter.query(
                `SELECT exchange_id, order_id, old_items, new_items, reason, status,
                        price_difference, payment_status, pickup_scheduled_date, created_at, updated_at
                 FROM exchanges WHERE ${where} ORDER BY created_at DESC LIMIT 3`,
                params
            );

            // items / old_items / new_items are stored as JSON strings
            const safeParse = (v) => {
                if (!v || typeof v !== 'string') return v;
                try { return JSON.parse(v); } catch { return v; }
            };
            const returns = returnRows.map(r => ({ ...r, items: safeParse(r.items) }));
            const exchanges = exchangeRows.map(e => ({ ...e, old_items: safeParse(e.old_items), new_items: safeParse(e.new_items) }));

            if (!returns.length && !exchanges.length) {
                return {
                    found: false,
                    message: 'No return or exchange request found for this order/phone',
                    hint: 'Requests must be submitted via the returns page at offcomfrt.in/pages/return within 2 days of delivery'
                };
            }

            return { found: true, returns, exchanges };
        }
    }
];

const toolMap = new Map(tools.map(t => [t.name, t]));

function getTool(name) {
    return toolMap.get(name) || null;
}

/** OpenAI-format tool definitions for the chat completions API. */
function getToolSchemas() {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
}

// ---------- Token-lean tool routing ----------
// Tool schemas are re-sent on every agent round and dominate the request size,
// so we only send the tools whose triggers match the conversation context.
// run_sql_read is always included as a generic escape hatch; if nothing
// matches, the full toolbox is sent so capability is never lost.
const TOOL_TRIGGERS = {
    query_stats: /\b(stats?|statistics|overview|summary|dashboard|how many|total|count)\b/i,
    search_customers: /\b(customers?|shoppers?|buyers?|clients?|who is|email|phone|number|contact)\b/i,
    search_messages: /\b(messages?|chats?|conversations?|whatsapp|said|replied|history)\b/i,
    list_tickets: /\b(tickets?|support|complaints?|issues?|queries|grievance)\b/i,
    search_learned_replies: /\b(reply|replies|respond|draft|answer|suggest\w*|how (do|did|should) we)\b/i,
    update_ticket: /\b(tickets?|resolve|closed?|reopen)\b/i,
    get_abandoned_carts: /\b(carts?|abandon\w*|checkouts?|recover\w*)\b/i,
    shopify_search_orders: /\b(orders?|shopify|purchases?|bought|payments?|refunds?|fulfill?\w*|cod|prepaid)\b|#\d+/i,
    track_awb: /\b(track\w*|awb|waybill|shipments?|couriers?|deliver\w*|transit|shipping)\b/i,
    track_order_by_id: /\b(track\w*|orders?|status|where|deliver\w*|ship\w*)\b|#?\d{4,5}/i,
    check_serviceability: /\b(pin ?codes?|serviceab\w*|deliverable|cod|prepaid)\b/i,
    list_shipments: /\b(shipments?|shipped|awb|couriers?|labels?|manifest|shipping)\b/i,
    book_shipment: /\b(book\w*|ship\b|shipment|couriers?)\b/i,
    schedule_pickup: /\b(pick ?-?ups?)\b/i,
    send_whatsapp_message: /\b(send|message|whatsapp|reply|notify|inform|tell)\b/i,
    create_broadcast_draft: /\b(broadcasts?|campaigns?|blast|announce\w*)\b/i,
    run_sql_read: /\b(sql|query|database|db|tables?|select)\b/i,
    query_returns_system: /\b(returns?|exchanges?|influencers?|refunds?)\b/i,
    check_return_exchange_status: /\b(returns?|exchanges?|refunds?|pickups?)\b|req-\d+/i,
    batch_update_tickets: /\b(batch|bulk|mass|all tickets|resolve all|close all)\b/i,
    bulk_send_whatsapp: /\b(bulk\s*send|broadcast\s*whatsapp|mass\s*message|send\s*to\s*all)\b/i,
    batch_book_shipments: /\b(batch\s*ship|bulk\s*ship|ship\s*all|book\s*all)\b/i,
    smart_triage_tickets: /\b(triage|categorize|classify|prioritiz|sort\s*tickets)\b/i,
    get_pending_shipments: /\b(pending\s*ship|unshipped|not\s*shipped|ready\s*to\s*ship)\b/i
};

/** Pick only the tool schemas relevant to the given conversation context. */
function selectToolSchemas(contextText) {
    const text = String(contextText || '');
    const names = new Set(
        tools.filter(t => TOOL_TRIGGERS[t.name] && TOOL_TRIGGERS[t.name].test(text)).map(t => t.name)
    );
    if (!names.size) return getToolSchemas(); // ambiguous intent — full toolbox
    names.add('run_sql_read'); // generic fallback so routing misses stay answerable
    return tools
        .filter(t => names.has(t.name))
        .map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
}

/** Human-readable summary for a confirmation-gated action. */
function summarizeTool(name, args) {
    const tool = getTool(name);
    if (!tool) return name;
    if (typeof tool.summary === 'function') {
        try { return tool.summary(args || {}); } catch { return name; }
    }
    return `${name}(${JSON.stringify(args || {})})`;
}

module.exports = { tools, getTool, getToolSchemas, selectToolSchemas, summarizeTool, validateReadOnlySql };
