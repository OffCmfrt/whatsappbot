/**
 * AI data store — pending actions, chat history, usage logging, daily limits.
 * Backed by the shared Supabase PostgreSQL pool (dbAdapter).
 */

const { dbAdapter } = require('../../database/db');
const { computeCostUsd } = require('./aiClient');

const PENDING_ACTION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const HISTORY_MAX_TURNS = 20;

// ---------- Pending actions (confirmation flow) ----------

async function createPendingAction({ actor, toolName, toolArgs, summary }) {
    const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString();
    const row = await dbAdapter.insert('ai_pending_actions', {
        actor,
        tool_name: toolName,
        tool_args: JSON.stringify(toolArgs || {}),
        summary: summary || toolName,
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: expiresAt
    });
    return row;
}

async function getPendingAction(id) {
    const rows = await dbAdapter.query('SELECT * FROM ai_pending_actions WHERE id = ?', [id]);
    return rows[0] || null;
}

async function updatePendingAction(id, fields) {
    await dbAdapter.update('ai_pending_actions', fields, { id });
}

/**
 * Claim a pending action for execution (validates actor, status, expiry).
 * Returns { ok, action?, error? }.
 */
async function claimPendingAction(id, actor) {
    const action = await getPendingAction(id);
    if (!action) return { ok: false, error: 'Action not found' };
    if (action.actor !== actor) return { ok: false, error: 'This action belongs to another user' };
    if (action.status !== 'pending') return { ok: false, error: `Action is already ${action.status}` };
    if (action.expires_at && new Date(action.expires_at).getTime() < Date.now()) {
        await updatePendingAction(id, { status: 'expired' });
        return { ok: false, error: 'Action expired (10 minute limit). Please ask the copilot again.' };
    }
    await updatePendingAction(id, { status: 'confirmed' });
    return { ok: true, action };
}

async function cancelPendingAction(id, actor) {
    const action = await getPendingAction(id);
    if (!action) return { ok: false, error: 'Action not found' };
    if (action.actor !== actor) return { ok: false, error: 'This action belongs to another user' };
    if (action.status !== 'pending') return { ok: false, error: `Action is already ${action.status}` };
    await updatePendingAction(id, { status: 'cancelled' });
    return { ok: true };
}

// ---------- Chat history ----------

async function getChatHistory(actor) {
    const rows = await dbAdapter.query(
        'SELECT role, content FROM ai_chat_history WHERE actor = ? ORDER BY id DESC LIMIT ?',
        [actor, HISTORY_MAX_TURNS]
    );
    return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

async function appendChatHistory(actor, role, content) {
    await dbAdapter.insert('ai_chat_history', {
        actor,
        role,
        content: typeof content === 'string' ? content.substring(0, 8000) : JSON.stringify(content),
        created_at: new Date().toISOString()
    });
}

async function pruneChatHistory(actor) {
    // Keep only the newest HISTORY_MAX_TURNS rows per actor
    await dbAdapter.run(
        `DELETE FROM ai_chat_history WHERE actor = ? AND id NOT IN (
            SELECT id FROM ai_chat_history WHERE actor = ? ORDER BY id DESC LIMIT ?
        )`,
        [actor, actor, HISTORY_MAX_TURNS]
    );
}

async function clearChatHistory(actor) {
    await dbAdapter.run('DELETE FROM ai_chat_history WHERE actor = ?', [actor]);
}

// ---------- Usage logging & daily limits ----------

async function logUsage({ actor, kind, model, promptTokens, completionTokens, toolCalls }) {
    try {
        await dbAdapter.insert('ai_usage_log', {
            actor: actor || 'unknown',
            kind: kind || 'chat',
            model: model || null,
            prompt_tokens: promptTokens || 0,
            completion_tokens: completionTokens || 0,
            cost_usd: computeCostUsd(promptTokens || 0, completionTokens || 0).toFixed(6),
            tool_calls: toolCalls && toolCalls.length ? JSON.stringify(toolCalls).substring(0, 2000) : null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.error('[AI] Failed to log usage:', e.message);
    }
}

/** Count of AI requests by this actor today (UTC). */
async function getTodayUsageCount(actor, kind = null) {
    const params = [actor];
    let sql = `SELECT COUNT(*)::int AS count FROM ai_usage_log WHERE actor = ? AND created_at >= date_trunc('day', NOW())`;
    if (kind) {
        sql += ' AND kind = ?';
        params.push(kind);
    }
    const rows = await dbAdapter.query(sql, params);
    return rows[0]?.count || 0;
}

/** Aggregate usage stats for the dashboard widget. */
async function getUsageStats(days = 30) {
    const rows = await dbAdapter.query(
        `SELECT date_trunc('day', created_at)::date AS day,
                kind,
                COUNT(*)::int AS requests,
                SUM(prompt_tokens)::bigint AS prompt_tokens,
                SUM(completion_tokens)::bigint AS completion_tokens,
                SUM(cost_usd) AS cost_usd
         FROM ai_usage_log
         WHERE created_at >= NOW() - (? || ' days')::interval
         GROUP BY 1, 2
         ORDER BY 1 DESC`,
        [String(days)]
    );
    const totals = await dbAdapter.query(
        `SELECT COUNT(*)::int AS requests,
                COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM ai_usage_log
         WHERE created_at >= NOW() - (? || ' days')::interval`,
        [String(days)]
    );
    return { daily: rows, totals: totals[0] || {} };
}

module.exports = {
    createPendingAction,
    getPendingAction,
    updatePendingAction,
    claimPendingAction,
    cancelPendingAction,
    getChatHistory,
    appendChatHistory,
    pruneChatHistory,
    clearChatHistory,
    logUsage,
    getTodayUsageCount,
    getUsageStats
};
