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
        const banner = document.getElementById('authAlertBanner');
        if (banner) banner.style.display = 'flex';
        window.parent.postMessage({ type: 'session_expired' }, '*');
        throw new Error('Session expired. Please sign in to the Command Center.');
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
        case 'sync': loadSyncLog(syncLogState.page); break;
        case 'tax': loadTaxCorrections(taxState.page); break;
        case 'returns': loadReturns(returnsState.page); break;
        case 'cod': loadCodLog(codState.page); break;
        case 'config': loadConfig(); break;
    }
}

// ============================================================
// Overview & Sync Activity (State & Logic)
// ============================================================

const overviewSyncState = {
    page: 1,
    limit: 25,
    status: '',
    search: '',
    total: 0,
    totalPages: 1,
    isLoading: false
};

async function loadOverviewStats() {
    try {
        const data = await apiFetch('/stats');
        if (!data || !data.success) {
            console.warn('Stats fetch unsuccessful:', data?.error);
            return null;
        }

        const { sync, returns, cod } = data;
        const total = sync?.today?.total || ((sync?.today?.synced || 0) + (sync?.today?.failed || 0)) || 1;
        const rate = Math.round(((sync?.today?.synced || 0) / total) * 100);

        const elSynced = document.getElementById('statSyncedToday');
        const elRate = document.getElementById('statSuccessRate');
        const elFailed = document.getElementById('statFailed');
        const elPending = document.getElementById('statPendingRetry');
        const elReturns = document.getElementById('statReturnsToday');
        const elCod = document.getElementById('statCodPending');

        if (elSynced) elSynced.textContent = sync?.today?.synced ?? 0;
        if (elRate) elRate.textContent = `${rate}%`;
        if (elFailed) elFailed.textContent = sync?.today?.failed ?? 0;
        if (elPending) elPending.textContent = sync?.today?.pendingRetry ?? 0;
        if (elReturns) elReturns.textContent = (returns?.today?.returns || 0) + (returns?.today?.rtos || 0);
        if (elCod) elCod.textContent = cod?.pending ?? 0;

        return data;
    } catch (err) {
        console.warn('Overview stats error:', err.message);
        return null;
    }
}

