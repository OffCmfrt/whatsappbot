/**
 * AI Insights — aggregated analytics and smart suggestions for the copilot.
 *
 * Pulls from ai_usage_log, ai_learned_replies, support_tickets, and orders
 * to produce insight cards the dashboard can render directly.
 */

const { dbAdapter } = require('../../database/db');

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

module.exports = { getInsights, ticketCategoryAnalysis, resolutionTimeTrends, topCustomerQuestions, generateSuggestions };
