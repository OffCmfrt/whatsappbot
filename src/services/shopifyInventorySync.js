// ============================================================================
// SHOPIFY ⇄ STOCK ROOM INVENTORY SYNC
// Pure plan builders + a rate-limited background job runner for the Shoppers
// Hub sync workbench:
//   • Pull  — Shopify bulk edits land in manual_inventory (adds + quantity
//             updates), applied as batched SQL, no per-SKU round trips.
//   • Push  — hub quantities (or Bulk In/Out deltas) written to Shopify via
//             inventory_levels/adjust.json, one item per call through the
//             shared 2 req/sec limiter, cancellable, progress-polled.
// All Shopify/DB access goes through `deps` so the math is unit-testable
// offline (test/testShopifyInventorySync.js).
// ============================================================================

'use strict';

// Only one push-family job may run at a time — parallel bulk runs stampeded
// carrier/Zoho APIs before; the limiter serializes anyway, so nothing is lost.
const MAX_JOBS_KEPT = 30;
const MAX_RESULTS_KEPT = 1000;
// Give up on a push once the same Shopify rejection comes back this many times
// in a row — a real per-SKU problem varies, a systemic one does not.
const IDENTICAL_ERROR_ABORT_AFTER = 3;

/* ── shared key conventions (identical to sync-from-shopify) ── */
function normKey(s) {
    return String(s || '').toLowerCase().trim().replace(/\s+/g, '-');
}

function variantSkuKey(handle, variantTitle) {
    const h = String(handle || '').toLowerCase();
    const vt = variantTitle && variantTitle !== 'Default Title' ? variantTitle : '';
    return vt ? `${h}-${vt}`.toLowerCase().replace(/\s+/g, '-') : h;
}

function inferCategory(productType) {
    const t = String(productType || '').toUpperCase();
    if (t.includes('SWEAT') || t.includes('HOODIE')) return 'SWEAT';
    if (t.includes('T-SHIRT') || t.includes('TEE')) return 'T-SHIRT';
    if (t.includes('PANT') || t.includes('SHORT') || t.includes('LOWER')) return 'LOWER';
    if (t.includes('BUNDLE') || t.includes('SET')) return 'BUNDLE';
    return null;
}

/* ── push preflight: Shopify API access scopes ── */
// Every inventory write endpoint (REST inventory_levels/adjust and GraphQL
// inventorySetQuantities alike) needs write_inventory. read_products is NOT
// enough, and a missing scope answers identically for all ~230 SKUs, so the
// hub checks once up front and refuses to start a job that cannot succeed.
const REQUIRED_PUSH_SCOPES = ['write_inventory'];

const SCOPE_FIX_STEPS = [
    'Shopify admin → Settings → Apps and sales channels → Develop apps',
    'Open this app → Configuration → Admin API access scopes → add "Write inventory" (products)',
    'Save, then click Reinstall so the new scopes are granted to the existing token',
    'If Shopify issues a new Admin API access token on reinstall, update SHOPIFY_ACCESS_TOKEN and redeploy',
];

// scopes: array of granted scope handles, or null/undefined when unknown.
// Unknown must stay permissive — a failed probe should not block real pushes.
function evaluatePushReadiness(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0) {
        return { known: false, pushEnabled: true, missingScopes: [], checkedAt: new Date().toISOString() };
    }
    const have = new Set(scopes.map(s => String(s).toLowerCase()));
    const missingScopes = REQUIRED_PUSH_SCOPES.filter(s => !have.has(s));
    return {
        known: true,
        pushEnabled: missingScopes.length === 0,
        missingScopes,
        grantedScopes: scopes,
        checkedAt: new Date().toISOString(),
        message: missingScopes.length
            ? `The Shopify app is missing the ${missingScopes.join(', ')} scope, so nothing can be pushed. ${SCOPE_FIX_STEPS[1]}`
            : null,
        fixSteps: missingScopes.length ? SCOPE_FIX_STEPS : [],
    };
}

