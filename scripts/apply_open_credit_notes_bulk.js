#!/usr/bin/env node
/**
 * Apply every unused (open) return/exchange credit note to the invoice it
 * reverses — the bulk half of "no false dues on returned goods".
 *
 * A credit note created "against" an invoice is not always applied by Books: it
 * sits as unused customer credit while the invoice keeps billing the returned
 * product, so the customer is chased for goods they gave back. This walk finds
 * those invoices and releases the note against them.
 *
 * Quota shape — reads are what costs, so they are batched:
 *   snapshot : page the invoice list once (≈1 call / 200 invoices) and the
 *              credit-note ledger once. Both are cached on disk.
 *   plan     : pure cache matching, ZERO API calls
 *   --apply  : exactly one POST per note, no reads at all
 * So the whole repair costs ≈(invoices/200) + (notes) calls instead of two
 * calls per note. An invoice number missing from the snapshot is resolved with
 * a single search_text lookup, bounded by --deep.
 *
 * Only the overlap is applied (min(note balance, invoice balance)), and the
 * running balance per invoice is tracked while applying, so two notes on the
 * same invoice can never over-apply it. A note whose invoice is already settled
 * or void is reported, never written.
 *
 * Usage:
 *   node scripts/apply_open_credit_notes_bulk.js                  # plan everything (free)
 *   node scripts/apply_open_credit_notes_bulk.js --limit=50       # plan first 50
 *   node scripts/apply_open_credit_notes_bulk.js --apply          # plan + write
 *   node scripts/apply_open_credit_notes_bulk.js --apply --plan=tmp/x.json
 *   node scripts/apply_open_credit_notes_bulk.js --scan           # size only
 *   node scripts/apply_open_credit_notes_bulk.js --fresh          # ignore all caches
 *
 * Options:
 *   --apply        write to Zoho (default: plan only, nothing written)
 *   --plan=FILE    with --apply: execute a plan saved by an earlier run
 *   --limit=N      process at most N candidates (0 = all)
 *   --prefixes=a,b credit-note reference prefixes (default RET,RTO,EXCH)
 *   --fresh        ignore the cached ledger + snapshot
 *   --scan         only refresh caches, print the size
 *   --pace=MS      delay between writes (default 400)
 *   --print=N      how many planned lines to print (default 10)
 *   --deep=N       invoice-number lookups for numbers absent from the snapshot
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zohoService = require('../src/services/zohoService');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FRESH = args.includes('--fresh');
const SCAN_ONLY = args.includes('--scan');
const num = (flag, dflt) => {
    const hit = args.find(a => a.startsWith(`--${flag}=`));
    return hit ? parseInt(hit.split('=')[1], 10) || dflt : dflt;
};
const str = (flag, dflt) => (args.find(a => a.startsWith(`--${flag}=`)) || '').split('=')[1] || dflt;
const LIMIT = num('limit', 0);
const PACE_MS = num('pace', 400);
const PRINT_LIMIT = num('print', 10);
const DEEP_LIMIT = num('deep', 25);
const PLAN_ARG = str('plan', '');
const PREFIXES = str('prefixes', 'RET,RTO,EXCH').split(',').map(p => p.trim().toUpperCase()).filter(Boolean);

const TMP = path.join(__dirname, '..', 'tmp');
const LEDGER_CACHE = path.join(TMP, 'credit_note_ledger.json');
const SNAPSHOT_CACHE = path.join(TMP, 'invoice_snapshot.json');
const PLAN_FILE = path.join(TMP, 'credit_note_repair_plan.json');
const PROGRESS_FILE = path.join(TMP, 'credit_note_repair_progress.jsonl');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 200;

const money = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (msg) => console.log(`[${APPLY ? 'APPLY' : 'PLAN'}] ${msg}`);
const readCache = (file) => {
    try {
        const hit = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
    } catch (e) { /* no cache yet */ }
    return null;
};
const writeCache = (file, data) => {
    try {
        fs.mkdirSync(TMP, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ at: Date.now(), ...data }));
    } catch (e) { log(`could not write the cache: ${e.message}`); }
};

// ------------------------------------------------------------------ caches
async function loadLedger() {
    if (!FRESH) {
        const cached = readCache(LEDGER_CACHE);
        if (cached) {
            log(`ledger: reusing ${cached.notes.length} cached credit note(s)`);
            return cached.notes;
        }
    }
    log('ledger: paging the credit-note list');
    const notes = await zohoService.searchCreditNotes({ page_limit: 1000 });
    writeCache(LEDGER_CACHE, { notes });
    log(`ledger: ${notes.length} credit note(s) cached`);
    return notes;
}

/**
 * Page the invoice list once. Every row carries invoice_id, invoice_number,
 * status and balance, so the plan needs nothing else — a per-invoice read would
 * cost one call each for data already sitting in the listing.
 */
