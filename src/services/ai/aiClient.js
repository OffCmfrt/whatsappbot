/**
 * Provider-agnostic LLM chat client (OpenAI-compatible chat completions API).
 *
 * Uses plain axios (no SDK) to stay lightweight on Render's 256MB memory cap.
 * Default provider is Groq (llama-3.3-70b-versatile), switchable via env:
 *   AI_PROVIDER  — groq | openai | deepseek | gemini (default: groq)
 *   AI_API_KEY   — provider API key (required)
 *   AI_MODEL     — model override (default per provider)
 *   AI_BASE_URL  — base URL override (default per provider)
 */

const axios = require('axios');

const PROVIDER_DEFAULTS = {
    groq: {
        baseURL: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
        inputCostPer1M: 0.59,
        outputCostPer1M: 0.79
    },
    openai: {
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        inputCostPer1M: 0.15,
        outputCostPer1M: 0.60
    },
    deepseek: {
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        inputCostPer1M: 0.27,
        outputCostPer1M: 1.10
    },
    gemini: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.5-flash-lite',
        inputCostPer1M: 0.10,
        outputCostPer1M: 0.40
    }
};

function getConfig() {
    const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
    const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.groq;
    return {
        provider,
        apiKey: process.env.AI_API_KEY,
        model: process.env.AI_MODEL || defaults.model,
        baseURL: (process.env.AI_BASE_URL || defaults.baseURL).replace(/\/$/, ''),
        inputCostPer1M: parseFloat(process.env.AI_INPUT_COST_PER_1M) || defaults.inputCostPer1M,
        outputCostPer1M: parseFloat(process.env.AI_OUTPUT_COST_PER_1M) || defaults.outputCostPer1M
    };
}

function isConfigured() {
    return Boolean(process.env.AI_API_KEY);
}

// Rough token estimate (~4 chars per token) used for history truncation
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
}

function computeCostUsd(promptTokens, completionTokens) {
    const cfg = getConfig();
    return (promptTokens / 1e6) * cfg.inputCostPer1M + (completionTokens / 1e6) * cfg.outputCostPer1M;
}

/**
 * Call the chat completions endpoint with retry on transient failures.
 * @param {object} opts
 * @param {Array} opts.messages    — OpenAI-format messages
 * @param {Array} [opts.tools]     — OpenAI-format tool definitions
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {object} [opts.responseFormat] — e.g. { type: 'json_object' }
 * @returns {{ message: object, usage: { prompt_tokens, completion_tokens }, model: string }}
 */
async function chatCompletion({ messages, tools, temperature = 0.3, maxTokens = 1024, responseFormat = null }) {
    const cfg = getConfig();
    if (!cfg.apiKey) {
        throw new Error('AI_API_KEY is not configured');
    }

    const body = {
        model: cfg.model,
        messages,
        temperature,
        max_tokens: maxTokens
    };
    if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }
    if (responseFormat) {
        body.response_format = responseFormat;
    }

    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await axios.post(`${cfg.baseURL}/chat/completions`, body, {
                headers: {
                    'Authorization': `Bearer ${cfg.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            const choice = response.data?.choices?.[0];
            if (!choice || !choice.message) {
                throw new Error('AI provider returned an empty response');
            }

            return {
                message: choice.message,
                finishReason: choice.finish_reason,
                usage: {
                    prompt_tokens: response.data?.usage?.prompt_tokens || 0,
                    completion_tokens: response.data?.usage?.completion_tokens || 0
                },
                model: response.data?.model || cfg.model
            };
        } catch (error) {
            lastError = error;
            const status = error.response?.status;
            const retriable = !status || status === 429 || status >= 500;

            // Rate limited on free tier — surface a friendly, non-retriable error
            if (status === 429 && attempt === maxAttempts) {
                const err = new Error('AI rate limit reached (free tier). Please try again in a minute.');
                err.code = 'AI_RATE_LIMIT';
                throw err;
            }
            if (!retriable || attempt === maxAttempts) break;

            const delayMs = 1000 * Math.pow(2, attempt - 1);
            console.warn(`⚠️ [AI] ${cfg.provider} request failed (${status || error.code || error.message}), retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }

    const detail = lastError?.response?.data?.error?.message || lastError?.message || 'unknown error';
    const err = new Error(`AI request failed: ${detail}`);
    err.code = lastError?.code || 'AI_ERROR';
    throw err;
}

module.exports = { chatCompletion, getConfig, isConfigured, estimateTokens, computeCostUsd };