/* ── catalog indexing ── */
// Map hub sku_key → {product, variant}. Secondary index on the variant's own
// SKU code rescues rows that were keyed differently (sheet imports).
function indexCatalog(catalog) {
    const byKey = new Map();
    const bySku = new Map();
    for (const product of catalog || []) {
        for (const variant of product.variants || []) {
            const entry = { product, variant, skuKey: variantSkuKey(product.handle, variant.title) };
            byKey.set(entry.skuKey, entry);
            const sku = normKey(variant.sku);
            if (sku && !bySku.has(sku)) bySku.set(sku, entry);
        }
    }
    return { byKey, bySku };
}

function matchHubRow(index, hubRow) {
    const direct = index.byKey.get(normKey(hubRow.sku_key));
    if (direct) return { entry: direct, via: 'key' };
    const viaSku = index.bySku.get(normKey(hubRow.sku_key));
    if (viaSku) return { entry: viaSku, via: 'sku' };
    return null;
}

/* ── pull plan: Shopify → hub ── */
// modes: 'match' (align hub to Shopify everywhere) | 'fill_zero' (adopt only
// where hub is 0) | 'new_only' (import products missing from hub).
function buildPullPlan(catalog, hubRows, opts = {}) {
    const mode = opts.mode || 'match';
    const index = indexCatalog(catalog);
    const rows = [];
    // Pass 1 — resolve every hub row to a catalog variant first (exact key,
    // then variant-SKU fallback), so a via-SKU match can never also emit an
    // "add" row for the same variant.
    const matchByCatalogKey = new Map(); // catalog skuKey → {hub, via}
    const unmatchedHub = [];
    for (const hub of hubRows || []) {
        const key = normKey(hub.sku_key);
        const direct = index.byKey.get(key);
        if (direct) { matchByCatalogKey.set(direct.skuKey, { hub, via: 'key' }); continue; }
        const viaSku = index.bySku.get(key);
        if (viaSku) { matchByCatalogKey.set(viaSku.skuKey, { hub, via: 'sku' }); continue; }
        unmatchedHub.push(hub);
    }

    // Pass 2 — every catalog variant becomes add / update / fill / equal / skip
    const consumed = new Set();
    for (const [skuKey, { product, variant }] of index.byKey) {
        const shopifyQty = Number(variant.inventory) || 0;
        const base = {
            sku_key: skuKey,
            product_name: product.title,
            size: variant.title || 'FREE',
            category: inferCategory(product.product_type),
            shopify_qty: shopifyQty,
        };
        const m = matchByCatalogKey.get(skuKey);
        if (!m) {
            rows.push({ ...base, hub_qty: null, delta: null, action: 'add' });
            continue;
        }
        consumed.add(m.hub.sku_key);
        const hub = m.hub;
        const hubQty = Number(hub.quantity) || 0;
        const delta = shopifyQty - hubQty;
        const row = {
            ...base,
            sku_key: hub.sku_key, // keep the hub's own key — apply updates in place
            product_name: hub.product_name, size: hub.size, category: hub.category,
            hub_qty: hubQty, delta,
        };
        if (delta === 0) row.action = 'equal';
        else if (mode === 'new_only') row.action = 'out_of_scope';
        else if (mode === 'fill_zero' && hubQty !== 0) row.action = 'out_of_scope';
        else row.action = hubQty === 0 ? 'fill' : 'update';
        if (m.via === 'sku') row.matched_via = 'sku';
        rows.push(row);
    }

    // Hub rows with no Shopify counterpart at all (discontinued or hand-made keys)
    const hubOnly = unmatchedHub
        .filter(hub => !consumed.has(hub.sku_key))
        .map(hub => ({
            sku_key: hub.sku_key, product_name: hub.product_name, size: hub.size,
            category: hub.category, hub_qty: Number(hub.quantity) || 0, action: 'hub_only',
        }));

    const counts = { add: 0, fill: 0, update: 0, equal: 0, out_of_scope: 0, hub_only: hubOnly.length };
    for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;
    const diffRows = rows.filter(r => r.action === 'add' || r.action === 'fill' || r.action === 'update');
    return {
        direction: 'pull',
        mode,
        generatedAt: new Date().toISOString(),
        rows: rows.sort((a, b) => String(a.product_name).localeCompare(String(b.product_name))),
        hubOnly,
        stats: {
            ...counts,
            diff_rows: diffRows.length,
            units_hub: rows.reduce((s, r) => s + (r.hub_qty || 0), 0),
            units_shopify: rows.reduce((s, r) => s + (r.shopify_qty || 0), 0),
            net_delta: diffRows.reduce((s, r) => s + (r.action === 'add' ? r.shopify_qty : r.delta), 0),
        },
    };
}

