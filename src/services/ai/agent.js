/**
 * AI Copilot agent — tool-calling loop with confirmation gating.
 *
 * Flow: system prompt + chat history + user message + tool schemas → model.
 *   - Read-only tools are executed immediately and results fed back (max 6 rounds).
 *   - Tools with requiresConfirmation are NEVER executed here: a pending action row
 *     is created and returned so the dashboard can show a Confirm/Cancel dialog.
 */

const { chatCompletion, isConfigured, estimateTokens } = require('./aiClient');
const { getTool, selectToolSchemas, summarizeTool } = require('./tools');
const aiStore = require('./aiStore');
const Settings = require('../../models/Settings');

const MAX_TOOL_ROUNDS = 4;
const MAX_INPUT_TOKENS = 6000;
// Keep tool results small: they are re-sent on every subsequent round, so large
// results multiply token usage and trip Groq's free-tier 12k tokens/min limit.
const TOOL_RESULT_MAX_CHARS = 5000;
const HISTORY_TURN_MAX_CHARS = 1200;

// Compact on purpose — the system prompt is re-sent on every agent round.
const SYSTEM_PROMPT = `You are the OFFCOMFRT admin AI copilot in the WhatsApp bot dashboard, helping the team with customers, orders, messages, tickets, carts, shipments and tracking.
Rules:
- Fetch real data with tools; never invent orders, tracking or stats. Prefer answering from data already in this conversation instead of re-calling tools.
- Confirmation-gated tools (send message, update ticket, book shipment, schedule pickup, broadcast draft) pause for admin confirm — say the action is prepared and needs confirmation.
- Be concise: short paragraphs, dash lists, no markdown tables. Amounts INR; DB times UTC (IST = UTC+5:30).
- If ambiguous, list options and ask. If a tool errors, say so plainly and suggest next steps.`;

/**
 * Models sometimes emit numbers as strings ("limit": "10"). Schemas accept both
 * (['integer','string']) so the provider doesn't reject the call; here we coerce
 * numeric strings back to integers based on the tool's declared schema.
 */
function coerceArgs(tool, args) {
    const props = tool?.parameters?.properties;
    if (!props || !args || typeof args !== 'object') return args;
    for (const [key, schema] of Object.entries(props)) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (types.includes('integer') && typeof args[key] === 'string') {
            const n = parseInt(args[key], 10);
            if (!Number.isNaN(n)) args[key] = n;
        }
    }
    return args;
}

/** Truncate oldest history turns so the estimated input stays under budget. */
function truncateHistory(history, budgetTokens) {
    const out = [];
    let total = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        let content = String(history[i].content || '');
        // Clamp single oversized turns so one long answer doesn't evict all context
        if (content.length > HISTORY_TURN_MAX_CHARS) {
            content = content.substring(0, HISTORY_TURN_MAX_CHARS) + '…';
        }
        const t = estimateTokens(content) + 4;
        if (total + t > budgetTokens) break;
        total += t;
        out.unshift({ ...history[i], content });
    }
    return out;
}

/** Recursively drop null/empty values — DB rows are full of them and they cost tokens. */
function compactValue(value) {
    if (Array.isArray(value)) {
        return value.map(compactValue);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (v === null || v === undefined || v === '') continue;
            out[k] = compactValue(v);
        }
        return out;
    }
    return value;
}

function clampToolResult(result) {
    let json;
    try {
        json = JSON.stringify(compactValue(result));
    } catch {
        json = String(result);
    }
    if (json.length > TOOL_RESULT_MAX_CHARS) {
        json = json.substring(0, TOOL_RESULT_MAX_CHARS) + '… (truncated)';
    }
    return json;
}

/**
 * Run one copilot turn for an admin.
 * @returns {{ reply: string, pendingAction: {id, summary, toolName}|null, usage: object }}
 */
