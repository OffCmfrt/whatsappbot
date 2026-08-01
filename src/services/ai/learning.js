/**
 * AI learning store — the bot gets smarter from real conversations.
 *
 * Every reply a human agent sends becomes a learned "question → approved reply"
 * example (PII scrubbed to placeholders so examples generalize). Retrieval is
 * hybrid: pgvector semantic search when embeddings are configured, with
 * Postgres full-text search as fallback/filler. Ranking blends similarity,
 * reinforcement (uses), resolved-ticket outcomes and recency decay; pinned
 * examples always rank first.
 *
 * Token-lean by design: only the top few compact examples are injected.
 */

const { dbAdapter } = require('../../database/db');
const { embedText, isEmbeddingConfigured } = require('./aiClient');
const Settings = require('../../models/Settings');

const MAX_LEARNED_ROWS = 1000;
const MIN_QUESTION_CHARS = 8;
const MIN_REPLY_CHARS = 15;
const EXAMPLE_Q_MAX_CHARS = 200;
const EXAMPLE_A_MAX_CHARS = 400;
const RECENCY_HALF_LIFE_DAYS = 120;

// 'simple' text-search config: no English stemming, so Hindi/Hinglish tokens
// match as-is alongside English.
const TSV = `to_tsvector('simple', customer_question || ' ' || agent_reply)`;

const SOP_GOLDEN_EXAMPLES = [
    {
        q: "Where is my order? Track my order status",
        a: "Order tracking is checked strictly in partner sequence: 1. Shiprocket (primary), 2. Delhivery One, 3. Ekart (prepaid only). If 'Edit Details' was clicked without reply, calling executive contacts you: COD stays on hold; Prepaid ships as-is after 24h."
    },
    {
        q: "Tracking says delivered but I have not received my order / item missing",
        a: "Please check with neighbours, nearby flats, or security. We have notified our delivery partner and requested Proof of Delivery (POD). Once received (within 24h), we will share the POD with you."
    },
    {
        q: "Can I get a refund back to my bank account / payment method?",
        a: "Original payment method refunds (takes 5-7 days) are issued ONLY for: 1. Item damaged on arrival, 2. Wrong product delivered, 3. Prepaid order cancelled at confirmation, or 4. RTO return without receipt. All other cases receive store credit only."
    },
    {
        q: "I want to change my size or request an exchange",
        a: "Before dispatch: use 'Edit Details' on your Shoppers Hub confirmation message. After delivery: submit your exchange request on offcomfrt.in → Support → Return/Exchange."
    },
    {
        q: "Received damaged defective or wrong product",
        a: "Please submit proof at offcomfrt.in → Support → Return/Exchange. Mandatory: unboxing video for wrong product; photos for damage. Once verified, this qualifies for a refund."
    },
    {
        q: "I need to change my delivery address",
        a: "Pre-dispatch: click 'Edit Details' on Shoppers Hub message. Post-dispatch: address cannot be changed on active shipment. Prepaid: wait for RTO to reship or cancel in-transit to ship fresh order. COD: fresh order dispatched immediately."
    },
    {
        q: "I already paid online but courier is asking for COD cash",
        a: "This happens when 'Edit Details' converted the order to COD without re-applying discount. Please pay the delivery partner the amount requested at the door; we will refund that paid amount back to you separately."
    },
    {
        q: "I want to cancel my order",
        a: "Cancellations are actioned via the Shoppers Hub confirmation text (Confirm/Cancel/Edit Details). If already shipped: Prepaid is cancelled in transit with refund; COD customers should simply refuse delivery."
    },
    {
        q: "I am frustrated / want a phone callback from manager",
        a: "We resolve all issues over chat first and consult admin for the best possible solution before arranging any call. Please share your issue details here."
    }
];

// ---------- PII scrubbing ----------

/**
 * Replace identifying values with placeholders so examples teach the pattern,
 * not one customer's data. Order matters: specific → generic.
 */