async function loadOverviewSync(page = overviewSyncState.page) {
    overviewSyncState.page = Math.max(1, parseInt(page, 10) || 1);

    const searchInput = document.getElementById('overviewSyncSearch');
    const statusSelect = document.getElementById('overviewStatusFilter');
    const limitSelect = document.getElementById('overviewLimitSelect');

    if (searchInput) overviewSyncState.search = searchInput.value.trim();
    if (statusSelect) overviewSyncState.status = statusSelect.value;
    if (limitSelect) overviewSyncState.limit = parseInt(limitSelect.value, 10) || 25;

    const tbody = document.getElementById('recentSyncBody');
    if (tbody && (!tbody.children.length || tbody.querySelector('.empty-state'))) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="loading-spinner"></span><p style="margin-top:8px">Loading sync activity...</p></div></td></tr>`;
    }

    try {
        const query = new URLSearchParams({
            page: String(overviewSyncState.page),
            limit: String(overviewSyncState.limit)
        });
        if (overviewSyncState.status) query.set('status', overviewSyncState.status);
        if (overviewSyncState.search) query.set('search', overviewSyncState.search);

        const data = await apiFetch(`/sync?${query.toString()}`);
        if (!data || !data.success) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p style="color:var(--bad)">Failed to load sync activity: ${escHtml(data?.error || 'Server error')}</p></div></td></tr>`;
            return data;
        }

        overviewSyncState.total = data.total || 0;
        overviewSyncState.totalPages = data.totalPages || 1;

        const countPill = document.getElementById('overviewSyncCount');
        if (countPill) countPill.textContent = data.total ? data.total.toLocaleString('en-IN') : '0';

        renderSyncRows(data.data || [], 'recentSyncBody', true);
        renderPaginationBar('overviewPaginationButtons', 'overviewPaginationInfo', data, 'overview-page');
        return data;
    } catch (err) {
        console.error('Overview sync error:', err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p style="color:var(--bad)">Error: ${escHtml(err.message)}</p></div></td></tr>`;
    }
}

async function loadOverview(userInitiated = false) {
    const btn = document.getElementById('btnRefreshOverview');
    const textEl = document.getElementById('refreshBtnText');

    if (btn) {
        btn.classList.add('is-refreshing');
        if (textEl) textEl.textContent = 'Refreshing...';
    }

    try {
        const [statsRes, syncRes] = await Promise.allSettled([
            loadOverviewStats(),
            loadOverviewSync(userInitiated ? 1 : overviewSyncState.page)
        ]);

        if (userInitiated) {
            const syncData = syncRes.status === 'fulfilled' ? syncRes.value : null;
            const count = syncData?.total !== undefined ? syncData.total : overviewSyncState.total;
            toast(`Sync activity refreshed (${count} records)`, 'ok');
        }
    } catch (err) {
        console.error('loadOverview error:', err);
        if (userInitiated) toast('Refresh error: ' + err.message, 'err');
    } finally {
        if (btn) {
            btn.classList.remove('is-refreshing');
            if (textEl) textEl.textContent = 'Refresh';
        }
    }
}

// ============================================================
// Sync Log (Dedicated Tab)
// ============================================================

const syncLogState = {
    page: 1,
    limit: 25,
    status: '',
    search: '',
    totalPages: 1
};

async function loadSyncLog(page = 1, userInitiated = false) {
    syncLogState.page = Math.max(1, parseInt(page, 10) || 1);
    syncLogState.limit = parseInt(document.getElementById('syncLimitSelect')?.value || '25', 10);
    syncLogState.status = document.getElementById('syncStatusFilter')?.value || '';
    syncLogState.search = document.getElementById('syncSearch')?.value.trim() || '';

    const btn = document.getElementById('btnRefreshSync');
    if (userInitiated && btn) btn.classList.add('is-refreshing');

    try {
        const query = new URLSearchParams({
            page: syncLogState.page,
            limit: syncLogState.limit,
            status: syncLogState.status,
            search: syncLogState.search
        });
        const data = await apiFetch(`/sync?${query.toString()}`);
        if (!data || !data.success) return;

        syncLogState.totalPages = data.totalPages || 1;
        const countBadge = document.getElementById('syncCount');
        if (countBadge) countBadge.textContent = (data.total || 0).toLocaleString('en-IN');

        renderSyncRows(data.data || [], 'syncLogBody', true);
        renderPaginationBar('syncPaginationButtons', 'syncPaginationInfo', data, 'sync-page');

        if (userInitiated) {
            toast(`Order sync log refreshed (${(data.total || 0).toLocaleString('en-IN')} total)`, 'ok');
        }
    } catch (err) {
        console.error('Sync log load error:', err);
        if (userInitiated) toast('Failed to load sync log: ' + err.message, 'err');
    } finally {
        if (btn) btn.classList.remove('is-refreshing');
    }
}

function renderSyncRows(rows, tbodyId, showActions) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${showActions ? 7 : 4}"><div class="empty-state"><p>No sync records found</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(row => {
        const transform = row.transformation || {};
        const bundlesCount = transform.bundle_breaks?.length || 0;
        const taxCount = transform.tax_corrections?.length || 0;
        const hasTransforms = (bundlesCount + taxCount) > 0;
        const time = new Date(row.created_at).toLocaleString('en-IN', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });

        let transformHtml = '<span style="color:var(--text-faint)">None</span>';
        if (hasTransforms) {
            const tags = [];
            if (bundlesCount > 0) tags.push(`<span class="pill-tag">${bundlesCount} bundle${bundlesCount > 1 ? 's' : ''}</span>`);
            if (taxCount > 0) tags.push(`<span class="pill-tag">${taxCount} tax fix</span>`);
            transformHtml = tags.join('');
        }

        const isFailed = row.status === 'failed';
        const errorMsg = row.error_message || '';
        const errorShort = errorMsg.length > 42 ? errorMsg.substring(0, 42) + '...' : errorMsg;

        return `<tr class="clickable-row" data-action="show-transform" data-id="${row.id}">
            <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
            <td>${row.zoho_invoice_id ? `<span style="font-family:monospace">${escHtml(row.zoho_invoice_id)}</span>` : '<span style="color:var(--text-faint)">—</span>'}</td>
            <td><span class="badge badge-${row.status}">${row.status}</span></td>
            ${showActions ? `<td>${transformHtml}</td>` : ''}
            ${showActions ? `<td class="truncate" title="${escHtml(errorMsg)}" style="${isFailed ? 'color:var(--bad);font-size:12px' : ''}">${errorMsg ? escHtml(errorShort) : '<span style="color:var(--text-faint)">—</span>'}</td>` : ''}
            <td style="white-space:nowrap">${time}</td>
            ${showActions ? `<td>
                ${isFailed ? `<button class="btn btn-xs btn-outline" style="border-color:var(--bad);color:var(--bad);margin-right:4px" data-action="retry-sync" data-id="${row.id}">Retry</button>` : ''}
                <button class="btn btn-xs btn-ghost" data-action="show-transform" data-id="${row.id}">View</button>
            </td>` : ''}
        </tr>`;
    }).join('');
}

async function retrySync(id) {
    try {
        const data = await apiFetch(`/sync/retry/${id}`, { method: 'POST' });
        toast(data.success ? 'Sync retry initiated' : `Retry failed: ${data.error}`, data.success ? 'ok' : 'err');
        loadOverviewSync(overviewSyncState.page);
        loadSyncLog(syncLogState.page);
        loadOverviewStats();
    } catch (err) {
        toast('Retry error: ' + err.message, 'err');
    }
}

async function retryAllFailed() {
    if (!confirm('Retry all failed syncs?')) return;
    try {
        const data = await apiFetch('/sync/retry', { method: 'POST' });
        toast(`Retried ${data.retried} syncs — ${data.succeeded} succeeded`, 'ok');
        loadOverviewSync(1);
        loadSyncLog(1);
        loadOverviewStats();
    } catch (err) {
        toast('Retry error: ' + err.message, 'err');
    }
}

// ============================================================
// Tax Corrections
// ============================================================

const taxState = {
    page: 1,
    limit: 25,
    type: '',
    search: '',
    totalPages: 1
};

async function loadTaxCorrections(page = 1, userInitiated = false) {
    taxState.page = Math.max(1, parseInt(page, 10) || 1);
    taxState.limit = parseInt(document.getElementById('taxLimitSelect')?.value || '25', 10);
    taxState.type = document.getElementById('taxTypeFilter')?.value || '';
    taxState.search = document.getElementById('taxSearch')?.value.trim() || '';

    const btn = document.getElementById('btnRefreshTax');
    if (userInitiated && btn) btn.classList.add('is-refreshing');

    try {
        const query = new URLSearchParams({
            page: taxState.page,
            limit: taxState.limit,
            type: taxState.type,
            search: taxState.search
        });
        const data = await apiFetch(`/tax-corrections?${query.toString()}`);
        if (!data || !data.success) return;

        taxState.totalPages = data.totalPages || 1;
        const countBadge = document.getElementById('taxCount');
        if (countBadge) countBadge.textContent = (data.total || 0).toLocaleString('en-IN');

        const stats = data.stats || {};
        if (stats.today !== undefined) document.getElementById('statTaxCorrected').textContent = stats.today;
        if (stats.rateFixes !== undefined) document.getElementById('statRateFixes').textContent = stats.rateFixes;
        if (stats.stateFixes !== undefined) document.getElementById('statStateFixes').textContent = stats.stateFixes;

        const tbody = document.getElementById('taxCorrectionsBody');
        const rows = data.data || [];

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>No tax corrections found</p></div></td></tr>`;
        } else {
            tbody.innerHTML = rows.map(row => {
                const time = new Date(row.created_at).toLocaleString('en-IN', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });
                const origTax = row.original_tax ? JSON.stringify(row.original_tax).substring(0, 60) : '—';
                const corrTax = row.corrected_tax ? JSON.stringify(row.corrected_tax).substring(0, 60) : '—';

                return `<tr>
                    <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
                    <td><span class="badge badge-${row.correction_type === 'rate_fix' ? 'return' : 'exchange'}">${row.correction_type || '—'}</span></td>
                    <td class="truncate" title="${escHtml(origTax)}">${escHtml(origTax)}</td>
                    <td class="truncate" title="${escHtml(corrTax)}">${escHtml(corrTax)}</td>
                    <td style="white-space:nowrap">${time}</td>
                </tr>`;
            }).join('');
        }

        renderPaginationBar('taxPaginationButtons', 'taxPaginationInfo', data, 'tax-page');

        if (userInitiated) {
            toast(`Tax corrections refreshed (${(data.total || 0).toLocaleString('en-IN')} total)`, 'ok');
        }
    } catch (err) {
        console.error('Tax corrections load error:', err);
        if (userInitiated) toast('Failed to load tax corrections: ' + err.message, 'err');
    } finally {
        if (btn) btn.classList.remove('is-refreshing');
    }
}

