// ============================================================
// OFFCOMFRT — ZOHO SYNC CONSOLE — Frontend Logic
// ============================================================

const API_BASE = '/api/admin/zoho';

function getToken() {
    return localStorage.getItem('authToken') || '';
}

async function apiFetch(path, options = {}) {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {})
        }
    });
    if (res.status === 401) {
        window.parent.postMessage({ type: 'session_expired' }, '*');
        throw new Error('Session expired');
    }
    return res.json();
}

// ============================================================
// Toast notifications
// ============================================================

function toast(message, kind = '') {
    const stack = document.getElementById('toastStack');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.classList.add('out'), 3600);
    setTimeout(() => el.remove(), 4000);
}

// ============================================================
// Tab Navigation
// ============================================================

document.querySelectorAll('.section-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.section-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        const section = tab.dataset.section;
        document.getElementById(`section-${section}`).classList.add('active');
        loadSection(section);
    });
});

function loadSection(section) {
    switch (section) {
        case 'overview': loadOverview(); break;
        case 'sync': loadSyncLog(); break;
        case 'tax': loadTaxCorrections(); break;
        case 'returns': loadReturns(); break;
        case 'cod': loadCodLog(); break;
        case 'config': loadConfig(); break;
    }
}

// ============================================================
// Overview
// ============================================================

async function loadOverview() {
    try {
        const data = await apiFetch('/stats');
        if (!data.success) return;

        const { sync, returns, cod } = data;
        const total = sync.today.total || 1;
        const rate = Math.round((sync.today.synced / total) * 100);

        document.getElementById('statSyncedToday').textContent = sync.today.synced;
        document.getElementById('statSuccessRate').textContent = `${rate}%`;
        document.getElementById('statFailed').textContent = sync.today.failed;
        document.getElementById('statPendingRetry').textContent = sync.today.pendingRetry;
        document.getElementById('statReturnsToday').textContent = returns.today.returns + returns.today.rtos;
        document.getElementById('statCodPending').textContent = cod.pending;

        const syncData = await apiFetch('/sync?limit=10');
        if (syncData.success) {
            renderSyncRows(syncData.data, 'recentSyncBody', false);
        }
    } catch (err) {
        console.error('Overview load error:', err);
    }
}

// ============================================================
// Sync Log
// ============================================================

let syncPage = 1;

async function loadSyncLog(page = 1) {
    syncPage = page;
    const search = document.getElementById('syncSearch').value;
    const status = document.getElementById('syncStatusFilter').value;

    try {
        const data = await apiFetch(`/sync?page=${page}&limit=25&status=${status}&search=${encodeURIComponent(search)}`);
        if (!data.success) return;

        renderSyncRows(data.data, 'syncLogBody', true);
        renderPagination('syncPagination', data, loadSyncLog);
    } catch (err) {
        console.error('Sync log load error:', err);
    }
}

