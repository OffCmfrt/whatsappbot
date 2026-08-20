// ============================================================
// ZOHO SYNC DASHBOARD — Frontend Logic
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

        // Load recent sync activity
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
            ${showActions ? `<td>${row.status === 'failed' ? `<button class="btn btn-sm btn-warning" onclick="event.stopPropagation(); retrySync(${row.id})">Retry</button>` : ''}</td>` : ''}
        </tr>`;
    }).join('');
}

async function retrySync(id) {
    try {
        const data = await apiFetch(`/sync/retry/${id}`, { method: 'POST' });
        alert(data.success ? 'Sync retry initiated' : `Retry failed: ${data.error}`);
        loadSyncLog(syncPage);
    } catch (err) {
        alert('Retry error: ' + err.message);
    }
}

async function retryAllFailed() {
    if (!confirm('Retry all failed syncs?')) return;
    try {
        const data = await apiFetch('/sync/retry', { method: 'POST' });
        alert(`Retried ${data.retried} syncs, ${data.succeeded} succeeded`);
        loadSyncLog(syncPage);
    } catch (err) {
        alert('Retry error: ' + err.message);
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

        // Update stats
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
                <td>${row.status === 'failed' ? `<button class="btn btn-sm btn-warning" onclick="retryReturn(${row.id})">Retry</button>` : ''}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Returns load error:', err);
    }
}

async function retryReturn(id) {
    try {
        const data = await apiFetch(`/returns/retry/${id}`, { method: 'POST' });
        alert(data.success ? 'Return retry initiated' : `Retry failed: ${data.error}`);
        loadReturns();
    } catch (err) {
        alert('Retry error: ' + err.message);
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
                <td>${row.payment_status === 'pending' || row.payment_status === 'failed' ? `<button class="btn btn-sm btn-success" onclick="reconcileCod(${row.id})">Reconcile</button>` : ''}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('COD log load error:', err);
    }
}

async function reconcileCod(id) {
    try {
        const data = await apiFetch(`/cod/reconcile/${id}`, { method: 'POST' });
        alert(data.success ? 'COD reconciled successfully' : `Reconciliation failed: ${data.error}`);
        loadCodLog();
    } catch (err) {
        alert('Reconcile error: ' + err.message);
    }
}

// ============================================================
// Configuration
// ============================================================

async function loadConfig() {
    try {
        const [configData, bundlesData, connResult] = await Promise.all([
            apiFetch('/config'),
            apiFetch('/config/bundles'),
            apiFetch('/config/test-connection').catch(() => ({ success: false, error: 'Not configured' }))
        ]);

        // Connection status
        const connEl = document.getElementById('connectionStatus');
        if (connResult.success) {
            const orgName = escHtml(connResult.organization || 'Zoho');
            connEl.innerHTML = `<span class="status-dot status-connected"></span><span>Connected to ${orgName}</span>`;
        } else {
            const errMsg = escHtml(connResult.error || 'Not connected');
            connEl.innerHTML = `<span class="status-dot status-disconnected"></span><span>${errMsg}</span>`;
        }

        // Config info
        if (configData.success) {
            const cfg = configData.config;
            document.getElementById('configInfo').innerHTML = `
                <div><span>Seller State</span><span>${escHtml(cfg.sellerState)}</span></div>
                <div><span>Auto Sync</span><span>${cfg.autoSync ? 'Enabled' : 'Disabled'}</span></div>
                <div><span>Bundle Mappings</span><span>${cfg.bundleMappings}</span></div>
            `;
            document.getElementById('sellerStateDisplay').textContent = cfg.sellerState;
            document.getElementById('booksDomainDisplay').textContent = cfg.booksDomain;

            const toggle = document.getElementById('autoSyncToggle');
            if (cfg.autoSync) toggle.classList.add('active');
            else toggle.classList.remove('active');
            document.getElementById('autoSyncLabel').textContent = cfg.autoSync ? 'Enabled' : 'Disabled';
        }

        // Bundle mappings
        if (bundlesData.success) {
            renderBundleMap(bundlesData.data || []);
        }
    } catch (err) {
        console.error('Config load error:', err);
    }
}

function renderBundleMap(bundles) {
    const tbody = document.getElementById('bundleMapBody');
    if (bundles.length === 0) {
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
        alert('Bundle SKU and Component SKU are required');
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
            loadConfig();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function deleteBundle(id) {
    if (!confirm('Delete this bundle mapping?')) return;
    try {
        await apiFetch(`/config/bundles/${id}`, { method: 'DELETE' });
        loadConfig();
    } catch (err) {
        alert('Delete error: ' + err.message);
    }
}

async function testConnection() {
    const connEl = document.getElementById('connectionStatus');
    connEl.innerHTML = `<span class="loading-spinner"></span><span>Testing...</span>`;

    try {
        const data = await apiFetch('/config/test-connection');
        if (data.success) {
            connEl.innerHTML = `<span class="status-dot status-connected"></span><span>Connected to ${escHtml(data.organization || 'Zoho')}</span>`;
        } else {
            connEl.innerHTML = `<span class="status-dot status-disconnected"></span><span>${escHtml(data.error || 'Connection failed')}</span>`;
        }
    } catch (err) {
        connEl.innerHTML = `<span class="status-dot status-disconnected"></span><span>${escHtml(err.message)}</span>`;
    }
}

function toggleAutoSync() {
    // This is a display-only toggle — actual change requires env var update
    alert('Auto-sync is controlled by the ZOHO_AUTO_SYNC environment variable. Update it in your .env file and restart the server.');
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
                <pre style="color:var(--z-red)">${escHtml(row.error_message)}</pre>
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

// Close modal on overlay click
document.getElementById('transformModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('transformModal')) {
        closeModal('transformModal');
    }
});

// ============================================================
// Helpers
// ============================================================

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
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

    // Store the load function reference
    window.loadFnArg = loadFn;
}

// ============================================================
// Init
// ============================================================

loadOverview();