// ============================================================
// Returns & RTO
// ============================================================

const returnsState = {
    page: 1,
    limit: 25,
    type: '',
    status: '',
    search: '',
    totalPages: 1
};

async function loadReturns(page = 1, userInitiated = false) {
    returnsState.page = Math.max(1, parseInt(page, 10) || 1);
    returnsState.limit = parseInt(document.getElementById('returnLimitSelect')?.value || '25', 10);
    returnsState.type = document.getElementById('returnTypeFilter')?.value || '';
    returnsState.status = document.getElementById('returnStatusFilter')?.value || '';
    returnsState.search = document.getElementById('returnSearch')?.value.trim() || '';

    const btn = document.getElementById('btnRefreshReturns');
    if (userInitiated && btn) btn.classList.add('is-refreshing');

    try {
        const query = new URLSearchParams({
            page: returnsState.page,
            limit: returnsState.limit,
            returnType: returnsState.type,
            status: returnsState.status,
            search: returnsState.search
        });

        const [statsResult, logResult] = await Promise.allSettled([
            apiFetch('/stats'),
            apiFetch(`/returns?${query.toString()}`)
        ]);

        if (statsResult.status === 'fulfilled' && statsResult.value && statsResult.value.success) {
            const retStats = statsResult.value.returns || {};
            document.getElementById('statReturns').textContent = retStats.today?.returns || 0;
            document.getElementById('statRTOs').textContent = retStats.today?.rtos || 0;
            document.getElementById('statCreditNotes').textContent = retStats.creditNotesCreated || 0;
            document.getElementById('statFailedReturns').textContent = retStats.failedReturns || 0;
        }

        if (logResult.status === 'fulfilled' && logResult.value && logResult.value.success) {
            const logData = logResult.value;
            returnsState.totalPages = logData.totalPages || 1;
            const countBadge = document.getElementById('returnsCount');
            if (countBadge) countBadge.textContent = (logData.total || 0).toLocaleString('en-IN');

            const tbody = document.getElementById('returnsBody');
            const rows = logData.data || [];

            if (rows.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No returns/RTOs found</p></div></td></tr>`;
            } else {
                tbody.innerHTML = rows.map(row => {
                    const time = new Date(row.created_at).toLocaleString('en-IN', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true
                    });
                    const items = row.original_items ? JSON.stringify(row.original_items).substring(0, 50) : '—';

                    return `<tr>
                        <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
                        <td><span class="badge badge-${row.return_type}">${row.return_type}</span></td>
                        <td>${row.zoho_credit_note_id ? escHtml(row.zoho_credit_note_id) : '<span style="color:var(--text-faint)">—</span>'}</td>
                        <td class="truncate" title="${escHtml(items)}">${escHtml(items)}</td>
                        <td><span class="badge badge-${row.status}">${row.status}</span></td>
                        <td style="white-space:nowrap">${time}</td>
                        <td>${row.status === 'failed' ? `<button class="btn btn-xs btn-outline" style="border-color:var(--bad);color:var(--bad)" data-action="retry-return" data-id="${row.id}">Retry</button>` : ''}</td>
                    </tr>`;
                }).join('');
            }

            renderPaginationBar('returnsPaginationButtons', 'returnsPaginationInfo', logData, 'returns-page');
            if (userInitiated) {
                toast(`Returns & RTO refreshed (${(logData.total || 0).toLocaleString('en-IN')} records)`, 'ok');
            }
        }
    } catch (err) {
        console.error('Returns load error:', err);
        if (userInitiated) toast('Failed to load returns: ' + err.message, 'err');
    } finally {
        if (btn) btn.classList.remove('is-refreshing');
    }
}

async function retryReturn(id) {
    try {
        const data = await apiFetch(`/returns/retry/${id}`, { method: 'POST' });
        toast(data.success ? 'Return retry initiated' : `Retry failed: ${data.error}`, data.success ? 'ok' : 'err');
        loadReturns(returnsState.page);
    } catch (err) {
        toast('Retry error: ' + err.message, 'err');
    }
}

// ============================================================
// COD Payments
// ============================================================

const codState = {
    page: 1,
    limit: 25,
    status: '',
    search: '',
    totalPages: 1
};

async function loadCodLog(page = 1, userInitiated = false) {
    codState.page = Math.max(1, parseInt(page, 10) || 1);
    codState.limit = parseInt(document.getElementById('codLimitSelect')?.value || '25', 10);
    codState.status = document.getElementById('codStatusFilter')?.value || '';
    codState.search = document.getElementById('codSearch')?.value.trim() || '';

    const btn = document.getElementById('btnRefreshCod');
    if (userInitiated && btn) btn.classList.add('is-refreshing');

    try {
        const query = new URLSearchParams({
            page: codState.page,
            limit: codState.limit,
            status: codState.status,
            search: codState.search
        });

        const [statsResult, logResult] = await Promise.allSettled([
            apiFetch('/stats'),
            apiFetch(`/cod?${query.toString()}`)
        ]);

        if (statsResult.status === 'fulfilled' && statsResult.value && statsResult.value.success) {
            const codStats = statsResult.value.cod || {};
            document.getElementById('statCodPending').textContent = codStats.pending || 0;
            document.getElementById('statCodReconciled').textContent = codStats.reconciledToday?.count || 0;
            document.getElementById('statCodAmount').textContent = `₹${(codStats.reconciledToday?.amount || 0).toLocaleString('en-IN')}`;
        }

        if (logResult.status === 'fulfilled' && logResult.value && logResult.value.success) {
            const logData = logResult.value;
            codState.totalPages = logData.totalPages || 1;
            const countBadge = document.getElementById('codCount');
            if (countBadge) countBadge.textContent = (logData.total || 0).toLocaleString('en-IN');

            const tbody = document.getElementById('codBody');
            const rows = logData.data || [];

            if (rows.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>No COD payments found</p></div></td></tr>`;
            } else {
                tbody.innerHTML = rows.map(row => {
                    const time = row.reconciled_at ? new Date(row.reconciled_at).toLocaleString('en-IN', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true
                    }) : '<span style="color:var(--text-faint)">—</span>';

                    return `<tr>
                        <td><strong>#${escHtml(row.shopify_order_id)}</strong></td>
                        <td>${row.awb || '<span style="color:var(--text-faint)">—</span>'}</td>
                        <td>${escHtml(row.carrier || '—')}</td>
                        <td>₹${parseFloat(row.amount || 0).toLocaleString('en-IN')}</td>
                        <td><span class="badge badge-${row.payment_status === 'reconciled' ? 'reconciled' : row.payment_status}">${row.payment_status}</span></td>
                        <td style="white-space:nowrap">${time}</td>
                        <td>${row.payment_status === 'pending' || row.payment_status === 'failed' ? `<button class="btn btn-xs btn-primary" data-action="reconcile-cod" data-id="${row.id}">Reconcile</button>` : ''}</td>
                    </tr>`;
                }).join('');
            }

            renderPaginationBar('codPaginationButtons', 'codPaginationInfo', logData, 'cod-page');
            if (userInitiated) {
                toast(`COD payments refreshed (${(logData.total || 0).toLocaleString('en-IN')} records)`, 'ok');
            }
        }
    } catch (err) {
        console.error('COD log load error:', err);
        if (userInitiated) toast('Failed to load COD log: ' + err.message, 'err');
    } finally {
        if (btn) btn.classList.remove('is-refreshing');
    }
}

