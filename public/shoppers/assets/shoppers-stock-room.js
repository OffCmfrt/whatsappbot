// ============================================================================
// OFFCOMFRT — STOCK ROOM (Manual Inventory & Bulk Inventory-In)
// Part of the Inventory Control Tower in Shoppers Hub.
// Manages manual inventory tracking and bulk stock-in operations.
// ============================================================================
(function () {
    'use strict';

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = (n) => Number(n || 0).toLocaleString('en-IN');

    // ── State ──
    const SR = {
        inventory: [],
        summary: null,
        adjustments: [],
        loading: false,
        filter: '',
        categoryFilter: '',
        statusFilter: '',   // '' | 'reorder' | 'zero'
        bulkItems: [],      // selected items for bulk-in
        bulkReference: '',
        bulkNotes: '',
    };

    // ── API helpers ──
    const getToken = () => localStorage.getItem('hubToken') || '';
    const authHeaders = () => ({ 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' });

    async function apiFetch(url, opts = {}) {
        const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
        if (res.status === 401) {
            localStorage.removeItem('hubToken');
            window.location.reload();
            throw new Error('Session expired');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    // ── Data loading ──
    async function loadInventory() {
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
        } catch (e) {
            console.error('Stock Room: adjustments load failed', e);
        }
    }

    // ── Bulk Inventory-In ──
    function addToBulk(skuKey) {
        const item = SR.inventory.find(i => i.sku_key === skuKey);
        if (!item) return;
        const existing = SR.bulkItems.find(b => b.sku_key === skuKey);
        if (existing) {
            existing.qty = (existing.qty || 0) + 1;
        } else {
            SR.bulkItems.push({
                sku_key: item.sku_key,
                product_name: item.product_name,
                size: item.size,
                category: item.category,
                qty: 1
            });
        }
        renderBulkModal();
    }

    function removeFromBulk(skuKey) {
        SR.bulkItems = SR.bulkItems.filter(b => b.sku_key !== skuKey);
        renderBulkModal();
    }

    function updateBulkQty(skuKey, qty) {
        const item = SR.bulkItems.find(b => b.sku_key === skuKey);
        if (item) {
            item.qty = Math.max(0, parseInt(qty) || 0);
            if (item.qty === 0) removeFromBulk(skuKey);
            else renderBulkModal();
        }
    }

    function openBulkModal() {
        SR.bulkItems = [];
        SR.bulkReference = '';
        SR.bulkNotes = '';
        renderBulkModal();
        document.getElementById('srBulkModal').style.display = 'flex';
    }

    function closeBulkModal() {
        document.getElementById('srBulkModal').style.display = 'none';
    }

    function renderBulkModal() {
        const modal = document.getElementById('srBulkModal');
        if (!modal) return;

        const totalItems = SR.bulkItems.length;
        const totalQty = SR.bulkItems.reduce((s, b) => s + b.qty, 0);

        modal.querySelector('.sr-bulk-body').innerHTML = `
            <div class="sr-bulk-search">
                <input type="text" id="srBulkSearch" placeholder="Search SKU or product name to add..." 
                       class="sr-bulk-search-input" autocomplete="off">
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
                        <thead>
                            <tr>
                                <th>Product</th>
                                <th>Size</th>
                                <th>Current Stock</th>
                                <th>Qty to Add</th>
                                <th>Projected</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${SR.bulkItems.map(b => {
                                const current = SR.inventory.find(i => i.sku_key === b.sku_key);
                                const currentQty = current ? current.quantity : 0;
                                const projected = currentQty + b.qty;
                                return `
                                    <tr>
                                        <td class="sr-bulk-product">${esc(b.product_name)}</td>
                                        <td class="sr-bulk-size">${esc(b.size)}</td>
                                        <td class="sr-bulk-current">${num(currentQty)}</td>
                                        <td>
                                            <input type="number" min="1" value="${b.qty}" 
                                                   class="sr-bulk-qty-input" 
                                                   data-sku="${esc(b.sku_key)}"
                                                   onchange="window.StockRoom?.updateBulkQty('${esc(b.sku_key)}', this.value)">
                                        </td>
                                        <td class="sr-bulk-projected ${projected <= (current?.reorder_level || 0) ? 'sr-reorder' : ''}">${num(projected)}</td>
                                        <td>
                                            <button class="sr-bulk-remove" onclick="window.StockRoom?.removeFromBulk('${esc(b.sku_key)}')" title="Remove">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                                </svg>
                                            </button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                `}
            </div>

            <div class="sr-bulk-meta">
                <div class="sr-bulk-field">
                    <label>Reference (optional)</label>
                    <input type="text" id="srBulkRef" placeholder="e.g. PO-2026-091, Batch #42" 
                           value="${esc(SR.bulkReference)}"
                           onchange="window.StockRoom.setBulkRef(this.value)">
                </div>
                <div class="sr-bulk-field">
                    <label>Notes (optional)</label>
                    <input type="text" id="srBulkNotes" placeholder="e.g. September restock from vendor"
                           value="${esc(SR.bulkNotes)}"
                           onchange="window.StockRoom.setBulkNotes(this.value)">
                </div>
            </div>
        `;

        // Wire search
        const searchInput = modal.querySelector('#srBulkSearch');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => handleBulkSearch(e.target.value));
            searchInput.focus();
        }
    }

    function handleBulkSearch(query) {
        const container = document.getElementById('srBulkSearchResults');
        if (!container) return;
        
        if (!query || query.length < 2) {
            container.innerHTML = '';
            return;
        }

        const q = query.toLowerCase();
        const matches = SR.inventory.filter(i => 
            !SR.bulkItems.find(b => b.sku_key === i.sku_key) &&
            (i.product_name.toLowerCase().includes(q) || i.sku_key.toLowerCase().includes(q) || i.size.toLowerCase().includes(q))
        ).slice(0, 15);

        container.innerHTML = matches.length === 0 
            ? '<div class="sr-search-empty">No matching SKUs found</div>'
            : matches.map(i => `
                <div class="sr-search-result" onclick="window.StockRoom?.addToBulk('${esc(i.sku_key)}')">
                    <span class="sr-search-name">${esc(i.product_name)}</span>
                    <span class="sr-search-size">${esc(i.size)}</span>
                    <span class="sr-search-stock ${i.quantity <= i.reorder_level ? 'sr-reorder' : ''}">${num(i.quantity)} in stock</span>
                </div>
            `).join('');
    }

    function setBulkRef(val) { SR.bulkReference = val; }
    function setBulkNotes(val) { SR.bulkNotes = val; }

    async function confirmBulkIn() {
        if (SR.bulkItems.length === 0) return;

        const totalQty = SR.bulkItems.reduce((s, b) => s + b.qty, 0);
        const confirmed = window.confirm(
            `Confirm Bulk Inventory-In\n\n` +
            `${SR.bulkItems.length} SKU(s) · ${totalQty} total units\n` +
            `Reference: ${SR.bulkReference || 'None'}\n\n` +
            `This will ADD the specified quantities to existing stock.\n` +
            `Existing stock will NOT be overwritten.`
        );
        if (!confirmed) return;

        try {
            const payload = {
                items: SR.bulkItems.map(b => ({
                    sku_key: b.sku_key,
                    product_name: b.product_name,
                    size: b.size,
                    category: b.category,
                    quantity: b.qty
                })),
                reference: SR.bulkReference || null,
                notes: SR.bulkNotes || null,
                performed_by: 'hub_operator'
            };

            const result = await apiFetch('/api/admin/inventory/bulk-in', {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (result.success) {
                showToast(`Bulk-in complete: ${result.processed} SKU(s), ${totalQty} units added`, 'success');
                closeBulkModal();
                await loadInventory();
                await loadAdjustments();
            } else {
                showToast(result.error || 'Bulk-in failed', 'error');
            }
        } catch (e) {
            console.error('Bulk-in error:', e);
            showToast('Bulk-in failed: ' + e.message, 'error');
        }
    }

    // ── Toast notification ──
    function showToast(message, type = 'info') {
        const existing = document.querySelector('.sr-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `sr-toast sr-toast-${type}`;
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed; bottom: 24px; right: 24px; z-index: 9999;
            padding: 14px 24px; border-radius: 8px; font-size: 13px; font-weight: 500;
            font-family: 'Inter', sans-serif; letter-spacing: 0.3px;
            background: ${type === 'success' ? '#0d3' : type === 'error' ? '#e33' : '#555'};
            color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            animation: sr-toast-in 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // ── Render ──
    function render() {
        const main = document.getElementById('srMain');
        if (!main) return;

        if (SR.loading) {
            main.innerHTML = `
                <div class="sr-loading">
                    <div class="inv-spinner"></div>
                    <span>Loading manual inventory...</span>
                </div>`;
            return;
        }

        const s = SR.summary || {};
        const items = SR.inventory;

        // Group by product for display
        const grouped = {};
        items.forEach(i => {
            if (!grouped[i.product_name]) grouped[i.product_name] = [];
            grouped[i.product_name].push(i);
        });

        main.innerHTML = `
            <div class="sr-container">
                <!-- Summary Cards -->
                <div class="sr-summary-row">
                    <div class="sr-stat-card">
                        <div class="sr-stat-value">${num(s.total_skus || 0)}</div>
                        <div class="sr-stat-label">Total SKUs</div>
                    </div>
                    <div class="sr-stat-card">
                        <div class="sr-stat-value">${num(s.total_units || 0)}</div>
                        <div class="sr-stat-label">Total Units</div>
                    </div>
                    <div class="sr-stat-card sr-stat-warning">
                        <div class="sr-stat-value">${num(s.reorder_needed || 0)}</div>
                        <div class="sr-stat-label">Below Reorder</div>
                    </div>
                    <div class="sr-stat-card sr-stat-danger">
                        <div class="sr-stat-value">${num(s.zero_stock || 0)}</div>
                        <div class="sr-stat-label">Zero Stock</div>
                    </div>
                </div>

                <!-- Toolbar -->
                <div class="sr-toolbar">
                    <div class="sr-toolbar-left">
                        <input type="text" id="srFilterInput" placeholder="Filter products..." 
                               class="sr-filter-input" value="${esc(SR.filter)}">
                        <select id="srCategoryFilter" class="sr-filter-select">
                            <option value="">All Categories</option>
                            <option value="T-SHIRT" ${SR.categoryFilter === 'T-SHIRT' ? 'selected' : ''}>T-Shirts</option>
                            <option value="SWEAT" ${SR.categoryFilter === 'SWEAT' ? 'selected' : ''}>Sweatshirts</option>
                            <option value="LOWER" ${SR.categoryFilter === 'LOWER' ? 'selected' : ''}>Lowers</option>
                        </select>
                        <select id="srStatusFilter" class="sr-filter-select">
                            <option value="">All Status</option>
                            <option value="reorder" ${SR.statusFilter === 'reorder' ? 'selected' : ''}>Needs Reorder</option>
                            <option value="zero" ${SR.statusFilter === 'zero' ? 'selected' : ''}>Zero Stock</option>
                        </select>
                    </div>
                    <div class="sr-toolbar-right">
                        <button id="srBulkInBtn" class="btn sr-bulk-in-btn">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 5v14M5 12h14"/>
                            </svg>
                            Bulk Inventory-In
                        </button>
                        <button id="srRefreshBtn" class="btn btn-outline" title="Refresh">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <!-- Inventory Table -->
                <div class="sr-table-wrap">
                    <table class="sr-table">
                        <thead>
                            <tr>
                                <th>Product</th>
                                <th>Category</th>
                                <th>Size</th>
                                <th>SKU Key</th>
                                <th>Stock</th>
                                <th>Reorder Level</th>
                                <th>Status</th>
                                <th>Updated</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${items.length === 0 ? `
                                <tr><td colspan="8" class="sr-empty">No inventory items found</td></tr>
                            ` : items.map(i => {
                                const needsReorder = i.quantity <= i.reorder_level;
                                const isZero = i.quantity === 0;
                                return `
                                    <tr class="${isZero ? 'sr-row-zero' : needsReorder ? 'sr-row-reorder' : ''}">
                                        <td class="sr-product">${esc(i.product_name)}</td>
                                        <td class="sr-category">${esc(i.category || '—')}</td>
                                        <td class="sr-size">${esc(i.size)}</td>
                                        <td class="sr-sku"><code>${esc(i.sku_key)}</code></td>
                                        <td class="sr-qty ${isZero ? 'sr-zero' : needsReorder ? 'sr-low' : ''}">${num(i.quantity)}</td>
                                        <td class="sr-reorder-level">${num(i.reorder_level)}</td>
                                        <td>
                                            ${isZero 
                                                ? '<span class="sr-status sr-status-zero">ZERO</span>' 
                                                : needsReorder 
                                                    ? '<span class="sr-status sr-status-reorder">REORDER</span>' 
                                                    : '<span class="sr-status sr-status-ok">OK</span>'}
                                        </td>
                                        <td class="sr-updated">${i.updated_at ? new Date(i.updated_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—'}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>

                <!-- Recent Adjustments -->
                <div class="sr-adjustments-section">
                    <h3 class="sr-section-title">Recent Adjustments</h3>
                    <div class="sr-adjustments-table-wrap">
                        <table class="sr-adjustments-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>SKU</th>
                                    <th>Product</th>
                                    <th>Size</th>
                                    <th>Type</th>
                                    <th>Change</th>
                                    <th>Before</th>
                                    <th>After</th>
                                    <th>Reference</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${SR.adjustments.length === 0 ? `
                                    <tr><td colspan="9" class="sr-empty">No adjustments recorded yet</td></tr>
                                ` : SR.adjustments.slice(0, 20).map(a => `
                                    <tr>
                                        <td class="sr-adj-date">${new Date(a.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                                        <td class="sr-adj-sku"><code>${esc(a.sku_key)}</code></td>
                                        <td class="sr-adj-product">${esc(a.product_name)}</td>
                                        <td class="sr-adj-size">${esc(a.size)}</td>
                                        <td><span class="sr-adj-type sr-adj-type-${esc(a.adjustment_type)}">${esc(a.adjustment_type)}</span></td>
                                        <td class="sr-adj-change ${a.quantity_change >= 0 ? 'sr-positive' : 'sr-negative'}">${a.quantity_change >= 0 ? '+' : ''}${num(a.quantity_change)}</td>
                                        <td class="sr-adj-before">${num(a.quantity_before)}</td>
                                        <td class="sr-adj-after">${num(a.quantity_after)}</td>
                                        <td class="sr-adj-ref">${esc(a.reference || '—')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        // Wire events
        const filterInput = main.querySelector('#srFilterInput');
        if (filterInput) {
            let debounce;
            filterInput.addEventListener('input', (e) => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    SR.filter = e.target.value;
                    loadInventory();
                }, 300);
            });
        }

        const catFilter = main.querySelector('#srCategoryFilter');
        if (catFilter) {
            catFilter.addEventListener('change', (e) => {
                SR.categoryFilter = e.target.value;
                loadInventory();
            });
        }

        const statusFilter = main.querySelector('#srStatusFilter');
        if (statusFilter) {
            statusFilter.addEventListener('change', (e) => {
                SR.statusFilter = e.target.value;
                loadInventory();
            });
        }

        const bulkBtn = main.querySelector('#srBulkInBtn');
        if (bulkBtn) bulkBtn.addEventListener('click', openBulkModal);

        const refreshBtn = main.querySelector('#srRefreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => { loadInventory(); loadAdjustments(); });
    }

    // ── Bulk Modal HTML (injected once) ──
    function injectBulkModal() {
        if (document.getElementById('srBulkModal')) return;
        const div = document.createElement('div');
        div.id = 'srBulkModal';
        div.className = 'sr-bulk-modal-overlay';
        div.innerHTML = `
            <div class="sr-bulk-modal">
                <div class="sr-bulk-modal-header">
                    <h3>Bulk Inventory-In</h3>
                    <button class="sr-bulk-close" onclick="window.StockRoom?.closeBulkModal()">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="sr-bulk-body"></div>
                <div class="sr-bulk-footer">
                    <button class="btn btn-outline" onclick="window.StockRoom?.closeBulkModal()">Cancel</button>
                    <button class="btn sr-confirm-bulk-btn" onclick="window.StockRoom?.confirmBulkIn()">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 5v14M5 12h14"/>
                        </svg>
                        Apply Bulk Inventory-In
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(div);

        // Close on overlay click
        div.addEventListener('click', (e) => {
            if (e.target === div) closeBulkModal();
        });
    }

    // ── Tab integration ──
    function activate() {
        injectBulkModal();
        loadInventory();
        loadAdjustments();
    }

    function deactivate() {
        const modal = document.getElementById('srBulkModal');
        if (modal) modal.style.display = 'none';
    }

    // ── Public API ──
    window.StockRoom = {
        activate,
        deactivate,
        addToBulk,
        removeFromBulk,
        updateBulkQty,
        setBulkRef,
        setBulkNotes,
        openBulkModal,
        closeBulkModal,
        confirmBulkIn,
        render,
    };
})();
