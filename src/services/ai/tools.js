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
                limit: { type: 'integer', description: 'Number of recent messages (default 20, max 50)' }
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
                limit: { type: 'integer', description: 'Max tickets to return (default 20, max 50)' }
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
                ticketId: { type: 'integer', description: 'Support ticket ID' },
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
                limit: { type: 'integer', description: 'Max carts (default 20, max 50)' }
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
                limit: { type: 'integer', description: 'Max orders when listing recent (default 10, max 25)' }
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
                limit: { type: 'integer', description: 'Max results (default 20, max 50)' }
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
                shipmentId: { type: 'integer', description: 'Internal shipment ID (from list_shipments)' },
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
                limit: { type: 'integer', description: 'Max rows (default 20)' }
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
    check_serviceability: /\b(pin ?codes?|serviceab\w*|deliverable|cod|prepaid)\b/i,
    list_shipments: /\b(shipments?|shipped|awb|couriers?|labels?|manifest|shipping)\b/i,
    book_shipment: /\b(book\w*|ship\b|shipment|couriers?)\b/i,
    schedule_pickup: /\b(pick ?-?ups?)\b/i,
    send_whatsapp_message: /\b(send|message|whatsapp|reply|notify|inform|tell)\b/i,
    create_broadcast_draft: /\b(broadcasts?|campaigns?|blast|announce\w*)\b/i,
    run_sql_read: /\b(sql|query|database|db|tables?|select)\b/i,
    query_returns_system: /\b(returns?|exchanges?|influencers?|refunds?)\b/i
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