async function reconcileCod(id) {
    try {
        const data = await apiFetch(`/cod/reconcile/${id}`, { method: 'POST' });
        toast(data.success ? 'COD reconciled successfully' : `Reconciliation failed: ${data.error}`, data.success ? 'ok' : 'err');
        loadCodLog(codState.page);
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
                    <label class="colorway-opt ${sel.has(c.baseName) ? 'selected' : ''}" data-action="toggle-colorway" data-title="${escAttr(s.title)}" data-base="${escAttr(c.baseName)}">
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
        ? `<button class="btn btn-sm btn-outline" data-action="edit-bundle" data-title="${escAttr(s.title)}">Edit</button>
           <span class="bundle-card-action-spacer"></span>
           <button class="btn btn-sm btn-danger" data-action="remove-bundle" data-title="${escAttr(s.title)}">Remove</button>`
        : (st === 'ready' || st === 'manual')
            ? `<button class="btn btn-sm btn-primary" data-action="apply-bundle" data-title="${escAttr(s.title)}" ${sel.size === 0 ? 'disabled' : ''}>
                   ${configured.length > 0 ? 'Save Changes' : st === 'ready' ? 'Apply — One Click' : 'Apply Selection'}
               </button>
               ${wizardEditing[s.title] || configured.length > 0 ? `<button class="btn btn-sm btn-ghost" data-action="cancel-edit" data-title="${escAttr(s.title)}">Cancel</button>` : ''}`
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
        <td><button class="btn btn-sm btn-danger" data-action="delete-bundle" data-id="${b.id}">Delete</button></td>
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// Delegated click handling (CSP blocks inline event handlers)
// ============================================================

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = parseInt(el.dataset.id || '0', 10);
    const title = el.dataset.title || '';
    switch (el.dataset.action) {
        // Overview actions
        case 'refresh-overview': loadOverview(true); break;
        case 'overview-page': {
            const p = parseInt(el.dataset.page, 10);
            if (!isNaN(p) && p >= 1 && p <= overviewSyncState.totalPages) {
                loadOverviewSync(p);
            }
            break;
        }

        // Dedicated Order Sync actions
        case 'refresh-sync': loadSyncLog(syncLogState.page, true); break;
        case 'sync-page': {
            const p = parseInt(el.dataset.page, 10);
            if (!isNaN(p) && p >= 1 && p <= syncLogState.totalPages) {
                loadSyncLog(p);
            }
            break;
        }
        case 'search-sync': loadSyncLog(1); break;
        case 'retry-all-failed': retryAllFailed(); break;

        // Tax Corrections actions
        case 'refresh-tax': loadTaxCorrections(taxState.page, true); break;
        case 'tax-page': {
            const p = parseInt(el.dataset.page, 10);
            if (!isNaN(p) && p >= 1 && p <= taxState.totalPages) {
                loadTaxCorrections(p);
            }
            break;
        }
        case 'filter-tax': loadTaxCorrections(1); break;

        // Returns & RTO actions
        case 'refresh-returns': loadReturns(returnsState.page, true); break;
        case 'returns-page': {
            const p = parseInt(el.dataset.page, 10);
            if (!isNaN(p) && p >= 1 && p <= returnsState.totalPages) {
                loadReturns(p);
            }
            break;
        }
        case 'filter-returns': loadReturns(1); break;
        case 'retry-return': retryReturn(id); break;

        // COD Payments actions
        case 'refresh-cod': loadCodLog(codState.page, true); break;
        case 'cod-page': {
            const p = parseInt(el.dataset.page, 10);
            if (!isNaN(p) && p >= 1 && p <= codState.totalPages) {
                loadCodLog(p);
            }
            break;
        }
        case 'search-cod': loadCodLog(1); break;
        case 'reconcile-cod': reconcileCod(id); break;

        // Bundle & Config actions
        case 'test-connection': testConnection(); break;
        case 'apply-all-ready': applyAllReady(); break;
        case 'wizard-filter': filterWizard(el.dataset.filter); break;
        case 'add-bundle-row': addBundleMapping(); break;
        case 'close-modal': closeModal(el.dataset.modal); break;
        case 'show-transform': showTransformDetail(id); break;
        case 'retry-sync': {
            e.stopPropagation();
            retrySync(id);
            break;
        }
        case 'toggle-colorway': toggleColorway(title, el.dataset.base); break;
        case 'edit-bundle': editBundle(title); break;
        case 'remove-bundle': removeBundle(title); break;
        case 'apply-bundle': applyBundle(title); break;
        case 'cancel-edit': cancelEdit(title); break;
        case 'delete-bundle': deleteBundle(id); break;
        case 'page': {
            const p = parseInt(el.dataset.page, 10);
            if (!isNaN(p)) loadSyncLog(p);
            break;
        }
    }
});