function renderSyncRows(rows, tbodyId, showActions) {
    const tbody = document.getElementById(tbodyId);
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${showActions ? 7 : 4}"><div class="empty-state"><p>No sync records found</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(row => {
        const transform = row.transformation || {};
        const hasTransforms = (transform.bundle_breaks?.length || 0) + (transform.tax_corrections?.length || 0) > 0;
        const time = new Date(row.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });

        return `<tr class="clickable-row" onclick="showTransformDetail(${row.id})">
            <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
            <td>${row.zoho_invoice_id ? escHtml(row.zoho_invoice_id) : '—'}</td>
            <td><span class="badge badge-${row.status}">${row.status}</span></td>
            ${showActions ? `<td>${hasTransforms ? `${transform.bundle_breaks?.length || 0} bundles, ${transform.tax_corrections?.length || 0} tax` : 'None'}</td>` : ''}
            ${showActions ? `<td class="truncate" title="${escHtml(row.error_message || '')}">${row.error_message ? escHtml(row.error_message.substring(0, 50)) : '—'}</td>` : ''}
            <td>${time}</td>
            ${showActions ? `<td>${row.status === 'failed' ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); retrySync(${row.id})">Retry</button>` : ''}</td>` : ''}
        </tr>`;
    }).join('');
}

async function retrySync(id) {
    try {
        const data = await apiFetch(`/sync/retry/${id}`, { method: 'POST' });
        toast(data.success ? 'Sync retry initiated' : `Retry failed: ${data.error}`, data.success ? 'ok' : 'err');
        loadSyncLog(syncPage);
    } catch (err) {
        toast('Retry error: ' + err.message, 'err');
    }
}

async function retryAllFailed() {
    if (!confirm('Retry all failed syncs?')) return;
    try {
        const data = await apiFetch('/sync/retry', { method: 'POST' });
        toast(`Retried ${data.retried} syncs — ${data.succeeded} succeeded`, 'ok');
        loadSyncLog(syncPage);
    } catch (err) {
        toast('Retry error: ' + err.message, 'err');
    }
}

// ============================================================
// Tax Corrections
// ============================================================

async function loadTaxCorrections() {
    const type = document.getElementById('taxTypeFilter').value;
    try {
        const data = await apiFetch(`/tax-corrections?limit=50&type=${type}`);
        if (!data.success) return;

        const tbody = document.getElementById('taxCorrectionsBody');
        const rows = data.data || [];

        const rateFixes = rows.filter(r => r.correction_type === 'rate_fix').length;
        const stateFixes = rows.filter(r => r.correction_type === 'state_fix' || r.correction_type === 'intra_state' || r.correction_type === 'inter_state').length;
        document.getElementById('statTaxCorrected').textContent = rows.length;
        document.getElementById('statRateFixes').textContent = rateFixes;
        document.getElementById('statStateFixes').textContent = stateFixes;

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>No tax corrections yet</p></div></td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(row => {
            const time = new Date(row.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
            const origTax = row.original_tax ? JSON.stringify(row.original_tax).substring(0, 60) : '—';
            const corrTax = row.corrected_tax ? JSON.stringify(row.corrected_tax).substring(0, 60) : '—';

            return `<tr>
                <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
                <td><span class="badge badge-${row.correction_type === 'rate_fix' ? 'return' : 'exchange'}">${row.correction_type || '—'}</span></td>
                <td class="truncate" title="${escHtml(origTax)}">${escHtml(origTax)}</td>
                <td class="truncate" title="${escHtml(corrTax)}">${escHtml(corrTax)}</td>
                <td>${time}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Tax corrections load error:', err);
    }
}

// ============================================================
// Returns & RTO
// ============================================================

