const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ============================================================
// CREDENTIAL FINGERPRINTS — changing ADMIN_PASSWORD or
// SHOPPERS_HUB_PASSWORD in the environment instantly invalidates
// every previously issued admin JWT (tokens embed the fingerprint
// that was current at login time). No token blocklist needed.
// ============================================================
function adminCredentialFingerprint() {
    return crypto.createHash('sha256')
        .update(`admin-login|${process.env.ADMIN_USERNAME || ''}|${process.env.ADMIN_PASSWORD || ''}`)
        .digest('hex').slice(0, 16);
}

function hubCredentialFingerprint() {
    return crypto.createHash('sha256')
        .update(`shoppers-hub|${process.env.SHOPPERS_HUB_PASSWORD || ''}`)
        .digest('hex').slice(0, 16);
}

// Verify a JWT and enforce credential-fingerprint checks for admin tokens.
// Throws on any failure so callers can return a single 401 path.
async function verifyJwtOrThrow(token) {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') {
        const current = [adminCredentialFingerprint(), hubCredentialFingerprint()];
        if (!decoded.credFp || !current.includes(decoded.credFp)) {
            const err = new Error('Credentials changed');
            err.sessionExpired = true;
            throw err;
        }
        return decoded;
    }
    if (decoded.role === 'operator') {
        // Single-session enforcement: an operator may hold exactly ONE live
        // session across all platforms. Every login overwrites the account's
        // active_session_id, so the newest login wins and any earlier token
        // (other device, other window, stale tab) fails here. Admin is exempt.
        const { dbAdapter } = require('../database/db');
        const rows = await dbAdapter.query(
            'SELECT is_active, active_session_id FROM hub_operators WHERE id = ?',
            [decoded.operatorId]
        );
        const op = rows && rows[0];
        if (!op || !op.is_active) {
            const err = new Error('Account deactivated');
            err.sessionExpired = true;
            throw err;
        }
        if (!decoded.sid || !op.active_session_id || decoded.sid !== op.active_session_id) {
            const err = new Error('Session superseded');
            err.sessionExpired = true;
            err.loggedElsewhere = true;
            throw err;
        }
    }
    return decoded;
}

// ============================================================
// PERMISSION CATALOG — single source of truth for the smart
// login system. Drives both the API gate and the admin UI
// (checkbox labels come from here via GET /operators/permissions).
// ============================================================
const PERMISSIONS = {
    pages: [
        { key: 'shoppers', label: 'Shopper Confirmations', description: 'Main shopper list, filters, confirmations dashboard' },
        { key: 'inbox', label: 'Inbox & Live Chat', description: 'Customer messages inbox and live chat view' },
        { key: 'follow_up', label: 'Follow-Up Campaigns', description: 'Follow-up campaigns list and management' },
        { key: 'multi_orders', label: 'Multi Orders', description: 'Multi-order (repeat customer) view' },
        { key: 'shipped', label: 'Shipped Orders / Shipping', description: 'Shipped orders view and shipping module' },
        { key: 'analytics', label: 'Analytics', description: 'Analytics dashboards and reports' }
    ],
    functions: [
        { key: 'export', label: 'Export Data', description: 'Export shoppers / inbox data to files' },
        { key: 'edit_orders', label: 'Edit / Delete Shoppers', description: 'Edit shopper details, change status, delete records' },
        { key: 'send_messages', label: 'Send WhatsApp Messages', description: 'Reply to customers via live chat' },
        { key: 'ship_orders', label: 'Ship Orders', description: 'Create shipments, generate labels, cancel shipments' },
        { key: 'ai_copilot', label: 'AI Copilot', description: 'Use AI Copilot chat, suggestions and actions' }
    ]
};

const ALL_PERMISSION_KEYS = [
    ...PERMISSIONS.pages.map(p => p.key),
    ...PERMISSIONS.functions.map(f => f.key)
];

// Middleware to verify JWT token
async function verifyToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        req.admin = await verifyJwtOrThrow(token);
        next();
    } catch (error) {
        return res.status(401).json({ error: sessionErrorMessage(error) });
    }
}