function renderPaginationBar(controlsId, infoId, data, actionName = 'page') {
    const controls = document.getElementById(controlsId);
    const info = infoId ? document.getElementById(infoId) : null;
    const page = data.page || 1;
    const limit = data.limit || 25;
    const total = data.total || 0;
    const totalPages = data.totalPages || (total > 0 ? Math.ceil(total / limit) : 1);

    if (info) {
        if (total === 0) {
            info.innerHTML = 'Showing <strong>0</strong> records';
        } else {
            const start = ((page - 1) * limit) + 1;
            const end = Math.min(page * limit, total);
            info.innerHTML = `Showing <strong>${start}–${end}</strong> of <strong>${total.toLocaleString('en-IN')}</strong> records (Page ${page} of ${totalPages})`;
        }
    }

    if (!controls) return;
    if (totalPages <= 1) {
        controls.innerHTML = '';
        return;
    }

    const pages = [];
    const delta = 2;
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= page - delta && i <= page + delta)) {
            pages.push(i);
        } else if (pages[pages.length - 1] !== '...') {
            pages.push('...');
        }
    }

    let html = '';
    html += `<button data-action="${actionName}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} title="Previous page">&lsaquo; Prev</button>`;

    for (const p of pages) {
        if (p === '...') {
            html += `<span style="color:var(--text-faint);padding:0 3px">&hellip;</span>`;
        } else {
            html += `<button class="${p === page ? 'active' : ''}" data-action="${actionName}" data-page="${p}">${p}</button>`;
        }
    }

    html += `<button data-action="${actionName}" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''} title="Next page">Next &rsaquo;</button>`;

    controls.innerHTML = html;
}

