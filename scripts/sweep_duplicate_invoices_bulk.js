#!/usr/bin/env node
/**
 * Void the duplicate invoices that chase customers for money nobody owes.
 *
 * When a sync raced itself, an order can end up with two documents on the same
 * reference: the real one, settled, and a twin still sitting "overdue" for the
 * full amount. The twin was never paid and never credited — it is a phantom
 * receivable, and it is what keeps orders on the overdue list after the customer
 * has paid.
 *
 * A duplicate is only touched when ALL of these hold, re-read live at the moment
 * of the write (not taken from a stale listing):
 *   • the document is live (not void/deleted) and still shows a balance
 *   • balance == total, i.e. not one rupee was ever applied to it  → no money
 *     is destroyed by voiding it
 *   • credits_applied == 0                                        → no credit
 *     note is stranded on it
 *   • a SIBLING on the same reference is settled (balance ≤ 0.02)  → the order
 *     is already paid for somewhere, so this document is the spare
 *
 * Anything that fails a guard is reported, never written. Voiding is
 * irreversible in Books, so this tool refuses to guess.
 *
 * Cost: 2 reads per candidate (duplicate + sibling) then 1 POST. Candidates come
 * from the cached invoice snapshot, so planning itself is free.
 *
 * Usage:
 *   node scripts/sweep_duplicate_invoices_bulk.js                 # list candidates (free)
 *   node scripts/sweep_duplicate_invoices_bulk.js --verify=20     # live-check 20
 *   node scripts/sweep_duplicate_invoices_bulk.js --apply         # verify + void all
 *   node scripts/sweep_duplicate_invoices_bulk.js --apply --refs=tmp/exchange_all_orders.txt
 *
 * Options:
 *   --apply        write to Zoho (default: report only)
 *   --verify=N     live-verify at most N candidates without writing
 *   --refs=FILE    only those references (comma separated ids in a file)
 *   --limit=N      hard cap on candidates processed
 *   --pace=MS      delay between writes (default 400)
 *   --fresh        ignore the cached snapshot + resume log
 *   --print=N      candidate lines to print (default 12)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zohoService = require('../src/services/zohoService');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FRESH = args.includes('--fresh');
const num = (flag, dflt) => {
    const hit = args.find(a => a.startsWith(`--${flag}=`));
    return hit ? parseInt(hit.split('=')[1], 10) : dflt;
};
const str = (flag, dflt) => (args.find(a => a.startsWith(`--${flag}=`)) || '').split('=')[1] || dflt;
const VERIFY = num('verify', 0);
const LIMIT = num('limit', 0);
const PACE_MS = num('pace', 400);
const PRINT_LIMIT = num('print', 12);
const REFS_ARG = str('refs', '');

const TMP = path.join(__dirname, '..', 'tmp');
const SNAPSHOT_CACHE = path.join(TMP, 'invoice_snapshot.json');
const PROGRESS_FILE = path.join(TMP, 'duplicate_sweep_progress.jsonl');
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

const money = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (msg) => console.log(`[${APPLY ? 'APPLY' : 'CHECK'}] ${msg}`);
const norm = (o) => String(o || '').replace(/^#/, '').trim();

function loadSnapshot() {
    if (!FRESH) {
        try {
            const hit = JSON.parse(fs.readFileSync(SNAPSHOT_CACHE, 'utf8'));
            if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) {
                log(`snapshot: reusing ${hit.invoices.length} row(s) from ${new Date(hit.at).toISOString()}`);
                return hit.invoices;
            }
        } catch (e) { /* no cache */ }
    }
    throw new Error('no invoice snapshot — run scripts/apply_open_credit_notes_bulk.js --fresh first (it builds one)');
}

function scope() {
    if (!REFS_ARG) return null;
    const text = fs.readFileSync(path.resolve(REFS_ARG), 'utf8');
    const ids = text.split(/[\s,]+/).map(norm).filter(Boolean);
    log(`scope: ${ids.length} reference(s) from ${REFS_ARG}`);
    return new Set(ids);
}

/**
 * Candidates: live invoices that still owe, sharing a reference with a sibling
 * that is already settled.
 */
function candidatesFrom(invoices, only) {
    const groups = new Map();
    for (const row of invoices) {
        const ref = String(row.reference_number || '').trim();
        if (!ref) continue;
        if (only && !only.has(ref)) continue;
        if (!groups.has(ref)) groups.set(ref, []);
        groups.get(ref).push(row);
    }
    const out = [];
    let multi = 0;
    for (const [ref, rows] of groups) {
        if (rows.length < 2) continue;
        multi++;
        const live = rows.filter(r => r.status !== 'void' && r.status !== 'deleted');
        if (live.length < 2) continue;
        const settled = live.filter(r => money(r.balance) <= 0.02);
        const open = live.filter(r => money(r.balance) > 0.02);
        if (!settled.length || !open.length) continue;
        const keeper = settled.sort((a, b) => money(b.total) - money(a.total))[0];
        for (const dup of open) {
            out.push({
                reference: ref,
                invoiceId: String(dup.invoice_id),
                invoiceNumber: dup.invoice_number,
                total: money(dup.total),
                balance: money(dup.balance),
                status: dup.status,
                keeperId: String(keeper.invoice_id),
                keeperNumber: keeper.invoice_number,
                keeperBalance: money(keeper.balance)
            });
        }
    }
    log(`references: ${groups.size}, with 2+ invoices: ${multi}, duplicate candidates: ${out.length}`);
    return out;
}

