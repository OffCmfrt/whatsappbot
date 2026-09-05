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
        render();
        try {
            const params = new URLSearchParams();
            if (SR.filter) params.set('product', SR.filter);
            if (SR.categoryFilter) params.set('category', SR.categoryFilter);
            if (SR.statusFilter === 'reorder') params.set('reorder_only', '1');
            const data = await apiFetch(`/api/admin/inventory/manual?${params}`);
            SR.inventory = data.items || [];
            SR.summary = data.summary || {};
            SR.loaded = true;
        } catch (e) {
            console.error('Stock Room: load failed', e);
            SR.inventory = [];
        }
        SR.loading = false;
        render();
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
        render();
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
        if (item) { item.qty = Math.max(0, parseInt(qty) || 0); if (item.qty === 0) removeFromBulk(skuKey); else renderBulkModal(); }
    }

    function openBulkModal() { SR.bulkItems = []; SR.bulkReference = ''; SR.bulkNotes = ''; renderBulkModal(); const m = document.getElementById('srBulkModal'); if (m) m.style.display = 'flex'; }
    function closeBulkModal() { const m = document.getElementById('srBulkModal'); if (m) m.style.display = 'none'; }

    function renderBulkModal() {
        const modal = document.getElementById('srBulkModal');
        if (!modal) return;
        const totalItems = SR.bulkItems.length;
        const totalQty = SR.bulkItems.reduce((s, b) => s + b.qty, 0);

        modal.querySelector('.sr-bulk-body').innerHTML = `
            <div class="sr-bulk-search">
                <input type="text" id="srBulkSearch" placeholder="Search SKU or product name to add..." class="sr-bulk-search-input" autocomplete="off">
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
                        <p>No SKUs selected yet. Search above to add items.</p>
                    </div>
                ` : `
                    <table class="sr-bulk-table">
                        <thead><tr><th>Product</th><th>Size</th><th>Current</th><th>Qty to Add</th><th>Projected</th><th></th></tr></thead>
                        <tbody>
                            ${SR.bulkItems.map(b => {
                                const current = SR.inventory.find(i => i.sku_key === b.sku_key);
                                const curQty = current ? current.quantity : 0;
                                const proj = curQty + b.qty;
                                return `<tr>
                                    <td class="sr-bulk-product">${esc(b.product_name)}</td>
                                    <td class="sr-bulk-size">${esc(b.size)}</td>
                                    <td class="sr-bulk-current">${num(curQty)}</td>
                                    <td><input type="number" min="1" value="${b.qty}" class="sr-bulk-qty-input" data-sr-bulk-qty="${esc(b.sku_key)}"></td>
                                    <td class="${proj <= (current?.reorder_level || 0) ? 'sr-bulk-projected sr-reorder' : ''}">${num(proj)}</td>
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
                    <input type="text" id="srBulkRef" placeholder="e.g. PO-2026-091, Batch #42" value="${esc(SR.bulkReference)}">
                </div>
                <div class="sr-bulk-field">
                    <label>Notes (optional)</label>
                    <input type="text" id="srBulkNotes" placeholder="e.g. September restock from vendor" value="${esc(SR.bulkNotes)}">
                </div>
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
        const totalQty = SR.bulkItems.reduce((s, b) => s + b.qty, 0);
        if (!window.confirm(`Confirm Bulk Inventory-In\n\n${SR.bulkItems.length} SKU(s) · ${totalQty} total units\nReference: ${SR.bulkReference || 'None'}\n\nThis will ADD the specified quantities to existing stock.`)) return;
        try {
            const result = await apiFetch('/api/admin/inventory/bulk-in', {
                method: 'POST',
                body: JSON.stringify({
                    items: SR.bulkItems.map(b => ({ sku_key: b.sku_key, product_name: b.product_name, size: b.size, category: b.category, quantity: b.qty })),
                    reference: SR.bulkReference || null, notes: SR.bulkNotes || null, performed_by: 'hub_operator'
                })
            });
            if (result.success) {
                showToast(`Bulk-in complete: ${result.processed} SKU(s), ${totalQty} units added`, 'success');
                closeBulkModal();
                SR.loaded = false;
                await loadInventory(true);
                await loadAdjustments();
            } else { showToast(result.error || 'Bulk-in failed', 'error'); }
        } catch (e) { showToast('Bulk-in failed: ' + e.message, 'error'); }
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

    /* ── render ── */
    function render() {
        const main = document.getElementById('srMain');
        if (!main) return;

        if (SR.loading) {
            main.innerHTML = `<div class="sr-loading"><div class="inv-spinner"></div><span>Loading manual inventory...</span></div>`;
            return;
        }

        const s = SR.summary || {};
        const items = sortedItems();
        const total = items.length;
        const pageStart = SR.page * SR.pageSize;
        const pageRows = items.slice(pageStart, pageStart + SR.pageSize);
        const totalPages = Math.max(1, Math.ceil(total / SR.pageSize));

        // Recent movement summary from adjustments (last 7 days)
        const sevenDaysAgo = Date.now() - 7 * 86400000;
        const recentAdj = SR.adjustments.filter(a => new Date(a.created_at).getTime() > sevenDaysAgo);
        const recentIn = recentAdj.filter(a => a.adjustment_type === 'stock_in' || a.adjustment_type === 'bulk_in').reduce((s, a) => s + Math.abs(a.quantity_change), 0);
        const recentOut = recentAdj.filter(a => a.adjustment_type === 'stock_out').reduce((s, a) => s + Math.abs(a.quantity_change), 0);

        main.innerHTML = `
            <div class="sr-container">
                <!-- Page header -->
                <div class="ict-page-head">
                    <h2>Stock Room</h2>
                    <p>Manual inventory tracking · ${num(s.total_skus || 0)} SKUs · ${num(s.total_units || 0)} units on hand${recentAdj.length ? ` · ${num(recentIn)} in / ${num(recentOut)} out (7d)` : ''}</p>
                </div>

                <!-- Summary Cards (ICT style) -->
                <div class="ict-mini-stats">
                    <div class="ict-stat-card">
                        <div class="ict-stat-value">${num(s.total_skus || 0)}</div>
                        <div class="ict-stat-label">Total SKUs</div>
                    </div>
                    <div class="ict-stat-card">
                        <div class="ict-stat-value">${num(s.total_units || 0)}</div>
                        <div class="ict-stat-label">Total Units</div>
                    </div>
                    <div class="ict-stat-card">
                        <div class="ict-stat-value ict-tone-attention">${num(s.reorder_needed || 0)}</div>
                        <div class="ict-stat-label">Below Reorder</div>
                    </div>
                    <div class="ict-stat-card">
                        <div class="ict-stat-value ict-tone-critical">${num(s.zero_stock || 0)}</div>
                        <div class="ict-stat-label">Zero Stock</div>
                    </div>
                </div>

                <!-- Toolbar -->
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
                        <button class="btn sr-bulk-in-btn" data-sr="bulk-open">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
                            Bulk In
                        </button>
                        <button class="ict-chip" data-sr="refresh" title="Refresh">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                        </button>
                    </div>
                </div>

                <!-- Inventory Table (ICT style) -->
                <div class="ict-card ict-card-flush">
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
                    </div>` : ''}
                </div>

                <!-- Recent Adjustments -->
                <div class="ict-card" style="margin-top:16px">
                    <div style="padding:16px 20px 0">
                        <h3 style="margin:0 0 4px;font-size:1rem;font-weight:600;color:var(--ict-text)">Recent Adjustments</h3>
                        <p style="margin:0 0 12px;font-size:0.82rem;color:var(--ict-text-muted)">Last ${SR.adjustments.length} inventory movements${recentAdj.length ? ` · ${num(recentIn)} IN / ${num(recentOut)} OUT in 7d` : ''}</p>
                    </div>
                    <div class="ict-table-wrap">
                        <table class="ict-table">
                            <thead><tr>
                                <th>Date</th><th>SKU</th><th>Product</th><th>Size</th><th>Type</th>
                                <th class="ict-th-right">Change</th><th class="ict-th-right">Before</th><th class="ict-th-right">After</th><th>Reference</th>
                            </tr></thead>
                            <tbody>
                                ${SR.adjustments.length === 0 ? `<tr><td colspan="9"><div class="ict-empty">No adjustments recorded yet.</div></td></tr>` : SR.adjustments.slice(0, 20).map(a => `
                                    <tr>
                                        <td class="ict-muted">${fmtDateTime(a.created_at)}</td>
                                        <td class="ict-mono ict-muted"><code>${esc(a.sku_key)}</code></td>
                                        <td>${esc(a.product_name)}</td>
                                        <td class="ict-muted">${esc(a.size)}</td>
                                        <td>${pill(a.adjustment_type === 'stock_in' || a.adjustment_type === 'bulk_in' ? 'healthy' : a.adjustment_type === 'stock_out' ? 'critical' : 'info', a.adjustment_type.replace('_', ' '))}</td>
                                        <td class="ict-num ${a.quantity_change >= 0 ? 'ict-healthy-text' : 'ict-critical-text'}" style="font-weight:600">${a.quantity_change >= 0 ? '+' : ''}${num(a.quantity_change)}</td>
                                        <td class="ict-num ict-muted">${num(a.quantity_before)}</td>
                                        <td class="ict-num ict-strong">${num(a.quantity_after)}</td>
                                        <td class="ict-muted">${esc(a.reference || '—')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>`;

        // Wire filter events (debounced)
        const filterInput = main.querySelector('#srFilterInput');
        if (filterInput) {
            let debounce;
            filterInput.addEventListener('input', (e) => {
                clearTimeout(debounce);
                debounce = setTimeout(() => { SR.filter = e.target.value; SR.loaded = false; SR.page = 0; loadInventory(true); }, 300);
            });
        }
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
        } else if (action === 'bulk-open') {
            openBulkModal();
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
            render();
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
        if (id === 'srCategoryFilter') { SR.categoryFilter = e.target.value; SR.loaded = false; SR.page = 0; loadInventory(true); }
        else if (id === 'srStatusFilter') { SR.statusFilter = e.target.value; SR.loaded = false; SR.page = 0; loadInventory(true); }
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
            render(); // just re-render with cached data
        }
    }

    function deactivate() {
        const modal = document.getElementById('srBulkModal');
        if (modal) modal.style.display = 'none';
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
        refresh: refreshAll,
    };
})();
