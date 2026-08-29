const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { dbAdapter } = require('../database/db');
const { verifyToken, requireAdmin, PERMISSIONS, ALL_PERMISSION_KEYS } = require('../middleware/auth');

// ============================================================
// SMART LOGIN — Team / Operator management (admin only)
// Mounted at /api/admin → paths are /api/admin/operators/...
// ============================================================

// Sanitize an operator row for API responses (never leak the hash)
function publicOperator(op) {
    return {
        id: op.id,
        username: op.username,
        name: op.name,
        permissions: Array.isArray(op.permissions) ? op.permissions : [],
        is_active: op.is_active,
        last_login_at: op.last_login_at,
        created_at: op.created_at
    };
}

function sanitizePermissions(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter(p => ALL_PERMISSION_KEYS.includes(p)))];
}

// Permission catalog — drives the checkboxes in the Team UI
router.get('/operators/permissions', verifyToken, requireAdmin, (req, res) => {
    res.json({ success: true, permissions: PERMISSIONS });
});

// Current identity (lets the frontend re-validate a stored token)
router.get('/operators/me', verifyToken, (req, res) => {
    const identity = req.admin;
    res.json({
        success: true,
        role: identity.role,
        username: identity.username,
        operatorId: identity.operatorId || null,
        permissions: identity.role === 'admin' ? ALL_PERMISSION_KEYS : (identity.permissions || [])
    });
});

// Full activity feed across all operators (admin monitoring view)
router.get('/operators/activity', verifyToken, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const operatorId = parseInt(req.query.operatorId);

        let sql = 'SELECT * FROM hub_operator_activity';
        const params = [];
        if (operatorId) { sql += ' WHERE operator_id = ?'; params.push(operatorId); }
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = await dbAdapter.query(sql, params);
        res.json({ success: true, activity: rows });
    } catch (error) {
        console.error('Operator activity fetch error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch activity' });
    }
});

// Per-operator activity + summary stats (admin "see their working" view)
router.get('/operators/:id/activity', verifyToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);

        const [activity, summary] = await Promise.all([
            dbAdapter.query(
                'SELECT * FROM hub_operator_activity WHERE operator_id = ? ORDER BY created_at DESC LIMIT ?',
                [id, limit]
            ),
            dbAdapter.query(`
                SELECT
                    COUNT(*)::int AS total_actions,
                    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')::int AS actions_today,
                    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS actions_7d,
                    COUNT(*) FILTER (WHERE action = 'login')::int AS logins,
                    COUNT(*) FILTER (WHERE action = 'login_failed')::int AS failed_logins,
                    MAX(created_at) AS last_action_at
                FROM hub_operator_activity WHERE operator_id = ?
            `, [id])
        ]);

        res.json({ success: true, activity, summary: summary[0] || {} });
    } catch (error) {
        console.error('Operator activity fetch error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch activity' });
    }
});

// List all operators with usage stats
router.get('/operators', verifyToken, requireAdmin, async (req, res) => {
    try {
        const operators = await dbAdapter.query('SELECT * FROM hub_operators ORDER BY created_at ASC');
        const counts = await dbAdapter.query(`
            SELECT operator_id, COUNT(*)::int AS actions,
                   COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS actions_7d
            FROM hub_operator_activity WHERE operator_id IS NOT NULL GROUP BY operator_id
        `);
        const countMap = Object.fromEntries(counts.map(c => [c.operator_id, c]));

        res.json({
            success: true,
            operators: operators.map(op => ({
                ...publicOperator(op),
                total_actions: countMap[op.id]?.actions || 0,
                actions_7d: countMap[op.id]?.actions_7d || 0
            }))
        });
    } catch (error) {
        console.error('List operators error:', error);
        res.status(500).json({ success: false, error: 'Failed to list operators' });
    }
});

// Create operator
router.post('/operators', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { username, name, password, permissions } = req.body;
        const cleanUsername = (username || '').toString().trim().toLowerCase();

        if (!cleanUsername || !/^[a-z0-9._-]{3,30}$/.test(cleanUsername)) {
            return res.status(400).json({ success: false, error: 'Operator ID must be 3-30 characters (letters, numbers, . _ -)' });
        }
        if (!password || password.toString().length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }

        const existing = await dbAdapter.query('SELECT id FROM hub_operators WHERE LOWER(username) = ?', [cleanUsername]);
        if (existing.length > 0) {
            return res.status(409).json({ success: false, error: 'This operator ID already exists' });
        }

        const passwordHash = await bcrypt.hash(password.toString(), 10);
        const created = await dbAdapter.run(
            'INSERT INTO hub_operators (username, name, password_hash, permissions) VALUES (?, ?, ?, ?::jsonb) RETURNING *',
            [cleanUsername, (name || '').toString().trim() || null, passwordHash, JSON.stringify(sanitizePermissions(permissions))]
        );
        const operator = await dbAdapter.query('SELECT * FROM hub_operators WHERE id = ?', [created.lastInsertRowid]);

        res.json({ success: true, operator: publicOperator(operator[0]) });
    } catch (error) {
        console.error('Create operator error:', error);
        res.status(500).json({ success: false, error: 'Failed to create operator' });
    }
});

// Update operator (name, permissions, active status)
router.put('/operators/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name, permissions, is_active } = req.body;

        const existing = await dbAdapter.query('SELECT * FROM hub_operators WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, error: 'Operator not found' });
        }

        const newName = name !== undefined ? (name || '').toString().trim() || null : existing[0].name;
        const newPermissions = permissions !== undefined ? sanitizePermissions(permissions) : existing[0].permissions;
        const newActive = is_active !== undefined ? !!is_active : existing[0].is_active;

        // Deactivating the account also clears its single-session slot so any
        // live session dies immediately (verifyToken re-checks this per request)
        const sessionClear = newActive ? '' : ', active_session_id = NULL';
        await dbAdapter.run(
            `UPDATE hub_operators SET name = ?, permissions = ?::jsonb, is_active = ?${sessionClear}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [newName, JSON.stringify(newPermissions), newActive, id]
        );

        const operator = await dbAdapter.query('SELECT * FROM hub_operators WHERE id = ?', [id]);
        res.json({ success: true, operator: publicOperator(operator[0]) });
    } catch (error) {
        console.error('Update operator error:', error);
        res.status(500).json({ success: false, error: 'Failed to update operator' });
    }
});

// Reset password — returns the new password ONCE so admin can share it
router.post('/operators/:id/reset-password', verifyToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const newPassword = (req.body.password || '').toString();

        const existing = await dbAdapter.query('SELECT id FROM hub_operators WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, error: 'Operator not found' });
        }
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        // Clear the session slot too — the old session must not survive a reset
        await dbAdapter.run(
            'UPDATE hub_operators SET password_hash = ?, active_session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [passwordHash, id]
        );

        res.json({ success: true, message: 'Password updated. Share it with the operator — it will not be shown again.' });
    } catch (error) {
        console.error('Reset operator password error:', error);
        res.status(500).json({ success: false, error: 'Failed to reset password' });
    }
});

// Delete operator (keeps activity history rows for the audit trail)
router.delete('/operators/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const existing = await dbAdapter.query('SELECT id FROM hub_operators WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, error: 'Operator not found' });
        }

        await dbAdapter.run('DELETE FROM hub_operators WHERE id = ?', [id]);
        res.json({ success: true, message: 'Operator deleted' });
    } catch (error) {
        console.error('Delete operator error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete operator' });
    }
});

module.exports = router;