async function loadReturns() {
    const type = document.getElementById('returnTypeFilter').value;
    const status = document.getElementById('returnStatusFilter').value;

    try {
        const [statsData, logData] = await Promise.all([
            apiFetch('/stats'),
            apiFetch(`/returns?limit=50&returnType=${type}&status=${status}`)
        ]);

        if (statsData.success) {
            document.getElementById('statReturns').textContent = statsData.returns.today.returns;
            document.getElementById('statRTOs').textContent = statsData.returns.today.rtos;
            document.getElementById('statCreditNotes').textContent = statsData.returns.creditNotesCreated;
            document.getElementById('statFailedReturns').textContent = statsData.returns.failedReturns;
        }

        if (!logData.success) return;
        const tbody = document.getElementById('returnsBody');
        const rows = logData.data || [];

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No returns/RTOs yet</p></div></td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(row => {
            const time = new Date(row.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
            const items = row.original_items ? JSON.stringify(row.original_items).substring(0, 50) : '—';

            return `<tr>
                <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
                <td><span class="badge badge-${row.return_type}">${row.return_type}</span></td>
                <td>${row.zoho_credit_note_id ? escHtml(row.zoho_credit_note_id) : '—'}</td>
                <td class="truncate" title="${escHtml(items)}">${escHtml(items)}</td>
                <td><span class="badge badge-${row.status}">${row.status}</span></td>
                <td>${time}</td>
                <td>${row.status === 'failed' ? `<button class="btn btn-sm btn-outline" onclick="retryReturn(${row.id})">Retry</button>` : ''}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Returns load error:', err);
    }
}

async function retryReturn(id) {
    try {
        const data = await apiFetch(`/returns/retry/${id}`, { method: 'POST' });
        toast(data.success ? 'Return retry initiated' : `Retry failed: ${data.error}`, data.success ? 'ok' : 'err');
        loadReturns();
    } catch (err) {
        toast('Retry error: ' + err.message, 'err');
    }
}

// ============================================================
// COD Payments
// ============================================================

async function loadCodLog() {
    const search = document.getElementById('codSearch').value;
    const status = document.getElementById('codStatusFilter').value;

    try {
        const [statsData, logData] = await Promise.all([
            apiFetch('/stats'),
            apiFetch(`/cod?limit=50&status=${status}&search=${encodeURIComponent(search)}`)
        ]);

        if (statsData.success) {
            document.getElementById('statCodPending').textContent = statsData.cod.pending;
            document.getElementById('statCodReconciled').textContent = statsData.cod.reconciledToday.count;
            document.getElementById('statCodAmount').textContent = `₹${statsData.cod.reconciledToday.amount.toLocaleString('en-IN')}`;
        }

        if (!logData.success) return;
        const tbody = document.getElementById('codBody');
        const rows = logData.data || [];

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No COD payments yet</p></div></td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(row => {
            const time = row.reconciled_at ? new Date(row.reconciled_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '—';

            return `<tr>
                <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
                <td>${row.awb || '—'}</td>
                <td>${escHtml(row.carrier || '—')}</td>
                <td>₹${parseFloat(row.amount || 0).toLocaleString('en-IN')}</td>
                <td><span class="badge badge-${row.payment_status === 'reconciled' ? 'reconciled' : row.payment_status}">${row.payment_status}</span></td>
                <td>${time}</td>
                <td>${row.payment_status === 'pending' || row.payment_status === 'failed' ? `<button class="btn btn-sm btn-primary" onclick="reconcileCod(${row.id})">Reconcile</button>` : ''}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('COD log load error:', err);
    }
}

async function reconcileCod(id) {
    try {
        const data = await apiFetch(`/cod/reconcile/${id}`, { method: 'POST' });
        toast(data.success ? 'COD reconciled successfully' : `Reconciliation failed: ${data.error}`, data.success ? 'ok' : 'err');
        loadCodLog();
    } catch (err) {
        toast('Reconcile error: ' + err.message, 'err');
    }
}

// ============================================================
// Configuration + Bundle Setup Wizard
// ============================================================

let wizardData = null;             // raw wizard payload
let wizardSelections = {};         // title -> Set of selected baseNames
let wizardEditing = {};            // title -> bool (configured card in edit mode)
let wizardFilter = 'all';

async function loadConfig() {
    try {
        const [configData, connResult] = await Promise.all([
            apiFetch('/config'),
            apiFetch('/config/test-connection').catch(() => ({ success: false, error: 'Not configured' }))
        ]);

        // Connection status — strip + brand-bar pill
        const connEl = document.getElementById('connectionStatus');
        const pill = document.getElementById('connPill');
        const pillText = document.getElementById('connPillText');
        if (connResult.success) {
            const orgName = connResult.organization || 'Zoho';
            connEl.innerHTML = `<span class="status-dot status-connected"></span> ${escHtml(orgName)}`;
            pill.className = 'live-pill on';
            pillText.textContent = 'LIVE — ' + orgName.toUpperCase().slice(0, 24);
        } else {
            const errMsg = connResult.error || 'Not connected';
            connEl.innerHTML = `<span class="status-dot status-disconnected"></span> ${escHtml(errMsg)}`;
            pill.className = 'live-pill off';
            pillText.textContent = 'OFFLINE';
        }

        if (configData.success) {
            const cfg = configData.config;
            document.getElementById('sellerStateDisplay').textContent = cfg.sellerState;
            document.getElementById('booksDomainDisplay').textContent = cfg.booksDomain;
            document.getElementById('autoSyncLabel').textContent = cfg.autoSync ? 'Enabled' : 'Disabled';
        }
    } catch (err) {
        console.error('Config load error:', err);
    }

    loadWizard();
}

async function loadWizard() {
    const grid = document.getElementById('wizardGrid');
    grid.innerHTML = `<div class="wizard-loading"><span class="loading-spinner"></span>&nbsp;&nbsp;Loading your Shopify bundles &amp; Zoho catalog...</div>`;
    try {
        const data = await apiFetch('/config/bundles/wizard');
        if (!data.success) {
            grid.innerHTML = `<div class="wizard-loading">Could not load wizard: ${escHtml(data.error || 'unknown error')}</div>`;
            return;
        }
        wizardData = data;

        // Pre-select: ready bundles → all candidates; configured bundles → their components
        wizardSelections = {};
        wizardEditing = {};
        for (const s of data.suggestions) {
            const configured = data.configured[s.title];
            if (configured && configured.length > 0) {
                wizardSelections[s.title] = new Set(configured.map(r => r.component_sku));
            } else if (s.autoReady) {
                wizardSelections[s.title] = new Set(s.candidates.map(c => c.baseName));
            } else {
                wizardSelections[s.title] = new Set();
            }
        }

        renderWizard();
        renderBundleMap(Object.values(data.configured).flat());
    } catch (err) {
        grid.innerHTML = `<div class="wizard-loading">Could not load wizard: ${escHtml(err.message)}</div>`;
    }
}

function cardState(s) {
    const configured = wizardData.configured[s.title];
    if (configured && configured.length > 0 && !wizardEditing[s.title]) return 'configured';
    if (s.autoReady) return 'ready';
    if (s.candidates && s.candidates.length > 0) return 'manual';
    return 'none';
}

function filterWizard(filter) {
    wizardFilter = filter;
    document.querySelectorAll('.wizard-chips .chip').forEach(c => {
        c.classList.toggle('active', c.dataset.filter === filter);
    });
    renderWizard();
}

function renderWizard() {
    if (!wizardData) return;
    const grid = document.getElementById('wizardGrid');
    const suggestions = wizardData.suggestions || [];

    // Progress + apply-all button
    const configuredCount = suggestions.filter(s => (wizardData.configured[s.title] || []).length > 0).length;
    document.getElementById('wizardProgress').textContent = `${configuredCount} / ${suggestions.length}`;
    const readyUnconfigured = suggestions.filter(s => s.autoReady && !(wizardData.configured[s.title] || []).length);
    const applyAllBtn = document.getElementById('applyAllReadyBtn');
    applyAllBtn.style.display = readyUnconfigured.length > 0 ? '' : 'none';
    applyAllBtn.textContent = `Apply ${readyUnconfigured.length} Ready Suggestion${readyUnconfigured.length === 1 ? '' : 's'}`;

    const filtered = suggestions.filter(s => {
        const st = cardState(s);
        if (wizardFilter === 'all') return true;
        if (wizardFilter === 'ready') return st === 'ready';
        if (wizardFilter === 'manual') return st === 'manual' || st === 'none';
        if (wizardFilter === 'configured') return (wizardData.configured[s.title] || []).length > 0;
        return true;
    });

    if (filtered.length === 0) {
        grid.innerHTML = `<div class="wizard-loading">Nothing here — switch filter to see other bundles.</div>`;
        return;
    }

    grid.innerHTML = filtered.map(s => renderBundleCard(s)).join('');
}

function renderBundleCard(s) {
    const st = cardState(s);
    const configured = wizardData.configured[s.title] || [];
    const sel = wizardSelections[s.title] || new Set();

    const stateChip = {
        configured: `<span class="bundle-card-state state-configured">● Configured</span>`,
        ready: `<span class="bundle-card-state state-ready">⚡ Ready</span>`,
        manual: `<span class="bundle-card-state state-manual">Pick pieces</span>`,
        none: `<span class="bundle-card-state state-none">No singles</span>`
    }[st];

    const packLabel = s.packSize
        ? `${s.packSize}-piece pack`
        : 'Pack contents unknown';

    let body = '';

    if (st === 'configured') {
        body = `
            <div class="component-list">
                ${configured.map(r => `
                    <div class="component-row">
                        <strong>${escHtml(r.component_sku)}</strong>
                        <span>×${r.component_qty} · GST ${r.gst_rate}%</span>
                    </div>
                `).join('')}
            </div>`;
    } else if (st === 'ready' || st === 'manual') {
        body = `
            <div class="bundle-card-reason">${escHtml(s.reason)}</div>
            <div class="colorway-picker">
                ${s.candidates.map(c => `
                    <label class="colorway-opt ${sel.has(c.baseName) ? 'selected' : ''}" onclick="toggleColorway('${escAttr(s.title)}', '${escAttr(c.baseName)}')">
                        <span class="cw-check">✓</span>
                        ${escHtml(c.colorway)}
                        <span class="cw-sizes">${c.sizeCount} sizes</span>
                    </label>
                `).join('')}
            </div>
            ${s.packSize && sel.size > 0 && sel.size !== s.packSize ? `<div class="bundle-card-reason" style="color:var(--warn)">Heads-up: pack holds ${s.packSize} piece(s) but you picked ${sel.size}.</div>` : ''}`;
    } else {
        body = `<div class="bundle-card-reason">${escHtml(s.reason)}. Create the single items in Zoho first, then reload.</div>`;
    }

    const actions = st === 'configured'
        ? `<button class="btn btn-sm btn-outline" onclick="editBundle('${escAttr(s.title)}')">Edit</button>
           <span class="bundle-card-action-spacer"></span>
           <button class="btn btn-sm btn-danger" onclick="removeBundle('${escAttr(s.title)}')">Remove</button>`
        : (st === 'ready' || st === 'manual')
            ? `<button class="btn btn-sm btn-primary" onclick="applyBundle('${escAttr(s.title)}')" ${sel.size === 0 ? 'disabled' : ''}>
                   ${configured.length > 0 ? 'Save Changes' : st === 'ready' ? 'Apply — One Click' : 'Apply Selection'}
               </button>
               ${wizardEditing[s.title] || configured.length > 0 ? `<button class="btn btn-sm btn-ghost" onclick="cancelEdit('${escAttr(s.title)}')">Cancel</button>` : ''}`
            : '';

    return `
        <div class="bundle-card ${st === 'configured' ? 'is-configured' : st === 'ready' ? 'is-ready' : ''}">
            <div class="bundle-card-top">
                <div>
                    <div class="bundle-card-title">${escHtml(s.title)}</div>
                    <div class="bundle-card-sub">${packLabel}${s.family ? ` · ${escHtml(s.family)}` : ''}</div>
                </div>
                ${stateChip}
            </div>
            ${body}
            <div class="bundle-card-actions">${actions}</div>
        </div>`;
}

function toggleColorway(title, baseName) {
    const sel = wizardSelections[title] = wizardSelections[title] || new Set();
    if (sel.has(baseName)) sel.delete(baseName);
    else sel.add(baseName);
    renderWizard();
}

function editBundle(title) {
    wizardEditing[title] = true;
    renderWizard();
}

function cancelEdit(title) {
    delete wizardEditing[title];
    // restore selection to saved components
    const configured = wizardData.configured[title] || [];
    wizardSelections[title] = new Set(configured.map(r => r.component_sku));
    renderWizard();
}

async function applyBundle(title) {
    const sel = wizardSelections[title];
    if (!sel || sel.size === 0) {
        toast('Pick at least one colorway first', 'err');
        return;
    }
    const components = [...sel].map(baseName => ({ component_sku: baseName, component_qty: 1 }));
    try {
        const data = await apiFetch('/config/bundles/apply', {
            method: 'POST',
            body: JSON.stringify({ bundle_sku: title, gst_rate: 5.0, components })
        });
        if (data.success) {
            toast(`${title} mapped to ${components.length} piece(s)`, 'ok');
            await loadWizard();
        } else {
            toast(`Error: ${data.error}`, 'err');
        }
    } catch (err) {
        toast('Error: ' + err.message, 'err');
    }
}

async function removeBundle(title) {
    if (!confirm(`Remove the mapping for "${title}"? Bundles sold after this will invoice as a single line until re-mapped.`)) return;
    try {
        const data = await apiFetch(`/config/bundles/by-name/${encodeURIComponent(title)}`, { method: 'DELETE' });
        if (data.success) {
            toast(`Removed mapping for ${title}`, 'ok');
            await loadWizard();
        } else {
            toast(`Error: ${data.error}`, 'err');
        }
    } catch (err) {
        toast('Error: ' + err.message, 'err');
    }
}

async function applyAllReady() {
    if (!wizardData) return;
    const ready = wizardData.suggestions.filter(
        s => s.autoReady && !(wizardData.configured[s.title] || []).length
    );
    if (ready.length === 0) return;
    let ok = 0;
    for (const s of ready) {
        try {
            const data = await apiFetch('/config/bundles/apply', {
                method: 'POST',
                body: JSON.stringify({
                    bundle_sku: s.title,
                    gst_rate: 5.0,
                    components: s.candidates.map(c => ({ component_sku: c.baseName, component_qty: 1 }))
                })
            });
            if (data.success) ok++;
        } catch (err) { /* keep going */ }
    }
    toast(`Applied ${ok} of ${ready.length} ready bundles`, ok > 0 ? 'ok' : 'err');
    await loadWizard();
}

// Advanced: raw row table + manual add

function renderBundleMap(bundles) {
    const tbody = document.getElementById('bundleMapBody');
    if (!bundles || bundles.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>No bundle mappings configured</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = bundles.map(b => `<tr>
        <td><strong>${escHtml(b.bundle_sku)}</strong></td>
        <td>${escHtml(b.component_sku)}</td>
        <td>${b.component_qty}</td>
        <td>${b.gst_rate}%</td>
        <td><button class="btn btn-sm btn-danger" onclick="deleteBundle(${b.id})">Delete</button></td>
    </tr>`).join('');
}

async function addBundleMapping() {
    const bundleSku = document.getElementById('newBundleSku').value.trim();
    const componentSku = document.getElementById('newComponentSku').value.trim();
    const qty = parseInt(document.getElementById('newComponentQty').value) || 1;
    const gstRate = parseFloat(document.getElementById('newGstRate').value) || 5;

    if (!bundleSku || !componentSku) {
        toast('Bundle title and component name are required', 'err');
        return;
    }

    try {
        const data = await apiFetch('/config/bundles', {
            method: 'POST',
            body: JSON.stringify({ bundle_sku: bundleSku, component_sku: componentSku, component_qty: qty, gst_rate: gstRate })
        });

        if (data.success) {
            document.getElementById('newBundleSku').value = '';
            document.getElementById('newComponentSku').value = '';
            document.getElementById('newComponentQty').value = '1';
            document.getElementById('newGstRate').value = '5';
            toast('Mapping row added', 'ok');
            loadWizard();
        } else {
            toast(`Error: ${data.error}`, 'err');
        }
    } catch (err) {
        toast('Error: ' + err.message, 'err');
    }
}

async function deleteBundle(id) {
    if (!confirm('Delete this mapping row?')) return;
    try {
        await apiFetch(`/config/bundles/${id}`, { method: 'DELETE' });
        toast('Row deleted', 'ok');
        loadWizard();
    } catch (err) {
        toast('Delete error: ' + err.message, 'err');
    }
}

async function testConnection() {
    const connEl = document.getElementById('connectionStatus');
    connEl.innerHTML = `<span class="loading-spinner"></span> Testing...`;

    try {
        const data = await apiFetch('/config/test-connection');
        if (data.success) {
            connEl.innerHTML = `<span class="status-dot status-connected"></span> ${escHtml(data.organization || 'Zoho')}`;
            toast('Zoho connection OK', 'ok');
        } else {
            connEl.innerHTML = `<span class="status-dot status-disconnected"></span> ${escHtml(data.error || 'Connection failed')}`;
            toast('Connection failed: ' + (data.error || ''), 'err');
        }
    } catch (err) {
        connEl.innerHTML = `<span class="status-dot status-disconnected"></span> ${escHtml(err.message)}`;
    }
}

// ============================================================
// Transformation Detail Modal
// ============================================================

async function showTransformDetail(logId) {
    try {
        const data = await apiFetch(`/sync?search=${logId}&limit=1`);
        if (!data.success || !data.data || data.data.length === 0) return;

        const row = data.data[0];
        const transform = row.transformation || {};
        const body = document.getElementById('transformModalBody');

        body.innerHTML = `
            <div class="transform-block">
                <h4>Order</h4>
                <pre>Shopify Order: #${escHtml(row.shopify_order_id)}\nZoho Invoice: ${row.zoho_invoice_id || 'Not created'}\nStatus: ${row.status}</pre>
            </div>
            ${transform.bundle_breaks?.length ? `
            <div class="transform-block">
                <h4>Bundle Breaks</h4>
                <pre>${escHtml(JSON.stringify(transform.bundle_breaks, null, 2))}</pre>
            </div>` : ''}
            ${transform.tax_corrections?.length ? `
            <div class="transform-block">
                <h4>Tax Corrections</h4>
                <pre>${escHtml(JSON.stringify(transform.tax_corrections, null, 2))}</pre>
            </div>` : ''}
            ${transform.tax_decision ? `
            <div class="transform-block">
                <h4>Tax Decision</h4>
                <pre>${escHtml(JSON.stringify(transform.tax_decision, null, 2))}</pre>
            </div>` : ''}
            ${row.error_message ? `
            <div class="transform-block">
                <h4>Error</h4>
                <pre style="color:var(--bad)">${escHtml(row.error_message)}</pre>
            </div>` : ''}
        `;

        document.getElementById('transformModal').style.display = 'flex';
    } catch (err) {
        console.error('Transform detail error:', err);
    }
}

function closeModal(id) {
    document.getElementById(id).style.display = 'none';
}

document.getElementById('transformModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('transformModal')) {
        closeModal('transformModal');
    }
});

// ============================================================
// Helpers
// ============================================================

function escHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function escAttr(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function renderPagination(containerId, data, loadFn) {
    const container = document.getElementById(containerId);
    if (!data.totalPages || data.totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    let html = '';
    for (let i = 1; i <= data.totalPages; i++) {
        html += `<button class="${i === data.page ? 'active' : ''}" onclick="loadFnArg(${i})">${i}</button>`;
    }
    container.innerHTML = html;

    window.loadFnArg = loadFn;
}

// ============================================================
// Init
// ============================================================

loadOverview();