// Legacy pagination helper alias (keeps existing tabs working)
function renderPagination(containerId, data, loadFn) {
    renderPaginationBar(containerId, null, data, 'page');
}

// ============================================================
// Init & Filter Listeners (Clean, Memory-Smart, Debounced)
// ============================================================

function setupDebouncedInput(inputId, onTrigger) {
    const input = document.getElementById(inputId);
    if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(onTrigger, 280);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(timer);
            onTrigger();
        }
    });
}

function setupSelectChange(selectId, onTrigger) {
    const el = document.getElementById(selectId);
    if (el) el.addEventListener('change', onTrigger);
}

// Overview listeners
setupDebouncedInput('overviewSyncSearch', () => loadOverviewSync(1));
setupSelectChange('overviewStatusFilter', () => loadOverviewSync(1));
setupSelectChange('overviewLimitSelect', () => loadOverviewSync(1));

// Order Sync tab listeners
setupDebouncedInput('syncSearch', () => loadSyncLog(1));
setupSelectChange('syncStatusFilter', () => loadSyncLog(1));
setupSelectChange('syncLimitSelect', () => loadSyncLog(1));

// Tax Corrections tab listeners
setupDebouncedInput('taxSearch', () => loadTaxCorrections(1));
setupSelectChange('taxTypeFilter', () => loadTaxCorrections(1));
setupSelectChange('taxLimitSelect', () => loadTaxCorrections(1));

// Returns & RTO tab listeners
setupDebouncedInput('returnSearch', () => loadReturns(1));
setupSelectChange('returnTypeFilter', () => loadReturns(1));
setupSelectChange('returnStatusFilter', () => loadReturns(1));
setupSelectChange('returnLimitSelect', () => loadReturns(1));

// COD Payments tab listeners
setupDebouncedInput('codSearch', () => loadCodLog(1));
setupSelectChange('codStatusFilter', () => loadCodLog(1));
setupSelectChange('codLimitSelect', () => loadCodLog(1));

// Initial load
loadOverview(false);