async function loadInvoices() {
    if (!FRESH) {
        const cached = readCache(SNAPSHOT_CACHE);
        if (cached) {
            log(`invoices: reusing ${cached.invoices.length} cached row(s)`);
            return cached.invoices;
        }
    }
    log('invoices: paging the invoice list');
    const seen = new Map();
    let page = 1;
    for (;;) {
        const rows = await zohoService.searchInvoice({ page, per_page: PAGE_SIZE });
        for (const row of rows) if (row && row.invoice_id) seen.set(String(row.invoice_id), row);
        if (rows.length < PAGE_SIZE) break;
        page++;
        if (page % 25 === 0) log(`  invoices: page ${page}, ${seen.size} row(s)`);
        if (page > 600) { log('invoices: page cap reached, snapshot may be partial'); break; }
    }
    const invoices = [...seen.values()];
    writeCache(SNAPSHOT_CACHE, { invoices });
    log(`invoices: ${invoices.length} row(s) cached over ${page} page(s)`);
    return invoices;
}

function indexInvoices(invoices) {
    const byNumber = new Map();
    for (const row of invoices) {
        const key = String(row.invoice_number || '').trim().toUpperCase();
        if (key) byNumber.set(key, row);
    }
    return byNumber;
}

// ------------------------------------------------------------------ candidates
function candidatesFrom(notes) {
    const out = [];
    for (const n of notes) {
        const ref = String(n.reference_number || '');
        const prefix = ref.split('-')[0].toUpperCase();
        if (!PREFIXES.includes(prefix)) continue;
        if (n.status !== 'open') continue;
        const balance = money(n.balance);
        if (!(balance > 0.02)) continue;
        // The list row carries the associated invoice NUMBER (comma separated
        // when several); the first one is the document being reversed.
        const invoiceNumber = String(n.applied_invoices || '').split(',')[0].trim();
        out.push({
            creditNoteId: n.creditnote_id,
            creditNoteNumber: n.creditnote_number,
            reference: ref,
            noteBalance: balance,
            invoiceNumber: invoiceNumber || null
        });
    }
    // Oldest note first: a long-standing note is usually attached to the
    // longest-overdue invoice, which is the one being chased.
    out.sort((a, b) => String(a.reference).localeCompare(String(b.reference), undefined, { numeric: true }));
    return out;
}

// ------------------------------------------------------------------ progress
function loadProgress() {
    const done = new Map();
    if (FRESH || !fs.existsSync(PROGRESS_FILE)) return done;
    for (const line of fs.readFileSync(PROGRESS_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.creditNoteId) done.set(String(entry.creditNoteId), entry);
        } catch (e) { /* partial line */ }
    }
    return done;
}