function scrubPII(text, customerName = null) {
    let out = String(text || '');
    out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '{{email}}');
    out = out.replace(/\b(?:ORD|ORDER)[-_ ]?[A-Z0-9-]{3,}\b/gi, '{{order_id}}');
    out = out.replace(/#\d{3,}/g, '{{order_id}}');
    out = out.replace(/(?:\+91[\s-]?)?\b[6-9]\d{9}\b/g, '{{phone}}');
    out = out.replace(/\b\d{8,16}\b/g, '{{awb}}');
    out = out.replace(/\b\d{6}\b/g, '{{pincode}}');
    if (customerName && customerName.trim().length >= 3) {
        const escaped = customerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '{{name}}');
    }
    return out.replace(/\s{2,}/g, ' ').trim();
}

function normalizeForCompare(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Postgres vector literal, e.g. '[0.1,0.2,...]'
function toVectorLiteral(embedding) {
    return `[${embedding.join(',')}]`;
}

// Fire-and-forget: embed the question and store it (skipped when pgvector or
// the embedding API is unavailable — FTS keeps working without it)
function attachEmbedding(id, questionText) {
    if (!isEmbeddingConfigured()) return;
    embedText(questionText)
        .then(vec => vec && dbAdapter.run(
            'UPDATE ai_learned_replies SET embedding = ?::vector WHERE id = ?',
            [toVectorLiteral(vec), id]
        ))
        .catch(e => console.warn('[AI] attachEmbedding failed:', e.message));
}

// ---------- Learning ----------

/**
 * Learn from a human agent's reply. Called fire-and-forget after a manual
 * reply is sent — must never throw into the send flow.
 *
 * suggestedText (optional) is the AI draft the agent picked before sending:
 *   sent unchanged  → strong reinforcement (the AI was right)
 *   edited          → learn the human-corrected version (stronger than plain)
 */
async function learnFromAgentReply({ phone, replyText, suggestedText = null }) {
    try {
        const enabled = await Settings.get('ai_learning_enabled', 'true');
        if (String(enabled) === 'false') return;

        const reply = String(replyText || '').trim();
        if (reply.length < MIN_REPLY_CHARS) return;

        // The question is the customer's latest incoming message before this reply
        const digits = String(phone).replace(/\D/g, '');
        const phonePattern = `%${digits.slice(-10)}`;
        const [rows, customer] = await Promise.all([
            dbAdapter.query(
                `SELECT message_content FROM messages
                 WHERE customer_phone LIKE ? AND message_type = 'incoming'
                 ORDER BY id DESC LIMIT 1`,
                [phonePattern]
            ),
            dbAdapter.query('SELECT name FROM customers WHERE phone LIKE ? LIMIT 1', [phonePattern])
        ]);
        const question = String(rows[0]?.message_content || '').trim();
        if (question.length < MIN_QUESTION_CHARS) return;

        const name = customer[0]?.name || null;
        const q = scrubPII(question, name).substring(0, 500);
        const a = scrubPII(reply, name).substring(0, 1500);
        if (q.length < MIN_QUESTION_CHARS || a.length < MIN_REPLY_CHARS) return;

        // Reinforcement weight from the suggestion feedback signal
        let weight = 1;
        if (suggestedText) {
            weight = normalizeForCompare(suggestedText) === normalizeForCompare(reply) ? 3 : 2;
        }

        // Same (scrubbed) question seen before → reinforce, keep newest wording
        const existing = await dbAdapter.query(
            'SELECT id FROM ai_learned_replies WHERE LOWER(customer_question) = LOWER(?) LIMIT 1',
            [q]
        );
        if (existing[0]) {
            await dbAdapter.run(
                'UPDATE ai_learned_replies SET agent_reply = ?, uses = uses + ?, updated_at = NOW() WHERE id = ?',
                [a, weight, existing[0].id]
            );
        } else {
            const row = await dbAdapter.insert('ai_learned_replies', {
                customer_question: q,
                agent_reply: a,
                customer_phone: digits.slice(-10),
                uses: weight,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
            if (row?.id) attachEmbedding(row.id, q);
            // Keep the table bounded: drop the least-reinforced, oldest rows
            await dbAdapter.run(
                `DELETE FROM ai_learned_replies WHERE pinned IS NOT TRUE AND id NOT IN (
                    SELECT id FROM ai_learned_replies ORDER BY pinned DESC, uses DESC, id DESC LIMIT ?
                )`,
                [MAX_LEARNED_ROWS]
            );
        }
    } catch (e) {
        console.error('[AI] learnFromAgentReply failed:', e.message);
    }
}

/**
 * Outcome signal: a ticket for this customer was resolved, so the recent
 * examples learned from their conversation demonstrably worked.
 */
async function boostFromResolvedTicket(phone) {
    try {
        const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
        if (last10.length < 10) return;
        await dbAdapter.run(
            `UPDATE ai_learned_replies SET resolved_boost = resolved_boost + 1
             WHERE customer_phone = ? AND updated_at >= NOW() - INTERVAL '7 days'`,
            [last10]
        );
    } catch (e) {
        console.error('[AI] boostFromResolvedTicket failed:', e.message);
    }
}

// ---------- Retrieval ----------

// Blend base similarity with reinforcement, outcome and recency signals
function rerank(rows, limit) {
    const now = Date.now();
    return rows
        .map(r => {
            const days = Math.max(0, (now - new Date(r.updated_at || now).getTime()) / 86400000);
            const decay = Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
            const boost = 1 + 0.15 * Math.log(1 + (r.uses || 1)) + 0.3 * (r.resolved_boost || 0);
            return { ...r, score: (r.pinned ? 1e6 : 0) + (r.similarity || 0.1) * boost * decay };
        })
        .sort((x, y) => y.score - x.score)
        .slice(0, limit)
        .map(r => ({
            q: String(r.customer_question).substring(0, EXAMPLE_Q_MAX_CHARS),
            a: String(r.agent_reply).substring(0, EXAMPLE_A_MAX_CHARS),
            uses: r.uses
        }));
}

/**
 * Retrieve the most similar learned examples for a customer question.
 * Semantic (pgvector) when available, full-text otherwise; results merged.
 * Returns compact [{ q, a, uses }] ready for prompt injection (or []).
 */
async function findSimilarExamples(questionText, limit = 3) {
    try {
        const text = scrubPII(String(questionText || '')).substring(0, 300);
        if (text.length < 3) return [];

        const candidates = [];
        const seen = new Set();

        // Semantic candidates (cosine similarity, floor 0.35 to avoid noise)
        if (isEmbeddingConfigured()) {
            const vec = await embedText(text);
            if (vec) {
                try {
                    const rows = await dbAdapter.query(
                        `SELECT id, customer_question, agent_reply, uses, resolved_boost, pinned, updated_at,
                                1 - (embedding <=> ?::vector) AS similarity
                         FROM ai_learned_replies
                         WHERE embedding IS NOT NULL AND 1 - (embedding <=> ?::vector) > 0.35
                         ORDER BY embedding <=> ?::vector
                         LIMIT ?`,
                        [toVectorLiteral(vec), toVectorLiteral(vec), toVectorLiteral(vec), limit * 3]
                    );
                    for (const r of rows) {
                        seen.add(r.id);
                        candidates.push(r);
                    }
                } catch (e) {
                    // pgvector not installed on this DB — FTS below still covers us
                }
            }
        }

        // Full-text candidates (also catches rows not embedded yet)
        const ftsRows = await dbAdapter.query(
            `SELECT id, customer_question, agent_reply, uses, resolved_boost, pinned, updated_at,
                    ts_rank(${TSV}, plainto_tsquery('simple', ?)) AS similarity
             FROM ai_learned_replies
             WHERE ${TSV} @@ plainto_tsquery('simple', ?)
             ORDER BY similarity DESC, uses DESC
             LIMIT ?`,
            [text, text, limit * 3]
        );
        for (const r of ftsRows) {
            if (!seen.has(r.id)) candidates.push(r);
        }

        return rerank(candidates, limit);
    } catch (e) {
        console.warn('[AI] findSimilarExamples DB query unavailable, using SOP in-memory fallback');
        const text = String(questionText || '').toLowerCase();
        const fallbackMatches = SOP_GOLDEN_EXAMPLES.filter(ex => {
            const words = ex.q.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            return words.some(w => text.includes(w));
        }).map(ex => ({ q: ex.q, a: ex.a, uses: 10 }));
        
        return fallbackMatches.slice(0, limit);
    }
}

// ---------- Curation (dashboard management) ----------

async function listLearnedReplies({ search = '', limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT id, customer_question, agent_reply, uses, resolved_boost, pinned, updated_at
               FROM ai_learned_replies`;
    if (search && search.trim()) {
        sql += ' WHERE customer_question ILIKE ? OR agent_reply ILIKE ?';
        const like = `%${search.trim()}%`;
        params.push(like, like);
    }
    sql += ' ORDER BY pinned DESC, uses DESC, updated_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 100, 300));
    return dbAdapter.query(sql, params);
}

/** Create a hand-written "golden" example (pinned by default). */
async function createLearnedReply({ question, reply, pinned = true }) {
    const q = scrubPII(question).substring(0, 500);
    const a = scrubPII(reply).substring(0, 1500);
    if (q.length < 3 || a.length < 3) throw new Error('Question and reply are required');
    const row = await dbAdapter.insert('ai_learned_replies', {
        customer_question: q,
        agent_reply: a,
        customer_phone: null,
        uses: 1,
        pinned: !!pinned,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    });
    if (row?.id) attachEmbedding(row.id, q);
    return row;
}

async function updateLearnedReply(id, { question, reply, pinned }) {
    const fields = { updated_at: new Date().toISOString() };
    if (question !== undefined) fields.customer_question = scrubPII(question).substring(0, 500);
    if (reply !== undefined) fields.agent_reply = scrubPII(reply).substring(0, 1500);
    if (pinned !== undefined) fields.pinned = !!pinned;
    await dbAdapter.update('ai_learned_replies', fields, { id });
    if (fields.customer_question) attachEmbedding(id, fields.customer_question);
}

async function deleteLearnedReply(id) {
    await dbAdapter.run('DELETE FROM ai_learned_replies WHERE id = ?', [id]);
}

/**
 * Seed standard operating procedure (SOP) golden learned replies from the
 * Support Agent Workflow Framework (PDF) into ai_learned_replies table.
 * All entries are pinned by default so they always rank top in similarity search.
 */
async function seedSopLearnedReplies() {
    try {
        for (const ex of SOP_GOLDEN_EXAMPLES) {
            const existing = await dbAdapter.query(
                'SELECT id FROM ai_learned_replies WHERE LOWER(customer_question) = LOWER(?) LIMIT 1',
                [ex.q]
            );
            if (!existing || existing.length === 0) {
                await dbAdapter.insert('ai_learned_replies', {
                    customer_question: ex.q,
                    agent_reply: ex.a,
                    customer_phone: null,
                    uses: 10,
                    pinned: true,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
            }
        }
        console.log('✅ SOP golden learned replies seeded successfully');
    } catch (e) {
        console.error('⚠️ Failed to seed SOP learned replies:', e.message);
    }
}

module.exports = {
    learnFromAgentReply,
    boostFromResolvedTicket,
    findSimilarExamples,
    listLearnedReplies,
    createLearnedReply,
    updateLearnedReply,
    deleteLearnedReply,
    seedSopLearnedReplies,
    scrubPII
};