/* ── push plan: hub → Shopify ── */
// totals: Map inventory_item_id → summed available across locations. When an
// item has no levels row, falls back to the catalog's computed inventory.
function buildPushPlan(catalog, hubRows, totals, opts = {}) {
    // `recent` marks a hub row edited after the last push that actually wrote
    // something, i.e. a change made here that the operator probably wants to
    // send. The workbench preselects only those: preselecting the entire diff is
    // how one intended +40 edit once turned into 134 SKUs overwritten on Shopify.
    const sinceMs = Number(opts.sinceMs) || 0;
    const recency = hub => ({
        hub_updated_at: (hub && hub.updated_at) || null,
        recent: sinceMs > 0 && !!(hub && hub.updated_at) && Date.parse(hub.updated_at) > sinceMs,
    });
    const index = indexCatalog(catalog);
    const rows = [];
    let matched = 0;
    for (const hub of hubRows || []) {
        const m = matchHubRow(index, hub);
        if (!m) {
            rows.push({ sku_key: hub.sku_key, product_name: hub.product_name, size: hub.size,
                hub_qty: Number(hub.quantity) || 0, shopify_qty: null, delta: null, action: 'no_match', ...recency(hub) });
            continue;
        }
        matched++;
        const { entry } = m;
        const iid = entry.variant.inventory_item_id;
        if (!iid) {
            rows.push({ sku_key: hub.sku_key, product_name: hub.product_name, size: hub.size,
                hub_qty: Number(hub.quantity) || 0, shopify_qty: null, delta: null, action: 'no_inv_item', ...recency(hub) });
            continue;
        }
        const shopifyQty = totals && totals.has(iid) ? (totals.get(iid) || 0) : (Number(entry.variant.inventory) || 0);
        const hubQty = Number(hub.quantity) || 0;
        const delta = hubQty - shopifyQty;
        rows.push({
            sku_key: hub.sku_key, product_name: hub.product_name, size: hub.size,
            inventory_item_id: iid, variant_id: entry.variant.id, hub_qty: hubQty,
            shopify_qty: shopifyQty, delta, matched_via: m.via, ...recency(hub),
            action: delta === 0 ? 'equal' : delta > 0 ? 'increase' : 'decrease',
        });
    }
    const counts = { increase: 0, decrease: 0, equal: 0, no_match: 0, no_inv_item: 0 };
    for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;
    const actionable = rows.filter(r => r.action === 'increase' || r.action === 'decrease');
    return {
        direction: 'push',
        generatedAt: new Date().toISOString(),
        rows: rows.sort((a, b) => String(a.product_name).localeCompare(String(b.product_name))),
        stats: {
            ...counts,
            matched,
            units_hub: rows.reduce((s, r) => s + (r.hub_qty || 0), 0),
            units_shopify: rows.reduce((s, r) => s + (r.shopify_qty || 0), 0),
            net_delta: actionable.reduce((s, r) => s + r.delta, 0),
            // Splitting the net figure matters: a net of -5,567 hides that 107 SKUs
            // were being set to zero while 23 were being raised.
            units_added: actionable.reduce((s, r) => s + (r.delta > 0 ? r.delta : 0), 0),
            units_removed: actionable.reduce((s, r) => s + (r.delta < 0 ? -r.delta : 0), 0),
            will_clear: actionable.filter(r => r.hub_qty === 0 && r.shopify_qty > 0).length,
            recent_diffs: actionable.filter(r => r.recent).length,
        },
    };
}

