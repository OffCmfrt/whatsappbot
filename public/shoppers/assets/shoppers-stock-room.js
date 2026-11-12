// ============================================================================
// OFFCOMFRT — STOCK ROOM (Manual Inventory & Bulk Inventory-In)
// Part of the Inventory Control Tower in Shoppers Hub.
// Premium manual inventory management with memory-smart state persistence,
// sortable tables, and CSP-safe delegated event handling.
// ============================================================================
(function () {
    'use strict';

    /* ── helpers (shared with ICT) ── */
    const esc = (s) => (typeof window.escapeHtml === 'function')
        ? window.escapeHtml(s)
        : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = (n) => Number(n || 0).toLocaleString('en-IN');
    const inr = (n) => '\u20B9' + Math.round(n || 0).toLocaleString('en-IN');
    const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const fmtDateTime = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const pill = (tone, label) => `<span class="ict-pill ict-tone-${tone}"><span class="ict-pill-dot"></span>${esc(label)}</span>`;
    const STAT_TONE = { ok: 'healthy', reorder: 'attention', zero: 'critical' };

    /* ── state (persists across tab switches — memory smart) ── */
    const SR = {
        inventory: [],
        allInventory: [],  // full dataset loaded once, filtered client-side
        summary: null,
        adjustments: [],
        loaded: false,        // has data been fetched at least once?
        loading: false,
        filter: '',
        categoryFilter: '',
        statusFilter: '',     // '' | 'reorder' | 'zero'
        sortKey: 'product_name',
        sortDir: 'asc',
        page: 0,
        pageSize: 25,
        bulkItems: [],
        bulkReference: '',
        bulkNotes: '',
        bulkOutMode: false,   // false = Bulk In (add), true = Bulk Out (subtract)
        bulkPushShopify: localStorage.getItem('srBulkPushShopify') === '1', // mirror bulk deltas to Shopify
    };

    /* ── API ── */
    const getToken = () => localStorage.getItem('authToken') || '';
    const authHeaders = () => ({ 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' });

    async function apiFetch(url, opts = {}) {
        const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
        if (res.status === 401) { localStorage.removeItem('authToken'); localStorage.removeItem('hubIdentity'); window.location.reload(); throw new Error('Session expired'); }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    /* ── data loading (only fetches when needed) ── */
    async function loadInventory(force = false) {
        if (SR.loading) return;
        if (SR.loaded && !force) return; // memory smart — skip if already loaded
        SR.loading = true;
        try {
            const data = await apiFetch('/api/admin/inventory/manual');
            SR.allInventory = data.items || []; // full dataset for client-side filtering
            SR.summary = data.summary || {};
            SR.loaded = true;
        } catch (e) {
            console.error('Stock Room: load failed', e);
            SR.allInventory = [];
        }
        SR.loading = false;
        applyFiltersAndRender();
    }

    /* ── client-side filter + sort + render (instant, no API call) ── */
    function applyFiltersAndRender() {
        const q = (SR.filter || '').toLowerCase();
        let items = SR.allInventory || [];
        if (q) {
            items = items.filter(i =>
                (i.product_name || '').toLowerCase().includes(q) ||
                (i.sku_key || '').toLowerCase().includes(q) ||
                (i.size || '').toLowerCase().includes(q)
            );
        }
        if (SR.categoryFilter) {
            items = items.filter(i => i.category === SR.categoryFilter);
        }
        if (SR.statusFilter === 'reorder') {
            items = items.filter(i => i.quantity > 0 && i.quantity <= (i.reorder_level || 0));
        } else if (SR.statusFilter === 'zero') {
            items = items.filter(i => i.quantity === 0);
        }
        SR.inventory = items;
        SR.page = 0;
        renderTable();
    }

    async function loadAdjustments() {
        try {
            const data = await apiFetch('/api/admin/inventory/adjustments?limit=50');
            SR.adjustments = data.adjustments || [];
        } catch (e) { console.error('Stock Room: adjustments load failed', e); }
    }

    async function refreshAll() {
        SR.loaded = false;
        await loadInventory(true);
        await loadAdjustments();
    }

    /* ── sync from Shopify (legacy quick import — superseded by the workbench) ── */
    async function syncFromShopify() {
        if (!window.confirm('Import new products from Shopify?\n\nThis will add any products from Shopify that are not already in your manual inventory.\n\nExisting items will not be modified.\n\nFor quantity sync in both directions use the Shopify Sync workbench.')) return;
        
        try {
            showToast('Syncing products from Shopify...', 'info');
            const result = await apiFetch('/api/admin/inventory/sync-from-shopify', { method: 'POST' });
            
            if (result.success) {
                showToast(`✓ ${result.message}`, 'success');
                // Refresh the inventory to show new items
                SR.loaded = false;
                await loadInventory(true);
                await loadAdjustments();
            } else {
                showToast(result.error || 'Sync failed', 'error');
            }
        } catch (e) {
            console.error('Shopify sync error:', e);
            showToast('Sync failed: ' + e.message, 'error');
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
       SHOPIFY SYNC WORKBENCH — two-way bulk sync
       Pull  : Shopify → Stock Room (compare, select, batched apply)
       Push  : Stock Room → Shopify (rate-limited background job + polling)
       Bulk In/Out can mirror their deltas to Shopify directly (toggle).
       ════════════════════════════════════════════════════════════════════ */
    const SW = {
        built: false,
        tab: 'pull',            // pull | push | history
        busy: false,            // a plan/apply/push action is in flight
        pull: { plan: null, mode: 'match', force: false, selected: new Set(), filter: 'diff', search: '', page: 0 },
        push: { plan: null, selected: new Set(), filter: 'diff', search: '', page: 0, job: null, jobId: null, timer: null },
        history: { runs: [], loaded: false },
        lastResult: null,       // { kind, html } rendered under the controls
    };

    const SW_API = '/api/admin/inventory/shopify-sync';
    const SW_PAGE = 100;

    // apiFetch that also surfaces structured error bodies (409 push-in-flight)
    async function apiFetchFull(url, opts = {}) {
        const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
        if (res.status === 401) { localStorage.removeItem('authToken'); localStorage.removeItem('hubIdentity'); window.location.reload(); throw new Error('Session expired'); }
        let json = null;
        try { json = await res.json(); } catch (_) { /* non-JSON */ }
        return { ok: res.ok, status: res.status, json };
    }

    function injectSyncModal() {
        if (document.getElementById('srSyncModal')) return;
        const div = document.createElement('div');
        div.id = 'srSyncModal';
        div.className = 'sr-bulk-modal-overlay';
        div.innerHTML = `
            <div class="sr-bulk-modal sw-modal">
                <div class="sr-bulk-modal-header">
                    <h3>Shopify Inventory Sync</h3>
                    <button class="sr-bulk-close" data-sw="close">&times;</button>
                </div>
                <div class="sw-tabs">
                    <button class="sw-tab" data-sw="tab" data-tab="pull">⬇ Pull from Shopify</button>
                    <button class="sw-tab" data-sw="tab" data-tab="push">⬆ Push to Shopify</button>
                    <button class="sw-tab" data-sw="tab" data-tab="history">History</button>
                </div>
                <div class="sw-body" id="swBody"><div class="sr-loading"><div class="inv-spinner"></div><span>Loading…</span></div></div>
            </div>`;
        document.body.appendChild(div);
        div.addEventListener('click', (e) => { if (e.target === div) closeSyncWorkbench(); });
        SW.built = true;
    }

    function openSyncWorkbench(tab = 'pull', opts = {}) {
        injectSyncModal();
        const m = document.getElementById('srSyncModal');
        if (m) m.style.display = 'flex';
        SW.tab = tab;
        swSyncTabChrome();
        if (opts.pushJobId) { swRender(); swAttachPushJob(opts.pushJobId); return; }
        if (tab === 'history') { if (!SW.history.loaded) swLoadHistory(); else swRender(); }
        else {
            const side = SW[tab];
            if (opts.forcePlan || !side.plan) swFetchPlan(tab, !!opts.forcePlan);
            else swRender();
        }
    }

    function closeSyncWorkbench() {
        const m = document.getElementById('srSyncModal');
        if (m) m.style.display = 'none';
        swStopPolling();
    }

    function swStopPolling() {
        if (SW.push.timer) { clearInterval(SW.push.timer); SW.push.timer = null; }
    }

    function swSyncTabChrome() {
        document.querySelectorAll('#srSyncModal .sw-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === SW.tab));
    }

    /* ── plan fetch ── */
    async function swFetchPlan(direction, force) {
        SW.busy = true;
        swRender();
        try {
            const body = direction === 'push'
                ? { direction, force: !!force }
                : { direction, mode: SW.pull.mode, force: !!force };
            const res = await apiFetchFull(`${SW_API}/plan`, { method: 'POST', body: JSON.stringify(body) });
            if (!res.ok || !res.json?.success) throw new Error(res.json?.error || `HTTP ${res.status}`);
            SW[direction].plan = res.json.plan;
            if (res.json.warning) SW.lastResult = { kind: 'warn', html: esc(res.json.warning) };
            // default selection: every actionable row
            SW[direction].selected = new Set(
                res.json.plan.rows.filter(r => swActionable(direction, r.action)).map(r => r.sku_key)
            );
            SW[direction].page = 0;
        } catch (e) {
            SW.lastResult = { kind: 'error', html: `Plan failed: ${esc(e.message)}` };
        }
        SW.busy = false;
        swRender();
    }

    function swActionable(direction, action) {
        return direction === 'pull'
            ? (action === 'add' || action === 'update' || action === 'fill')
            : (action === 'increase' || action === 'decrease');
    }

    function swFilteredRows(direction) {
        const side = SW[direction];
        let rows = side.plan ? side.plan.rows : [];
        const f = side.filter;
        if (direction === 'pull') {
            if (f === 'diff') rows = rows.filter(r => swActionable('pull', r.action));
            else if (f === 'adds') rows = rows.filter(r => r.action === 'add');
            else if (f === 'down') rows = rows.filter(r => r.action === 'update' && r.delta < 0);
            else if (f === 'hubonly') rows = side.plan.hubOnly || [];
        } else {
            if (f === 'diff') rows = rows.filter(r => swActionable('push', r.action));
            else if (f === 'up') rows = rows.filter(r => r.action === 'increase');
            else if (f === 'down') rows = rows.filter(r => r.action === 'decrease');
            else if (f === 'unmatched') rows = rows.filter(r => r.action === 'no_match' || r.action === 'no_inv_item');
        }
        const q = (side.search || '').toLowerCase();
        if (q) rows = rows.filter(r =>
            (r.product_name || '').toLowerCase().includes(q) ||
            (r.sku_key || '').toLowerCase().includes(q) ||
            (r.size || '').toLowerCase().includes(q));
        return rows;
    }

    /* ── pull apply ── */
    async function swApplyPull() {
        const rows = (SW.pull.plan?.rows || []).filter(r => SW.pull.selected.has(r.sku_key) && swActionable('pull', r.action));
        if (rows.length === 0) { showToast('Nothing selected to pull', 'info'); return; }
        if (!window.confirm(`Pull ${rows.length} SKU(s) from Shopify into the Stock Room?\n\nHub quantities will be set to Shopify's current stock.`)) return;
        SW.busy = true;
        swRender();
        try {
            const res = await apiFetchFull(`${SW_API}/pull/apply`, { method: 'POST', body: JSON.stringify({ rows, mode: SW.pull.mode }) });
            if (!res.ok || !res.json?.success) throw new Error(res.json?.error || `HTTP ${res.status}`);
            const d = res.json;
            SW.lastResult = { kind: 'ok', html: `Pulled ${d.added} new · ${d.updated} updated · ${num(d.unitsDelta)} units net${d.failures?.length ? ` · ${d.failures.length} failed` : ''}` };
            SR.loaded = false;
            await loadInventory(true);
            await loadAdjustments();
            SW.pull.plan = null; // quantities changed — force recompare on next look
        } catch (e) {
            SW.lastResult = { kind: 'error', html: `Pull failed: ${esc(e.message)}` };
        }
        SW.busy = false;
        swRender();
    }

    /* ── push job ── */
    async function swStartPush() {
        const keys = [...SW.push.selected];
        if (keys.length === 0) { showToast('Nothing selected to push', 'info'); return; }
        if (!window.confirm(`Push ${keys.length} SKU(s) to Shopify?\n\nShopify stock will be adjusted so its totals match the hub. This runs in the background at Shopify's rate limit (~2 writes/sec).`)) return;
        SW.busy = true;
        swRender();
        try {
            const res = await apiFetchFull(`${SW_API}/push/start`, { method: 'POST', body: JSON.stringify({ sku_keys: keys }) });
            const d = res.json || {};
            if (res.status === 409 && d.jobId) { swAttachPushJob(d.jobId); SW.busy = false; swRender(); return; }
            if (!res.ok || !d.success) throw new Error(d.error || `HTTP ${res.status}`);
            if (d.unmatched?.length) SW.lastResult = { kind: 'warn', html: `${d.unmatched.length} hub SKU(s) had no Shopify match and were skipped` };
            if (d.total === 0 || d.status === 'done') {
                SW.lastResult = { kind: 'ok', html: 'Nothing to push — Shopify already matches the hub for this selection' };
                SW.busy = false; swRender(); return;
            }
            swAttachPushJob(d.jobId);
        } catch (e) {
            SW.lastResult = { kind: 'error', html: `Push failed to start: ${esc(e.message)}` };
            SW.busy = false;
            swRender();
            return;
        }
        SW.busy = false;
        swRender();
    }

    function swAttachPushJob(jobId) {
        SW.push.jobId = jobId;
        swStopPolling();
        SW.push.timer = setInterval(async () => {
            try {
                const data = await apiFetchFull(`${SW_API}/jobs/${jobId}`);
                if (!data.ok) throw new Error(data.json?.error || `HTTP ${data.status}`);
                SW.push.job = data.json.job;
                SW.busy = SW.push.job.status === 'running';
                swRender();
                if (['done', 'cancelled', 'failed'].includes(SW.push.job.status)) {
                    swStopPolling();
                    SW.push.plan = null; // Shopify moved — force fresh compare
                    SW.history.loaded = false;
                    const j = SW.push.job;
                    // "done" with zero writes is a problem, not a success
                    const tone = j.status === 'done' && (j.succeeded > 0 || j.total === 0)
                        ? 'success' : 'error';
                    const tail = j.error ? ` — ${j.error}`
                        : (j.status === 'done' && j.succeeded === 0 && j.total > 0) ? ' — nothing was written'
                          : '';
                    showToast(`Shopify push ${j.status}: ${j.succeeded}/${j.total} SKU(s) written${tail}`, tone);
                }
            } catch (e) {
                swStopPolling();
                SW.lastResult = { kind: 'error', html: `Lost contact with the push job: ${esc(e.message)}` };
                swRender();
            }
        }, 1500);
        // first paint without waiting a tick
        apiFetchFull(`${SW_API}/jobs/${jobId}`).then(data => {
            if (data.ok && data.json?.job) { SW.push.job = data.json.job; swRender(); }
        }).catch(() => {});
    }

    async function swCancelPush() {
        if (!SW.push.jobId) return;
        try { await apiFetch(`${SW_API}/jobs/${SW.push.jobId}/cancel`, { method: 'POST' }); showToast('Cancellation requested', 'info'); } catch (e) { showToast('Cancel failed: ' + e.message, 'error'); }
    }

    /* ── history ── */
    async function swLoadHistory() {
        SW.history.loading = true;
        swRender();
        try {
            const data = await apiFetch(`${SW_API}/runs?limit=30`);
            SW.history.runs = data.runs || [];
            SW.history.loaded = true;
        } catch (e) {
            SW.lastResult = { kind: 'error', html: `History failed: ${esc(e.message)}` };
        }
        SW.history.loading = false;
        swRender();
    }

    /* ── render ── */
    const swPill = (action) => {
        const map = {
            add: ['healthy', 'NEW'], fill: ['info', 'FILL'], update: ['attention', 'CHANGE'],
            equal: ['', 'EQUAL'], out_of_scope: ['', 'SKIP'], hub_only: ['attention', 'HUB ONLY'],
            increase: ['healthy', 'INCREASE'], decrease: ['critical', 'DECREASE'],
            no_match: ['critical', 'NO SHOPIFY MATCH'], no_inv_item: ['attention', 'UNTRACKED'],
        };
        const [tone, label] = map[action] || ['', action];
        return tone ? pill(tone, label) : `<span class="ict-muted">${esc(label)}</span>`;
    };

    function swDeltaCell(delta) {
        if (delta == null) return '<span class="ict-muted">—</span>';
        if (delta === 0) return '<span class="ict-muted">0</span>';
        return `<span class="${delta > 0 ? 'ict-healthy-text' : 'ict-critical-text'}" style="font-weight:600">${delta > 0 ? '+' : ''}${num(delta)}</span>`;
    }

    function swRender() {
        const body = document.getElementById('swBody');
        if (!body) return;
        swSyncTabChrome();
        if (SW.busy && !SW[SW.tab]) return;
        if (SW.tab === 'history') { body.innerHTML = swRenderHistory(); return; }
        const side = SW[SW.tab];
        const isPull = SW.tab === 'pull';
        const jobRunning = !isPull && SW.push.job && SW.push.job.status === 'running';

        if (SW.busy && !side.plan) { body.innerHTML = `<div class="sr-loading"><div class="inv-spinner"></div><span>${isPull ? 'Comparing with Shopify catalog…' : 'Reading Shopify stock levels…'}</span></div>`; return; }

        const stats = side.plan?.stats;
        const rows = swFilteredRows(SW.tab);
        const totalPages = Math.max(1, Math.ceil(rows.length / SW_PAGE));
        const pageRows = rows.slice(side.page * SW_PAGE, side.page * SW_PAGE + SW_PAGE);
        const selCount = (side.plan?.rows || []).filter(r => side.selected.has(r.sku_key) && swActionable(SW.tab, r.action)).length;

        const chips = isPull
            ? [['diff', 'Differences'], ['adds', 'New in Shopify'], ['down', 'Decreases'], ['hubonly', 'Hub only'], ['all', 'All']]
            : [['diff', 'Differences'], ['up', 'Increases'], ['down', 'Decreases'], ['unmatched', 'Unmatched'], ['all', 'All']];

        body.innerHTML = `
            <div class="sw-controls">
                ${isPull ? `
                    <select class="ict-input sw-mode-select" id="swMode">
                        <option value="match" ${side.mode === 'match' ? 'selected' : ''}>Match Shopify everywhere</option>
                        <option value="fill_zero" ${side.mode === 'fill_zero' ? 'selected' : ''}>Fill zero-stock SKUs only</option>
                        <option value="new_only" ${side.mode === 'new_only' ? 'selected' : ''}>Import new products only</option>
                    </select>` : `
                    <div class="sw-warn">${'⚠️ Writes to Shopify — hub stock becomes the source of truth for selected SKUs.'}</div>`}
                <label class="sw-force"><input type="checkbox" id="swForce" ${side.force ? 'checked' : ''}> Refresh Shopify data</label>
                <button class="btn sw-recompute-btn" data-sw="recompute" ${SW.busy ? 'disabled' : ''}>${side.plan ? 'Re-compare' : 'Compare with Shopify'}</button>
                <span class="ict-toolbar-count">${selCount} selected</span>
            </div>
            ${stats ? `
                <div class="sw-stats">
                    <span>${num(stats.diff_rows ?? (stats.increase + stats.decrease))} differ</span>
                    ${isPull ? `<span>+${num(stats.adds ?? stats.add ?? 0)} new</span>` : ''}
                    <span>Hub ${num(stats.units_hub)} u</span>
                    <span>Shopify ${num(stats.units_shopify ?? 0)} u</span>
                    <span class="${stats.net_delta >= 0 ? 'ict-healthy-text' : 'ict-critical-text'}">Net ${stats.net_delta >= 0 ? '+' : ''}${num(stats.net_delta)}</span>
                    <span class="ict-muted">as of ${new Date(side.plan.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>` : ''}
            ${SW.lastResult ? `<div class="sw-result sw-result-${SW.lastResult.kind}">${SW.lastResult.html}</div>` : ''}
            ${jobRunning || (SW.push.job && !isPull) ? swRenderJobProgress() : ''}
            ${side.plan ? `
                <div class="sw-filters">
                    ${chips.map(([k, l]) => `<button class="ict-chip ${side.filter === k ? 'active' : ''}" data-sw="filter" data-key="${k}">${l}</button>`).join('')}
                    <input type="text" class="ict-input sw-search" id="swSearch" placeholder="Filter by product, SKU, size…" value="${esc(side.search)}">
                    <button class="ict-chip" data-sw="select-all">Select all shown</button>
                    <button class="ict-chip" data-sw="clear-sel">Clear</button>
                </div>` : ''}
            <div class="sw-table-wrap">
                <table class="ict-table">
                    <thead><tr>
                        <th style="width:34px"></th><th>Product</th><th>Size</th><th>SKU</th>
                        <th class="ict-th-right">${isPull ? 'Hub' : 'Shopify'}</th>
                        <th class="ict-th-right">${isPull ? 'Shopify' : 'Hub'}</th>
                        <th class="ict-th-right">Δ</th><th>Action</th>
                    </tr></thead>
                    <tbody>
                        ${pageRows.length === 0 ? `<tr><td colspan="8"><div class="ict-empty">${side.plan ? 'Nothing in this view — try another filter or re-compare.' : 'Click “Compare with Shopify” to build the diff.'}</div></td></tr>`
                            : pageRows.map(r => swRenderRow(r, isPull)).join('')}
                    </tbody>
                </table>
            </div>
            ${rows.length > SW_PAGE ? `<div class="ict-pagination">
                <button class="ict-chip ${side.page <= 0 ? 'disabled' : ''}" data-sw="page" data-dir="-1" ${side.page <= 0 ? 'disabled' : ''}>← Prev</button>
                <span class="ict-page-info">Page ${side.page + 1} of ${totalPages}</span>
                <button class="ict-chip ${side.page >= totalPages - 1 ? 'disabled' : ''}" data-sw="page" data-dir="1" ${side.page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
            </div>` : ''}
            <div class="sw-footer">
                <button class="btn btn-outline" data-sw="close">Close</button>
                ${isPull ? `
                    <button class="btn sw-apply-btn" data-sw="apply-pull" ${selCount === 0 || SW.busy ? 'disabled' : ''}>${'⬇ Pull ' + selCount + ' SKU(s) into Stock Room'}</button>`
                : `
                    <button class="btn sr-confirm-bulk-btn sw-push-btn" data-sw="push-start" ${selCount === 0 || SW.busy || jobRunning ? 'disabled' : ''}>${'⬆ Push ' + selCount + ' SKU(s) to Shopify'}</button>`}
            </div>`;
    }

    function swRenderRow(r, isPull) {
        const side = SW[SW.tab];
        const canPick = swActionable(SW.tab, r.action);
        const checked = side.selected.has(r.sku_key) ? 'checked' : '';
        const hub = r.hub_qty == null ? '<span class="ict-muted">—</span>' : num(r.hub_qty);
        const shop = r.shopify_qty == null ? '<span class="ict-muted">—</span>' : num(r.shopify_qty);
        return `<tr class="${canPick && r.delta !== 0 && r.delta !== null ? (r.delta > 0 ? 'sw-row-up' : 'sw-row-down') : ''}">
            <td>${canPick ? `<input type="checkbox" data-sw="row-toggle" data-sku="${esc(r.sku_key)}" ${checked}>` : ''}</td>
            <td class="sr-product">${esc(r.product_name)}</td>
            <td class="ict-muted">${esc(r.size || '—')}</td>
            <td class="ict-mono ict-muted"><code>${esc(r.sku_key)}</code></td>
            <td class="ict-num">${isPull ? hub : shop}</td>
            <td class="ict-num">${isPull ? shop : hub}</td>
            <td class="ict-num">${swDeltaCell(r.delta)}</td>
            <td>${swPill(r.action)}${r.matched_via === 'sku' ? ' <span class="ict-muted" title="matched on the variant SKU code">via SKU</span>' : ''}</td>
        </tr>`;
    }

    function swRenderJobProgress() {
        const job = SW.push.job;
        if (!job) return '';
        const pct = job.total ? Math.round((job.done / job.total) * 100) : 100;
        const eta = job.status === 'running' && job.total ? ` · ~${Math.ceil((job.total - job.done) * 0.6)}s left` : '';
        const failed = (job.results || []).filter(r => !r.ok);
        // A job can finish "done" having written nothing: every SKU skipped as
        // already equal, or the whole run aborted by Shopify. Never paint that
        // green — say which happened.
        const wroteNothing = job.status !== 'running' && job.total > 0 && job.succeeded === 0;
        const banner = job.error
            ? `<div class="sw-job-error">⚠ ${esc(job.error)}${job.abortedRemaining ? ` — the remaining ${job.abortedRemaining} SKU(s) were not attempted.` : ''}</div>`
            : wroteNothing
              ? `<div class="sw-job-error">Nothing was written. All ${job.total} SKU(s) were already equal on Shopify (${job.skipped || 0} skipped) — if that is wrong, Shopify stock is not being read; check the Shopify connection and re-open the compare.</div>`
              : '';
        return `<div class="sw-job">
            <div class="sw-job-head">
                <span>Push job <code>${esc(job.id)}</code> — ${esc(job.status)}</span>
                <span>${job.done}/${job.total} SKU(s) · ${job.succeeded} written · ${job.failed} failed${eta}</span>
                ${job.status === 'running' ? `<button class="ict-chip" data-sw="push-cancel">Cancel</button>`
                  : failed.length ? `<button class="ict-chip" data-sw="push-retry">Retry ${failed.length} failed</button>` : ''}
            </div>
            <div class="sw-progress"><div class="sw-progress-fill${wroteNothing ? ' sw-progress-empty' : ''}" style="width:${pct}%"></div></div>
            ${banner}
            ${failed.length ? `<div class="sw-job-fails">${failed.slice(-8).map(f => `✗ ${esc(f.product_name || f.sku_key)} (${esc(f.size)}) — ${esc(f.error || 'failed')}`).join('<br>')}</div>` : ''}
        </div>`;
    }

    function swRenderHistory() {
        if (SW.history.loading) return `<div class="sr-loading"><div class="inv-spinner"></div><span>Loading history…</span></div>`;
        const runs = SW.history.runs || [];
        return `
            <div class="sw-controls">
                <button class="ict-chip" data-sw="hist-refresh">Refresh</button>
                <span class="ict-toolbar-count">${runs.length} run(s)</span>
            </div>
            <div class="sw-table-wrap">
                <table class="ict-table">
                    <thead><tr><th>When</th><th>Direction</th><th>Mode</th><th>Status</th><th class="ict-th-right">SKUs</th><th class="ict-th-right">Applied</th><th class="ict-th-right">Failed</th><th class="ict-th-right">Δ units</th><th>By</th><th>Reference</th></tr></thead>
                    <tbody>${runs.length === 0 ? '<tr><td colspan="10"><div class="ict-empty">No sync runs recorded yet.</div></td></tr>'
                        : runs.map(rn => `<tr>
                            <td class="ict-muted">${rn.started_at ? fmtDateTime(rn.started_at) : fmtDateTime(rn.created_at || new Date())}</td>
                            <td>${pill(rn.direction === 'pull' ? 'info' : 'attention', rn.direction)}</td>
                            <td class="ict-muted">${esc(rn.mode || '—')}</td>
                            <td>${pill(rn.status === 'done' ? 'healthy' : rn.status === 'running' ? 'info' : 'critical', rn.status)}</td>
                            <td class="ict-num">${num(rn.skus_total)}</td>
                            <td class="ict-num">${num(rn.skus_applied)}</td>
                            <td class="ict-num ${rn.skus_failed ? 'ict-critical-text' : ''}">${num(rn.skus_failed)}</td>
                            <td class="ict-num">${rn.units_delta >= 0 ? '+' : ''}${num(rn.units_delta)}</td>
                            <td class="ict-muted">${esc(rn.performed_by || '—')}</td>
                            <td class="ict-mono ict-muted">${esc(rn.reference || '—')}</td>
                        </tr>`).join('')}</tbody>
                </table>
            </div>`;
    }

    /* ── workbench delegated events ── */
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-sw]');
        if (!el) return;
        const action = el.dataset.sw;
        if (action === 'close') { closeSyncWorkbench(); return; }
        if (action === 'tab') { openSyncWorkbench(el.dataset.tab); return; }
        if (!document.getElementById('srSyncModal') || document.getElementById('srSyncModal').style.display === 'none') return;

        if (action === 'recompute') {
            const side = SW[SW.tab] || SW.pull;
            side.force = document.getElementById('swForce')?.checked || false;
            SW[SW.tab].plan = null;
            swFetchPlan(SW.tab, side.force);
        } else if (action === 'filter') {
            SW[SW.tab].filter = el.dataset.key; SW[SW.tab].page = 0; swRender();
        } else if (action === 'page') {
            const side = SW[SW.tab];
            side.page = Math.max(0, side.page + (parseInt(el.dataset.dir, 10) || 0));
            swRender();
        } else if (action === 'select-all') {
            swFilteredRows(SW.tab).filter(r => swActionable(SW.tab, r.action)).forEach(r => SW[SW.tab].selected.add(r.sku_key));
            swRender();
        } else if (action === 'clear-sel') {
            SW[SW.tab].selected.clear(); swRender();
        } else if (action === 'apply-pull') {
            swApplyPull();
        } else if (action === 'push-start') {
            swStartPush();
        } else if (action === 'push-cancel') {
            swCancelPush();
        } else if (action === 'push-retry') {
            const failed = (SW.push.job?.results || []).filter(r => !r.ok).map(r => r.sku_key);
            if (failed.length) { SW.push.selected = new Set(failed); swStartPush(); }
        } else if (action === 'hist-refresh') {
            swLoadHistory();
        }
    });

    document.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-sw="row-toggle"]');
        if (cb) {
            const sku = cb.dataset.sku;
            if (cb.checked) SW[SW.tab].selected.add(sku); else SW[SW.tab].selected.delete(sku);
            // update count only — full re-render would steal focus
            const cnt = document.querySelector('.sw-controls .ict-toolbar-count');
            if (cnt) cnt.textContent = `${(SW[SW.tab].plan?.rows || []).filter(r => SW[SW.tab].selected.has(r.sku_key) && swActionable(SW.tab, r.action)).length} selected`;
            const applyBtn = document.querySelector('[data-sw="apply-pull"], [data-sw="push-start"]');
            if (applyBtn) applyBtn.disabled = !SW[SW.tab].selected.size || SW.busy;
            return;
        }
        if (e.target.id === 'swMode') { SW.pull.mode = e.target.value; SW.pull.plan = null; swFetchPlan('pull', SW.pull.force); }
        if (e.target.id === 'swBulkShopify') {
            SR.bulkPushShopify = !!e.target.checked;
            localStorage.setItem('srBulkPushShopify', SR.bulkPushShopify ? '1' : '0');
        }
    });

    document.addEventListener('input', (e) => {
        if (e.target.id === 'swSearch') {
            clearTimeout(e.target._swDeb);
            e.target._swDeb = setTimeout(() => {
                const keep = document.activeElement === e.target;
                SW[SW.tab].search = e.target.value; SW[SW.tab].page = 0;
                swRenderTableOnly();
                if (keep) { const s = document.getElementById('swSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
            }, 200);
        }
    });

    // re-render just the table + footer count on search/page (keeps focus)
    function swRenderTableOnly() {
        const body = document.getElementById('swBody');
        if (!body || SW.tab === 'history') { swRender(); return; }
        // simple approach: full re-render but restore focus via the input handler above
        swRender();
    }

    /* ── sorting ── */
    function sortedItems() {
        const items = [...SR.inventory];
        const k = SR.sortKey;
        const dir = SR.sortDir === 'asc' ? 1 : -1;
        items.sort((a, b) => {
            let va = a[k], vb = b[k];
            if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
            va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase();
            return va.localeCompare(vb) * dir;
        });
        return items;
    }

    function toggleSort(key) {
        if (SR.sortKey === key) SR.sortDir = SR.sortDir === 'asc' ? 'desc' : 'asc';
        else { SR.sortKey = key; SR.sortDir = 'asc'; }
        SR.page = 0;
        renderTable();
    }

    /* ── bulk inventory-in ── */
    function addToBulk(skuKey) {
        const item = SR.inventory.find(i => i.sku_key === skuKey);
        if (!item) return;
        const existing = SR.bulkItems.find(b => b.sku_key === skuKey);
        if (existing) { existing.qty += 1; }
        else { SR.bulkItems.push({ sku_key: item.sku_key, product_name: item.product_name, size: item.size, category: item.category, qty: 1 }); }
        renderBulkModal();
    }

    function removeFromBulk(skuKey) { SR.bulkItems = SR.bulkItems.filter(b => b.sku_key !== skuKey); renderBulkModal(); }

    function updateBulkQty(skuKey, qty) {
        const item = SR.bulkItems.find(b => b.sku_key === skuKey);
        if (item) {
            let q = Math.max(0, parseInt(qty) || 0);
            // In Bulk Out mode, cap at current stock
            if (SR.bulkOutMode) {
                const current = SR.inventory.find(i => i.sku_key === skuKey);
                const maxQty = current ? current.quantity : 0;
                q = Math.min(q, maxQty);
            }
            item.qty = q;
            if (item.qty === 0) removeFromBulk(skuKey); else renderBulkModal();
        }
    }

    function openBulkModal(outMode = false) { SR.bulkItems = []; SR.bulkReference = ''; SR.bulkNotes = ''; SR.bulkOutMode = !!outMode; renderBulkModal(); updateBulkModalChrome(); const m = document.getElementById('srBulkModal'); if (m) m.style.display = 'flex'; }
    function closeBulkModal() { const m = document.getElementById('srBulkModal'); if (m) m.style.display = 'none'; }

    function updateBulkModalChrome() {
        const modal = document.getElementById('srBulkModal');
        if (!modal) return;
        const isOut = SR.bulkOutMode;
        const h3 = modal.querySelector('.sr-bulk-modal-header h3');
        if (h3) h3.textContent = isOut ? 'Bulk Inventory-Out' : 'Bulk Inventory-In';
        const btn = modal.querySelector('.sr-confirm-bulk-btn');
        if (btn) {
            btn.innerHTML = isOut
                ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg> Apply Bulk Out`
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg> Apply Bulk In`;
            btn.classList.toggle('sr-bulk-out-btn', isOut);
            btn.classList.toggle('sr-bulk-in-btn', !isOut);
        }
    }

    function renderBulkModal() {
        const modal = document.getElementById('srBulkModal');
        if (!modal) return;
        const totalItems = SR.bulkItems.length;
        const totalQty = SR.bulkItems.reduce((s, b) => s + b.qty, 0);
        const isOut = SR.bulkOutMode;
        const qtyLabel = isOut ? 'Qty to Remove' : 'Qty to Add';
        const emptyMsg = isOut ? 'No SKUs selected yet. Search above to remove items.' : 'No SKUs selected yet. Search above to add items.';

        modal.querySelector('.sr-bulk-body').innerHTML = `
            <div class="sr-bulk-search">
                <input type="text" id="srBulkSearch" placeholder="Search SKU or product name..." class="sr-bulk-search-input" autocomplete="off">
                <div id="srBulkSearchResults" class="sr-bulk-search-results"></div>
            </div>
            <div class="sr-bulk-selected">
                <div class="sr-bulk-selected-header">
                    <h4>Selected SKUs (${totalItems})</h4>
                    <span class="sr-bulk-total-qty">Total units: ${num(totalQty)}</span>
                </div>
                ${totalItems === 0 ? `
                    <div class="sr-bulk-empty">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                        </svg>
                        <p>${emptyMsg}</p>
                    </div>
                ` : `
                    <table class="sr-bulk-table">
                        <thead><tr><th>Product</th><th>Size</th><th>Current</th><th>${qtyLabel}</th><th>Projected</th><th></th></tr></thead>
                        <tbody>
                            ${SR.bulkItems.map(b => {
                                const current = SR.inventory.find(i => i.sku_key === b.sku_key);
                                const curQty = current ? current.quantity : 0;
                                const proj = isOut ? curQty - b.qty : curQty + b.qty;
                                const projClass = proj <= 0 ? 'sr-bulk-projected sr-zero' : proj <= (current?.reorder_level || 0) ? 'sr-bulk-projected sr-reorder' : '';
                                const maxHint = isOut ? `<span class="sr-bulk-max" title="Max: ${curQty}">max ${curQty}</span>` : '';
                                return `<tr>
                                    <td class="sr-bulk-product">${esc(b.product_name)}</td>
                                    <td class="sr-bulk-size">${esc(b.size)}</td>
                                    <td class="sr-bulk-current">${num(curQty)}</td>
                                    <td><input type="number" min="1" ${isOut ? `max="${curQty}"` : ''} value="${b.qty}" class="sr-bulk-qty-input" data-sr-bulk-qty="${esc(b.sku_key)}">${maxHint}</td>
                                    <td class="${projClass}">${num(proj)}</td>
                                    <td><button class="sr-bulk-remove" data-sr="bulk-remove" data-sku="${esc(b.sku_key)}" title="Remove">&times;</button></td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                `}
            </div>
            <div class="sr-bulk-meta">
                <div class="sr-bulk-field">
                    <label>Reference (optional)</label>
                    <input type="text" id="srBulkRef" placeholder="${isOut ? 'e.g. Damage log, Audit #12' : 'e.g. PO-2026-091, Batch #42'}" value="${esc(SR.bulkReference)}">
                </div>
                <div class="sr-bulk-field">
                    <label>Notes (optional)</label>
                    <input type="text" id="srBulkNotes" placeholder="${isOut ? 'e.g. Damaged goods, Audit correction' : 'e.g. September restock from vendor'}" value="${esc(SR.bulkNotes)}">
                </div>
                <label class="sr-bulk-shopify-toggle">
                    <input type="checkbox" id="srBulkShopify" ${SR.bulkPushShopify ? 'checked' : ''}>
                    Also apply the same ${isOut ? 'reductions' : 'additions'} to Shopify stock
                </label>
            </div>`;

        const searchInput = modal.querySelector('#srBulkSearch');
        if (searchInput) { searchInput.addEventListener('input', (e) => handleBulkSearch(e.target.value)); searchInput.focus(); }
    }

    function handleBulkSearch(query) {
        const container = document.getElementById('srBulkSearchResults');
        if (!container) return;
        if (!query || query.length < 2) { container.innerHTML = ''; return; }
        const q = query.toLowerCase();
        const matches = SR.inventory.filter(i =>
            !SR.bulkItems.find(b => b.sku_key === i.sku_key) &&
            (i.product_name.toLowerCase().includes(q) || i.sku_key.toLowerCase().includes(q) || i.size.toLowerCase().includes(q))
        ).slice(0, 15);
        container.innerHTML = matches.length === 0
            ? '<div class="sr-search-empty">No matching SKUs found</div>'
            : matches.map(i => `<div class="sr-search-result" data-sr="bulk-add" data-sku="${esc(i.sku_key)}">
                <span class="sr-search-name">${esc(i.product_name)}</span>
                <span class="sr-search-size">${esc(i.size)}</span>
                <span class="sr-search-stock ${i.quantity <= i.reorder_level ? 'sr-reorder' : ''}">${num(i.quantity)} in stock</span>
            </div>`).join('');
    }

    async function confirmBulkIn() {
        if (SR.bulkItems.length === 0) return;
        const isOut = SR.bulkOutMode;
        const totalQty = SR.bulkItems.reduce((s, b) => s + b.qty, 0);
        const verb = isOut ? 'REMOVE' : 'ADD';
        const endpoint = isOut ? '/api/admin/inventory/bulk-out' : '/api/admin/inventory/bulk-in';
        const label = isOut ? 'Bulk Inventory-Out' : 'Bulk Inventory-In';

        if (!window.confirm(`Confirm ${label}\n\n${SR.bulkItems.length} SKU(s) · ${totalQty} total units\nReference: ${SR.bulkReference || 'None'}${SR.bulkPushShopify ? '\n\n＋ Same deltas will be pushed to Shopify.' : ''}`)) return;
        try {
            const result = await apiFetch(endpoint, {
                method: 'POST',
                body: JSON.stringify({
                    items: SR.bulkItems.map(b => ({ sku_key: b.sku_key, product_name: b.product_name, size: b.size, category: b.category, quantity: b.qty })),
                    reference: SR.bulkReference || null, notes: SR.bulkNotes || null, performed_by: 'hub_operator',
                    sync_shopify: !!SR.bulkPushShopify
                })
            });
            if (result.success) {
                showToast(`${isOut ? 'Bulk-out' : 'Bulk-in'} complete: ${result.processed} SKU(s), ${totalQty} units ${isOut ? 'removed' : 'added'}`, 'success');
                closeBulkModal();
                SR.loaded = false;
                await loadInventory(true);
                await loadAdjustments();
                // Shopify mirror feedback — open the workbench on the live job
                const ss = result.shopify_sync;
                if (ss && ss.queued && ss.total > 0) {
                    showToast(`Shopify push started for ${ss.total} SKU(s) — track progress in Shopify Sync`, 'info');
                    openSyncWorkbench('push', { pushJobId: ss.jobId });
                } else if (ss && ss.alreadyRunning) {
                    showToast('A Shopify push is already running — bulk deltas will need a manual push afterwards', 'error');
                } else if (ss && ss.error) {
                    showToast(`Shopify mirror failed: ${ss.error}`, 'error');
                } else if (ss && ss.queued === false && ss.total === 0) {
                    showToast('Shopify: nothing matched for the push (SKUs not in catalog)', 'error');
                }
            } else { showToast(result.error || `${label} failed`, 'error'); }
        } catch (e) { showToast(`${label} failed: ` + e.message, 'error'); }
    }

    /* ── toast ── */
    function showToast(message, type = 'info') {
        const existing = document.querySelector('.sr-toast'); if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = `sr-toast sr-toast-${type}`;
        toast.textContent = message;
        toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:14px 24px;border-radius:8px;font-size:13px;font-weight:500;font-family:'Inter',sans-serif;letter-spacing:0.3px;background:${type === 'success' ? '#0d3' : type === 'error' ? '#e33' : '#555'};color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.4);animation:sr-toast-in 0.3s ease;`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    /* ── sort arrow helper ── */
    const sortArrow = (key) => {
        if (SR.sortKey !== key) return '<span class="ict-sort-arrow">⇅</span>';
        return `<span class="ict-sort-arrow ${SR.sortDir}">${SR.sortDir === 'asc' ? '↑' : '↓'}</span>`;
    };
    const sortTh = (label, key) => `<th class="ict-th" data-sr="sort" data-key="${key}">${esc(label)}${sortArrow(key)}</th>`;

    /* ── render table only (preserves toolbar & input focus) ── */
    function renderTable() {
        const main = document.getElementById('srMain');
        if (!main) return;
        const card = main.querySelector('.ict-card-flush');
        if (!card) { render(); return; } // first load — do full render

        const items = sortedItems();
        const total = items.length;
        const pageStart = SR.page * SR.pageSize;
        const pageRows = items.slice(pageStart, pageStart + SR.pageSize);
        const totalPages = Math.max(1, Math.ceil(total / SR.pageSize));

        card.innerHTML = `
            <div class="ict-table-wrap">
                <table class="ict-table">
                    <thead><tr>
                        ${sortTh('Product', 'product_name')}
                        ${sortTh('Category', 'category')}
                        ${sortTh('Size', 'size')}
                        <th>SKU Code</th>
                        ${sortTh('Stock', 'quantity', 'right')}
                        ${sortTh('Reorder', 'reorder_level', 'right')}
                        <th>Status</th>
                        ${sortTh('Updated', 'updated_at')}
                    </tr></thead>
                    <tbody>
                        ${pageRows.length === 0 ? `<tr><td colspan="8"><div class="ict-empty">No inventory items match these filters.</div></td></tr>` : pageRows.map(i => {
                            const isZero = i.quantity === 0;
                            const needsReorder = !isZero && i.quantity <= i.reorder_level;
                            const status = isZero ? pill('critical', 'ZERO') : needsReorder ? pill('attention', 'REORDER') : pill('healthy', 'OK');
                            return `<tr class="${isZero ? 'sr-row-zero' : needsReorder ? 'sr-row-reorder' : ''}">
                                <td class="sr-product">${esc(i.product_name)}</td>
                                <td class="ict-muted">${esc(i.category || '—')}</td>
                                <td class="ict-muted">${esc(i.size)}</td>
                                <td class="ict-mono ict-muted"><code>${esc(i.sku_key)}</code></td>
                                <td class="ict-num ict-strong ${isZero ? 'ict-critical-text' : needsReorder ? 'ict-tone-attention' : ''}">${num(i.quantity)}</td>
                                <td class="ict-num ict-muted">${num(i.reorder_level)}</td>
                                <td>${status}</td>
                                <td class="ict-muted">${i.updated_at ? fmtDate(i.updated_at) : '—'}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            ${total > SR.pageSize ? `<div class="ict-pagination">
                <button class="ict-chip ${SR.page <= 0 ? 'disabled' : ''}" data-sr="page" data-dir="-1" ${SR.page <= 0 ? 'disabled' : ''}>← Prev</button>
                <span class="ict-page-info">Page ${SR.page + 1} of ${totalPages}</span>
                <button class="ict-chip ${SR.page >= totalPages - 1 ? 'disabled' : ''}" data-sr="page" data-dir="1" ${SR.page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
            </div>` : ''}`;

        // Update the matching count in toolbar
        const countEl = main.querySelector('.ict-toolbar-count');
        if (countEl) countEl.textContent = `${num(total)} matching`;
    }

    /* ── update dynamic content only (preserves toolbar & input focus) ── */
    function updateContent() {
        const main = document.getElementById('srMain');
        if (!main) return;
        // If shell not built yet, do full render
        if (!main.querySelector('.ict-toolbar')) { render(); return; }

        const s = SR.summary || {};
        const items = sortedItems();
        const total = items.length;
        const pageStart = SR.page * SR.pageSize;
        const pageRows = items.slice(pageStart, pageStart + SR.pageSize);
        const totalPages = Math.max(1, Math.ceil(total / SR.pageSize));

        const sevenDaysAgo = Date.now() - 7 * 86400000;
        const recentAdj = SR.adjustments.filter(a => new Date(a.created_at).getTime() > sevenDaysAgo);
        const recentIn = recentAdj.filter(a => a.adjustment_type === 'stock_in' || a.adjustment_type === 'bulk_in').reduce((s, a) => s + Math.abs(a.quantity_change), 0);
        const recentOut = recentAdj.filter(a => a.adjustment_type === 'stock_out' || a.adjustment_type === 'bulk_out').reduce((s, a) => s + Math.abs(a.quantity_change), 0);

        // Update page header
        const headerP = main.querySelector('.ict-page-head p');
        if (headerP) headerP.innerHTML = `Manual inventory tracking · ${num(s.total_skus || 0)} SKUs · ${num(s.total_units || 0)} units on hand${recentAdj.length ? ` · ${num(recentIn)} in / ${num(recentOut)} out (7d)` : ''}`;

        // Update stat card values
        const statVals = main.querySelectorAll('.ict-stat-value');
        if (statVals.length >= 4) {
            statVals[0].textContent = num(s.total_skus || 0);
            statVals[1].textContent = num(s.total_units || 0);
            statVals[2].textContent = num(s.reorder_needed || 0);
            statVals[3].textContent = num(s.zero_stock || 0);
        }

        // Update matching count
        const countEl = main.querySelector('.ict-toolbar-count');
        if (countEl) countEl.textContent = `${num(total)} matching`;

        // Update table card
        const card = main.querySelector('.ict-card-flush');
        if (card) {
            card.innerHTML = `
                <div class="ict-table-wrap">
                    <table class="ict-table">
                        <thead><tr>
                            ${sortTh('Product', 'product_name')}
                            ${sortTh('Category', 'category')}
                            ${sortTh('Size', 'size')}
                            <th>SKU Code</th>
                            ${sortTh('Stock', 'quantity', 'right')}
                            ${sortTh('Reorder', 'reorder_level', 'right')}
                            <th>Status</th>
                            ${sortTh('Updated', 'updated_at')}
                        </tr></thead>
                        <tbody>
                            ${pageRows.length === 0 ? `<tr><td colspan="8"><div class="ict-empty">No inventory items match these filters.</div></td></tr>` : pageRows.map(i => {
                                const isZero = i.quantity === 0;
                                const needsReorder = !isZero && i.quantity <= i.reorder_level;
                                const status = isZero ? pill('critical', 'ZERO') : needsReorder ? pill('attention', 'REORDER') : pill('healthy', 'OK');
                                return `<tr class="${isZero ? 'sr-row-zero' : needsReorder ? 'sr-row-reorder' : ''}">
                                    <td class="sr-product">${esc(i.product_name)}</td>
                                    <td class="ict-muted">${esc(i.category || '—')}</td>
                                    <td class="ict-muted">${esc(i.size)}</td>
                                    <td class="ict-mono ict-muted"><code>${esc(i.sku_key)}</code></td>
                                    <td class="ict-num ict-strong ${isZero ? 'ict-critical-text' : needsReorder ? 'ict-tone-attention' : ''}">${num(i.quantity)}</td>
                                    <td class="ict-num ict-muted">${num(i.reorder_level)}</td>
                                    <td>${status}</td>
                                    <td class="ict-muted">${i.updated_at ? fmtDate(i.updated_at) : '—'}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
                ${total > SR.pageSize ? `<div class="ict-pagination">
                    <button class="ict-chip ${SR.page <= 0 ? 'disabled' : ''}" data-sr="page" data-dir="-1" ${SR.page <= 0 ? 'disabled' : ''}>← Prev</button>
                    <span class="ict-page-info">Page ${SR.page + 1} of ${totalPages}</span>
                    <button class="ict-chip ${SR.page >= totalPages - 1 ? 'disabled' : ''}" data-sr="page" data-dir="1" ${SR.page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
                </div>` : ''}`;
        }

        // Update adjustments section
        const adjCard = main.querySelector('.ict-card[style]');
        if (adjCard) {
            const adjDesc = adjCard.querySelector('p');
            if (adjDesc) adjDesc.innerHTML = `Last ${SR.adjustments.length} inventory movements${recentAdj.length ? ` · ${num(recentIn)} IN / ${num(recentOut)} OUT in 7d` : ''}`;
            const adjBody = adjCard.querySelector('.ict-table-wrap');
            if (adjBody) adjBody.innerHTML = `<table class="ict-table">
                <thead><tr><th>Date</th><th>SKU</th><th>Product</th><th>Size</th><th>Type</th><th class="ict-th-right">Change</th><th class="ict-th-right">Before</th><th class="ict-th-right">After</th><th>Reference</th></tr></thead>
                <tbody>${SR.adjustments.length === 0 ? `<tr><td colspan="9"><div class="ict-empty">No adjustments recorded yet.</div></td></tr>` : SR.adjustments.slice(0, 20).map(a => `
                    <tr>
                        <td class="ict-muted">${fmtDateTime(a.created_at)}</td>
                        <td class="ict-mono ict-muted"><code>${esc(a.sku_key)}</code></td>
                        <td>${esc(a.product_name)}</td>
                        <td class="ict-muted">${esc(a.size)}</td>
                        <td>${pill(a.adjustment_type === 'stock_in' || a.adjustment_type === 'bulk_in' ? 'healthy' : a.adjustment_type === 'stock_out' || a.adjustment_type === 'bulk_out' ? 'critical' : 'info', a.adjustment_type.replace('_', ' '))}</td>
                        <td class="ict-num ${a.quantity_change >= 0 ? 'ict-healthy-text' : 'ict-critical-text'}" style="font-weight:600">${a.quantity_change >= 0 ? '+' : ''}${num(a.quantity_change)}</td>
                        <td class="ict-num ict-muted">${num(a.quantity_before)}</td>
                        <td class="ict-num ict-strong">${num(a.quantity_after)}</td>
                        <td class="ict-muted">${esc(a.reference || '—')}</td>
                    </tr>`).join('')}</tbody>
            </table>`;
        }
    }

    /* ── render (builds full page shell — called only once) ── */
    function render() {
        const main = document.getElementById('srMain');
        if (!main) return;

        if (SR.loading && !SR.loaded) {
            main.innerHTML = `<div class="sr-loading"><div class="inv-spinner"></div><span>Loading manual inventory...</span></div>`;
            return;
        }

        const s = SR.summary || {};
        const items = sortedItems();
        const total = items.length;
        const pageStart = SR.page * SR.pageSize;
        const pageRows = items.slice(pageStart, pageStart + SR.pageSize);
        const totalPages = Math.max(1, Math.ceil(total / SR.pageSize));

        const sevenDaysAgo = Date.now() - 7 * 86400000;
        const recentAdj = SR.adjustments.filter(a => new Date(a.created_at).getTime() > sevenDaysAgo);
        const recentIn = recentAdj.filter(a => a.adjustment_type === 'stock_in' || a.adjustment_type === 'bulk_in').reduce((s, a) => s + Math.abs(a.quantity_change), 0);
        const recentOut = recentAdj.filter(a => a.adjustment_type === 'stock_out' || a.adjustment_type === 'bulk_out').reduce((s, a) => s + Math.abs(a.quantity_change), 0);

        main.innerHTML = `
            <div class="sr-container">
                <div class="ict-page-head">
                    <h2>Stock Room</h2>
                    <p>Manual inventory tracking · ${num(s.total_skus || 0)} SKUs · ${num(s.total_units || 0)} units on hand${recentAdj.length ? ` · ${num(recentIn)} in / ${num(recentOut)} out (7d)` : ''}</p>
                </div>
                <div class="ict-mini-stats">
                    <div class="ict-stat-card"><div class="ict-stat-value">${num(s.total_skus || 0)}</div><div class="ict-stat-label">Total SKUs</div></div>
                    <div class="ict-stat-card"><div class="ict-stat-value">${num(s.total_units || 0)}</div><div class="ict-stat-label">Total Units</div></div>
                    <div class="ict-stat-card"><div class="ict-stat-value ict-tone-attention">${num(s.reorder_needed || 0)}</div><div class="ict-stat-label">Below Reorder</div></div>
                    <div class="ict-stat-card"><div class="ict-stat-value ict-tone-critical">${num(s.zero_stock || 0)}</div><div class="ict-stat-label">Zero Stock</div></div>
                </div>
                <div class="ict-toolbar">
                    <input type="text" class="ict-input" id="srFilterInput" placeholder="Search products, SKUs..." value="${esc(SR.filter)}" autocomplete="off">
                    <select class="ict-input" id="srCategoryFilter">
                        <option value="">All Categories</option>
                        <option value="T-SHIRT" ${SR.categoryFilter === 'T-SHIRT' ? 'selected' : ''}>T-Shirts</option>
                        <option value="SWEAT" ${SR.categoryFilter === 'SWEAT' ? 'selected' : ''}>Sweatshirts</option>
                        <option value="LOWER" ${SR.categoryFilter === 'LOWER' ? 'selected' : ''}>Lowers</option>
                    </select>
                    <select class="ict-input" id="srStatusFilter">
                        <option value="">All Status</option>
                        <option value="reorder" ${SR.statusFilter === 'reorder' ? 'selected' : ''}>Needs Reorder</option>
                        <option value="zero" ${SR.statusFilter === 'zero' ? 'selected' : ''}>Zero Stock</option>
                    </select>
                    <span class="ict-toolbar-count">${num(total)} matching</span>
                    <div style="margin-left:auto;display:flex;gap:6px">
                        <button class="btn sr-sync-shopify-btn" data-sr="sync-shopify" title="Two-way Shopify sync workbench" style="background:linear-gradient(135deg,#1a7f37,#238636);color:#fff;border:none;padding:8px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(26,127,55,0.3)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9m-9 9a9 9 0 0 1 9-9"/></svg> Shopify Sync</button>
                        <button class="btn sr-bulk-in-btn" data-sr="bulk-open" title="Add stock to multiple SKUs"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg> Bulk In</button>
                        <button class="btn sr-bulk-out-btn" data-sr="bulk-out-open" title="Remove stock from multiple SKUs"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg> Bulk Out</button>
                        <button class="ict-chip" data-sr="refresh" title="Refresh"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
                    </div>
                </div>
                <div class="ict-card ict-card-flush"></div>
                <div class="ict-card" style="margin-top:16px">
                    <div style="padding:16px 20px 0">
                        <h3 style="margin:0 0 4px;font-size:1rem;font-weight:600;color:var(--ict-text)">Recent Adjustments</h3>
                        <p style="margin:0 0 12px;font-size:0.82rem;color:var(--ict-text-muted)">Last ${SR.adjustments.length} inventory movements</p>
                    </div>
                    <div class="ict-table-wrap"></div>
                </div>
            </div>`;

        // Wire filter events (debounced) — done once on shell creation
        const filterInput = main.querySelector('#srFilterInput');
        if (filterInput) {
            let debounce;
            filterInput.addEventListener('input', (e) => {
                clearTimeout(debounce);
                debounce = setTimeout(() => { SR.filter = e.target.value; applyFiltersAndRender(); }, 200);
            });
        }

        // Populate dynamic sections
        updateContent();
    }

    /* ── bulk modal HTML (injected once) ── */
    function injectBulkModal() {
        if (document.getElementById('srBulkModal')) return;
        const div = document.createElement('div');
        div.id = 'srBulkModal';
        div.className = 'sr-bulk-modal-overlay';
        div.innerHTML = `
            <div class="sr-bulk-modal">
                <div class="sr-bulk-modal-header">
                    <h3>Bulk Inventory-In</h3>
                    <button class="sr-bulk-close" data-sr="bulk-close">&times;</button>
                </div>
                <div class="sr-bulk-body"></div>
                <div class="sr-bulk-footer">
                    <button class="btn btn-outline" data-sr="bulk-close">Cancel</button>
                    <button class="btn sr-confirm-bulk-btn" data-sr="bulk-confirm">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
                        Apply Bulk In
                    </button>
                </div>
            </div>`;
        document.body.appendChild(div);
        div.addEventListener('click', (e) => { if (e.target === div) closeBulkModal(); });
    }

    /* ── delegated event handling (CSP-safe) ── */
    document.addEventListener('click', (e) => {
        const view = document.getElementById('inventoryView');
        if (!view || view.style.display === 'none') return;

        const el = e.target.closest('[data-sr]');
        if (!el) return;
        const action = el.dataset.sr;

        if (action === 'sort') {
            const key = el.dataset.key;
            if (key) toggleSort(key);
        } else if (action === 'sync-shopify') {
            openSyncWorkbench('pull');
        } else if (action === 'bulk-open') {
            openBulkModal(false);
        } else if (action === 'bulk-out-open') {
            openBulkModal(true);
        } else if (action === 'bulk-close') {
            closeBulkModal();
        } else if (action === 'bulk-confirm') {
            confirmBulkIn();
        } else if (action === 'bulk-add') {
            const sku = el.dataset.sku;
            if (sku) addToBulk(sku);
        } else if (action === 'bulk-remove') {
            const sku = el.dataset.sku;
            if (sku) removeFromBulk(sku);
        } else if (action === 'refresh') {
            refreshAll();
        } else if (action === 'page') {
            const dir = parseInt(el.dataset.dir, 10) || 0;
            SR.page = Math.max(0, SR.page + dir);
            renderTable();
        }
    });

    document.addEventListener('input', (e) => {
        const view = document.getElementById('inventoryView');
        if (!view || view.style.display === 'none') return;

        // Bulk qty input
        const qtyInput = e.target.closest('[data-sr-bulk-qty]');
        if (qtyInput) {
            const sku = qtyInput.dataset.srBulkQty;
            if (sku) updateBulkQty(sku, qtyInput.value);
        }
    });

    document.addEventListener('change', (e) => {
        const view = document.getElementById('inventoryView');
        if (!view || view.style.display === 'none') return;

        const id = e.target.id;
        if (id === 'srCategoryFilter') { SR.categoryFilter = e.target.value; applyFiltersAndRender(); }
        else if (id === 'srStatusFilter') { SR.statusFilter = e.target.value; applyFiltersAndRender(); }
        else if (id === 'srBulkRef') { SR.bulkReference = e.target.value; }
        else if (id === 'srBulkNotes') { SR.bulkNotes = e.target.value; }
    });

    /* ── tab integration (memory smart) ── */
    function activate() {
        injectBulkModal();
        // Memory smart: only load if never loaded before
        if (!SR.loaded) {
            loadInventory();
            loadAdjustments();
        } else {
            updateContent(); // update stats/table only — preserves toolbar & input focus
        }
    }

    function deactivate() {
        const modal = document.getElementById('srBulkModal');
        if (modal) modal.style.display = 'none';
        // Sync job polling keeps running while a push is live (the workbench
        // reopens attached to the job) — but stop painting a hidden modal.
        // State persists — SR object is not cleared
    }

    /* ── public API ── */
    window.StockRoom = {
        activate,
        deactivate,
        addToBulk,
        removeFromBulk,
        updateBulkQty,
        openBulkModal,
        closeBulkModal,
        confirmBulkIn,
        syncFromShopify,
        openSyncWorkbench,
        closeSyncWorkbench,
        refresh: refreshAll,
    };
})();
