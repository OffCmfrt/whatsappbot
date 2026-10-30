/**
 * Bulk backfill: bring OLD exchanges onto the current Zoho booking model.
 * -------------------------------------------------------------------------
 * An exchange is two documents: the returned product is reversed by an
 * EXCH-<order> CREDIT NOTE on the original invoice, and the product the
 * customer received is billed on its own EXCH-INV-<order> invoice at the price
 * on the exchange record.
 *
 * Source of truth for WHAT was exchanged is the admin exchange/return
 * dashboard (`requests` table, type=exchange) — order number, original item,
 * replacement variant, replacement price. Zoho is only asked about that one
 * order's invoice, so the run needs ~2 calls per order instead of a
 * full-ledger sweep.
 *
 * Shapes repaired (both produced by the old flow):
 *   a) credit note deleted + invoice re-lined so it bills the replacement
 *      → restore the ordered items, book the credit note, bill the replacement
 *   b) invoice untouched + a zero-value "EXCH-INV-<order>" stock-only document
 *      → re-line that document with the replacement price
 *
 * What it writes, per order that needs it:
 *   1. reverts an old in-place re-line (only when the invoice bills the
 *      replacement instead of what was ordered)
 *   2. creates the EXCH-<order> credit note for the returned item(s)
 *   3. creates / re-lines EXCH-INV-<order> with the replacement at its price
 *   4. optional (--payments): moves the customer's payment onto it
 *
 * Two phases, so the review pass is never re-paid:
 *   plan  (read-only)  : 1 invoice lookup + 1 detail GET + 1 EXCH-INV lookup
 *                        per order, saved to tmp/exchange_backfill_plan_<stamp>.json
 *   apply (writes only): executes the saved plan — the fixes only — with no
 *                        re-planning
 *
 * Usage:
 *   node scripts/backfill_exchange_invoices_bulk.js                        # plan everything (dry run)
 *   node scripts/backfill_exchange_invoices_bulk.js --limit=500            # plan first 500
 *   node scripts/backfill_exchange_invoices_bulk.js --apply                # plan + apply
 *   node scripts/backfill_exchange_invoices_bulk.js --apply --plan=tmp/exchange_backfill_plan_XXX.json
 *   node scripts/backfill_exchange_invoices_bulk.js --orders=46015,46022 --apply
 *
 * Options:
 *   --apply              write to Zoho (default: plan only, nothing written)
 *   --plan=<file>        with --apply: execute a plan saved by an earlier run
 *   --limit=N            process at most N orders (default 0 = all)
 *   --orders=a,b,c       only these order numbers (retry a failed subset)
 *   --since=YYYY-MM-DD   only exchanges created on/after this date
 *   --pace=MS            delay between orders per worker (default 350)
 *   --concurrency=N      orders planned in parallel (default 4)
 *   --payments           also move recorded payments onto the replacement
 *                        invoice (default: leave the money where it is)
 *   --fresh              ignore and truncate the resume log, plan from scratch
 *   --print=N|all        how many plans to print (default 15)
 *
 * Every plan is appended to tmp/exchange_plan_progress.jsonl the moment it is
 * known, so a run that stops (quota, crash, Ctrl-C) resumes where it left off
 * instead of re-paying for thousands of invoice lookups.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Zoho starts refusing ("too many requests continuously") well before its
// documented 100/min when the burst is steady, so the shared limiter keeps its
// conservative default here — override it with ZOHO_RATE_PER_SEC if needed.

const zohoService = require('../src/services/zohoService');
const zohoReturnService = require('../src/services/zohoReturnService');
const { dbAdapter } = require('../src/database/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const MOVE_PAYMENTS = args.includes('--payments');
const num = (flag, dflt) => {
    const hit = args.find(a => a.startsWith(`--${flag}=`));
    return hit ? parseInt(hit.split('=')[1], 10) || dflt : dflt;
};
const LIMIT = num('limit', 0);
const PACE_MS = num('pace', 350);
const CONCURRENCY = Math.max(1, num('concurrency', 4));
const FRESH = args.includes('--fresh');
const PRINT_LIMIT = args.includes('--print=all') ? Infinity : num('print', 15);
const SINCE = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || '';
const PLAN_ARG = (args.find(a => a.startsWith('--plan=')) || '').split('=')[1] || '';
const ONLY_ORDERS = ((args.find(a => a.startsWith('--orders=')) || '').split('=')[1] || '')
    .split(',').map(o => o.replace(/^#/, '').trim()).filter(Boolean);

const MODE = APPLY ? 'APPLY' : 'PLAN';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (o) => String(o || '').replace(/^#/, '').trim();

function log(msg) { console.log(`[${MODE}] ${msg}`); }

// ---------------------------------------------------------------- dashboard

/**
 * Exchange requests from the admin dashboard, limited to the ones where the
 * exchange is actually confirmed: approved after inspection, or already on its
 * way / delivered. The reverse leg being merely booked (pickup_booked,
 * picked_up, in_transit) is not enough to re-bill the invoice.
 */