// Pair the rows a push would write with the live level each write starts from,
// then total up what that push would do to the storefront. The route runs this
// BEFORE creating a job so taking stock off Shopify is always a confirmed act.
async function planAbsolutePush({ client, catalog, hubRows, selectedSkuKeys }) {
    const index = indexCatalog(catalog);
    const wanted = selectedSkuKeys && selectedSkuKeys.length ? new Set(selectedSkuKeys.map(normKey)) : null;
    const matched = [];
    const unmatched = [];
    for (const hub of hubRows || []) {
        if (wanted && !wanted.has(normKey(hub.sku_key))) continue;
        const m = matchHubRow(index, hub);
        if (!m || !m.entry.variant.inventory_item_id) { unmatched.push(hub.sku_key); continue; }
        matched.push({
            sku_key: hub.sku_key, product_name: hub.product_name, size: hub.size,
            inventory_item_id: m.entry.variant.inventory_item_id,
            target: Number(hub.quantity) || 0,
            cached_qty: Number(m.entry.variant.inventory) || 0,
        });
    }
    const svc = client || lazyDefaults().client;
    let totals = null;
    try {
        totals = (await svc.getInventoryLevels(matched.map(t => t.inventory_item_id))).totals;
    } catch (e) {
        // The job re-reads levels and refuses to guess without them; the impact
        // numbers below merely fall back to the (10 min old) catalog cache.
        console.warn('[ShopifyInventorySync] impact level read failed:', e.message);
    }
    const impact = {
        skus: matched.length, skus_up: 0, skus_down: 0, units_added: 0, units_removed: 0,
        will_clear: 0, unchanged: 0, levels_read: !!totals,
    };
    for (const t of matched) {
        const current = totals ? (totals.get(t.inventory_item_id) ?? t.cached_qty) : t.cached_qty;
        t.current_qty = current;
        t.delta = t.target - current;
        if (t.delta === 0) { impact.unchanged++; continue; }
        if (t.delta > 0) { impact.skus_up++; impact.units_added += t.delta; continue; }
        impact.skus_down++;
        impact.units_removed += -t.delta;
        if (t.target === 0 && current > 0) impact.will_clear++;
    }
    return { matched, unmatched, impact };
}