function appendProgress(entry) {
    try {
        fs.mkdirSync(TMP, { recursive: true });
        fs.appendFileSync(PROGRESS_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
        log(`could not append to the resume log: ${e.message}`);
    }
}

// ------------------------------------------------------------------ planning
async function resolveMissing(candidate, budget) {
    if (budget.left <= 0) return null;
    if (!candidate.invoiceNumber) return null;
    budget.left--;
    try {
        const rows = await zohoService.searchInvoice({ page: 1, per_page: 20, search_text: candidate.invoiceNumber });
        const want = candidate.invoiceNumber.trim().toUpperCase();
        const hit = (rows || []).find(r => String(r.invoice_number || '').trim().toUpperCase() === want);
        if (hit) budget.found++;
        return hit || null;
    } catch (e) {
        return null;
    }
}

async function planAll(candidates, byNumber) {
    const done = loadProgress();
    const pending = candidates.filter(c => !done.has(String(c.creditNoteId)));
    const cached = candidates.length - pending.length;
    if (cached) log(`resume: ${cached} candidate(s) already handled, ${pending.length} remaining`);
    const queue = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
    log(`planning ${queue.length} candidate(s) of ${candidates.length}`);

    // What is still owed per invoice, so several notes on one invoice can
    // never add up to more than the document's balance.
    const remaining = new Map();
    const budget = { left: DEEP_LIMIT, found: 0 };
    const plans = [];
    let printed = 0;

    for (const candidate of queue) {
        const plan = { ...candidate, status: 'skipped', applyAmount: 0, notes: [] };
        let row = candidate.invoiceNumber ? byNumber.get(candidate.invoiceNumber.trim().toUpperCase()) : null;
        if (!row) row = await resolveMissing(candidate, budget);
        if (!row) {
            plan.status = candidate.invoiceNumber ? 'invoice_not_found' : 'no_linked_invoice';
            plans.push(plan);
            continue;
        }
        plan.invoiceId = row.invoice_id;
        plan.invoiceNumber = row.invoice_number;
        plan.invoiceStatus = row.status;
        if (row.status === 'void' || row.status === 'deleted') {
            plan.status = 'invoice_void';
            plans.push(plan);
            continue;
        }
        const invoiceBalance = money(row.balance);
        plan.invoiceBalance = invoiceBalance;
        if (!(invoiceBalance > 0.02)) {
            plan.status = 'invoice_already_settled';
            plans.push(plan);
            continue;
        }
        const left = remaining.has(String(row.invoice_id))
            ? remaining.get(String(row.invoice_id))
            : invoiceBalance;
        if (!(left > 0.02)) {
            plan.status = 'covered_by_other_note';
            plans.push(plan);
            continue;
        }
        plan.applyAmount = money(Math.min(plan.noteBalance, left));
        plan.status = 'would_apply';
        remaining.set(String(row.invoice_id), money(left - plan.applyAmount));
        plans.push(plan);
        if (printed < PRINT_LIMIT) {
            console.log(`  ${plan.reference} → ${plan.invoiceNumber}: apply ₹${plan.applyAmount} (note ₹${plan.noteBalance}, invoice due ₹${invoiceBalance})`);
            printed++;
        }
    }
    if (budget.left < DEEP_LIMIT) log(`deep lookups: ${DEEP_LIMIT - budget.left} used, ${budget.found} resolved`);

    fs.writeFileSync(PLAN_FILE, JSON.stringify({ builtAt: Date.now(), planVersion: 2, entries: plans }, null, 1));
    return plans;
}

// ------------------------------------------------------------------ apply
async function applyPlans(plans) {
    // Recompute the running balance from what is actually written, so a saved
    // plan replayed later still cannot over-apply an invoice.
    const remaining = new Map();
    const done = loadProgress();
    let applied = 0, skipped = 0, failed = 0, released = 0;

    for (const plan of plans) {
        if (!(plan.applyAmount > 0) || !plan.creditNoteId || !plan.invoiceId) continue;
        if (done.get(String(plan.creditNoteId))?.status === 'applied') { skipped++; continue; }
        const key = String(plan.invoiceId);
        if (!remaining.has(key)) remaining.set(key, plan.invoiceBalance);
        const left = remaining.get(key);
        if (!(left > 0.02)) { skipped++; continue; }
        const amount = money(Math.min(plan.applyAmount, left));
        const res = await applyOne({ ...plan, applyAmount: amount });
        appendProgress(res);
        if (res.status === 'applied') {
            applied++;
            released += amount;
            remaining.set(key, money(left - amount));
        } else {
            failed++;
            console.log(`  ⚠️ ${plan.reference}: ${res.status}${res.notes?.length ? ' — ' + res.notes.join('; ') : ''}`);
        }
        await sleep(PACE_MS);
    }
    return { applied, skipped, failed, released };
}

async function applyOne(plan) {
    if (!(plan.applyAmount > 0) || !plan.creditNoteId || !plan.invoiceId) {
        return { ...plan, status: 'invalid_plan' };
    }
    try {
        await zohoService.applyCreditNote(plan.creditNoteId, plan.invoiceId, plan.applyAmount);
        return { ...plan, status: 'applied' };
    } catch (e) {
        return { ...plan, status: 'apply_failed', notes: [...(plan.notes || []), e.message] };
    }
}

function summarise(plans) {
    const by = {};
    for (const p of plans) by[p.status] = (by[p.status] || 0) + 1;
    console.log('\n=== Summary ===');
    for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
    const total = plans.filter(p => p.status === 'would_apply' || p.status === 'applied')
        .reduce((s, p) => s + money(p.applyAmount), 0);
    console.log(`  amount ${APPLY ? 'applied' : 'to release'}: ₹${money(total)}`);
}

(async () => {
    fs.mkdirSync(TMP, { recursive: true });
    if (PLAN_ARG) {
        const saved = JSON.parse(fs.readFileSync(path.resolve(TMP, PLAN_ARG), 'utf8'));
        const entries = (saved.entries || saved).filter(e => e.status === 'would_apply' || e.status === 'applied');
        log(`executing saved plan ${PLAN_ARG}: ${entries.length} action(s)`);
        const res = await applyPlans(entries);
        log(`applied ${res.applied}, already done ${res.skipped}, failed ${res.failed}, released ₹${money(res.released)}`);
        return;
    }

    const notes = await loadLedger();
    const candidates = candidatesFrom(notes);
    const openAll = notes.filter(n => n.status === 'open').length;
    log(`credit notes: ${notes.length} total, ${openAll} open, ${candidates.length} open ${PREFIXES.join('/')} note(s) with a balance`);

    if (SCAN_ONLY) {
        const byPrefix = {};
        for (const c of candidates) {
            const k = c.reference.split('-')[0];
            byPrefix[k] = (byPrefix[k] || 0) + 1;
        }
        console.log('\nopen candidates by prefix:', JSON.stringify(byPrefix));
        console.log('plan cost: 0 call(s) after the snapshot — run without --scan to plan');
        return;
    }

    const invoices = await loadInvoices();
    const byNumber = indexInvoices(invoices);
    const plans = await planAll(candidates, byNumber);
    summarise(plans);

    if (!APPLY) {
        console.log(`\nNothing was written. Re-run with --apply (${path.relative(process.cwd(), PLAN_FILE)}).`);
        return;
    }

    const actionable = plans.filter(p => p.status === 'would_apply');
    log(`applying ${actionable.length} credit note(s)`);
    const res = await applyPlans(actionable);
    log(`applied ${res.applied}, skipped ${res.skipped}, failed ${res.failed}, released ₹${money(res.released)}`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