async function fetchExchangeRequests() {
    const base = (process.env.RETURNS_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.RETURNS_SUPABASE_SERVICE_KEY
        || process.env.SUPABASE_SERVICE_ROLE_KEY
        || process.env.SUPABASE_ANON_KEY
        || '';
    if (!base || !key) throw new Error('no Supabase REST credentials for the requests table');

    const rows = [];
    for (let offset = 0; ; offset += 1000) {
        const params = new URLSearchParams({
            select: 'request_id,order_number,type,status,forward_status,items,created_at',
            type: 'eq.exchange',
            status: 'in.(approved,out_for_delivery,delivered,resolved,completed)',
            order: 'created_at.desc',
            limit: '1000',
            offset: String(offset)
        });
        if (SINCE) params.set('created_at', `gte.${SINCE}`);
        const res = await fetch(`${base}/rest/v1/requests?${params.toString()}`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` }
        });
        if (!res.ok) throw new Error(`requests scan failed: HTTP ${res.status}`);
        const page = await res.json();
        rows.push(...page);
        if (page.length < 1000) break;
    }
    log(`dashboard: ${rows.length} confirmed exchange request(s)`);
    return rows;
}

/** Middleware-side exchange rows — fills gaps the dashboard may not have. */
async function fetchZohoReturns() {
    try {
        const rows = await dbAdapter.query(
            `SELECT shopify_order_id, original_items, corrected_items
             FROM zoho_returns
             WHERE return_type = 'exchange'${SINCE ? ' AND created_at >= $1' : ''}
             ORDER BY created_at DESC`,
            SINCE ? [SINCE] : []
        );
        log(`zoho_returns: ${rows.length} exchange row(s)`);
        return rows;
    } catch (e) {
        log(`zoho_returns unavailable (${e.message}) — continuing with the dashboard only`);
        return [];
    }
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

/**
 * The dashboard keeps the full original title with the ORIGINAL size
 * ("HENLEY - 001 ( B ) - S") plus the replacement size on its own ("M"), so the
 * trailing size has to be swapped — appending would keep the old size.
 */
function replacementName(item) {
    const base = String(item.replacementProductTitle || item.name || item.title || '').trim();
    const size = item.replacementVariant;
    if (!size || size === 'Same') return base;
    return `${base.replace(/\s-\s\S+$/, '')} - ${size}`;
}

function itemsFromRequest(items) {
    return asArray(items).map(i => ({
        original: {
            title: i.name || i.title || '',
            sku: i.sku || '',
            quantity: parseInt(i.quantity || 1, 10) || 1,
            // paidPrice is what the customer actually paid after any discount
            price: parseFloat(i.paidPrice ?? i.price ?? 0) || 0
        },
        exchanged: {
            title: replacementName(i),
            variant: i.replacementVariant || '',
            sku: i.replacementSku || '',
            quantity: parseInt(i.quantity || 1, 10) || 1,
            // What the replacement is billed at on its own invoice. Missing or
            // zero falls back to the amount paid for the item it replaces.
            price: parseFloat(i.replacementPrice || 0) || 0
        }
    }));
}

/** order number -> { originalItems, exchangedItems } — the dashboard wins. */
function buildOrderMap(requests, returns) {
    const map = new Map();

    for (const row of returns) {
        const order = norm(row.shopify_order_id);
        if (!order) continue;
        const originalItems = asArray(row.original_items);
        const exchangedItems = asArray(row.corrected_items);
        if (!originalItems.length || !exchangedItems.length) continue;
        if (!map.has(order)) map.set(order, { originalItems, exchangedItems, source: 'zoho_returns' });
    }

    for (const req of requests) {
        const order = norm(req.order_number);
        if (!order) continue;
        const pairs = itemsFromRequest(req.items);
        if (!pairs.length) continue;
        map.set(order, {
            originalItems: pairs.map(p => p.original),
            exchangedItems: pairs.map(p => p.exchanged),
            source: 'dashboard'
        });
    }

    return map;
}

// ---------------------------------------------------------------- Zoho notes

// One paged sweep of the credit-note list (~1 call per 200) replaces thousands
// of per-order "EXCH-<order>" lookups. Cached for the day so the apply pass is
// free.
const CN_CACHE = path.join(__dirname, '..', 'tmp', 'exchange_cn_index.json');
const CN_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

async function creditNoteIndex() {
    try {
        const cached = JSON.parse(fs.readFileSync(CN_CACHE, 'utf8'));
        if (Date.now() - cached.builtAt < CN_CACHE_TTL_MS) {
            log(`credit notes: reusing ${Object.keys(cached.notes || {}).length} reference(s) from cache`);
            return new Map(Object.entries(cached.notes || {}));
        }
    } catch (e) { /* no cache */ }

    const map = new Map();
    let pages = 0;
    for (let page = 1; page <= 200; page++) {
        const res = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/creditnotes`, null, { page, per_page: 200 });
        const rows = res.creditnotes || [];
        pages++;
        for (const row of rows) {
            const ref = String(row.reference_number || '').trim();
            if (ref && !map.has(ref)) map.set(ref, row.creditnote_id);
        }
        if (rows.length < 200) break;
    }
    log(`credit notes: ${map.size} reference(s) over ${pages} page(s)`);
    try {
        fs.mkdirSync(path.dirname(CN_CACHE), { recursive: true });
        fs.writeFileSync(CN_CACHE, JSON.stringify({ builtAt: Date.now(), notes: Object.fromEntries(map) }));
    } catch (e) {
        log(`could not cache credit notes: ${e.message}`);
    }
    return map;
}

// ---------------------------------------------------------------- reporting

function csvCell(value) {
    const s = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
    return `"${s.replace(/"/g, '""')}"`;
}

function writeReport(results) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(__dirname, '..', 'tmp', `backfill_exchange_invoices_${APPLY ? 'apply' : 'plan'}_${stamp}.csv`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = ['order', 'status', 'invoice_number', 'invoice_id', 'credit_note', 'credit_note_total', 'exch_inv', 'replacement_total', 'invoice_total', 'before', 'after', 'notes'];
    const lines = [header.join(',')];
    for (const r of results) {
        lines.push([
            r.orderId, r.status, r.invoiceNumber, r.invoiceId, r.creditNoteId, r.creditNoteTotal,
            r.replacementInvoiceId, r.replacementTotal, r.totalBefore, r.before, r.after, r.notes
        ].map(csvCell).join(','));
    }
    fs.writeFileSync(file, lines.join('\n'));
    return file;
}

function writePlan(entries) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(__dirname, '..', 'tmp', `exchange_backfill_plan_${stamp}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ builtAt: Date.now(), planVersion: PLAN_VERSION, entries }));
    return file;
}

function printCounts(title, results) {
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    console.log(`\n=== ${title} ===`);
    for (const [status, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${status}: ${count}`);
    }
    return counts;
}