/* ── pull apply: batched SQL, no per-SKU round trips ── */
// selected: plan rows with action add|fill|update the user checked.
// Existing-vs-new is re-checked live so a row added between plan and apply
// doesn't throw a duplicate-key error.
async function applyPullPlan(db, selected, opts = {}) {
    const rows = (selected || []).filter(r => ['add', 'fill', 'update'].includes(r.action) && Number.isFinite(Number(r.shopify_qty)));
    if (rows.length === 0) return { added: 0, updated: 0, skipped: 0, unitsDelta: 0, failures: [] };

    const performedBy = opts.performedBy || 'admin';
    const reference = opts.reference || 'shopify_pull';
    const notes = opts.notes || 'Shopify sync — pulled from live catalog';
    const timestamp = new Date().toISOString();
    const failures = [];

    const keys = rows.map(r => r.sku_key);
    const existingRes = await db.query(
        'SELECT sku_key, quantity FROM manual_inventory WHERE sku_key = ANY($1::text[])', [keys]
    );
    const existing = new Map(existingRes.map(r => [r.sku_key, Number(r.quantity) || 0]));

    const adds = rows.filter(r => !existing.has(r.sku_key));
    const updates = rows.filter(r => existing.has(r.sku_key));

    // 1) inserts, chunked so the parameter list stays bounded
    const INSERT_CHUNK = 200;
    for (let i = 0; i < adds.length; i += INSERT_CHUNK) {
        const chunk = adds.slice(i, i + INSERT_CHUNK);
        const values = [];
        const params = [];
        for (const r of chunk) {
            values.push(`($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, $${params.length + 5}, 0, $${params.length + 6})`);
            params.push(r.product_name, r.category || null, r.size || 'FREE', r.sku_key, Number(r.shopify_qty), timestamp);
        }
        try {
            await db.query(
                `INSERT INTO manual_inventory (product_name, category, size, sku_key, quantity, reorder_level, updated_at)
                 VALUES ${values.join(',')} ON CONFLICT (sku_key) DO NOTHING`, params
            );
        } catch (e) {
            chunk.forEach(r => failures.push({ sku_key: r.sku_key, error: e.message }));
        }
    }

    // 2) quantity updates, single statement via UNNEST
    if (updates.length > 0) {
        try {
            await db.query(
                `UPDATE manual_inventory m
                    SET quantity = s.qty, updated_at = $3
                  FROM (SELECT UNNEST($1::text[]) AS sku_key, UNNEST($2::int[]) AS qty) s
                 WHERE m.sku_key = s.sku_key`,
                [updates.map(r => r.sku_key), updates.map(r => Number(r.shopify_qty)), timestamp]
            );
        } catch (e) {
            updates.forEach(r => failures.push({ sku_key: r.sku_key, error: e.message }));
        }
    }

    // 3) adjustment ledger, chunked multi-row insert
    const failedSet = new Set(failures.map(f => f.sku_key));
    const LOG_CHUNK = 200;
    const ledger = [
        ...adds.filter(r => !failedSet.has(r.sku_key)).map(r => ({
            r, before: 0, after: Number(r.shopify_qty) })),
        ...updates.filter(r => !failedSet.has(r.sku_key)).map(r => ({
            r, before: existing.get(r.sku_key), after: Number(r.shopify_qty) })),
    ];
    for (let i = 0; i < ledger.length; i += LOG_CHUNK) {
        const chunk = ledger.slice(i, i + LOG_CHUNK);
        const values = [];
        const params = [];
        for (const { r, before, after } of chunk) {
            values.push(`($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, 'shopify_pull', $${params.length + 4}, $${params.length + 5}, $${params.length + 6}, $${params.length + 7}, $${params.length + 8}, $${params.length + 9}, $${params.length + 10})`);
            params.push(r.sku_key, r.product_name, r.size || 'FREE', after - before, before, after, reference, notes, performedBy, timestamp);
        }
        try {
            await db.query(
                `INSERT INTO inventory_adjustments
                    (sku_key, product_name, size, adjustment_type, quantity_change, quantity_before, quantity_after, reference, notes, performed_by, created_at)
                 VALUES ${values.join(',')}`, params
            );
        } catch (e) {
            console.error('[ShopifyInventorySync] adjustment ledger insert failed:', e.message);
        }
    }

    const unitsDelta = ledger.reduce((s, { before, after }) => s + (after - before), 0);
    return {
        added: adds.filter(r => !failedSet.has(r.sku_key)).length,
        updated: updates.filter(r => !failedSet.has(r.sku_key)).length,
        skipped: rows.length - ledger.length,
        unitsDelta,
        failures,
    };
}

/* ── push job runner ── */
const _jobs = new Map();
let _jobSeq = 0;

function _pruneJobs() {
    while (_jobs.size > MAX_JOBS_KEPT) {
        // evict the oldest FINISHED job; never evict active history-first
        const evict = [..._jobs.values()].find(j => j.status !== 'running');
        if (!evict) break;
        _jobs.delete(evict.id);
    }
}

