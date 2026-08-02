/**
 * AI Insights — aggregated analytics and smart suggestions for the copilot.
 *
 * Pulls from ai_usage_log, ai_learned_replies, support_tickets, and orders
 * to produce insight cards the dashboard can render directly.
 */

const { dbAdapter } = require('../../database/db');

// ── Existing functions ──────────────────────────────────────────────────────

/**
 * Ticket category breakdown for open tickets (keyword-based).
 */
async function ticketCategoryAnalysis() {
    const rows = await dbAdapter.query(
        `SELECT id, message FROM support_tickets WHERE status = 'open' LIMIT 200`
    );
    const categories = {
        'Order Status': /\b(where|status|track|when|deliver|arriv|ship)\b/i,
        'Return/Exchange': /\b(return|exchange|refund|replace|size|wrong)\b/i,
        'Payment': /\b(payment|pay|cod|prepaid|upi|card|money)\b/i,
        'Product Query': /\b(product|stock|available|color|material|fabric)\b/i,
        'Complaint': /\b(complain|bad|worst|damage|defect|broken|poor)\b/i,
        'General': /.*/
    };
    const counts = {};
    for (const row of rows) {
        let matched = false;
        for (const [cat, pattern] of Object.entries(categories)) {
            if (cat === 'General') continue;
            if (pattern.test(row.message || '')) {
                counts[cat] = (counts[cat] || 0) + 1;
                matched = true;
                break;
            }
        }
        if (!matched) counts['General'] = (counts['General'] || 0) + 1;
    }
    return { total: rows.length, categories: counts };
}

/**
 * Average resolution time in hours, grouped by portal.
 */
async function resolutionTimeTrends() {
    const rows = await dbAdapter.query(
        `SELECT portal_id,
                AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600)::float AS avg_hours,
                COUNT(*)::int AS resolved_count
         FROM support_tickets
         WHERE status IN ('resolved', 'closed')
           AND updated_at IS NOT NULL
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY portal_id
         ORDER BY avg_hours ASC`
    );
    return rows;
}

/**
 * Top customer questions from the learned replies table.
 */
async function topCustomerQuestions(limit = 10) {
    const rows = await dbAdapter.query(
        `SELECT customer_question, uses, resolved_boost, pinned, updated_at
         FROM ai_learned_replies
         ORDER BY uses DESC, resolved_boost DESC NULLS LAST
         LIMIT ?`,
        [Math.min(limit, 30)]
    );
    return rows;
}

/**
 * AI-generated suggestions based on current data patterns.
 */
async function generateSuggestions() {
    const suggestions = [];

    // Check for learned replies that could be promoted to golden examples
    const highUseRows = await dbAdapter.query(
        `SELECT id, customer_question, uses FROM ai_learned_replies
         WHERE pinned IS NOT TRUE AND uses >= 5
         ORDER BY uses DESC LIMIT 5`
    );
    if (highUseRows.length) {
        suggestions.push({
            type: 'training',
            priority: 'medium',
            text: `${highUseRows.length} high-use learned replies could be promoted to golden examples for more consistent AI behavior.`,
            action: { page: 'training', highlight: highUseRows.map(r => r.id) }
        });
    }

    // Check for stale open tickets
    const staleTickets = await dbAdapter.query(
        `SELECT COUNT(*)::int AS c FROM support_tickets
         WHERE status = 'open' AND created_at < NOW() - INTERVAL '48 hours'`
    );
    if (staleTickets[0]?.c > 0) {
        suggestions.push({
            type: 'action',
            priority: 'high',
            text: `${staleTickets[0].c} ticket(s) have been open for over 48 hours. Consider bulk-resolving or reassigning.`,
            action: { page: 'actions', preset: 'stale-tickets' }
        });
    }

    // Check for pending abandoned carts that could use recovery
    const pendingCarts = await dbAdapter.query(
        `SELECT COUNT(*)::int AS c FROM abandoned_carts WHERE status = 'pending' AND created_at >= NOW() - INTERVAL '24 hours'`
    );
    if (pendingCarts[0]?.c > 5) {
        suggestions.push({
            type: 'action',
            priority: 'medium',
            text: `${pendingCarts[0].c} abandoned carts in the last 24h. Consider sending recovery messages.`,
            action: { page: 'actions', preset: 'cart-recovery' }
        });
    }

    // Check AI usage efficiency
    const todayUsage = await dbAdapter.query(
        `SELECT COUNT(*)::int AS requests, COALESCE(SUM(cost_usd), 0)::float AS cost
         FROM ai_usage_log WHERE created_at >= date_trunc('day', NOW())`
    );
    if (todayUsage[0]?.requests > 100) {
        suggestions.push({
            type: 'info',
            priority: 'low',
            text: `AI usage is high today: ${todayUsage[0].requests} requests, $${todayUsage[0].cost.toFixed(2)} cost. Consider reviewing frequent queries.`,
            action: { page: 'analytics' }
        });
    }

    return suggestions;
}

// ── Enhanced Analytics (Phase 4) ────────────────────────────────────────────

/**
 * Daily sentiment breakdown over the last N days.
 * Returns array of { day, positive, neutral, negative, frustrated }.
 */
async function getSentimentTrends(days = 14) {
    const rows = await dbAdapter.query(
        `SELECT
            DATE(created_at) AS day,
            COUNT(CASE WHEN sentiment = 'positive' THEN 1 END)::int AS positive,
            COUNT(CASE WHEN sentiment = 'neutral' THEN 1 END)::int AS neutral,
            COUNT(CASE WHEN sentiment = 'negative' THEN 1 END)::int AS negative,
            COUNT(CASE WHEN sentiment = 'frustrated' THEN 1 END)::int AS frustrated
         FROM support_tickets
         WHERE created_at >= NOW() - INTERVAL '? days'
           AND sentiment IS NOT NULL
         GROUP BY DATE(created_at)
         ORDER BY day ASC`,
        [Math.min(days, 90)]
    );
    return rows;
}