// ---------------------------------------------------------------- phases

// Append-only resume log: one finished plan per line, flushed as soon as it is
// known. A killed run (quota, timeout, Ctrl-C) keeps every plan it paid for.
const PROGRESS_FILE = path.join(__dirname, '..', 'tmp', 'exchange_plan_progress.jsonl');

// Plans describe the credit-note + replacement-invoice model. Bump this when
// that model changes so a log written by an older script is re-planned instead
// of being replayed against different semantics.
const PLAN_VERSION = 3;

function loadProgress() {
    const done = new Map();
    if (FRESH) {
        try { fs.truncateSync(PROGRESS_FILE, 0); } catch (e) { /* no log yet */ }
        return done;
    }
    let text = '';
    try {
        text = fs.readFileSync(PROGRESS_FILE, 'utf8');
    } catch (e) {
        return done;
    }
    let stale = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const plan = JSON.parse(line);
            if (plan.planVersion !== PLAN_VERSION) { stale++; continue; }
            if (plan.orderId) done.set(norm(plan.orderId), plan);
        } catch (e) { /* half-written trailing line */ }
    }
    if (stale) log(`${stale} plan(s) in the resume log predate this model — re-planning them`);
    return done;
}

// Transient failures are not written to the resume log, so the next run picks
// those orders up again instead of inheriting a quota blip forever.
const TRANSIENT = new Set(['error', 'invoice_lookup_failed', 'invoice_fetch_failed']);

