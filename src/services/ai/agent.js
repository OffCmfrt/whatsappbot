/**
 * AI Copilot agent — tool-calling loop with confirmation gating.
 *
 * Flow: system prompt + chat history + user message + tool schemas → model.
 *   - Read-only tools are executed immediately and results fed back (max 6 rounds).
 *   - Tools with requiresConfirmation are NEVER executed here: a pending action row
 *     is created and returned so the dashboard can show a Confirm/Cancel dialog.
 */

const { chatCompletion, isConfigured, estimateTokens } = require('./aiClient');
const { getTool, getToolSchemas, summarizeTool } = require('./tools');
const aiStore = require('./aiStore');
const Settings = require('../../models/Settings');

const MAX_TOOL_ROUNDS = 6;
const MAX_INPUT_TOKENS = 8000;
const TOOL_RESULT_MAX_CHARS = 12000;

const SYSTEM_PROMPT = `You are the OFFCOMFRT admin AI copilot inside the WhatsApp bot dashboard.
You help the internal team query customers, orders, WhatsApp messages, support tickets, abandoned carts, Shopify orders, shipments and carrier tracking, and perform admin actions.

Rules:
- Use the provided tools to fetch real data. Never invent order numbers, tracking status or statistics.
- Actions that change anything (send message, update ticket, book shipment, schedule pickup, create broadcast draft) require admin confirmation — when you call such a tool, the system pauses and asks the admin to confirm. Tell the admin you've prepared the action and they need to confirm it.
- Keep answers concise and formatted for a chat panel: short paragraphs, dashes for lists. No markdown tables.
- Amounts are INR unless stated otherwise. Dates/times are UTC in the database; mention IST when relevant (UTC+5:30).
- If a request is ambiguous (e.g. multiple matching customers), show the options and ask which one.
- If a tool errors, report the error plainly and suggest what to try next.`;

/** Truncate oldest history turns so the estimated input stays under budget. */
function truncateHistory(history, budgetTokens) {
    const out = [];
    let total = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const t = estimateTokens(history[i].content) + 4;
        if (total + t > budgetTokens) break;
        total += t;
        out.unshift(history[i]);
    }
    return out;
}

function clampToolResult(result) {
    let json;
    try {
        json = JSON.stringify(result);
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
    const budget = MAX_INPUT_TOKENS - estimateTokens(SYSTEM_PROMPT) - estimateTokens(userMessage) - 1500; // reserve for tool schemas
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...truncateHistory(history, Math.max(budget, 1000)),
        { role: 'user', content: userMessage }
    ];

    const toolSchemas = getToolSchemas();
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

    try {
        const result = await tool.execute(args || {}, { actor, confirmed: true });
        await aiStore.updatePendingAction(actionId, { status: 'executed', result: clampToolResult(result) });
        await aiStore.appendChatHistory(actor, 'assistant', `✅ Executed: ${action.summary}`);
        return { ok: true, result, summary: action.summary };
    } catch (e) {
        await aiStore.updatePendingAction(actionId, { status: 'failed', result: JSON.stringify({ error: e.message }) });
        return { ok: false, error: e.message, summary: action.summary };
    }
}

module.exports = { runAgent, executeConfirmedAction, SYSTEM_PROMPT };