async function runAgent({ actor, userMessage }) {
    if (!isConfigured()) {
        return { reply: 'AI is not configured. Set AI_API_KEY in the server environment.', pendingAction: null, usage: null };
    }

    // Kill switch + daily cap
    const enabled = await Settings.get('ai_admin_copilot_enabled', 'true');
    if (String(enabled) === 'false') {
        return { reply: 'The AI copilot is currently disabled in settings.', pendingAction: null, usage: null };
    }
    const dailyLimit = parseInt(await Settings.get('ai_daily_admin_limit', process.env.AI_DAILY_ADMIN_LIMIT || '200')) || 200;
    const usedToday = await aiStore.getTodayUsageCount(actor, 'chat');
    if (usedToday >= dailyLimit) {
        return { reply: `AI daily limit reached (${dailyLimit} requests). Try again tomorrow or raise the limit in settings.`, pendingAction: null, usage: null };
    }

    const history = await aiStore.getChatHistory(actor);
    const budget = MAX_INPUT_TOKENS - estimateTokens(SYSTEM_PROMPT) - estimateTokens(userMessage) - 1000; // reserve for tool schemas
    const recentHistory = truncateHistory(history, Math.max(budget, 1000));
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recentHistory,
        { role: 'user', content: userMessage }
    ];

    // Route: only send tool schemas relevant to the question (+ recent context),
    // instead of all 14 schemas on every round — the single biggest token saver.
    const routingContext = `${recentHistory.slice(-4).map(h => h.content).join('\n')}\n${userMessage}`;
    const toolSchemas = selectToolSchemas(routingContext);
    const usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
    const toolCallLog = [];
    let pendingAction = null;
    let reply = null;
    let model = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const { message, usage, model: usedModel } = await chatCompletion({
            messages,
            tools: toolSchemas,
            maxTokens: 1024
        });
        model = usedModel;
        usageTotal.prompt_tokens += usage.prompt_tokens;
        usageTotal.completion_tokens += usage.completion_tokens;

        const toolCalls = message.tool_calls || [];
        if (!toolCalls.length) {
            reply = message.content || 'Done.';
            break;
        }

        if (round === MAX_TOOL_ROUNDS) {
            reply = 'I hit the tool-call limit for one question. Try asking something more specific.';
            break;
        }

        messages.push(message);

        for (const call of toolCalls) {
            const name = call.function?.name;
            let args = {};
            try {
                args = JSON.parse(call.function?.arguments || '{}');
            } catch { /* keep {} */ }

            const tool = getTool(name);
            let resultJson;

            if (tool) args = coerceArgs(tool, args);

            if (!tool) {
                resultJson = JSON.stringify({ error: `Unknown tool: ${name}` });
            } else if (tool.requiresConfirmation) {
                // Gate: store as pending action, never execute now
                const summary = summarizeTool(name, args);
                const row = await aiStore.createPendingAction({ actor, toolName: name, toolArgs: args, summary });
                pendingAction = { id: row?.id, summary, toolName: name };
                resultJson = JSON.stringify({
                    status: 'awaiting_confirmation',
                    note: 'Action prepared. The admin must click Confirm in the dashboard before it runs. Tell them what the action will do.'
                });
                toolCallLog.push({ tool: name, gated: true });
            } else {
                try {
                    const result = await tool.execute(args, { actor });
                    resultJson = clampToolResult(result);
                    toolCallLog.push({ tool: name });
                } catch (e) {
                    resultJson = JSON.stringify({ error: e.message });
                    toolCallLog.push({ tool: name, error: e.message });
                }
            }

            messages.push({ role: 'tool', tool_call_id: call.id, content: resultJson });
        }

        // One confirmation-gated action per turn: get the model's final wording now
        if (pendingAction) {
            const final = await chatCompletion({ messages, maxTokens: 512 });
            usageTotal.prompt_tokens += final.usage.prompt_tokens;
            usageTotal.completion_tokens += final.usage.completion_tokens;
            reply = final.message.content || `I've prepared: ${pendingAction.summary}. Please confirm to execute.`;
            break;
        }
    }

    if (reply === null) reply = 'Sorry, I could not produce an answer. Please try again.';

    await aiStore.appendChatHistory(actor, 'user', userMessage);
    await aiStore.appendChatHistory(actor, 'assistant', reply);
    await aiStore.pruneChatHistory(actor);
    await aiStore.logUsage({
        actor,
        kind: 'chat',
        model,
        promptTokens: usageTotal.prompt_tokens,
        completionTokens: usageTotal.completion_tokens,
        toolCalls: toolCallLog
    });

    return { reply, pendingAction, usage: usageTotal };
}

/**
 * Execute a previously confirmed pending action.
 * @returns {{ ok: boolean, result?: any, error?: string, summary?: string }}
 */
async function executeConfirmedAction(actionId, actor) {
    const claim = await aiStore.claimPendingAction(actionId, actor);
    if (!claim.ok) return { ok: false, error: claim.error };

    const action = claim.action;
    const tool = getTool(action.tool_name);
    if (!tool) {
        await aiStore.updatePendingAction(actionId, { status: 'failed', result: JSON.stringify({ error: 'Tool no longer exists' }) });
        return { ok: false, error: `Tool ${action.tool_name} no longer exists` };
    }

    let args = action.tool_args;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
    }
    args = coerceArgs(tool, args || {});

    try {
        const result = await tool.execute(args, { actor, confirmed: true });
        await aiStore.updatePendingAction(actionId, { status: 'executed', result: clampToolResult(result) });
        await aiStore.appendChatHistory(actor, 'assistant', `✅ Executed: ${action.summary}`);
        return { ok: true, result, summary: action.summary };
    } catch (e) {
        await aiStore.updatePendingAction(actionId, { status: 'failed', result: JSON.stringify({ error: e.message }) });
        return { ok: false, error: e.message, summary: action.summary };
    }
}

module.exports = { runAgent, executeConfirmedAction, SYSTEM_PROMPT };