function savePlan(plan) {
    if (TRANSIENT.has(plan.status)) return;
    try {
        fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
        fs.appendFileSync(PROGRESS_FILE, JSON.stringify({ ...plan, planVersion: PLAN_VERSION }) + '\n');
    } catch (e) {
        log(`could not append to the resume log: ${e.message}`);
    }
}

async function planOne(order, data, cnIndex) {
    try {
        return await zohoReturnService.planExchangeInvoice({
            orderId: order,
            originalItems: data.originalItems,
            exchangedItems: data.exchangedItems,
            requireMatch: true,
            withPayments: MOVE_PAYMENTS,
            // known from the bulk note map — null means "none for this order"
            creditNoteId: cnIndex.get(`EXCH-${order}`) ?? null
        });
    } catch (e) {
        return { orderId: order, status: 'error', notes: [e.message], before: [], after: [] };
    }
}

function reportPlan(plan, budget) {
    if (plan.status === 'would_fix' && budget.printed < PRINT_LIMIT) {
        console.log(`\n#${plan.orderId}  WOULD_FIX  invoice ${plan.invoiceNumber || plan.invoiceId || '?'}`);
        if (plan.revertLineItems?.length) {
            console.log(`   revert: invoice currently bills the replacement — ${plan.before.join(' | ')}`);
        }
        console.log(`   credit note: ${plan.creditNoteId ? `${plan.creditNoteId} (existing)` : `book for ₹${plan.creditNoteTotal}`}`);
        console.log(`   replacement invoice: ${plan.replacementInvoiceId
            ? `${plan.replacementInvoiceId} (${plan.replacementNeedsLines ? 're-line' : 'already priced'})`
            : 'create'} → ${(plan.after || []).join(' | ') || 'no lines'}`);
        if (plan.notes?.length) console.log(`   notes: ${plan.notes.join('; ')}`);
        budget.printed++;
    } else if (plan.status !== 'already_correct') {
        console.log(`#${plan.orderId}  ${plan.status}${plan.notes?.length ? ' — ' + plan.notes.join('; ') : ''}`);
    }
}

async function runPlan(orders, orderMap, cnIndex) {
    const done = loadProgress();
    // An explicit --orders list is a re-check request: plan those again rather
    // than trusting what an earlier run said about them.
    const pending = orders.filter(o => !done.has(o) || ONLY_ORDERS.length);
    const cached = orders.length - pending.length;
    if (cached) log(`resume: ${cached} order(s) already planned, ${pending.length} remaining`);

    const queue = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
    if (LIMIT > 0 && pending.length > queue.length) {
        log(`--limit=${LIMIT}: planning ${queue.length} of ${pending.length} remaining order(s)`);
    }

    const budget = { printed: 0 };
    const fresh = new Array(queue.length);
    let cursor = 0;
    let completed = 0;

    const worker = async () => {
        while (cursor < queue.length) {
            const i = cursor++;
            const order = queue[i];
            const plan = await planOne(order, orderMap.get(order), cnIndex);
            fresh[i] = plan;
            savePlan(plan);
            reportPlan(plan, budget);
            completed++;
            if (completed % 50 === 0) console.log(`… ${completed}/${queue.length} planned`);
            if (PACE_MS) await sleep(PACE_MS);
        }
    };

    const workers = Math.min(CONCURRENCY, queue.length || 1);
    log(`planning ${queue.length} order(s) with ${workers} worker(s)`);
    await Promise.all(Array.from({ length: workers }, worker));

    // Keep the order stable (cached + fresh, in dashboard order) so the plan
    // file diffs cleanly between runs.
    const byOrder = new Map(done);
    for (const plan of fresh) if (plan) byOrder.set(norm(plan.orderId), plan);
    return orders.map(o => byOrder.get(o)).filter(Boolean);
}

async function runApply(entries) {
    const results = [];

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        // The flag is authoritative at apply time: a plan saved by a run without
        // --payments must still move the money when this one asks for it.
        if (MOVE_PAYMENTS) entry.withPayments = true;
        let res;
        try {
            res = await zohoReturnService.applyExchangePlan(entry);
        } catch (e) {
            res = { ...entry, status: 'error', notes: [...(entry.notes || []), e.message] };
        }
        results.push(res);

        const tag = res.status === 'fixed' ? 'FIXED' : res.status.toUpperCase();
        console.log(`#${res.orderId}  ${tag}  ${res.invoiceNumber || res.invoiceId || ''}` +
            `${res.notes?.length ? ' — ' + res.notes.join('; ') : ''}`);
        if ((i + 1) % 25 === 0) console.log(`… ${i + 1}/${entries.length} applied`);
        await sleep(PACE_MS);
    }

    return results;
}