/**
 * Intent classification counts (last 30 days).
 */
async function getScenarioDistribution() {
    return dbAdapter.query(
        `SELECT ai_scenario, COUNT(*)::int AS count
         FROM support_tickets
         WHERE ai_scenario IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY ai_scenario ORDER BY count DESC`
    );
}

/**
 * AI performance metrics: acceptance rate, avg confidence, resolution rate,
 * cost per resolution.
 */
async function getAIPerformanceMetrics() {
    const [confidence, resolution, costData, totalTickets] = await Promise.all([
        dbAdapter.query(
            `SELECT AVG(ai_confidence)::float AS avg_confidence,
                    COUNT(*)::int AS classified
             FROM support_tickets
             WHERE ai_confidence IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'`
        ),
        dbAdapter.query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(CASE WHEN status IN ('resolved','closed') THEN 1 END)::int AS resolved
             FROM support_tickets
             WHERE created_at >= NOW() - INTERVAL '30 days'`
        ),
        dbAdapter.query(
            `SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost
             FROM ai_usage_log
             WHERE created_at >= NOW() - INTERVAL '30 days'`
        ),
        dbAdapter.query(
            `SELECT COUNT(*)::int AS total FROM support_tickets
             WHERE created_at >= NOW() - INTERVAL '30 days'`
        )
    ]);

    const resolved = resolution[0]?.resolved || 0;
    const totalCost = costData[0]?.total_cost || 0;

    return {
        avgConfidence: confidence[0]?.avg_confidence || 0,
        classifiedCount: confidence[0]?.classified || 0,
        resolutionRate: resolution[0]?.total ? (resolved / resolution[0].total * 100) : 0,
        resolvedCount: resolved,
        totalTickets: totalTickets[0]?.total || 0,
        totalCost: totalCost,
        costPerResolution: resolved > 0 ? totalCost / resolved : 0
    };
}

/**
 * Top escalation reasons — scenarios where AI confidence was low or sentiment
 * was frustrated, leading to auto-escalation.
 */
async function getEscalationReasons() {
    return dbAdapter.query(
        `SELECT
            COALESCE(ai_scenario, 'unknown') AS scenario,
            COUNT(*)::int AS count,
            AVG(ai_confidence)::float AS avg_confidence
         FROM support_tickets
         WHERE (ai_confidence < 0.6 OR sentiment = 'frustrated')
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY ai_scenario
         ORDER BY count DESC
         LIMIT 10`
    );
}

/**
 * Live monitoring snapshot: open tickets, recent escalations, today's AI usage,
 * and active session indicators.
 */
async function getLiveSnapshot() {
    const [openTickets, recentEscalations, todayUsage, sentimentBreakdown] = await Promise.all([
        dbAdapter.query(
            `SELECT COUNT(*)::int AS count FROM support_tickets WHERE status = 'open'`
        ),
        dbAdapter.query(
            `SELECT ticket_number, customer_phone, customer_name, ai_scenario, sentiment, ai_confidence, created_at
             FROM support_tickets
             WHERE (ai_confidence < 0.6 OR sentiment = 'frustrated')
               AND created_at >= NOW() - INTERVAL '1 hour'
             ORDER BY created_at DESC LIMIT 10`
        ),
        dbAdapter.query(
            `SELECT COUNT(*)::int AS requests, COALESCE(SUM(cost_usd), 0)::float AS cost
             FROM ai_usage_log
             WHERE created_at >= date_trunc('day', NOW())`
        ),
        dbAdapter.query(
            `SELECT sentiment, COUNT(*)::int AS count
             FROM support_tickets
             WHERE status = 'open' AND sentiment IS NOT NULL
             GROUP BY sentiment`
        )
    ]);

    return {
        openTickets: openTickets[0]?.count || 0,
        sentimentBreakdown: sentimentBreakdown,
        recentEscalations: recentEscalations,
        todayUsage: {
            requests: todayUsage[0]?.requests || 0,
            cost: todayUsage[0]?.cost || 0
        }
    };
}

/**
 * Master insights endpoint — returns everything the analytics page needs.
 */
async function getInsights() {
    const [ticketCategories, resolutionTimes, topQuestions, suggestions] = await Promise.all([
        ticketCategoryAnalysis(),
        resolutionTimeTrends(),
        topCustomerQuestions(15),
        generateSuggestions()
    ]);
    return { ticketCategories, resolutionTimes, topQuestions, suggestions };
}

/**
 * Enhanced analytics bundle — all the new Phase 4 metrics.
 */
async function getEnhancedAnalytics() {
    const [sentimentTrends, scenarioDist, aiPerf, escalationReasons] = await Promise.all([
        getSentimentTrends(14),
        getScenarioDistribution(),
        getAIPerformanceMetrics(),
        getEscalationReasons()
    ]);
    return { sentimentTrends, scenarioDistribution: scenarioDist, aiPerformance: aiPerf, escalationReasons };
}

module.exports = {
    getInsights,
    getEnhancedAnalytics,
    getSentimentTrends,
    getScenarioDistribution,
    getAIPerformanceMetrics,
    getEscalationReasons,
    getLiveSnapshot,
    ticketCategoryAnalysis,
    resolutionTimeTrends,
    topCustomerQuestions,
    generateSuggestions
};