function getJob(id) {
    return _jobs.get(String(id)) || null;
}

function getActivePushJob() {
    for (const job of _jobs.values()) {
        if (job.kind === 'push' && job.status === 'running') return job;
    }
    return null;
}

function cancelJob(id) {
    const job = _jobs.get(String(id));
    if (!job || job.status !== 'running') return null;
    job.cancelRequested = true;
    return job;
}

function jobSnapshot(job) {
    return {
        id: job.id, kind: job.kind, direction: job.direction, status: job.status,
        reference: job.reference, performedBy: job.performedBy,
        total: job.total, done: job.done, succeeded: job.succeeded, failed: job.failed,
        skipped: job.skipped,
        unitsDelta: job.unitsDelta, cancelRequested: job.cancelRequested,
        abortedRemaining: job.abortedRemaining || 0,
        error: job.error, createdAt: job.createdAt, finishedAt: job.finishedAt,
        results: job.results.slice(-200), // tail sample for the UI; full set in the run row
    };
}

async function _persistRunStart(db, job) {
    if (!db) return null;
    try {
        const res = await db.query(
            `INSERT INTO shopify_inventory_sync_runs
                (direction, mode, status, skus_total, reference, performed_by, started_at, created_at)
             VALUES ($1, $2, 'running', $3, $4, $5, $6, $6)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [job.direction, job.mode || 'delta', job.total, job.reference, job.performedBy, job.createdAt]
        );
        return res && res[0] ? res[0].id : null;
    } catch (e) {
        console.warn('[ShopifyInventorySync] run start persist failed:', e.message);
        return null;
    }
}

async function _persistRunFinish(db, job) {
    if (!db) return;
    try {
        await db.query(
            `UPDATE shopify_inventory_sync_runs
                SET status = $2, skus_applied = $3, skus_failed = $4, units_delta = $5,
                    detail = $6, finished_at = $7
              WHERE id = $1`,
            [job.runId, job.status, job.succeeded, job.failed, job.unitsDelta,
             JSON.stringify(job.results.slice(0, 500)), job.finishedAt || new Date().toISOString()]
        );
    } catch (e) {
        console.warn('[ShopifyInventorySync] run finish persist failed:', e.message);
    }
}

// tasks: [{sku_key, product_name, size, inventory_item_id, delta, target?}]
// delta mode sends task.delta; absolute mode carries target (hub qty) and the
// delta is recomputed against the fresh level total at write time, so plan
// drift between preview and execution is corrected instead of pushed.
// Location choice per item: the location holding the most available (so a
// decrease never strands more than one location in the negative); fall back
// to the store's first location for fresh items.
async function runPushJob({ client, db, tasks, reference, performedBy, mode, direction }) {
    const work = (tasks || []).filter(t => t && t.inventory_item_id && Number(t.delta) !== 0);
    const skipped = (tasks || []).length - work.length;

    const job = {
        id: `swp_${Date.now()}_${++_jobSeq}`,
        kind: 'push', direction: direction || 'push', mode: mode || 'delta',
        status: work.length === 0 ? 'done' : 'running',
        reference: reference || 'shopify_push', performedBy: performedBy || 'admin',
        total: work.length, done: 0, succeeded: 0, failed: 0, skipped,
        unitsDelta: 0, results: [], cancelRequested: false,
        abortedRemaining: 0,
        error: null, createdAt: new Date().toISOString(), finishedAt: null, runId: null,
    };
    _jobs.set(job.id, job);
    _pruneJobs();

    job.runId = await _persistRunStart(db, job);
    if (work.length === 0) {
        job.finishedAt = new Date().toISOString();
        await _persistRunFinish(db, job);
        return job;
    }

    // async loop — the route must not wait on it
    (async () => {
        try {
            const iids = [...new Set(work.map(t => t.inventory_item_id))];
            let levelsById = new Map();
            let totalsById = new Map();
            let levelReadError = null;
            try {
                const levels = await client.getInventoryLevels(iids);
                levelsById = levels.byId;
                totalsById = levels.totals || new Map();
            } catch (e) {
                levelReadError = e.message;
                console.warn('[ShopifyInventorySync] level read failed:', e.message);
            }
            // Default location for items that have no level row yet. /locations
            // needs the read_locations scope, which this app may not carry, so
            // fall back to a location id already visible in the levels read —
            // a single-warehouse store then needs no extra scope at all.
            let defaultLocationId = null;
            try {
                const locations = await client.getLocations();
                defaultLocationId = locations[0] ? locations[0].id : null;
            } catch (e) {
                const seen = [...levelsById.values()].flat().map(l => l.locationId).filter(Boolean);
                defaultLocationId = seen[0] || null;
                if (!defaultLocationId) console.warn('[ShopifyInventorySync] locations unavailable:', e.message);
            }

            // An absolute push aligns Shopify to the hub number, so it must know
            // the live total first: assuming 0 after a failed read would ADD the
            // whole hub quantity on top of real stock. Refuse to write instead.
            const needsLiveTotals = work.some(t => Number.isFinite(Number(t.target)));
            const refuseToGuess = Boolean(levelReadError) && needsLiveTotals;
            if (refuseToGuess) {
                job.error = `Shopify stock levels could not be read (${levelReadError}) — nothing was written, so no quantity was guessed.`;
                job.failed = job.total;
                job.done = job.total;
            }

            // A deterministic Shopify rejection (missing scope, malformed body,
            // unusable location) answers identically for every remaining SKU, and
            // at ~2 writes/sec that is minutes of pointless calls. Stop early
            // instead of reporting 230 failures for one underlying mistake.
            let lastError = null;
            let sameErrorStreak = 0;
            for (const task of refuseToGuess ? [] : work) {
                if (job.cancelRequested) break;
                const breakdown = levelsById.get(task.inventory_item_id) || [];
                const currentTotal = breakdown.length
                    ? breakdown.reduce((s, l) => s + (Number(l.available) || 0), 0)
                    : (totalsById.get(task.inventory_item_id) || 0);
                let delta = Number(task.delta);
                if (Number.isFinite(Number(task.target))) delta = Number(task.target) - currentTotal;
                if (delta === 0) { job.skipped++; job.done++; continue; }
                const target = breakdown.length
                    ? breakdown.reduce((max, l) => (l.available > max.available ? l : max), breakdown[0]).locationId
                    : defaultLocationId;
                let rec;
                if (!target) {
                    rec = { sku_key: task.sku_key, product_name: task.product_name, size: task.size,
                        delta, ok: false,
                        error: 'No inventory location available — set SHOPIFY_INVENTORY_LOCATION_ID or grant the app read_locations' };
                } else {
                    const res = await client.adjustInventoryLevel({
                        inventoryItemId: task.inventory_item_id, locationId: target,
                        availableDelta: delta,
                    });
                    rec = { sku_key: task.sku_key, product_name: task.product_name, size: task.size,
                        delta, locationId: target,
                        ok: res.success, availableAfterChange: res.availableAfterChange ?? null,
                        applied: res.appliedAdjustment ?? null, error: res.error || null };
                }
                job.results.push(rec);
                if (job.results.length > MAX_RESULTS_KEPT) job.results.splice(0, job.results.length - MAX_RESULTS_KEPT);
                if (rec.ok) { job.succeeded++; job.unitsDelta += delta; } else { job.failed++; }
                job.done++;
                // A rejected scope fails identically for every remaining SKU, and
                // at ~2 writes/sec that is minutes of pointless calls: stop on the
                // first one and surface the instruction instead of a failed count.
                if (!rec.ok && rec.error && /merchant approval|scope/i.test(rec.error)) {
                    job.error = rec.error;
                    job.abortedRemaining = job.total - job.done;
                    break;
                }
                if (!rec.ok && rec.error) {
                    const norm = String(rec.error).trim();
                    if (norm === lastError) sameErrorStreak++;
                    else { lastError = norm; sameErrorStreak = 1; }
                    if (sameErrorStreak >= IDENTICAL_ERROR_ABORT_AFTER) {
                        job.error = `${norm} — repeated on ${sameErrorStreak} SKU(s) in a row, so it will not resolve itself. Nothing further was written.`;
                        job.abortedRemaining = job.total - job.done;
                        break;
                    }
                } else {
                    lastError = null;
                    sameErrorStreak = 0;
                }
            }
            job.status = job.cancelRequested ? 'cancelled' : (job.error ? 'failed' : 'done');
        } catch (e) {
            job.status = 'failed';
            job.error = e.message;
        } finally {
            job.finishedAt = new Date().toISOString();
            await _persistRunFinish(db, job);
        }
    })();

    return job;
}

// Absolute push: align Shopify totals to hub quantities for the given rows.
// Reads Shopify levels fresh at start so plan drift since preview is corrected.
async function startAbsolutePushJob({ client, db, catalog, hubRows, selectedSkuKeys, reference, performedBy, preplan }) {
    // Deltas come from live levels (planAbsolutePush), not the cached catalog, so a
    // SKU that already matches Shopify never enters the job and the reported total
    // means "writes about to happen" rather than "rows the operator selected".
    const prepared = preplan || await planAbsolutePush({ client, catalog, hubRows, selectedSkuKeys });
    const tasks = prepared.matched.filter(t => t.delta !== 0).map(t => ({
        sku_key: t.sku_key, product_name: t.product_name, size: t.size,
        inventory_item_id: t.inventory_item_id, delta: t.delta, target: t.target,
    }));
    const job = await runPushJob({ client, db, tasks, reference, performedBy, mode: 'absolute', direction: 'push' });
    return { job, unmatched: prepared.unmatched, impact: prepared.impact };
}

// Delta push: apply known deltas (Bulk In/Out) onto Shopify directly.
async function startDeltaPushJob({ client, db, catalog, deltas, reference, performedBy }) {
    const index = indexCatalog(catalog);
    const tasks = [];
    const unmatched = [];
    for (const d of deltas || []) {
        const m = matchHubRow(index, { sku_key: d.sku_key });
        if (!m || !m.entry.variant.inventory_item_id) { unmatched.push(d.sku_key); continue; }
        tasks.push({
            sku_key: d.sku_key, product_name: d.product_name, size: d.size,
            inventory_item_id: m.entry.variant.inventory_item_id, delta: Number(d.delta) || 0,
        });
    }
    const job = await runPushJob({ client, db, tasks, reference, performedBy, mode: 'delta', direction: 'push_delta' });
    return { job, unmatched };
}

function lazyDefaults() {
    return {
        client: require('./shopifyService'),
        db: require('../database/db').dbAdapter,
    };
}

// Probe the live installation and grade it. A client without the probe method
// (older fakes, stubbed clients) reads as "unknown" = permissive.
async function getPushReadiness(client) {
    const svc = client || lazyDefaults().client;
    let scopes = null;
    try {
        if (svc && typeof svc.getAppScopes === 'function') scopes = await svc.getAppScopes(false);
    } catch (e) {
        console.warn('[ShopifyInventorySync] readiness probe failed:', e.message);
    }
    return evaluatePushReadiness(scopes);
}

module.exports = {
    normKey, variantSkuKey, inferCategory, indexCatalog, matchHubRow,
    buildPullPlan, buildPushPlan, planAbsolutePush, applyPullPlan,
    runPushJob, startAbsolutePushJob, startDeltaPushJob,
    getJob, getActivePushJob, cancelJob, jobSnapshot, lazyDefaults,
    evaluatePushReadiness, getPushReadiness, REQUIRED_PUSH_SCOPES,
};