/** Execute a plan saved by an earlier run — writes only, no re-planning. */
async function applyFromPlanFile() {
    const file = path.resolve(PLAN_ARG);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.planVersion !== PLAN_VERSION) {
        console.error(`Plan ${path.basename(file)} was built by a different model (version ${saved.planVersion ?? 'none'}) — re-run the plan phase instead of replaying it.`);
        return 1;
    }
    let entries = (saved.entries || []).filter(e => e.status === 'would_fix');
    log(`plan ${path.basename(file)}: ${entries.length} candidate(s) built ${new Date(saved.builtAt).toISOString()}`);

    if (ONLY_ORDERS.length) {
        const filtered = entries.filter(e => ONLY_ORDERS.includes(e.orderId));
        log(`--orders matched ${filtered.length} of ${ONLY_ORDERS.length} given order number(s)`);
        entries = filtered;
    }
    if (LIMIT > 0) entries = entries.slice(0, LIMIT);
    if (entries.length === 0) {
        console.log('\nNothing to apply.');
        return 0;
    }
    log(`executing ${entries.length} fix(es)`);

    const results = await runApply(entries);
    printCounts('Summary', results);
    console.log(`  report: ${writeReport(results)}`);

    return results.filter(r => /failed|error/.test(r.status)).length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- main

async function main() {
    if (PLAN_ARG) return applyFromPlanFile();

    console.log(`\n=== Exchange invoice backfill (${MODE}) — since ${SINCE || 'all time'}, limit ${LIMIT || 'all'} ===\n`);

    const [requests, returns] = await Promise.all([
        fetchExchangeRequests().catch(e => { log(`dashboard scan failed: ${e.message}`); return []; }),
        fetchZohoReturns()
    ]);

    const orderMap = buildOrderMap(requests, returns);
    let orders = [...orderMap.keys()];
    if (ONLY_ORDERS.length) {
        const filtered = orders.filter(o => ONLY_ORDERS.includes(o));
        log(`--orders matched ${filtered.length} of ${ONLY_ORDERS.length} given order number(s)`);
        orders = filtered;
    }
    log(`exchange orders to check: ${orders.length}`);
    if (orders.length === 0) {
        console.log('\nNothing to do.');
        return 0;
    }

    // 1 invoice lookup + 1 detail GET + 1 EXCH-INV lookup per order
    log(`estimated Zoho calls: ~${(LIMIT > 0 ? Math.min(LIMIT, orders.length) : orders.length) * 3 + 40}`);

    // ---- Phase 1: plan (read-only) --------------------------------------
    const cnIndex = await creditNoteIndex();
    const plans = await runPlan(orders, orderMap, cnIndex);
    const toFix = plans.filter(p => p.status === 'would_fix');
    const planFile = writePlan(toFix);
    log(`planned ${toFix.length} fix(es) → ${planFile}`);

    // ---- Phase 2: apply (writes only) -----------------------------------
    let results = plans;
    if (APPLY) {
        const queue = toFix;
        if (queue.length) {
            console.log(`\n=== Applying ${queue.length} candidate(s) ===`);
            const applied = await runApply(queue);
            const byOrder = new Map(applied.map(a => [a.orderId, a]));
            results = plans.map(p => byOrder.get(p.orderId) || p);
        }
    }

    printCounts('Summary', results);
    if (!APPLY) {
        console.log(`  plan:   ${planFile}`);
        console.log('\nNothing was written. Either re-run with --apply, or execute this plan as-is:');
        console.log(`  node scripts/backfill_exchange_invoices_bulk.js --apply --plan=${path.basename(planFile)}`);
    }
    const remaining = orders.length - plans.length;
    if (remaining > 0) {
        console.log(`\n${remaining} order(s) still unplanned — run again (or without --limit) to continue;`);
        console.log('finished plans are kept in tmp/exchange_plan_progress.jsonl (--fresh to start over).');
    }
    console.log(`  report: ${writeReport(results)}`);

    return results.filter(r => /failed|error/.test(r.status)).length > 0 ? 1 : 0;
}

main()
    .then(code => {
        // Let the pg pool close on its own; the process must not hang on it
        setTimeout(() => process.exit(code), 500);
    })
    .catch(err => {
        console.error('Backfill failed:', err.message);
        process.exit(1);
    });