// Human-readable 401 message for expired/superseded sessions
function sessionErrorMessage(error) {
    if (error.loggedElsewhere) {
        return 'Your session was ended — this account is logged in somewhere else. Only one active session is allowed.';
    }
    return error.sessionExpired
        ? 'Session expired. Password was changed — please log in again.'
        : 'Invalid token.';
}

// Middleware: only the master admin (env-based login) passes.
// Operators are always rejected.
function requireAdmin(req, res, next) {
    if (!req.admin) return res.status(401).json({ error: 'Access denied. No token provided.' });
    if (req.admin.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
}

function hasPermission(identity, key) {
    if (!identity) return false;
    if (identity.role === 'admin') return true; // master admin bypasses everything
    return Array.isArray(identity.permissions) && identity.permissions.includes(key);
}

// Middleware factory: require a single permission key.
// Admins always pass; operators must have the key in their JWT.
function requirePermission(key) {
    return (req, res, next) => {
        if (hasPermission(req.admin, key)) return next();
        return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    };
}

// Path-prefix → permission map for the permission gate.
// Longest prefix wins. Admin bypasses the gate entirely.
// key: null → admin-only section (operators always denied).
const ROUTE_PERMISSIONS = [
    { prefix: '/shoppers/export', key: 'export' },
    { prefix: '/inbox/export', key: 'export' },
    { prefix: '/shoppers/multi-orders', key: 'multi_orders' },
    { prefix: '/shoppers', key: 'shoppers' },
    { prefix: '/chat', key: 'inbox' },
    { prefix: '/follow-up', key: 'follow_up' },
    { prefix: '/shipping', key: 'shipped' },
    { prefix: '/analytics', key: 'analytics' },
    { prefix: '/ai/', key: 'ai_copilot' },
    { prefix: '/settings', key: null },
    { prefix: '/templates', key: null },
    { prefix: '/broadcast', key: null },
    { prefix: '/support-portals', key: null },
    { prefix: '/support-tickets', key: null },
    { prefix: '/upload', key: null },
    { prefix: '/shiprocket', key: null },
    { prefix: '/shopify', key: null },
    { prefix: '/sync', key: null },
    { prefix: '/offers', key: null },
    { prefix: '/zoho', key: null }
];

// Router-level gate mounted once in adminRoutes (after /login).
// Maps the request path to a page/function permission.
// Self-contained: verifies the JWT itself if verifyToken hasn't run yet.
async function permissionGate(req, res, next) {
    if (!req.admin) {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
        try {
            req.admin = await verifyJwtOrThrow(token);
        } catch (error) {
            return res.status(401).json({ error: sessionErrorMessage(error) });
        }
    }

    const identity = req.admin;
    if (identity.role === 'admin') return next();

    const path = req.path || '';
    let matched = null;
    for (const rule of ROUTE_PERMISSIONS) {
        if (path.startsWith(rule.prefix) && (!matched || rule.prefix.length > matched.prefix.length)) {
            matched = rule;
        }
    }

    if (!matched) return next(); // unmapped routes stay open to any logged-in operator
    if (hasPermission(identity, matched.key)) return next();
    return res.status(403).json({ error: 'You do not have permission to access this section.' });
}

// Fire-and-forget activity logger for operator audit trail.
// Never throws — auditing must not break the main request.
function logOperatorActivity(req, action, detail = '') {
    try {
        const identity = req.admin || {};
        // Only track operators; master-admin actions are not operator activity
        if (identity.role !== 'operator') return;
        const { dbAdapter } = require('../database/db');
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
        dbAdapter.run(
            'INSERT INTO hub_operator_activity (operator_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)',
            [identity.operatorId || null, identity.username || 'unknown', action, String(detail || '').slice(0, 500), ip]
        ).catch(err => console.error('Activity log insert failed:', err.message));
    } catch (err) {
        console.error('Activity log error:', err.message);
    }
}

module.exports = {
    verifyToken,
    requireAdmin,
    requirePermission,
    permissionGate,
    hasPermission,
    logOperatorActivity,
    adminCredentialFingerprint,
    hubCredentialFingerprint,
    PERMISSIONS,
    ALL_PERMISSION_KEYS
};