function loadProgress() {
    const done = new Set();
    if (FRESH || !fs.existsSync(PROGRESS_FILE)) return done;
    for (const line of fs.readFileSync(PROGRESS_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const e = JSON.parse(line);
            if (e.invoiceId) done.add(String(e.invoiceId));
        } catch (err) { /* partial */ }
    }
    return done;
}

function appendProgress(entry) {
    try {
        fs.mkdirSync(TMP, { recursive: true });
        fs.appendFileSync(PROGRESS_FILE, JSON.stringify(entry) + '\n');
    } catch (e) { log(`could not append to the resume log: ${e.message}`); }
}

/**
 * The money guard. Everything here is read fresh from the document itself.
 */
async function verify(candidate) {
    const out = { ...candidate, action: 'skip', reason: '' };
    let dup, keep;
    try {
        dup = await zohoService.getInvoice(candidate.invoiceId);
        keep = await zohoService.getInvoice(candidate.keeperId);
    } catch (e) {
        return { ...out, action: 'skip', reason: `read_failed: ${e.message}` };
    }
    if (!dup) return { ...out, reason: 'invoice_missing' };
    if (dup.status === 'void' || dup.status === 'deleted') return { ...out, reason: 'already_void' };
    const balance = money(dup.balance);
    const total = money(dup.total);
    const credits = money(dup.credits_applied);
    out.liveBalance = balance;
    out.liveTotal = total;
    out.liveCredits = credits;
    if (!(balance > 0.02)) return { ...out, reason: 'no_balance_left' };
    if (Math.abs(balance - total) > 0.02) return { ...out, reason: `money_applied (due ${balance} of ${total})` };
    if (credits > 0.02) return { ...out, reason: `credit_note_applied (₹${credits})` };
    if (!keep) return { ...out, reason: 'sibling_missing' };
    if (keep.status === 'void' || keep.status === 'deleted') return { ...out, reason: `sibling_is_${keep.status}` };
    if (money(keep.balance) > 0.02) return { ...out, reason: `sibling_not_settled (due ₹${money(keep.balance)})` };
    out.keeperStatus = keep.status;
    out.keeperLiveBalance = money(keep.balance);
    return { ...out, action: 'void', reason: 'duplicate_of_settled_document' };
}

(async () => {
    const invoices = loadSnapshot();
    const only = scope();
    const all = candidatesFrom(invoices, only);
    const done = loadProgress();
    let queue = all.filter(c => !done.has(String(c.invoiceId)));
    if (done.size) log(`resume: ${all.length - queue.length} already handled, ${queue.length} remaining`);

    const cap = APPLY ? LIMIT : (VERIFY || LIMIT || 0);
    if (cap > 0) queue = queue.slice(0, cap);
    log(`checking ${queue.length} candidate(s)`);

    const ok = [];
    const reasons = {};
    const writer = APPLY ? 'voiding' : 'would void';
    let processed = 0;
    for (const candidate of queue) {
        const res = await verify(candidate);
        processed++;
        if (res.action === 'void') {
            ok.push(res);
            if (ok.length <= PRINT_LIMIT) {
                console.log(`  ${res.invoiceNumber} ₹${res.liveBalance} ${res.status} — duplicate of settled ${res.keeperNumber} (${res.keeperStatus} ₹${res.keeperLiveBalance}) → ${writer}`);
            }
        } else {
            reasons[res.reason.split(' ')[0]] = (reasons[res.reason.split(' ')[0]] || 0) + 1;
            if (APPLY) appendProgress({ invoiceId: res.invoiceId, action: 'skipped', reason: res.reason });
        }
        if (processed % 100 === 0) log(`  ${processed}/${queue.length} checked, ${ok.length} clean`);
        if (!APPLY && processed >= (VERIFY || queue.length)) break;
        await sleep(20);
    }

    const amount = money(ok.reduce((s, c) => s + c.liveBalance, 0));
    console.log(`\n=== ${APPLY ? 'Voided' : 'Voidable'} ===`);
    console.log(`  documents: ${ok.length} | phantom receivable: ₹${amount}`);
    if (Object.keys(reasons).length) console.log('  skipped:', JSON.stringify(reasons));

    if (!APPLY) {
        console.log('\nNothing was written. Re-run with --apply to void these.');
        return;
    }

    log(`voiding ${ok.length} document(s)`);
    let voided = 0, failed = 0, removed = 0;
    for (const res of ok) {
        try {
            await zohoService.voidInvoice(res.invoiceId);
            voided++;
            removed += res.liveBalance;
            appendProgress({ invoiceId: res.invoiceId, invoiceNumber: res.invoiceNumber, reference: res.reference, action: 'voided', amount: res.liveBalance });
        } catch (e) {
            failed++;
            appendProgress({ invoiceId: res.invoiceId, invoiceNumber: res.invoiceNumber, action: 'void_failed', error: e.message });
            console.log(`  ⚠️ ${res.invoiceNumber}: ${e.message}`);
        }
        await sleep(PACE_MS);
    }
    log(`voided ${voided}, failed ${failed}, phantom receivable removed ₹${money(removed)}`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
