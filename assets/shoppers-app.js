// ==========================================
// OFFCOMFRT - Premium Shopper Hub Logic v2
// With Live Chat, Customer Messages & Analytics
// ==========================================

const API_BASE = 'https://whatsappbot-4l4b.onrender.com/api/admin';
console.log('🚀 Shopper Hub App Loaded - Ver: 1712700000');

// Check for cross-domain token in URL
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
if (tokenFromUrl) {
    localStorage.setItem('authToken', tokenFromUrl);
    window.history.replaceState({}, document.title, window.location.pathname);
}

const authToken = localStorage.getItem('authToken');

// ============================================================
// SMART LOGIN — identity & permissions
// Identity is decoded from the JWT; admins have every permission,
// operators only what the admin granted in Team & Permissions.
// ============================================================
function decodeJwtPayload(token) {
    try {
        const part = token.split('.')[1];
        return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) { return null; }
}

function getHubIdentity() {
    const cached = localStorage.getItem('hubIdentity');
    if (cached) { try { return JSON.parse(cached); } catch (e) { /* fall through */ } }
    const payload = decodeJwtPayload(authToken || localStorage.getItem('authToken') || '');
    if (!payload) return { role: 'admin', username: 'admin', permissions: [] };
    const identity = {
        role: payload.role || 'admin',
        username: payload.username || 'operator',
        name: payload.name || payload.username || 'operator',
        permissions: Array.isArray(payload.permissions) ? payload.permissions : []
    };
    localStorage.setItem('hubIdentity', JSON.stringify(identity));
    return identity;
}

const HUB_ALL_PERMS = ['shoppers', 'inbox', 'follow_up', 'multi_orders', 'shipped', 'analytics', 'export', 'edit_orders', 'send_messages', 'ship_orders', 'ai_copilot'];

function hubHasPerm(key) {
    const identity = getHubIdentity();
    if (identity.role === 'admin') return true;
    return (identity.permissions || []).includes(key);
}

function hubRequirePerm(key, label) {
    if (hubHasPerm(key)) return true;
    alert(`You don't have permission to ${label || 'perform this action'}. Contact the admin.`);
    return false;
}

// Hide UI entry points the operator is not allowed to use (backend enforces too)
function applyRolePermissions() {
    const identity = getHubIdentity();
    const isAdmin = identity.role === 'admin';

    // User badge in the nav bar
    const badge = document.getElementById('hubUserBadge');
    if (badge) {
        badge.textContent = `${isAdmin ? '👑 Admin' : '👤 ' + (identity.name || identity.username)}`;
        badge.style.display = 'inline-block';
    }

    // Nav buttons ↔ page permissions
    const navPermMap = {
        inboxBtn: 'inbox',
        followUpBtn: 'follow_up',
        multiOrdersBtn: 'multi_orders',
        shippedOrdersBtn: 'shipped',
        analyticsBtn: 'analytics',
        exportBtn: 'export'
    };
    Object.entries(navPermMap).forEach(([id, perm]) => {
        const el = document.getElementById(id);
        if (el && !hubHasPerm(perm)) el.style.display = 'none';
    });

    // Team button — master admin only
    const teamBtn = document.getElementById('teamBtn');
    if (teamBtn) teamBtn.style.display = isAdmin ? 'inline-flex' : 'none';

    // Logout — clears the session for both admin and operator accounts
    const logoutBtn = document.getElementById('hubLogoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (!confirm('Log out of Shoppers Hub?')) return;
            localStorage.removeItem('authToken');
            localStorage.removeItem('hubIdentity');
            window.location.reload();
        });
    }

    // CSS-level hiding of row/bulk actions the operator can't perform
    let css = '';
    if (!hubHasPerm('edit_orders')) {
        css += `.btn-text-edit, button[onclick^="openEditModal"], button[onclick^="bulkUpdateStatus"], #bulkDeleteBtn, .bulk-btn-delete, button[onclick^="openShopifyCancelModal"] { display: none !important; }`;
    }
    if (!hubHasPerm('send_messages')) {
        css += `#sendChatBtn, .btn-chat[onclick^="openChat"] { display: none !important; }`;
    }
    if (!hubHasPerm('ship_orders')) {
        css += `button[onclick^="openShipModal"], button[onclick^="openBulkShipModal"] { display: none !important; }`;
    }
    if (css) {
        let styleEl = document.getElementById('permHideStyles');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'permHideStyles';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
    }
}

// Pagination & State
let currentStatus = 'all';
let currentPageOffset = 0;
const limitPerPage = 50;
let searchTimeout = null;
let filterTimeout = null;
let currentChatPhone = null;
let analyticsData = null;
let currentQuickDateFilter = null;
let currentOrderIdFrom = '';
let currentOrderIdTo = '';
let currentPaymentMethod = '';
let currentDeliveryType = '';
let currentSortBy = 'newest';
let currentViewMode = localStorage.getItem('shopperViewMode') || 'rows';

// Full shopper rows by id — lets the edit modal read city/province/zip
// without threading more params through every onclick handler
const shopperEditCache = {};

// Bulk Selection State
let selectedShoppers = new Set();
let isBulkMode = false;
let allMatchingShoppers = []; // Store all shoppers matching current filters
let currentTotalCount = 0;

// Multi Orders Filter State
let moStatus = 'all';
let moSortBy = 'newest';
let moSearchQuery = '';
let moStartDate = '';
let moEndDate = '';
let moMinOrders = 2;
let moQuickDate = null;
let moAllGroups = []; // Store raw groups for client-side collapse/expand
let moSearchTimeout = null;

// Shipped Orders Filter State
let soStatus = '';
let soCarrier = '';
let soPayment = '';
let soSearchQuery = '';
let soLookupTimeout = null; // debounce for the New Shipment order lookup
let soStartDate = '';
let soEndDate = '';
let soQuickDate = null;
let soOffset = 0;
let soTotal = 0;
const SO_PAGE_SIZE = 25;
let soSearchTimeout = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    try {
        console.log('🔄 DOM Content Loaded - Initializing Dashboard...');
        if (!authToken) {
            console.log('ℹ️ No authToken found, showing login.');
            document.getElementById('loginView').style.display = 'flex';
            document.getElementById('dashboardView').style.display = 'none';
            // Explicitly hide all data overlay views (security: prevent pre-login data exposure)
            document.getElementById('inboxView').style.display = 'none';
            document.getElementById('analyticsView').style.display = 'none';
            document.getElementById('multiOrdersView').style.display = 'none';
            document.getElementById('followUpView').style.display = 'none';
            const soView = document.getElementById('shippedOrdersView');
            if (soView) soView.style.display = 'none';
            const teamViewEl = document.getElementById('teamView');
            if (teamViewEl) teamViewEl.style.display = 'none';
            setupLoginEvents();
            return;
        }

        document.getElementById('loginView').style.display = 'none';
        document.getElementById('dashboardView').style.display = 'block';
        applyRolePermissions();
        setupEventListeners();
        setupModalEvents();
        setupChatEvents();
        // Smart login: only load data for pages this identity may access
        if (hubHasPerm('shoppers')) fetchShoppersData();
        if (hubHasPerm('analytics')) fetchAnalytics();
        if (hubHasPerm('inbox')) fetchInboxCounts();
        console.log('✅ Dashboard Initialized Successfully');
    } catch (e) {
        console.error('❌ Dashboard Init Failed:', e);
    }
});

function setupLoginEvents() {
    const form = document.getElementById('shopperLoginForm');
    if (!form) return;
    
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('hubPassword');
        const usernameInput = document.getElementById('hubUsername');
        const btn = document.querySelector('#shopperLoginForm .btn-primary span');
        const err = document.getElementById('errorMessage');
        
        btn.textContent = "VERIFYING...";
        err.style.display = 'none';
        
        try {
            // Smart login: Operator ID + password, or blank ID + master access code
            localStorage.removeItem('hubIdentity'); // never carry a stale identity
            const res = await fetch('https://whatsappbot-4l4b.onrender.com/api/internal/shoppers/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: usernameInput ? usernameInput.value.trim() : '',
                    password: input.value
                })
            });
            const data = await res.json();
            
            if (data.success) {
                localStorage.setItem('authToken', data.token);
                // Cache identity so the UI can apply permissions instantly
                const identity = data.role === 'operator'
                    ? { role: 'operator', username: data.username, name: data.name, permissions: data.permissions || [] }
                    : { role: 'admin', username: data.username || 'admin', name: 'Admin', permissions: HUB_ALL_PERMS };
                localStorage.setItem('hubIdentity', JSON.stringify(identity));
                window.location.reload();
            } else {
                throw new Error(data.error || 'Invalid credentials');
            }
        } catch (error) {
            btn.textContent = "AUTHENTICATE";
            err.textContent = error.message;
            err.style.display = 'block';
        }
    });
}

// Debounced filter fetch to prevent rate limiting
function debouncedFetchShoppers() {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => {
        fetchShoppersData();
    }, 300);
}

function setupEventListeners() {
    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            currentStatus = e.target.dataset.filter;
            currentPageOffset = 0;
            allLoadedShoppers = [];
            updateClearFiltersButton();
            debouncedFetchShoppers();
        });
    });

    // Search
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                currentPageOffset = 0;
                allLoadedShoppers = [];
                updateClearFiltersButton();
                fetchShoppersData();
            }, 500);
        });
    }

    // Dates
    document.getElementById('startDate')?.addEventListener('change', () => { 
        currentPageOffset = 0; 
        allLoadedShoppers = [];
        clearQuickDateFilter();
        updateClearFiltersButton();
        debouncedFetchShoppers(); 
    });
    document.getElementById('endDate')?.addEventListener('change', () => { 
        currentPageOffset = 0; 
        allLoadedShoppers = [];
        clearQuickDateFilter();
        updateClearFiltersButton();
        debouncedFetchShoppers(); 
    });

    // Quick Date Filters
    document.querySelectorAll('.quick-date-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const range = e.target.dataset.range;
            applyQuickDateFilter(range);
        });
    });

    // Order ID Range Filter
    document.getElementById('applyOrderIdFilter')?.addEventListener('click', () => {
        currentOrderIdFrom = document.getElementById('orderIdFrom')?.value || '';
        currentOrderIdTo = document.getElementById('orderIdTo')?.value || '';
        currentPageOffset = 0;
        allLoadedShoppers = [];
        updateClearFiltersButton();
        fetchShoppersData();
    });
    
    // Payment Method Filter
    document.getElementById('paymentMethodFilter')?.addEventListener('change', (e) => {
        currentPaymentMethod = e.target.value;
        currentPageOffset = 0;
        allLoadedShoppers = [];
        updateClearFiltersButton();
        debouncedFetchShoppers();
    });
    
    // Delivery Type Filter
    document.getElementById('deliveryTypeFilter')?.addEventListener('change', (e) => {
        currentDeliveryType = e.target.value;
        currentPageOffset = 0;
        allLoadedShoppers = [];
        updateClearFiltersButton();
        debouncedFetchShoppers();
    });
    
    // Sort By Filter
    document.getElementById('sortByFilter')?.addEventListener('change', (e) => {
        currentSortBy = e.target.value;
        currentPageOffset = 0;
        allLoadedShoppers = [];
        debouncedFetchShoppers();
    });

    // Clear Filters
    document.getElementById('clearFiltersBtn')?.addEventListener('click', clearAllFilters);

    // Show More button
    document.getElementById('showMoreBtn')?.addEventListener('click', () => {
        loadMoreShoppers();
    });

    // View Toggle
    document.getElementById('viewRowsBtn')?.addEventListener('click', () => toggleViewMode('rows'));
    document.getElementById('viewCardsBtn')?.addEventListener('click', () => toggleViewMode('cards'));

    // Export - Open Modal
    document.getElementById('exportBtn')?.addEventListener('click', openExportModal);
    
    // Analytics
    document.getElementById('analyticsBtn')?.addEventListener('click', showAnalyticsView);
    document.getElementById('backToShoppers')?.addEventListener('click', hideAnalyticsView);
    document.getElementById('applyAnalyticsDate')?.addEventListener('click', fetchDetailedAnalytics);
    document.getElementById('exportAnalyticsBtn')?.addEventListener('click', exportAnalyticsToExcel);
    
    // Inbox
    document.getElementById('inboxBtn')?.addEventListener('click', showInboxView);
    document.getElementById('backToShoppersFromInbox')?.addEventListener('click', hideInboxView);
    document.getElementById('refreshInboxBtn')?.addEventListener('click', fetchInboxData);

    // Multi Orders
    document.getElementById('multiOrdersBtn')?.addEventListener('click', showMultiOrdersView);
    document.getElementById('backToShoppersFromMultiOrders')?.addEventListener('click', hideMultiOrdersView);
    document.getElementById('refreshMultiOrdersBtn')?.addEventListener('click', fetchMultiOrdersData);

    // Multi Orders - Sort
    document.getElementById('moSortBy')?.addEventListener('change', (e) => {
        moSortBy = e.target.value;
        fetchMultiOrdersData();
    });

    // Multi Orders - Status Pills
    document.querySelectorAll('.mo-status-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.mo-status-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            moStatus = pill.dataset.moStatus;
            fetchMultiOrdersData();
        });
    });

    // Multi Orders - Search
    document.getElementById('moSearchInput')?.addEventListener('input', (e) => {
        clearTimeout(moSearchTimeout);
        moSearchTimeout = setTimeout(() => {
            moSearchQuery = e.target.value.trim();
            fetchMultiOrdersData();
        }, 400);
    });

    // Multi Orders - Min Orders
    document.getElementById('moMinOrders')?.addEventListener('change', (e) => {
        moMinOrders = parseInt(e.target.value) || 2;
        fetchMultiOrdersData();
    });

    // Multi Orders - Date Range
    document.getElementById('moStartDate')?.addEventListener('change', (e) => {
        moStartDate = e.target.value;
        moQuickDate = null;
        document.querySelectorAll('.mo-quick-date').forEach(b => b.classList.remove('active'));
        fetchMultiOrdersData();
    });
    document.getElementById('moEndDate')?.addEventListener('change', (e) => {
        moEndDate = e.target.value;
        moQuickDate = null;
        document.querySelectorAll('.mo-quick-date').forEach(b => b.classList.remove('active'));
        fetchMultiOrdersData();
    });

    // Multi Orders - Quick Date Filters
    document.querySelectorAll('.mo-quick-date').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mo-quick-date').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            moQuickDate = btn.dataset.moRange;
            applyMoQuickDate(moQuickDate);
        });
    });

    // Multi Orders - Clear Filters
    document.getElementById('moClearFilters')?.addEventListener('click', clearMoFilters);

    // Multi Orders - Collapse/Expand All
    document.getElementById('moCollapseAll')?.addEventListener('click', () => {
        document.querySelectorAll('.multi-orders-list').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.mo-card-toggle-indicator').forEach(el => el.textContent = '▸');
    });
    document.getElementById('moExpandAll')?.addEventListener('click', () => {
        document.querySelectorAll('.multi-orders-list').forEach(el => el.style.display = 'block');
        document.querySelectorAll('.mo-card-toggle-indicator').forEach(el => el.textContent = '▾');
    });

    // Shipped Orders
    document.getElementById('shippedOrdersBtn')?.addEventListener('click', showShippedOrdersView);
    document.getElementById('backToShoppersFromShipped')?.addEventListener('click', hideShippedOrdersView);
    document.getElementById('refreshShippedBtn')?.addEventListener('click', () => { fetchShippedOrders(); syncShipmentStatuses(true); });
    document.getElementById('soSyncBtn')?.addEventListener('click', () => syncShipmentStatuses(true));
    document.getElementById('soExportBtn')?.addEventListener('click', exportShippedCsv);

    // Shipped Orders - New Forward Shipment (ship any order by its Order ID)
    document.getElementById('soNewShipBtn')?.addEventListener('click', openSoNewShipModal);
    document.getElementById('soLookupInput')?.addEventListener('input', (e) => {
        clearTimeout(soLookupTimeout);
        const q = e.target.value.trim();
        soLookupTimeout = setTimeout(() => runSoLookup(q), 350);
    });

    // Shipped Orders - Status Pills
    document.querySelectorAll('.so-status-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.so-status-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            soStatus = pill.dataset.soStatus || '';
            soOffset = 0;
            fetchShippedOrders();
        });
    });

    // Shipped Orders - Carrier / Payment dropdowns
    document.getElementById('soCarrierFilter')?.addEventListener('change', (e) => {
        soCarrier = e.target.value;
        soOffset = 0;
        fetchShippedOrders();
    });
    document.getElementById('soPaymentFilter')?.addEventListener('change', (e) => {
        soPayment = e.target.value;
        soOffset = 0;
        fetchShippedOrders();
    });

    // Shipped Orders - Search
    document.getElementById('soSearchInput')?.addEventListener('input', (e) => {
        clearTimeout(soSearchTimeout);
        soSearchTimeout = setTimeout(() => {
            soSearchQuery = e.target.value.trim();
            soOffset = 0;
            fetchShippedOrders();
        }, 400);
    });

    // Shipped Orders - Date Range
    document.getElementById('soStartDate')?.addEventListener('change', (e) => {
        soStartDate = e.target.value;
        soQuickDate = null;
        soOffset = 0;
        document.querySelectorAll('.so-quick-date').forEach(b => b.classList.remove('active'));
        fetchShippedOrders();
    });
    document.getElementById('soEndDate')?.addEventListener('change', (e) => {
        soEndDate = e.target.value;
        soQuickDate = null;
        soOffset = 0;
        document.querySelectorAll('.so-quick-date').forEach(b => b.classList.remove('active'));
        fetchShippedOrders();
    });

    // Shipped Orders - Quick Date Filters
    document.querySelectorAll('.so-quick-date').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.so-quick-date').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            soQuickDate = btn.dataset.soRange;
            soOffset = 0;
            applySoQuickDate(soQuickDate);
        });
    });

    // Shipped Orders - Clear Filters + Pagination
    document.getElementById('soClearFilters')?.addEventListener('click', clearSoFilters);
    document.getElementById('soPrevBtn')?.addEventListener('click', () => {
        soOffset = Math.max(0, soOffset - SO_PAGE_SIZE);
        fetchShippedOrders();
    });
    document.getElementById('soNextBtn')?.addEventListener('click', () => {
        if (soOffset + SO_PAGE_SIZE < soTotal) {
            soOffset += SO_PAGE_SIZE;
            fetchShippedOrders();
        }
    });
    document.querySelectorAll('.inbox-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            currentInboxTab = tab.dataset.inboxTab;
            inboxPageOffset = 0;
            document.querySelectorAll('.inbox-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            toggleInboxConfirmedFilters();
            inboxDeselectAll();
            fetchInboxData();
        });
    });
    document.getElementById('inboxPrevBtn')?.addEventListener('click', () => {
        inboxPageOffset = Math.max(0, inboxPageOffset - inboxLimitPerPage);
        fetchInboxData();
    });
    document.getElementById('inboxNextBtn')?.addEventListener('click', () => {
        inboxPageOffset += inboxLimitPerPage;
        fetchInboxData();
    });
    
    // Inbox date filter events
    document.querySelectorAll('.inbox-quick-date').forEach(btn => {
        btn.addEventListener('click', () => applyInboxQuickDate(btn.dataset.inboxRange));
    });
    document.getElementById('inboxStartDate')?.addEventListener('change', onInboxDateChange);
    document.getElementById('inboxEndDate')?.addEventListener('change', onInboxDateChange);
    document.getElementById('clearInboxFiltersBtn')?.addEventListener('click', clearInboxFilters);

    // Inbox filter bar events
    document.getElementById('inboxSearch')?.addEventListener('input', debounceInboxSearch);
    document.getElementById('inboxActionType')?.addEventListener('change', onInboxActionTypeChange);
    document.getElementById('inboxConfirmedBy')?.addEventListener('change', onInboxFilterChange);
    document.getElementById('inboxPaymentMethod')?.addEventListener('change', onInboxFilterChange);
    document.getElementById('inboxDeliveryType')?.addEventListener('change', onInboxFilterChange);
    document.getElementById('inboxDateField')?.addEventListener('change', onInboxDateFieldChange);

    // Inbox bulk action events
    document.getElementById('inboxSelectAllBtn')?.addEventListener('click', inboxSelectAll);
    document.getElementById('inboxExportBtn')?.addEventListener('click', () => exportInboxOrders(false));
    document.getElementById('inboxExportSelectedBtn')?.addEventListener('click', () => exportInboxOrders(true));
    document.getElementById('inboxMarkReadSelectedBtn')?.addEventListener('click', markReadSelected);
    document.getElementById('inboxDeselectAllBtn')?.addEventListener('click', inboxDeselectAll);
    
    // Quick filter buttons
    document.querySelectorAll('.quick-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => applyQuickAnalyticsFilter(btn.dataset.range));
    });
    
    // Export Modal Events
    setupExportModalEvents();
    
    // Keyboard shortcuts for bulk selection
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isBulkMode) {
            clearSelection();
        }
    });
}

function setupModalEvents() {
    const editModal = document.getElementById('editModal');
    const cancelEdit = document.getElementById('cancelEdit');
    const editForm = document.getElementById('editForm');

    const hideModal = () => editModal && editModal.classList.remove('active');

    if (cancelEdit) cancelEdit.addEventListener('click', hideModal);
    if (editModal) {
        editModal.addEventListener('click', (e) => {
            if (e.target === editModal) hideModal();
        });
    }
    
    if (editForm) {
        editForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('editShopperId').value;
            const name = document.getElementById('editName').value;
            const phone = document.getElementById('editPhone').value;
            const order_id = document.getElementById('editOrderId').value;
            const address = document.getElementById('editAddress').value;
            const city = document.getElementById('editCity')?.value.trim() || '';
            const province = document.getElementById('editState')?.value.trim() || '';
            const zip = document.getElementById('editZip')?.value.trim() || '';
            const editorState = getOrderEditorState();

            if (editorState.paymentChanged && !confirm(`Change payment method to ${editorState.paymentMethod.toUpperCase()} for this order?`)) return;

            try {
                const data = await apiCall(`/shoppers/${id}`, 'PUT', { 
                    name, 
                    phone, 
                    order_id, 
                    address, 
                    city,
                    province,
                    zip,
                    items_json: JSON.stringify(editorState.items),
                    order_total: editorState.orderTotal,
                    payment_method: editorState.paymentMethod
                });
                if (data.success) {
                    hideModal();
                    fetchShoppersData();
                    // Surface Shopify/GoKwik sync outcome (edits are pushed to both)
                    const sync = data.shopify_sync;
                    const gkSync = data.gokwik_sync;
                    const notes = [];
                    if (sync && sync.warnings && sync.warnings.length) notes.push(...sync.warnings);
                    if (gkSync && !gkSync.success && !gkSync.skipped) notes.push(`GoKwik sync failed: ${gkSync.reason}`);
                    if (notes.length) {
                        alert(`Saved to hub. Sync notes:\n• ${notes.join('\n• ')}`);
                    }
                } else {
                    alert(data.error || 'Update failed');
                }
            } catch (err) {
                alert('Error updating details');
            }
        });
    }
}

let chatPollingInterval = null;

// ── AI Suggest Reply ──
// Prefetch cache + in-flight dedupe so the ✨ click feels instant.
const _suggestPrefetch = new Map(); // key -> { promise, at }
const _PREFETCH_FRESH_MS = 90 * 1000;

function _suggestKey(phone) { return String(phone).replace(/\D/g, '').slice(-10); }

function prefetchSuggestions(phone) {
    if (!phone || !authToken) return;
    const key = _suggestKey(phone);
    const existing = _suggestPrefetch.get(key);
    if (existing && Date.now() - existing.at < _PREFETCH_FRESH_MS) return;
    _suggestPrefetch.set(key, {
        promise: apiCall('/ai/suggest-reply', 'POST', { phone, prefetch: true }).catch(() => null),
        at: Date.now()
    });
}

function injectSuggestReplyButton() {
    const inputArea = document.querySelector('#chatModal .chat-input-area');
    if (!inputArea || document.getElementById('aiSuggestReplyBtn')) return;

    // Inject styles once
    if (!document.getElementById('aiSuggestStyles')) {
        const s = document.createElement('style');
        s.id = 'aiSuggestStyles';
        s.textContent = `
        #aiSuggestions{padding:8px 12px 0;display:none;flex-direction:column;gap:6px;background:rgba(255,255,255,0.04);border-top:1px solid rgba(255,255,255,0.08)}
        #aiSuggestions.open{display:flex}
        .ai-suggestion-chip{text-align:left;background:rgba(0,92,75,0.15);border:1px solid rgba(0,115,94,0.3);color:#d1fae5;border-radius:10px;padding:8px 10px;font-size:12.5px;line-height:1.4;cursor:pointer;font-family:inherit}
        .ai-suggestion-chip:hover{background:rgba(0,92,75,0.25)}
        .ai-suggestions-note{font-size:11px;color:#8696a0;padding-bottom:4px}
        #aiSuggestReplyBtn{background:linear-gradient(135deg,#005c4b,#00735e);color:#e8f5e9;border:none;border-radius:10px;padding:0 12px;cursor:pointer;font-size:16px;line-height:1;height:44px}
        #aiSuggestReplyBtn:disabled{opacity:.5;cursor:wait}
        `;
        document.head.appendChild(s);
    }

    // Suggestions box (above input area)
    const suggestionsBox = document.createElement('div');
    suggestionsBox.id = 'aiSuggestions';
    inputArea.parentNode.insertBefore(suggestionsBox, inputArea);

    // ✨ button (before send button)
    const btn = document.createElement('button');
    btn.id = 'aiSuggestReplyBtn';
    btn.title = 'AI: suggest replies';
    btn.innerHTML = '✨';
    const sendBtn = document.getElementById('sendChatBtn');
    inputArea.insertBefore(btn, sendBtn);

    btn.onclick = async () => {
        const phone = currentChatPhone;
        if (!phone) { alert('Open a customer chat first'); return; }
        btn.disabled = true;
        btn.innerHTML = '…';
        suggestionsBox.classList.add('open');
        suggestionsBox.innerHTML = '<div class="ai-suggestions-note">Generating suggestions…</div>';
        try {
            const key = _suggestKey(phone);
            const pre = _suggestPrefetch.get(key);
            let data = (pre && Date.now() - pre.at < _PREFETCH_FRESH_MS) ? await pre.promise : null;
            _suggestPrefetch.delete(key);
            if (!data || !data.suggestions) {
                data = await apiCall('/ai/suggest-reply', 'POST', { phone });
            }
            if (data && data.success === false) {
                throw new Error(data.error || 'Failed to generate suggestions');
            }
            if (!data || !data.suggestions || !data.suggestions.length) {
                suggestionsBox.innerHTML = '<div class="ai-suggestions-note">No suggestions available for this chat.</div>';
            } else {
                suggestionsBox.innerHTML = '<div class="ai-suggestions-note">✨ Tap a draft to insert — review before sending:</div>';
                data.suggestions.forEach(s => {
                    const chip = document.createElement('button');
                    chip.className = 'ai-suggestion-chip';
                    chip.textContent = s;
                    chip.onclick = () => {
                        const input = document.getElementById('chatInput');
                        if (input) {
                            input.value = s;
                            input.focus();
                            input.style.height = '44px';
                            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
                        }
                        window.__aiSuggestedReply = s;
                        suggestionsBox.classList.remove('open');
                        suggestionsBox.innerHTML = '';
                    };
                    suggestionsBox.appendChild(chip);
                });
            }
        } catch (e) {
            suggestionsBox.innerHTML = '';
            const note = document.createElement('div');
            note.className = 'ai-suggestions-note';
            note.textContent = `❌ ${e.message || 'Failed to generate suggestions'}`;
            suggestionsBox.appendChild(note);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '✨';
        }
    };
}

function setupChatEvents() {
    const chatModal = document.getElementById('chatModal');
    const closeChat = document.getElementById('closeChat');
    const sendChatBtn = document.getElementById('sendChatBtn');
    const chatInput = document.getElementById('chatInput');
    const markResolvedBtn = document.getElementById('markResolvedBtn');

    // Inject AI suggest reply button
    injectSuggestReplyButton();

    if (closeChat) {
        closeChat.addEventListener('click', () => {
            chatModal.classList.remove('active');
            currentChatPhone = null;
            if (chatPollingInterval) { clearInterval(chatPollingInterval); chatPollingInterval = null; }
            // Refresh inbox list to update unread counts
            fetchInboxData();
        });
    }

    if (sendChatBtn) {
        sendChatBtn.addEventListener('click', sendChatMessage);
    }

    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
        // Auto-expand textarea
        chatInput.addEventListener('input', () => {
            chatInput.style.height = '44px';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });
    }

    if (markResolvedBtn) {
        markResolvedBtn.addEventListener('click', async () => {
            if (!currentChatPhone) return;
            // Find shopper by phone and update status to confirmed
            const shoppers = await apiCall(`/shoppers?search=${currentChatPhone}&limit=1`);
            if (shoppers.shoppers && shoppers.shoppers[0]) {
                await updateStatus(shoppers.shoppers[0].id, 'confirmed');
                alert('Marked as resolved!');
                chatModal.classList.remove('active');
                fetchShoppersData();
            }
        });
    }
}

async function apiCall(endpoint, method = 'GET', body = null) {
    console.log(`[API] ${method} ${endpoint}`, { hasToken: !!authToken, tokenPreview: authToken ? authToken.substring(0, 20) + '...' : 'none' });
    
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${API_BASE}${endpoint}`, options);
    console.log(`[API] Response status:`, res.status);
    
    if (res.status === 401) {
        console.error('[API] Auth failed, clearing token');
        localStorage.removeItem('authToken');
        localStorage.removeItem('hubIdentity');
        window.location.reload();
        return;
    }
    if (res.status === 403) {
        // Smart login: permission denied — keep the session, notify only
        console.warn('[API] Permission denied for', endpoint);
        alert('You do not have permission to perform this action.');
        return;
    }
    return res.json();
}

// Track all loaded shoppers
let allLoadedShoppers = [];

async function loadMoreShoppers() {
    const showMoreBtn = document.getElementById('showMoreBtn');
    const grid = document.getElementById('shoppersGrid');
    
    // Disable button and show loading state
    showMoreBtn.disabled = true;
    showMoreBtn.textContent = 'LOADING...';
    
    const search = document.getElementById('searchInput')?.value || '';
    const startDate = document.getElementById('startDate')?.value || '';
    const endDate = document.getElementById('endDate')?.value || '';
    
    // Format dates for API
    const formattedStartDate = startDate ? `${startDate}T00:00:00` : '';
    const formattedEndDate = endDate ? `${endDate}T23:59:59` : '';
    
    // Calculate next offset
    const nextOffset = allLoadedShoppers.length;
    
    const queryParams = new URLSearchParams({
        limit: limitPerPage,
        offset: nextOffset,
        status: currentStatus,
        search,
        startDate: formattedStartDate,
        endDate: formattedEndDate,
        orderIdFrom: currentOrderIdFrom,
        orderIdTo: currentOrderIdTo,
        paymentMethod: currentPaymentMethod,
        deliveryType: currentDeliveryType,
        sortBy: currentSortBy
    });
    
    // Note: Do NOT add noLimit=true for load-more requests
    // Pagination must always use explicit limit for proper chunked loading
    
    try {
        const data = await apiCall(`/shoppers?${queryParams.toString()}`);
        if (data && data.success) {
            const newShoppers = data.shoppers || [];
            
            // Append to loaded shoppers
            allLoadedShoppers = [...allLoadedShoppers, ...newShoppers];
            
            // Render new cards and append to grid
            renderCards(newShoppers, data.total, true);
            
            // Update tab counts and stats with all loaded data
            updateTabCounts(data.counts || {});
            updateStats(allLoadedShoppers, data.total);
        } else {
            throw new Error(data?.error || 'Failed to fetch');
        }
    } catch (err) {
        console.error(err);
        alert('Error loading more data. Please try again.');
    } finally {
        // Re-enable button
        showMoreBtn.disabled = false;
        showMoreBtn.textContent = 'SHOW MORE';
    }
}

async function fetchShoppersData() {
    const grid = document.getElementById('shoppersGrid');
    grid.innerHTML = `
        <div class="table-loading">
            <div class="spinner"></div>
            <span style="font-family: 'Archivo Narrow', sans-serif; letter-spacing: 2px; font-weight: 500; opacity: 0.7;">SYNCHRONIZING DATA...</span>
        </div>
    `;

    const search = document.getElementById('searchInput')?.value || '';
    const startDate = document.getElementById('startDate')?.value || '';
    const endDate = document.getElementById('endDate')?.value || '';
    
    // Format dates for API - append time for proper filtering
    // startDate should be start of day (00:00:00)
    // endDate should be end of day (23:59:59) to include full day
    const formattedStartDate = startDate ? `${startDate}T00:00:00` : '';
    const formattedEndDate = endDate ? `${endDate}T23:59:59` : '';

    const queryParams = new URLSearchParams({
        limit: limitPerPage,
        offset: currentPageOffset,
        status: currentStatus,
        search,
        startDate: formattedStartDate,
        endDate: formattedEndDate,
        orderIdFrom: currentOrderIdFrom,
        orderIdTo: currentOrderIdTo,
        paymentMethod: currentPaymentMethod,
        deliveryType: currentDeliveryType,
        sortBy: currentSortBy
    });

    // Add noLimit parameter when no date filters are applied
    if (!startDate && !endDate && !search && currentStatus === 'all') {
        queryParams.append('noLimit', 'true');
    }

    try {
        const data = await apiCall(`/shoppers?${queryParams.toString()}`);
        if (data && data.success) {
            allLoadedShoppers = data.shoppers || [];
            currentTotalCount = data.total || 0;
            renderCards(data.shoppers, data.total, false);
            updateTabCounts(data.counts || {});
            updateStats(allLoadedShoppers, data.total);
        } else {
            throw new Error(data?.error || 'Failed to fetch');
        }
    } catch (err) {
        console.error(err);
        grid.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 4rem; grid-column: 1/-1;">Error loading data.</div>`;
    }
}



async function fetchAnalytics() {
    try {
        // Get current date filters from the UI
        const startDate = document.getElementById('startDate')?.value || '';
        const endDate = document.getElementById('endDate')?.value || '';
        
        // Build query params - use date range if available, otherwise use noLimit to get all data
        let endpoint = '/chat/analytics/overview';
        if (startDate && endDate) {
            endpoint += `?startDate=${startDate}&endDate=${endDate}`;
        } else {
            // No date filter - get ALL historical data
            endpoint += '?noLimit=true';
        }
        
        const data = await apiCall(endpoint);
        if (data && data.success) {
            analyticsData = data;
            updateAnalyticsDisplay(data.overview);
        }
    } catch (err) {
        console.error('Failed to fetch analytics:', err);
    }
}

function updateAnalyticsDisplay(overview) {
    const total = overview.total_shoppers || 0;
    const confirmed = overview.confirmed_count || 0;
    const pending = overview.pending_count || 0;
    const responded = overview.responded_count || 0;
    
    const responseRate = total > 0 ? Math.round((responded / total) * 100) : 0;
    
    const totalBox = document.getElementById('statTotal');
    const pendingBox = document.getElementById('statPending');
    const confirmedBox = document.getElementById('statConfirmed');
    const responseBox = document.getElementById('statResponse');
    
    if (totalBox) totalBox.querySelector('.stat-value').textContent = total;
    if (pendingBox) pendingBox.querySelector('.stat-value').textContent = pending;
    if (confirmedBox) confirmedBox.querySelector('.stat-value').textContent = confirmed;
    if (responseBox) responseBox.querySelector('.stat-value').textContent = responseRate + '%';
}

function updateTabCounts(counts) {
    // Update tab count badges
    const total = counts.total || 0;
    const pending = counts.pending || 0;
    const confirmed = counts.confirmed || 0;
    const cancelled = counts.cancelled || 0;
    const edits = counts.edit_details || 0;
    
    const countAll = document.getElementById('countAll');
    const countPending = document.getElementById('countPending');
    const countConfirmed = document.getElementById('countConfirmed');
    const countCancelled = document.getElementById('countCancelled');
    const countEdits = document.getElementById('countEdits');
    
    if (countAll) countAll.textContent = total > 0 ? `(${total})` : '';
    if (countPending) countPending.textContent = pending > 0 ? `(${pending})` : '';
    if (countConfirmed) countConfirmed.textContent = confirmed > 0 ? `(${confirmed})` : '';
    if (countCancelled) countCancelled.textContent = cancelled > 0 ? `(${cancelled})` : '';
    if (countEdits) countEdits.textContent = edits > 0 ? `(${edits})` : '';
}

// ==========================================
// INBOX VIEW - Full Page (Unread & Confirmed)
// ==========================================

let currentInboxTab = 'unread';
let inboxPageOffset = 0;
const inboxLimitPerPage = 20;
let inboxStartDate = '';
let inboxEndDate = '';
let inboxQuickDate = null;
let inboxActionType = '';
let inboxConfirmedBy = '';
let inboxPaymentMethod = '';
let inboxDeliveryType = '';
let inboxSearch = '';
let inboxSelectedItems = new Set();
let inboxDateField = 'updated_at';

async function fetchInboxCounts() {
    try {
        // Build date params for count queries
        const dateQs = [];
        if (inboxStartDate) dateQs.push(`startDate=${inboxStartDate}`);
        if (inboxEndDate) dateQs.push(`endDate=${inboxEndDate}`);
        const dateParam = dateQs.length > 0 ? '&' + dateQs.join('&') : '';

        const [unreadData, confirmedData, analyticsData] = await Promise.all([
            apiCall(`/chat/unread?limit=1${dateParam}`),
            apiCall(`/shoppers/recent-confirmed?limit=1${dateParam}`),
            apiCall('/chat/analytics/overview')
        ]);

        const unreadTotal = unreadData?.total || 0;
        const confirmedTotal = confirmedData?.total || 0;

        // Update nav badge
        const navBadge = document.getElementById('inboxNavBadge');
        if (navBadge) {
            navBadge.textContent = unreadTotal;
            navBadge.style.display = unreadTotal > 0 ? 'inline' : 'none';
        }

        // Update inbox tab counts (only if inbox view elements exist)
        const unreadCountEl = document.getElementById('inboxUnreadCount');
        const confirmedCountEl = document.getElementById('inboxConfirmedCount');
        if (unreadCountEl) unreadCountEl.textContent = unreadTotal;
        if (confirmedCountEl) confirmedCountEl.textContent = confirmedTotal;

        // Update stat cards
        const statUnread = document.getElementById('inboxStatUnread');
        const statConfirmed = document.getElementById('inboxStatConfirmed');
        if (statUnread) statUnread.textContent = unreadTotal;
        if (statConfirmed) statConfirmed.textContent = confirmedTotal;

        // Also update pending & edits from analytics
        if (analyticsData?.overview) {
            const statPending = document.getElementById('inboxStatPending');
            const statEdits = document.getElementById('inboxStatEdits');
            if (statPending) statPending.textContent = analyticsData.overview.pending_count || 0;
            if (statEdits) statEdits.textContent = analyticsData.overview.edit_requests_count || 0;
        }
    } catch (err) {
        console.error('Failed to fetch inbox counts:', err);
    }
}

function showInboxView() {
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('inboxView').style.display = 'block';
    inboxPageOffset = 0;

    // Show/hide confirmed-only filters based on active tab
    toggleInboxConfirmedFilters();

    // Re-apply existing filter selection (don't force a default)
    if (inboxQuickDate) {
        document.querySelectorAll('.inbox-quick-date').forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.inbox-quick-date[data-inbox-range="${inboxQuickDate}"]`);
        if (activeBtn) activeBtn.classList.add('active');
    }
    // If date inputs have values, restore them
    const startEl = document.getElementById('inboxStartDate');
    const endEl = document.getElementById('inboxEndDate');
    if (startEl) startEl.value = inboxStartDate;
    if (endEl) endEl.value = inboxEndDate;

    fetchInboxData();
}

function hideInboxView() {
    document.getElementById('inboxView').style.display = 'none';
    document.getElementById('dashboardView').style.display = 'block';
}

// ==========================================
// MULTI ORDERS VIEW - 2+ Orders within 24h
// ==========================================

function showMultiOrdersView() {
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('multiOrdersView').style.display = 'block';

    if (moQuickDate) {
        // Re-apply the quick date selection to refresh relative dates (today, yesterday, etc.)
        document.querySelectorAll('.mo-quick-date').forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.mo-quick-date[data-mo-range="${moQuickDate}"]`);
        if (activeBtn) activeBtn.classList.add('active');
        applyMoQuickDate(moQuickDate);
    } else if (!moStartDate && !moEndDate) {
        // Default to today if no date filter is set
        moQuickDate = 'today';
        document.querySelectorAll('.mo-quick-date').forEach(b => b.classList.remove('active'));
        const todayBtn = document.querySelector('.mo-quick-date[data-mo-range="today"]');
        if (todayBtn) todayBtn.classList.add('active');
        applyMoQuickDate('today');
    } else {
        fetchMultiOrdersData();
    }
}

function hideMultiOrdersView() {
    document.getElementById('multiOrdersView').style.display = 'none';
    document.getElementById('dashboardView').style.display = 'block';
}

async function fetchMultiOrdersData() {
    const container = document.getElementById('multiOrdersContainer');
    if (!container) return;

    container.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4rem;">
            <div class="spinner" style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#ff4757;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:1rem;"></div>
            <span style="font-family:'Archivo Narrow',sans-serif;letter-spacing:2px;font-weight:500;opacity:0.7;">FETCHING DATA...</span>
        </div>
    `;

    try {
        // Build query params
        const params = new URLSearchParams();
        if (moStatus && moStatus !== 'all') params.set('status', moStatus);
        if (moSortBy) params.set('sort', moSortBy);
        if (moSearchQuery) params.set('search', moSearchQuery);
        if (moStartDate) params.set('startDate', moStartDate);
        if (moEndDate) params.set('endDate', moEndDate);
        if (moMinOrders && moMinOrders > 2) params.set('minOrders', moMinOrders);

        const qs = params.toString();
        const url = '/shoppers/multi-orders' + (qs ? '?' + qs : '');
        const data = await apiCall(url);
        if (data && data.success) {
            moAllGroups = data.groups || [];
            renderMultiOrders(data.groups, data.totalCustomers, data.totalOrders, data.totalValue, data.avgValue, data.statusCounts);
        } else {
            throw new Error(data?.error || 'Failed to fetch');
        }
    } catch (err) {
        console.error('Multi orders fetch error:', err);
        container.innerHTML = `
            <div class="multi-orders-empty">
                <div class="multi-orders-empty-icon">⚠️</div>
                <div class="multi-orders-empty-title">Failed to Load</div>
                <div class="multi-orders-empty-text">${err.message || 'Could not fetch multi-order data'}</div>
            </div>
        `;
    }
}

function renderMultiOrders(groups, totalCustomers, totalOrders, totalValue, avgValue, statusCounts) {
    const container = document.getElementById('multiOrdersContainer');
    document.getElementById('multiOrdersCustomerCount').textContent = totalCustomers || 0;
    document.getElementById('multiOrdersTotalCount').textContent = totalOrders || 0;
    document.getElementById('multiOrdersTotalValue').textContent = '₹' + (totalValue || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    document.getElementById('multiOrdersAvgValue').textContent = '₹' + (avgValue || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    // Update status pill counts
    if (statusCounts) {
        const setCount = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ? ` (${val})` : ''; };
        setCount('moCountAll', statusCounts.all);
        setCount('moCountPending', statusCounts.pending);
        setCount('moCountConfirmed', statusCounts.confirmed);
        setCount('moCountCancelled', statusCounts.cancelled);
        setCount('moCountEdit', statusCounts.edit_details);
    }

    // Update results bar
    const resultsBar = document.getElementById('moResultsBar');
    if (resultsBar) {
        resultsBar.style.display = 'flex';
        document.getElementById('moShowingCount').textContent = groups ? groups.length : 0;
        document.getElementById('moTotalCount').textContent = statusCounts ? statusCounts.all : (groups ? groups.length : 0);
    }

    // Update active filter tags
    updateMoActiveFilters();

    if (!groups || groups.length === 0) {
        container.innerHTML = `
            <div class="multi-orders-empty">
                <div class="multi-orders-empty-icon">📦</div>
                <div class="multi-orders-empty-title">No Multi Orders Found</div>
                <div class="multi-orders-empty-text">${moStatus !== 'all' || moSearchQuery || moStartDate || moEndDate || moMinOrders > 2 ? 'No results match your current filters. Try adjusting or clearing them.' : 'No customers have placed 2+ orders within 24 hours'}</div>
            </div>
        `;
        return;
    }

    container.innerHTML = groups.map((group, idx) => {
        const initials = (group.name || 'U').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const groupTotal = group.orders.reduce((sum, o) => sum + (Number(o.order_total) || 0), 0);
        const ordersHtml = group.orders.map(order => {
            shopperEditCache[String(order.id)] = order;
            const statusClass = order.status || 'pending';
            const amount = order.order_total ? `Rs.${Number(order.order_total).toFixed(2)}` : 'N/A';
            const dateStr = order.created_at ? formatDate(order.created_at) : 'N/A';
            const items = order.items_json ? parseItemsPreview(order.items_json) : (order.product_name || 'N/A');

            return `
                <div class="multi-order-item">
                    <div class="multi-order-details">
                        <h4>${order.order_id || 'N/A'}</h4>
                        <p>${items}</p>
                    </div>
                    <div class="multi-order-amount">${amount}</div>
                    <div class="multi-order-date">${dateStr}</div>
                    <div class="multi-order-status ${statusClass}">${(order.status || 'pending').replace('_', ' ')}</div>
                    <div class="multi-order-actions">
                        <button class="btn btn-success" onclick="confirmMultiOrder('${order.id}')">Confirm</button>
                        <button class="btn btn-danger" onclick="cancelMultiOrder('${order.id}')">Cancel</button>
                        <button class="btn btn-warning" onclick="editMultiOrder('${order.id}', '${encodeURIComponent(order.name || '')}', '${order.phone}', '${order.order_id}', '${encodeURIComponent(order.address || '')}', '${encodeURIComponent(order.items_json || '')}', '${encodeURIComponent(order.payment_method || '')}', '${order.order_total || 0}')">Edit</button>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="multi-customer-card">
                <div class="multi-customer-header" style="cursor: pointer;" onclick="toggleMoCard(this)">
                    <div class="multi-customer-info">
                        <div class="multi-customer-avatar">${initials}</div>
                        <div>
                            <p class="multi-customer-name">${group.name || 'Unknown Customer'} <span class="mo-card-toggle-indicator" style="font-size:0.75rem;opacity:0.5;margin-left:0.3rem;">▾</span></p>
                            <p class="multi-customer-phone">${formatPhone(group.phone)} &middot; <span style="color:#ffa502;">₹${groupTotal.toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:0})}</span></p>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:0.5rem;">
                        <a href="tel:${formatPhoneForCall(group.phone)}" class="mo-header-btn mo-call-btn" onclick="event.stopPropagation();" title="Call ${formatPhone(group.phone)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                            Call
                        </a>
                        <a href="javascript:void(0)" class="mo-header-btn mo-wa-btn" onclick="event.stopPropagation(); openChat('${group.phone}', '${encodeURIComponent(group.name || '')}', '${(group.orders[0] || {}).order_id || ''}', '${(group.orders[0] || {}).status || 'pending'}')" title="Chat with ${group.name || 'Customer'}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>
                            Chat
                        </a>
                        <span class="multi-customer-badge">${group.orders.length} ORDERS</span>
                    </div>
                </div>
                <div class="multi-orders-list">
                    ${ordersHtml}
                </div>
            </div>
        `;
    }).join('');
}

function parseItemsPreview(itemsJson) {
    try {
        const items = JSON.parse(itemsJson);
        if (Array.isArray(items)) {
            return items.map(i => i.name || i.product || 'Item').join(', ');
        }
        if (typeof items === 'object' && items !== null) {
            return Object.values(items).map(i => i.name || i.product || 'Item').join(', ');
        }
        return String(itemsJson).substring(0, 60);
    } catch {
        return String(itemsJson).substring(0, 60) || 'N/A';
    }
}

async function confirmMultiOrder(id) {
    if (!confirm('Are you sure you want to CONFIRM this order?')) return;
    try {
        const data = await apiCall(`/shoppers/${id}/status`, 'POST', { status: 'confirmed' });
        if (data.success) {
            fetchMultiOrdersData();
        } else {
            alert('Failed to confirm order');
        }
    } catch (err) {
        alert('Error confirming order');
    }
}

async function cancelMultiOrder(id) {
    if (!confirm('Are you sure you want to CANCEL this order?')) return;
    try {
        const data = await apiCall(`/shoppers/${id}/status`, 'POST', { status: 'cancelled' });
        if (data.success) {
            // Surface carrier cancellation outcome for shipped orders
            if (data.shipmentCancellation?.hadShipment) {
                alert(data.message);
            }
            fetchMultiOrdersData();
        } else {
            alert('Failed to cancel order');
        }
    } catch (err) {
        alert('Error cancelling order');
    }
}

function editMultiOrder(id, nameEnc, phone, orderId, addressEnc, itemsEnc, paymentEnc, orderTotal) {
    document.getElementById('editShopperId').value = id;
    document.getElementById('editName').value = nameEnc ? decodeURIComponent(nameEnc) : '';
    document.getElementById('editPhone').value = phone || '';
    document.getElementById('editOrderId').value = orderId || '';
    document.getElementById('editAddress').value = addressEnc ? decodeURIComponent(addressEnc) : '';
    fillEditAddressFields(id);

    // Hide customer message box for multi-order edit
    const msgBox = document.getElementById('editCustomerMessage');
    if (msgBox) msgBox.style.display = 'none';

    // Render product editor (inventory picker + pricing + payment)
    const itemsJson = itemsEnc ? decodeURIComponent(itemsEnc) : '[]';
    mountOrderEditor('editOrderEditor', {
        items: itemsJson,
        orderTotal: parseFloat(orderTotal) || 0,
        paymentMethod: paymentEnc ? decodeURIComponent(paymentEnc) : ''
    });

    const editModal = document.getElementById('editModal');
    if (editModal) {
        editModal.classList.add('active');
    }
}

// ==========================================
// MULTI ORDERS HELPER FUNCTIONS
// ==========================================

function toggleMoCard(headerEl) {
    const list = headerEl.parentElement.querySelector('.multi-orders-list');
    const indicator = headerEl.querySelector('.mo-card-toggle-indicator');
    if (!list) return;
    if (list.style.display === 'none') {
        list.style.display = 'block';
        if (indicator) indicator.textContent = '▾';
    } else {
        list.style.display = 'none';
        if (indicator) indicator.textContent = '▸';
    }
}

function applyMoQuickDate(range) {
    // Get current time in IST (UTC + 5:30)
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    
    let start, end;

    switch (range) {
        case 'today':
            // Use UTC methods on the IST-adjusted date to get IST date components
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'yesterday':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 1));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 1));
            break;
        case 'last7':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 6));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'last30':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 29));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'thisMonth':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        default:
            return;
    }

    // Format dates as YYYY-MM-DD using UTC methods (since we already adjusted for IST)
    const fmt = d => {
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    
    moStartDate = fmt(start);
    moEndDate = fmt(end);

    const startEl = document.getElementById('moStartDate');
    const endEl = document.getElementById('moEndDate');
    if (startEl) startEl.value = moStartDate;
    if (endEl) endEl.value = moEndDate;

    fetchMultiOrdersData();
}

function clearMoFilters() {
    moStatus = 'all';
    moSortBy = 'newest';
    moSearchQuery = '';
    moStartDate = '';
    moEndDate = '';
    moMinOrders = 2;
    moQuickDate = null;

    // Reset UI
    document.querySelectorAll('.mo-status-pill').forEach(p => p.classList.remove('active'));
    const allPill = document.querySelector('.mo-status-pill[data-mo-status="all"]');
    if (allPill) allPill.classList.add('active');

    const sortEl = document.getElementById('moSortBy');
    if (sortEl) sortEl.value = 'newest';

    const searchEl = document.getElementById('moSearchInput');
    if (searchEl) searchEl.value = '';

    const minEl = document.getElementById('moMinOrders');
    if (minEl) minEl.value = '2';

    const startEl = document.getElementById('moStartDate');
    const endEl = document.getElementById('moEndDate');
    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';

    document.querySelectorAll('.mo-quick-date').forEach(b => b.classList.remove('active'));

    fetchMultiOrdersData();
}

function updateMoActiveFilters() {
    const container = document.getElementById('moActiveFilters');
    if (!container) return;

    const tags = [];
    if (moStatus && moStatus !== 'all') {
        tags.push({ label: `Status: ${moStatus.replace('_', ' ')}`, clear: () => {
            moStatus = 'all';
            document.querySelectorAll('.mo-status-pill').forEach(p => p.classList.remove('active'));
            document.querySelector('.mo-status-pill[data-mo-status="all"]')?.classList.add('active');
            fetchMultiOrdersData();
        }});
    }
    if (moSortBy && moSortBy !== 'newest') {
        const labels = { oldest: 'Oldest First', order_count_desc: 'Most Orders', order_count_asc: 'Fewest Orders', total_desc: 'Highest Value', total_asc: 'Lowest Value', name_asc: 'Name A-Z', name_desc: 'Name Z-A', recent_order: 'Recent Order' };
        tags.push({ label: `Sort: ${labels[moSortBy] || moSortBy}`, clear: () => {
            moSortBy = 'newest';
            document.getElementById('moSortBy').value = 'newest';
            fetchMultiOrdersData();
        }});
    }
    if (moSearchQuery) {
        tags.push({ label: `Search: "${moSearchQuery}"`, clear: () => {
            moSearchQuery = '';
            document.getElementById('moSearchInput').value = '';
            fetchMultiOrdersData();
        }});
    }
    if (moStartDate || moEndDate) {
        tags.push({ label: `Date: ${moStartDate || '...'} — ${moEndDate || '...'}`, clear: () => {
            moStartDate = '';
            moEndDate = '';
            moQuickDate = null;
            document.getElementById('moStartDate').value = '';
            document.getElementById('moEndDate').value = '';
            document.querySelectorAll('.mo-quick-date').forEach(b => b.classList.remove('active'));
            fetchMultiOrdersData();
        }});
    }
    if (moMinOrders > 2) {
        tags.push({ label: `${moMinOrders}+ Orders`, clear: () => {
            moMinOrders = 2;
            document.getElementById('moMinOrders').value = '2';
            fetchMultiOrdersData();
        }});
    }

    container.innerHTML = tags.map((tag, i) =>
        `<span class="mo-filter-tag" data-tag-index="${i}">${tag.label} <span class='tag-close'>✕</span></span>`
    ).join('');

    // Wire up click to clear individual tags
    container.querySelectorAll('.mo-filter-tag').forEach((el, i) => {
        el.addEventListener('click', () => {
            if (tags[i] && typeof tags[i].clear === 'function') tags[i].clear();
        });
    });
}

async function fetchInboxData() {
    const container = document.getElementById('inboxListContainer');
    if (!container) return;

    container.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4rem;"><div class="spinner"></div><span style="font-family:\'Archivo Narrow\',sans-serif;letter-spacing:2px;font-weight:500;opacity:0.7;margin-top:1rem;">LOADING...</span></div>';

    try {
        // Build query params
        const qs = [];
        if (inboxStartDate) qs.push(`startDate=${inboxStartDate}`);
        if (inboxEndDate) qs.push(`endDate=${inboxEndDate}`);
        if (inboxSearch) qs.push(`search=${encodeURIComponent(inboxSearch)}`);
        if (currentInboxTab === 'unread') {
            if (inboxActionType) qs.push(`actionType=${inboxActionType}`);
        }
        if (currentInboxTab === 'confirmed') {
            if (inboxConfirmedBy) qs.push(`confirmedBy=${inboxConfirmedBy}`);
            if (inboxPaymentMethod) qs.push(`paymentMethod=${inboxPaymentMethod}`);
            if (inboxDeliveryType) qs.push(`deliveryType=${inboxDeliveryType}`);
            if (inboxDateField) qs.push(`dateField=${inboxDateField}`);
        }
        const filterParam = qs.length > 0 ? '&' + qs.join('&') : '';

        const endpoint = currentInboxTab === 'unread'
            ? `/chat/unread?limit=${inboxLimitPerPage}&offset=${inboxPageOffset}${filterParam}`
            : `/shoppers/recent-confirmed?limit=${inboxLimitPerPage}&offset=${inboxPageOffset}${filterParam}`;

        const data = await apiCall(endpoint);
        if (data && data.success) {
            renderInboxList(data.shoppers, data.total);
            fetchInboxCounts(); // refresh counts/badges
        } else {
            throw new Error(data?.error || 'Failed to fetch');
        }
    } catch (err) {
        console.error('Failed to fetch inbox data:', err);
        container.innerHTML = '<div class="inbox-empty"><div class="inbox-empty-icon">⚠️</div><div class="inbox-empty-title">Error loading data</div><div class="inbox-empty-text">Please try again</div></div>';
    }
}

function renderInboxList(shoppers, total) {
    const container = document.getElementById('inboxListContainer');
    const pageInfo = document.getElementById('inboxPageInfo');
    const prevBtn = document.getElementById('inboxPrevBtn');
    const nextBtn = document.getElementById('inboxNextBtn');
    const listTitle = document.getElementById('inboxListTitle');

    if (!container) return;

    if (listTitle) {
        listTitle.textContent = currentInboxTab === 'unread' ? 'Unread Customer Messages' : 'Recently Confirmed Orders';
    }

    // Update date bar context label
    const dateBarLabel = document.getElementById('inboxDateBarLabel');
    if (dateBarLabel) {
        if (currentInboxTab === 'unread') {
            dateBarLabel.textContent = '📅 Messages from:';
        } else {
            dateBarLabel.textContent = inboxDateField === 'updated_at' ? '📅 Confirmed from:' : '📅 Ordered from:';
        }
    }

    // Update active filter chip
    updateInboxFilterChip();

    if (!shoppers || shoppers.length === 0) {
        const isUnread = currentInboxTab === 'unread';
        const hasDateFilter = inboxStartDate || inboxEndDate || inboxQuickDate;
        const filterHint = hasDateFilter ? `<div class="inbox-empty-hint" style="margin-top:0.75rem;font-size:0.8rem;opacity:0.5;">A date filter is active — <a href="#" onclick="clearInboxFilters(); return false;" style="color:#25d366;text-decoration:underline;">Clear filter</a> to see all</div>` : '';
        container.innerHTML = `
            <div class="inbox-empty">
                <div class="inbox-empty-icon">${isUnread ? '💬' : '✓'}</div>
                <div class="inbox-empty-title">${isUnread ? 'No unread messages' : 'No recent confirmations'}</div>
                <div class="inbox-empty-text">${isUnread ? 'All customer messages have been attended to' : 'Confirmed orders will appear here'}</div>
                ${filterHint}
            </div>
        `;
        if (pageInfo) pageInfo.textContent = 'Showing 0-0 of 0';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        return;
    }

    container.innerHTML = shoppers.map(s => {
        const initials = getInitials(s.name);
        const avatarClass = currentInboxTab === 'unread' ? 'unread' : 'confirmed';
        const timeAgo = formatTimeAgo(s.last_message_at || s.last_response_at || s.updated_at);
        const absTime = formatDate(s.last_message_at || s.updated_at || s.created_at);
    
        // Confirmation method badge
        let methodBadge = '';
        if (s.confirmed_by === 'whatsapp') {
            methodBadge = '<span class="inbox-method-badge whatsapp">WhatsApp</span>';
        } else if (s.confirmed_by === 'manual') {
            methodBadge = '<span class="inbox-method-badge manual">Manual</span>';
        }
    
        // Preview content
        let preview = '';
        if (currentInboxTab === 'unread') {
            const msgText = s.latest_message || s.customer_message || '';
            const shortMsg = msgText.split('\n')[0].substring(0, 100);
            preview = `<span class="msg-prefix">MSG:</span> ${escapeHtml(shortMsg)}`;
            if (s.unread_count && s.unread_count > 1) {
                preview += ` <span class="inbox-unread-count">${s.unread_count} unread</span>`;
            }
        } else {
            let items = [];
            try { items = JSON.parse(s.items_json || '[]'); } catch(e) {}
            const itemNames = items.slice(0, 3).map(i => i.title || i.name).join(', ') + (items.length > 3 ? ` +${items.length - 3} more` : '');
            preview = escapeHtml(itemNames) || 'No items';
        }
    
        const phoneVal = s.phone || '';
        const orderIdVal = s.order_id || s.shopper_id || '';
        const statusVal = s.status || 'pending';
        const itemKey = orderIdVal || phoneVal;
        const isChecked = inboxSelectedItems.has(itemKey) ? 'checked' : '';
    
        // Time display - different for unread vs confirmed
        let timeDisplay = '';
        if (currentInboxTab === 'unread') {
            timeDisplay = `
                <div class="inbox-time">
                    <div class="inbox-time-relative">${timeAgo}</div>
                    <div class="inbox-time-absolute">${absTime}</div>
                </div>
            `;
        } else {
            // Confirmed tab: show both created_at and updated_at
            const orderTime = s.created_at ? formatDate(s.created_at) : 'N/A';
            const confirmedTime = s.updated_at ? formatDate(s.updated_at) : 'N/A';
            const orderTimeAgo = s.created_at ? formatTimeAgo(s.created_at) : '';
            const confirmedTimeAgo = s.updated_at ? formatTimeAgo(s.updated_at) : '';
            timeDisplay = `
                <div class="inbox-time inbox-time-dual">
                    <div class="inbox-time-block">
                        <div class="inbox-time-label">Ordered</div>
                        <div class="inbox-time-relative">${orderTimeAgo}</div>
                        <div class="inbox-time-absolute">${orderTime}</div>
                    </div>
                    <div class="inbox-time-block">
                        <div class="inbox-time-label">Confirmed</div>
                        <div class="inbox-time-relative">${confirmedTimeAgo}</div>
                        <div class="inbox-time-absolute">${confirmedTime}</div>
                    </div>
                </div>
            `;
        }
    
        return `
            <div class="inbox-item" onclick="openChat('${phoneVal}', '${encodeURIComponent(s.name || '')}', '${orderIdVal}', '${statusVal}')">
                <div class="inbox-item-checkbox-wrap" onclick="event.stopPropagation()">
                    <input type="checkbox" class="inbox-item-checkbox" data-phone="${phoneVal}" data-order-id="${orderIdVal}" data-key="${itemKey}" ${isChecked} onchange="onInboxItemCheck(this)">
                </div>
                <div class="inbox-avatar ${avatarClass}">${initials}</div>
                <div class="inbox-customer-info">
                    <div class="inbox-customer-name">${currentInboxTab === 'unread' ? '<span class="unread-dot"></span>' : ''}${escapeHtml(s.name || 'Customer')} ${methodBadge}</div>
                    <div class="inbox-customer-order">${orderIdVal || 'N/A'}</div>
                    <span class="inbox-status ${statusVal}">${statusVal.toUpperCase()}</span>
                </div>
                <div class="inbox-preview">${preview}</div>
                <div>
                    <div class="inbox-amount">\u20B9${s.order_total || '0'}</div>
                    <div class="inbox-pay-method">${s.payment_method || 'COD'}</div>
                </div>
                ${timeDisplay}
                <div class="inbox-actions">
                    ${currentInboxTab === 'unread' ? `<button class="inbox-action-btn mark-read" onclick="event.stopPropagation(); markInboxAsRead('${phoneVal}')" title="Mark as Read">\u2713 Read</button>` : ''}
                    <button class="inbox-action-btn chat" onclick="event.stopPropagation(); openChat('${phoneVal}', '${encodeURIComponent(s.name || '')}', '${orderIdVal}', '${statusVal}')">Chat</button>
                    <a class="inbox-action-btn wa" href="https://wa.me/${formatPhone(phoneVal)}" target="_blank" onclick="event.stopPropagation();">WA</a>
                </div>
            </div>
        `;
    }).join('');

    // Pagination
    const startNum = inboxPageOffset + 1;
    const endNum = Math.min(inboxPageOffset + inboxLimitPerPage, total);
    if (pageInfo) pageInfo.textContent = `Showing ${startNum}-${endNum} of ${total}`;
    if (prevBtn) prevBtn.disabled = inboxPageOffset === 0;
    if (nextBtn) nextBtn.disabled = endNum >= total;
}

// Mark all messages for a phone as read
async function markInboxAsRead(phone) {
    if (!phone) return;
    try {
        const data = await apiCall(`/chat/mark-read/${phone}`, 'POST');
        if (data && data.success) {
            fetchInboxData(); // Refresh the list
            fetchInboxCounts(); // Update counts
        }
    } catch (err) {
        console.error('Mark read error:', err);
    }
}

// Update the active filter chip display
function updateInboxFilterChip() {
    const chip = document.getElementById('inboxActiveFilterChip');
    if (!chip) return;

    const tags = [];

    // Date filter chip
    let dateLabel = '';
    if (inboxQuickDate) {
        const quickLabels = { today: 'Today', yesterday: 'Yesterday', last7: 'Last 7 Days', last30: 'Last 30 Days', thisMonth: 'This Month' };
        dateLabel = quickLabels[inboxQuickDate] || '';
    } else if (inboxStartDate || inboxEndDate) {
        if (inboxStartDate && inboxEndDate) {
            dateLabel = `${inboxStartDate} → ${inboxEndDate}`;
        } else if (inboxStartDate) {
            dateLabel = `From ${inboxStartDate}`;
        } else {
            dateLabel = `Until ${inboxEndDate}`;
        }
    }
    if (dateLabel) {
        const fieldPrefix = (currentInboxTab === 'confirmed' && inboxDateField === 'updated_at') ? 'Confirmed' : 'Ordered';
        tags.push(`<span class="chip-tag" onclick="clearInboxFilters()" title="Clear date filter">${fieldPrefix}: ${dateLabel} <span class=\"chip-close\">\u2715</span></span>`);
    }

    // Action type chip (unread tab only)
    if (inboxActionType && currentInboxTab === 'unread') {
        const actionLabels = { edit_details: 'Edit', confirmed: 'Confirm', cancelled: 'Cancel', pending: 'Pending' };
        const actionLabel = actionLabels[inboxActionType] || inboxActionType;
        tags.push(`<span class="chip-tag" onclick="clearInboxFilter('actionType')" title="Clear action filter">Action: ${actionLabel} <span class=\"chip-close\">\u2715</span></span>`);
    }

    // Confirmed-by chip
    if (inboxConfirmedBy && currentInboxTab === 'confirmed') {
        const methodLabel = inboxConfirmedBy === 'whatsapp' ? 'WhatsApp' : 'Manual';
        tags.push(`<span class="chip-tag" onclick="clearInboxFilter('confirmedBy')" title="Clear method filter">Method: ${methodLabel} <span class=\"chip-close\">\u2715</span></span>`);
    }

    // Payment method chip
    if (inboxPaymentMethod && currentInboxTab === 'confirmed') {
        tags.push(`<span class="chip-tag" onclick="clearInboxFilter('paymentMethod')" title="Clear payment filter">Payment: ${inboxPaymentMethod} <span class=\"chip-close\">\u2715</span></span>`);
    }

    // Delivery type chip
    if (inboxDeliveryType && currentInboxTab === 'confirmed') {
        tags.push(`<span class="chip-tag" onclick="clearInboxFilter('deliveryType')" title="Clear delivery filter">Delivery: ${inboxDeliveryType} <span class=\"chip-close\">\u2715</span></span>`);
    }

    // Search chip
    if (inboxSearch) {
        tags.push(`<span class="chip-tag" onclick="clearInboxFilter('search')" title="Clear search">Search: ${escapeHtml(inboxSearch.substring(0, 20))}${inboxSearch.length > 20 ? '...' : ''} <span class=\"chip-close\">\u2715</span></span>`);
    }

    if (tags.length > 0) {
        chip.innerHTML = tags.join(' ');
        chip.style.display = 'inline-flex';
    } else {
        chip.style.display = 'none';
    }
}

// Clear a specific inbox filter
function clearInboxFilter(filterName) {
    switch(filterName) {
        case 'actionType':
            inboxActionType = '';
            const atEl = document.getElementById('inboxActionType');
            if (atEl) atEl.value = '';
            break;
        case 'confirmedBy':
            inboxConfirmedBy = '';
            const cbEl = document.getElementById('inboxConfirmedBy');
            if (cbEl) cbEl.value = '';
            break;
        case 'paymentMethod':
            inboxPaymentMethod = '';
            const pmEl = document.getElementById('inboxPaymentMethod');
            if (pmEl) pmEl.value = '';
            break;
        case 'deliveryType':
            inboxDeliveryType = '';
            const dtEl = document.getElementById('inboxDeliveryType');
            if (dtEl) dtEl.value = '';
            break;
        case 'search':
            inboxSearch = '';
            const sEl = document.getElementById('inboxSearch');
            if (sEl) sEl.value = '';
            break;
    }
    inboxPageOffset = 0;
    fetchInboxData();
    updateInboxFilterChip();
}

// Apply quick date filter to inbox
function applyInboxQuickDate(range) {
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);

    let start, end;
    switch (range) {
        case 'today':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'yesterday':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 1));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 1));
            break;
        case 'last7':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 6));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'last30':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 29));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'thisMonth':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        default:
            return;
    }

    const fmt = d => {
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    inboxStartDate = fmt(start);
    inboxEndDate = fmt(end);
    inboxQuickDate = range;

    const startEl = document.getElementById('inboxStartDate');
    const endEl = document.getElementById('inboxEndDate');
    if (startEl) startEl.value = inboxStartDate;
    if (endEl) endEl.value = inboxEndDate;

    // Update quick date button active state
    document.querySelectorAll('.inbox-quick-date').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`.inbox-quick-date[data-inbox-range="${range}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    inboxPageOffset = 0;
    fetchInboxData();
    updateInboxFilterChip();
}

// Clear inbox date filters
function clearInboxFilters() {
    inboxStartDate = '';
    inboxEndDate = '';
    inboxQuickDate = null;
    inboxActionType = '';

    const startEl = document.getElementById('inboxStartDate');
    const endEl = document.getElementById('inboxEndDate');
    const actionEl = document.getElementById('inboxActionType');
    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';
    if (actionEl) actionEl.value = '';

    document.querySelectorAll('.inbox-quick-date').forEach(b => b.classList.remove('active'));

    inboxPageOffset = 0;
    fetchInboxData();
    updateInboxFilterChip();
}

// Inbox date input change handler
function onInboxDateChange() {
    const startEl = document.getElementById('inboxStartDate');
    const endEl = document.getElementById('inboxEndDate');
    inboxStartDate = startEl?.value || '';
    inboxEndDate = endEl?.value || '';
    inboxQuickDate = null;
    document.querySelectorAll('.inbox-quick-date').forEach(b => b.classList.remove('active'));
    inboxPageOffset = 0;
    fetchInboxData();
    updateInboxFilterChip();
}

// Toggle confirmed-only filters visibility based on active tab
function toggleInboxConfirmedFilters() {
    const confirmedFilters = document.querySelectorAll('.inbox-confirmed-filter');
    const unreadFilters = document.querySelectorAll('.inbox-unread-filter');
    const isConfirmed = currentInboxTab === 'confirmed';
    const isUnread = currentInboxTab === 'unread';
    
    confirmedFilters.forEach(el => {
        el.classList.toggle('hidden', !isConfirmed);
    });
    
    unreadFilters.forEach(el => {
        el.classList.toggle('hidden', !isUnread);
    });
}

// Inbox search debounce
let inboxSearchTimeout = null;
function debounceInboxSearch() {
    clearTimeout(inboxSearchTimeout);
    inboxSearchTimeout = setTimeout(() => {
        inboxSearch = document.getElementById('inboxSearch')?.value?.trim() || '';
        inboxPageOffset = 0;
        fetchInboxData();
        updateInboxFilterChip();
    }, 300);
}

// Inbox dropdown filter change handler
function onInboxFilterChange() {
    inboxConfirmedBy = document.getElementById('inboxConfirmedBy')?.value || '';
    inboxPaymentMethod = document.getElementById('inboxPaymentMethod')?.value || '';
    inboxDeliveryType = document.getElementById('inboxDeliveryType')?.value || '';
    inboxPageOffset = 0;
    fetchInboxData();
    updateInboxFilterChip();
}

// Inbox action type filter change handler (for unread tab)
function onInboxActionTypeChange() {
    inboxActionType = document.getElementById('inboxActionType')?.value || '';
    inboxPageOffset = 0;
    fetchInboxData();
    updateInboxFilterChip();
}

// Inbox date field change handler (Confirmed Date vs Order Date)
function onInboxDateFieldChange() {
    inboxDateField = document.getElementById('inboxDateField')?.value || 'updated_at';
    // Update the date bar label
    const dateBarLabel = document.getElementById('inboxDateBarLabel');
    if (dateBarLabel) {
        dateBarLabel.textContent = inboxDateField === 'updated_at' ? '\uD83D\uDCC5 Confirmed from:' : '\uD83D\uDCC5 Ordered from:';
    }
    inboxPageOffset = 0;
    fetchInboxData();
    updateInboxFilterChip();
}

// Checkbox change handler for individual items
function onInboxItemCheck(checkbox) {
    const key = checkbox.dataset.key;
    if (checkbox.checked) {
        inboxSelectedItems.add(key);
    } else {
        inboxSelectedItems.delete(key);
    }
    updateInboxBulkBar();
}

// Select all visible items
function inboxSelectAll() {
    const checkboxes = document.querySelectorAll('.inbox-item-checkbox');
    const allChecked = [...checkboxes].every(cb => cb.checked);
    checkboxes.forEach(cb => {
        cb.checked = !allChecked;
        const key = cb.dataset.key;
        if (!allChecked) {
            inboxSelectedItems.add(key);
        } else {
            inboxSelectedItems.delete(key);
        }
    });
    const selectAllBtn = document.getElementById('inboxSelectAllBtn');
    if (selectAllBtn) {
        selectAllBtn.textContent = allChecked ? 'Select All' : 'Deselect All';
        selectAllBtn.classList.toggle('active', !allChecked);
    }
    updateInboxBulkBar();
}

// Deselect all items
function inboxDeselectAll() {
    inboxSelectedItems.clear();
    document.querySelectorAll('.inbox-item-checkbox').forEach(cb => cb.checked = false);
    const selectAllBtn = document.getElementById('inboxSelectAllBtn');
    if (selectAllBtn) {
        selectAllBtn.textContent = 'Select All';
        selectAllBtn.classList.remove('active');
    }
    updateInboxBulkBar();
}

// Update bulk action bar visibility
function updateInboxBulkBar() {
    const bulkBar = document.getElementById('inboxBulkBar');
    const countEl = document.getElementById('inboxSelectedCount');
    const markReadBtn = document.getElementById('inboxMarkReadSelectedBtn');
    if (!bulkBar) return;

    const count = inboxSelectedItems.size;
    if (countEl) countEl.textContent = `${count} selected`;
    bulkBar.style.display = count > 0 ? 'flex' : 'none';

    // Only show mark-read on unread tab
    if (markReadBtn) {
        markReadBtn.style.display = currentInboxTab === 'unread' ? 'inline-flex' : 'none';
    }
}

// Mark selected items as read (unread tab only)
async function markReadSelected() {
    const phones = new Set();
    document.querySelectorAll('.inbox-item-checkbox:checked').forEach(cb => {
        if (cb.dataset.phone) phones.add(cb.dataset.phone);
    });

    if (phones.size === 0) return;

    for (const phone of phones) {
        try {
            await apiCall(`/chat/mark-read/${phone}`, 'POST');
        } catch (e) {
            console.error('Mark read error for', phone, e);
        }
    }

    inboxDeselectAll();
    fetchInboxData();
}

// Export inbox orders (all matching filters or selected only)
async function exportInboxOrders(selectedOnly) {
    const format = 'xlsx'; // default format

    const qs = [`tab=${currentInboxTab}`, `format=${format}`];
    if (inboxStartDate) qs.push(`startDate=${inboxStartDate}`);
    if (inboxEndDate) qs.push(`endDate=${inboxEndDate}`);
    if (inboxSearch) qs.push(`search=${encodeURIComponent(inboxSearch)}`);

    if (currentInboxTab === 'confirmed') {
        if (inboxConfirmedBy) qs.push(`confirmedBy=${inboxConfirmedBy}`);
        if (inboxPaymentMethod) qs.push(`paymentMethod=${inboxPaymentMethod}`);
        if (inboxDeliveryType) qs.push(`deliveryType=${inboxDeliveryType}`);
        if (inboxDateField) qs.push(`dateField=${inboxDateField}`);
    }

    if (selectedOnly && inboxSelectedItems.size > 0) {
        qs.push(`orderIds=${[...inboxSelectedItems].join(',')}`);
    }

    try {
        const res = await fetch(`${API_BASE}/inbox/export?${qs.join('&')}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;

            const now = new Date();
            const istOffsetMs = 5.5 * 60 * 60 * 1000;
            const istNow = new Date(now.getTime() + istOffsetMs);
            const dateStr = `${istNow.getUTCFullYear()}-${String(istNow.getUTCMonth() + 1).padStart(2, '0')}-${String(istNow.getUTCDate()).padStart(2, '0')}`;
            const tabLabel = currentInboxTab === 'confirmed' ? 'confirmed_orders' : 'inbox';
            const selLabel = selectedOnly ? '_selected' : '';

            a.download = `${tabLabel}${selLabel}_${dateStr}.xlsx`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();
        } else {
            alert('Export failed. Please try again.');
        }
    } catch (e) {
        console.error('Inbox export error:', e);
        alert('Export error');
    }
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].substring(0, 2).toUpperCase();
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const now = new Date();
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';

    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    // Use IST for the fallback date display
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffsetMs);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${istDate.getUTCDate()} ${months[istDate.getUTCMonth()]}`;
}

function toggleCardSelection(shopperId, event) {
    if (event) {
        event.stopPropagation();
    }
    
    const checkbox = document.getElementById(`select-${shopperId}`);
    const card = document.getElementById(`card-${shopperId}`);
    
    if (selectedShoppers.has(shopperId)) {
        selectedShoppers.delete(shopperId);
        if (checkbox) checkbox.classList.remove('checked');
        if (card) card.classList.remove('selected');
    } else {
        selectedShoppers.add(shopperId);
        if (checkbox) checkbox.classList.add('checked');
        if (card) card.classList.add('selected');
    }
    
    updateBulkActionsBar();
}

function updateBulkActionsBar() {
    const bulkBar = document.getElementById('bulkActionsBar');
    const selectedCount = document.getElementById('selectedCount');
    
    if (selectedShoppers.size > 0) {
        isBulkMode = true;
        bulkBar?.classList.add('active');
        if (selectedCount) selectedCount.textContent = selectedShoppers.size;
    } else {
        isBulkMode = false;
        bulkBar?.classList.remove('active');
    }
}

function clearSelection() {
    selectedShoppers.clear();
    isBulkMode = false;
    
    // Remove selected class from all cards
    document.querySelectorAll('.shopper-card').forEach(card => {
        card.classList.remove('selected');
    });
    
    // Uncheck all checkboxes
    document.querySelectorAll('.card-select-checkbox').forEach(checkbox => {
        checkbox.classList.remove('checked');
    });
    
    // Reset select all buttons
    document.getElementById('selectAllBtn')?.classList.remove('active');
    document.getElementById('selectAllMatchingBtn')?.classList.remove('active');
    
    updateBulkActionsBar();
}

function selectAllVisible() {
    // Select all shoppers currently visible on the page
    allMatchingShoppers.forEach(shopper => {
        selectedShoppers.add(shopper.id);
    });
    
    // Update UI
    document.querySelectorAll('.shopper-card').forEach(card => {
        card.classList.add('selected');
    });
    document.querySelectorAll('.card-select-checkbox').forEach(checkbox => {
        checkbox.classList.add('checked');
    });
    
    // Update button state
    document.getElementById('selectAllBtn')?.classList.add('active');
    document.getElementById('selectAllMatchingBtn')?.classList.remove('active');
    
    updateBulkActionsBar();
}

async function selectAllMatching() {
    // Fetch all shoppers matching current filters (not just current page)
    const search = document.getElementById('searchInput')?.value || '';
    const startDate = document.getElementById('startDate')?.value || '';
    const endDate = document.getElementById('endDate')?.value || '';
    
    // Format dates for API - append time for proper filtering
    const formattedStartDate = startDate ? `${startDate}T00:00:00` : '';
    const formattedEndDate = endDate ? `${endDate}T23:59:59` : '';
    
    const queryParams = new URLSearchParams({
        noLimit: 'true', // Get all matching records
        offset: 0,
        status: currentStatus,
        search,
        startDate: formattedStartDate,
        endDate: formattedEndDate,
        orderIdFrom: currentOrderIdFrom,
        orderIdTo: currentOrderIdTo,
        paymentMethod: currentPaymentMethod,
        deliveryType: currentDeliveryType,
        sortBy: currentSortBy
    });
    
    try {
        const data = await apiCall(`/shoppers?${queryParams.toString()}`);
        if (data && data.success && data.shoppers) {
            // Add all matching shoppers to selection
            data.shoppers.forEach(shopper => {
                selectedShoppers.add(shopper.id);
            });
            
            // Update UI for visible cards
            document.querySelectorAll('.shopper-card').forEach(card => {
                card.classList.add('selected');
            });
            document.querySelectorAll('.card-select-checkbox').forEach(checkbox => {
                checkbox.classList.add('checked');
            });
            
            // Update button states
            document.getElementById('selectAllBtn')?.classList.add('active');
            document.getElementById('selectAllMatchingBtn')?.classList.add('active');
            
            updateBulkActionsBar();
            
            // Show notification
            alert(`${selectedShoppers.size} orders selected (all matching filters)`);
        }
    } catch (err) {
        console.error('Failed to select all matching:', err);
        alert('Failed to select all matching orders');
    }
}

async function bulkUpdateStatus(status) {
    if (!hubRequirePerm('edit_orders', 'change shopper statuses')) return;
    if (selectedShoppers.size === 0) return;
    
    if (!confirm(`Are you sure you want to mark ${selectedShoppers.size} orders as ${status.toUpperCase()}?`)) {
        return;
    }
    
    const ids = Array.from(selectedShoppers);
    let successCount = 0;
    let failCount = 0;
    
    // Process in batches of 5
    for (let i = 0; i < ids.length; i += 5) {
        const batch = ids.slice(i, i + 5);
        const promises = batch.map(id => 
            apiCall(`/shoppers/${id}/status`, 'POST', { status })
                .then(() => { successCount++; })
                .catch(() => { failCount++; })
        );
        await Promise.all(promises);
    }
    
    alert(`${successCount} orders updated successfully${failCount > 0 ? `, ${failCount} failed` : ''}`);
    clearSelection();
    fetchShoppersData();
    fetchInboxCounts()
}

async function bulkDelete() {
    if (!hubRequirePerm('edit_orders', 'delete shoppers')) return;
    if (selectedShoppers.size === 0) return;
    
    if (!confirm(`⚠️ WARNING: Are you sure you want to DELETE ${selectedShoppers.size} orders?\n\nThis action cannot be undone!`)) {
        return;
    }
    
    // Double confirmation for bulk delete
    if (!confirm(`Please confirm again: Delete ${selectedShoppers.size} orders permanently?`)) {
        return;
    }
    
    const ids = Array.from(selectedShoppers);
    
    try {
        // Use bulk delete endpoint - single API call for all IDs
        await apiCall('/shoppers/bulk', 'DELETE', { ids });
        alert(`${ids.length} orders deleted successfully`);
    } catch (error) {
        console.error('Bulk delete error:', error);
        alert('Failed to delete orders. Please try again.');
    }
    
    clearSelection();
    fetchShoppersData();
    fetchAnalytics();
    fetchInboxCounts()
}

function toggleViewMode(mode) {
    currentViewMode = mode;
    localStorage.setItem('shopperViewMode', mode);
    const rowsBtn = document.getElementById('viewRowsBtn');
    const cardsBtn = document.getElementById('viewCardsBtn');
    if (rowsBtn && cardsBtn) {
        rowsBtn.classList.toggle('active', mode === 'rows');
        cardsBtn.classList.toggle('active', mode === 'cards');
    }
    fetchShoppersData();
}

function renderCards(shoppers, total, append = false) {
    const grid = document.getElementById('shoppersGrid');
    const pageInfo = document.getElementById('pageInfo');
    const showMoreBtn = document.getElementById('showMoreBtn');

    // Apply view mode class
    grid.classList.toggle('cards-view', currentViewMode === 'cards');
    const rowsBtn = document.getElementById('viewRowsBtn');
    const cardsBtn = document.getElementById('viewCardsBtn');
    if (rowsBtn && cardsBtn) {
        rowsBtn.classList.toggle('active', currentViewMode === 'rows');
        cardsBtn.classList.toggle('active', currentViewMode === 'cards');
    }

    if (!shoppers || shoppers.length === 0) {
        grid.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 4rem; grid-column: 1/-1;">No records found.</div>`;
        pageInfo.textContent = 'Showing 0-0 of 0';
        showMoreBtn.style.display = 'none';
        return;
    }

    // Only clear grid if not appending
    if (!append) {
        grid.innerHTML = '';
    }
    shoppers.forEach((s, i) => {
        shopperEditCache[String(s.id)] = s;
        const card = document.createElement('div');
        card.className = `shopper-card status-${s.status} ${s.customer_message ? 'has-message' : ''} ${selectedShoppers.has(s.id) ? 'selected' : ''}`;
        card.id = `card-${s.id}`;
        card.style.setProperty('--index', i);

        // Parse items
        let items = [];
        try { items = JSON.parse(s.items_json || '[]'); } catch(e) {}
        const itemsListHtml = items.map(item => {
            // Check for size in multiple properties, including variant_title fallback
            let size = item.size || item.variant_size || item.product_size || '';
            // Fallback: extract size from variant_title (e.g., "Size: M" or "M")
            if (!size && item.variant_title) {
                const sizeMatch = item.variant_title.match(/Size:\s*(\w+)/i) || item.variant_title.match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
                if (sizeMatch) size = sizeMatch[1].toUpperCase();
            }
            const sizeDisplay = size ? ` <span class="product-size">(${size})</span>` : '';
            return `<li>• ${item.title || item.name}${sizeDisplay} (Qty: ${item.quantity || 1})</li>`;
        }).join('');

        // Customer message preview
        let messagePreviewHtml = '';
        if (s.customer_message) {
            const shortMsg = s.customer_message.split('\n')[0].substring(0, 100);
            const msgTime = s.last_response_at ? formatDate(s.last_response_at) : '';
            messagePreviewHtml = `
                <div class="customer-message-preview">
                    <div class="msg-label">Customer Message</div>
                    <div class="msg-content">${escapeHtml(shortMsg)}${s.customer_message.length > 100 ? '...' : ''}</div>
                    ${msgTime ? `<div class="msg-time">${msgTime}</div>` : ''}
                </div>
            `;
        }

        // Status badge
        const statusBadgeClass = s.status || 'pending';
        const statusLabel = (s.status || 'PENDING').toUpperCase();
        
        // Check if card is selected
        const isSelected = selectedShoppers.has(s.id);

        const productsText = items.map(i => i.title || i.name).join(', ') || 'No products';

        // Shipping state: confirmed + no AWB = shippable; AWB present = show chip
        const canShip = s.status === 'confirmed' && !s.awb;
        const awbChipLabel = s.awb ? `${s.courier_name || 'Shipped'} · ${s.awb}` : '';

        // GoKwik RTO risk chip (only when a risk score has been received)
        const rtoRisk = (s.rto_risk || '').toLowerCase();
        const rtoChipHtml = (rtoRisk === 'high' || rtoRisk === 'medium')
            ? `<span class="rto-chip rto-${rtoRisk}" title="GoKwik RTO risk: ${rtoRisk.toUpperCase()}">${rtoRisk === 'high' ? 'HIGH RTO' : 'MED RTO'}</span>`
            : '';
        
        if (currentViewMode === 'cards') {
            card.innerHTML = `
                <div class="card-select-checkbox ${isSelected ? 'checked' : ''}" id="select-${s.id}" onclick="toggleCardSelection('${s.id}', event)"></div>
                <span class="card-select-hint">Click to select</span>

                <div class="card-header-main">
                    <div class="source-info">
                        <span class="badge badge-shopify">Shopify</span>
                        <span class="badge badge-status ${statusBadgeClass}">${statusLabel}</span>
                        <span class="badge badge-delivery">${s.delivery_type || 'Standard'}</span>
                        ${rtoChipHtml}
                    </div>
                    <div class="amount-info">
                        <div class="price-big">₹${s.order_total || '0.00'}</div>
                        <span class="pay-method-badge">${s.payment_method || 'COD'}</span>
                    </div>
                </div>

                <div class="customer-basics">
                    <h2 class="customer-name-big">
                        ${s.name || 'Customer'}
                        <button class="btn-text-edit" onclick="openEditModal('${s.id}', '${encodeURIComponent(s.name || '')}', '${s.phone}', '${s.order_id}', '${encodeURIComponent(s.address || '')}', '${encodeURIComponent(s.items_json || '')}', '${encodeURIComponent(s.customer_message || '')}', '${s.last_response_at || ''}', '${encodeURIComponent(s.payment_method || '')}', '${s.order_total || 0}')">EDIT</button>
                    </h2>
                    <div class="customer-email">${s.email || 'no-email@provided.com'}</div>
                    <div class="customer-meta-row">
                        <span class="order-id-small">ID: ${s.order_id || 'N/A'}</span>
                        <span class="timestamp-row">${formatDate(s.created_at)}</span>
                    </div>
                </div>

                ${messagePreviewHtml}

                <div class="card-section">
                    <div class="section-label">Products</div>
                    <ul class="product-list-simple">
                        ${itemsListHtml || '<li>• No products found</li>'}
                    </ul>
                </div>

                <div class="card-section">
                    <div class="section-label">Address</div>
                    <p class="address-text">${s.address || 'No address provided'}, ${s.city || ''}, ${s.zip || ''}</p>
                    <span class="state-badge">${s.province || 'India'}</span>
                </div>

                <div class="card-actions-grid">
                    <button class="action-btn btn-chat" onclick="openChat('${s.phone}', '${encodeURIComponent(s.name || '')}', '${s.order_id}', '${s.status}')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
                        Chat
                    </button>
                    <a href="tel:${formatPhoneForCall(s.phone)}" class="action-btn btn-call">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                        ${s.phone || 'N/A'}
                    </a>
                    <a href="https://wa.me/${formatPhone(s.phone)}" target="_blank" class="action-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.335-1.662c1.72.937 3.659 1.432 5.631 1.433h.005c6.554 0 11.89-5.335 11.893-11.892a11.826 11.826 0 00-3.481-8.413z"/></svg>
                        WhatsApp
                    </a>
                </div>

                <div class="status-actions">
                    <button class="status-pill ${s.status === 'confirmed' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'confirmed')">Confirm</button>
                    <button class="status-pill ${s.status === 'pending' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'pending')">Retry</button>
                    <button class="status-pill ${s.status === 'edit_details' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'edit_details')">Edits</button>
                    <button class="status-pill ${s.status === 'cancelled' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'cancelled')">Cancel</button>
                </div>

                ${canShip ? `<button class="ship-btn" onclick="openShipModal('${s.id}')">🚚 Ship Order</button>` : ''}
                ${s.awb ? `<div class="awb-chip" onclick="openShipmentsDrawer('${s.id}', '${s.order_id}')" title="View shipments">📦 ${escapeHtml(awbChipLabel)}</div>` : ''}
            `;
        } else {
            card.innerHTML = `
            <div class="card-select-checkbox ${isSelected ? 'checked' : ''}" id="select-${s.id}" onclick="toggleCardSelection('${s.id}', event)"></div>

            <div class="row-status">
                <span class="badge badge-status ${statusBadgeClass}">${statusLabel}</span>
                ${rtoChipHtml}
            </div>

            <div class="row-order-info">
                <div class="order-id-small">${s.order_id || 'N/A'}</div>
                <div class="timestamp-row">${formatDate(s.created_at)}</div>
            </div>

            <div class="row-customer">
                <div class="customer-name-big">
                    ${s.name || 'Customer'}
                    ${s.customer_message ? '<span class="msg-indicator" title="Customer message"></span>' : ''}
                </div>
                <div class="customer-meta">${s.phone || 'N/A'} · ${s.email || 'no-email'}</div>
            </div>

            <div class="row-products" title="${escapeHtml(productsText)}">
                ${productsText}
            </div>

            <div class="row-location">
                ${s.city || ''}, ${s.province || 'India'}
            </div>

            <div class="row-price">
                <div class="price-big">₹${s.order_total || '0.00'}</div>
                <span class="pay-method-badge">${s.payment_method || 'COD'}</span>
            </div>

            <div class="row-actions-compact">
                <button class="action-icon-btn" onclick="openChat('${s.phone}', '${encodeURIComponent(s.name || '')}', '${s.order_id}', '${s.status}')" title="Chat">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
                </button>
                <a href="tel:${formatPhoneForCall(s.phone)}" class="action-icon-btn btn-call-icon" title="Call">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                </a>
                <a href="https://wa.me/${formatPhone(s.phone)}" target="_blank" class="action-icon-btn" title="WhatsApp">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.335-1.662c1.72.937 3.659 1.432 5.631 1.433h.005c6.554 0 11.89-5.335 11.893-11.892a11.826 11.826 0 00-3.481-8.413z"/></svg>
                </a>
                <button class="action-icon-btn" onclick="openEditModal('${s.id}', '${encodeURIComponent(s.name || '')}', '${s.phone}', '${s.order_id}', '${encodeURIComponent(s.address || '')}', '${encodeURIComponent(s.items_json || '')}', '${encodeURIComponent(s.customer_message || '')}', '${s.last_response_at || ''}', '${encodeURIComponent(s.payment_method || '')}', '${s.order_total || 0}')" title="Edit">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                </button>
                ${canShip ? `<button class="action-icon-btn ship-icon-btn" onclick="openShipModal('${s.id}')" title="Ship Order">🚚</button>` : ''}
                ${s.awb ? `<button class="action-icon-btn ship-icon-btn" onclick="openShipmentsDrawer('${s.id}', '${s.order_id}')" title="${escapeHtml(awbChipLabel)}">📦</button>` : ''}
            </div>

            <div class="row-status-pills">
                <button class="status-pill-mini ${s.status === 'confirmed' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'confirmed')" title="Confirm">✓</button>
                <button class="status-pill-mini ${s.status === 'pending' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'pending')" title="Retry">↻</button>
                <button class="status-pill-mini ${s.status === 'edit_details' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'edit_details')" title="Edits">✎</button>
                <button class="status-pill-mini ${s.status === 'cancelled' ? 'active' : ''}" onclick="updateStatus('${s.id}', 'cancelled')" title="Cancel">✕</button>
            </div>
        `;
        }
        grid.appendChild(card);
    });

    // Update pagination info
    const loadedCount = grid.querySelectorAll('.shopper-card').length;
    const startNum = 1;
    const endNum = loadedCount;
    pageInfo.textContent = `Showing ${startNum}-${endNum} of ${total}`;

    // Show/hide "Show More" button
    if (endNum < total) {
        showMoreBtn.style.display = 'block';
    } else {
        showMoreBtn.style.display = 'none';
    }
}

function openEditModal(id, nameEnc, phone, orderId, addressEnc, itemsEnc, messageEnc, msgTime, paymentEnc, orderTotal) {
    if (!hubRequirePerm('edit_orders', 'edit shopper details')) return;
    document.getElementById('editShopperId').value = id;
    document.getElementById('editName').value = nameEnc ? decodeURIComponent(nameEnc) : '';
    document.getElementById('editPhone').value = phone;
    document.getElementById('editOrderId').value = orderId;
    document.getElementById('editAddress').value = addressEnc ? decodeURIComponent(addressEnc) : '';
    fillEditAddressFields(id);
    
    // Show customer message if exists
    const msgBox = document.getElementById('editCustomerMessage');
    const msgContent = document.getElementById('editMsgContent');
    const msgTimeEl = document.getElementById('editMsgTime');
    
    if (messageEnc && messageEnc !== 'null') {
        msgBox.style.display = 'block';
        msgContent.textContent = decodeURIComponent(messageEnc);
        msgTimeEl.textContent = msgTime ? formatDate(msgTime) : '';
    } else {
        msgBox.style.display = 'none';
    }
    
    // Structured Editor (products from inventory + pricing + payment)
    const itemsJson = itemsEnc ? decodeURIComponent(itemsEnc) : '[]';
    mountOrderEditor('editOrderEditor', {
        items: itemsJson,
        orderTotal: parseFloat(orderTotal) || 0,
        paymentMethod: paymentEnc ? decodeURIComponent(paymentEnc) : ''
    });

    document.getElementById('editModal').classList.add('active');
}

// Populate the structured address inputs from the cached shopper row
function fillEditAddressFields(id) {
    const cached = shopperEditCache[String(id)] || {};
    const cityEl = document.getElementById('editCity');
    const stateEl = document.getElementById('editState');
    const zipEl = document.getElementById('editZip');
    if (cityEl) cityEl.value = cached.city || '';
    if (stateEl) stateEl.value = cached.province || '';
    if (zipEl) zipEl.value = cached.zip || '';
    const status = document.getElementById('editAddrSyncStatus');
    if (status) { status.textContent = ''; status.style.color = ''; }
}

// Pull the live shipping address from the Shopify order into the edit form
async function pullShopifyAddress() {
    const id = document.getElementById('editShopperId').value;
    const status = document.getElementById('editAddrSyncStatus');
    if (!id) return;
    if (status) { status.textContent = 'Fetching address from Shopify…'; status.style.color = '#888'; }
    try {
        const data = await apiCall(`/shoppers/${id}/shopify-address`);
        if (data && data.success && data.address) {
            const a = data.address;
            const street = [a.address1, a.address2].filter(Boolean).join(', ');
            if (street) document.getElementById('editAddress').value = street;
            document.getElementById('editCity').value = a.city || '';
            document.getElementById('editState').value = a.province || '';
            document.getElementById('editZip').value = a.zip || '';
            if (status) { status.textContent = '✓ Loaded from Shopify — click Save Details to apply'; status.style.color = '#25d366'; }
        } else {
            if (status) { status.textContent = (data && data.error) || 'No shipping address found on the Shopify order'; status.style.color = '#f5a623'; }
        }
    } catch (err) {
        if (status) { status.textContent = 'Failed to fetch address from Shopify'; status.style.color = '#ff4757'; }
    }
}

async function openChat(phone, nameEnc, orderId, status) {
    // Validate phone number
    if (!phone || phone.trim() === '') {
        console.error('[openChat] Invalid phone number:', phone);
        alert('Error: No phone number available for this customer');
        return;
    }
    
    console.log(`[openChat] Opening chat for phone: ${phone}, name: ${nameEnc ? decodeURIComponent(nameEnc) : 'Customer'}`);
    
    currentChatPhone = phone;
    const chatModal = document.getElementById('chatModal');
    const chatMessages = document.getElementById('chatMessages');
    
    // Update sidebar info
    document.getElementById('chatCustomerName').textContent = nameEnc ? decodeURIComponent(nameEnc) : 'Customer';
    document.getElementById('chatCustomerPhone').textContent = phone;
    document.getElementById('chatCustomerOrder').textContent = orderId || 'N/A';
    document.getElementById('chatCustomerStatus').textContent = (status || 'pending').toUpperCase();
    document.getElementById('chatHeaderTitle').textContent = `Chat with ${nameEnc ? decodeURIComponent(nameEnc).split(' ')[0] : 'Customer'}`;
    
    chatMessages.innerHTML = '<div class="chat-loading"><div class="spinner"></div><span>Loading conversation...</span></div>';
    chatModal.classList.add('active');
    
    // Warm the AI suggestion cache so ✨ click feels instant
    try { prefetchSuggestions(phone); } catch (e) { /* never block chat open */ }
    
    // Mark all messages for this phone as read when opening chat
    try {
        await apiCall(`/chat/mark-read/${phone}`, 'POST');
    } catch (err) {
        console.error('Failed to mark messages as read:', err);
    }
    
    // Start polling for new messages
    if (chatPollingInterval) clearInterval(chatPollingInterval);
    chatPollingInterval = setInterval(async () => {
        if (!currentChatPhone) return;
        try {
            const data = await apiCall(`/chat/${currentChatPhone}`);
            if (data && data.success) {
                renderChatMessages(data.messages);
            }
        } catch (err) {
            // Silently fail on polling errors
        }
    }, 8000); // Poll every 8 seconds
    
    try {
        const data = await apiCall(`/chat/${phone}`);
        if (data && data.success) {
            renderChatMessages(data.messages);
        } else {
            chatMessages.innerHTML = '<div class="chat-loading">Failed to load messages</div>';
        }
    } catch (err) {
        chatMessages.innerHTML = '<div class="chat-loading">Error loading conversation</div>';
    }
}

// Helper: format time only (IST) for chat messages – e.g. "09:31 PM"
function formatChatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(d.getTime() + istOffsetMs);
    let hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${minutes} ${ampm}`;
}

// Helper: get IST date key from ISO string – e.g. "2026-04-18"
function getISTDateKey(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(d.getTime() + istOffsetMs);
    const y = istDate.getUTCFullYear();
    const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Helper: human-readable date label for chat separator
function getDateLabel(dateKey) {
    if (!dateKey) return '';
    const today = getISTDateKey(new Date().toISOString());
    const yesterday = getISTDateKey(new Date(Date.now() - 86400000).toISOString());
    if (dateKey === today) return 'Today';
    if (dateKey === yesterday) return 'Yesterday';
    return formatISTDateLabel(dateKey);
}

// Helper: format an IST date string (YYYY-MM-DD) to a readable label without browser timezone interference
// Options: 'short' = "Apr 15", 'long' = "Apr 15, 2026", 'full' = "April 15, 2026"
function formatISTDateLabel(istDateStr, style = 'short') {
    if (!istDateStr) return '';
    const [y, m, d] = istDateStr.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthsFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const day = parseInt(d);
    const monthIdx = parseInt(m) - 1;
    if (style === 'full') return `${monthsFull[monthIdx]} ${day}, ${y}`;
    if (style === 'long') return `${months[monthIdx]} ${day}, ${y}`;
    return `${months[monthIdx]} ${day}`;
}

// Helper: get message type label
function getMessageTypeLabel(msg) {
    const type = msg.type || '';
    if (type === 'template') return 'Template';
    if (type === 'manual_reply') return 'Manual';
    if (type === 'outgoing' || type === 'auto_reply' || type === 'text') return 'Bot';
    if (type === 'broadcast') return 'Broadcast';
    return '';
}

// Helper: get WhatsApp-style status indicator HTML
function getStatusIndicator(msg) {
    if (msg.sender !== 'agent') return '';
    const status = (msg.status || 'sent').toLowerCase();
    
    // WhatsApp-style checkmarks:
    // ✓ = sent (single grey)
    // ✓✓ = delivered (double grey)
    // ✓✓ = read (double blue)
    // ! = failed (red)
    switch (status) {
        case 'sent':
            return '<span class="msg-status msg-status-sent" title="Sent">✓</span>';
        case 'delivered':
            return '<span class="msg-status msg-status-delivered" title="Delivered">✓✓</span>';
        case 'read':
            return '<span class="msg-status msg-status-read" title="Read">✓✓</span>';
        case 'failed':
            return '<span class="msg-status msg-status-failed" title="Failed">!</span>';
        default:
            return '<span class="msg-status msg-status-sent" title="Sent">✓</span>';
    }
}

// Helper: format message content for display
function formatMessageContent(content, msg) {
    if (!content) return '';
    let text = content;
    
    // Check if this is a template message
    const templateMatch = text.match(/^\[Template: (\w+)\]\s*(.*)$/);
    if (templateMatch) {
        const templateName = templateMatch[1];
        const paramsText = templateMatch[2]?.trim();
        
        // Render as a template card
        return `
            <div class="template-message-card">
                <div class="template-card-header">
                    <span class="template-badge">📨 ${escapeHtml(templateName)}</span>
                </div>
                ${paramsText ? `<div class="template-card-content">${formatTemplateParams(paramsText)}</div>` : ''}
            </div>
        `;
    }
    
    if (text.startsWith('[Image] ')) {
        text = text.replace(/^\[Image\] /, '📷 ');
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
}

// Helper: format template parameters for display
function formatTemplateParams(paramsText) {
    if (!paramsText) return '';
    
    // Split by | separator and format each parameter
    const params = paramsText.split('|').map(p => p.trim()).filter(Boolean);
    
    if (params.length === 0) return escapeHtml(paramsText);
    
    // Format as a list or structured display
    return params.map(param => {
        const escaped = escapeHtml(param);
        // Try to detect common patterns and format them nicely
        if (escaped.match(/^(#\d+|Order)/i)) {
            return `<div class="template-param"><strong>Order:</strong> ${escaped}</div>`;
        }
        if (escaped.match(/^Rs\.?\s*\d+/i)) {
            return `<div class="template-param"><strong>Amount:</strong> ${escaped}</div>`;
        }
        if (escaped.match(/^(Processing|Confirmed|Shipped|Delivered|Cancelled)/i)) {
            return `<div class="template-param"><strong>Status:</strong> ${escaped}</div>`;
        }
        return `<div class="template-param">${escaped}</div>`;
    }).join('');
}

function renderChatMessages(messages) {
    const chatMessages = document.getElementById('chatMessages');
    
    // Check if user is near bottom before re-rendering (within 100px of bottom)
    const isNearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 100;
    
    if (!messages || messages.length === 0) {
        chatMessages.innerHTML = '<div class="chat-empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><div class="chat-empty-text">No messages yet</div><div class="chat-empty-sub">Start the conversation by typing below</div></div>';
        return;
    }
    
    chatMessages.innerHTML = '';
    let lastDateKey = null;
    
    messages.forEach(msg => {
        const currentDateKey = getISTDateKey(msg.created_at);
        
        // Insert date separator if the date changed
        if (currentDateKey && currentDateKey !== lastDateKey) {
            const separator = document.createElement('div');
            separator.className = 'chat-date-separator';
            separator.innerHTML = `<span>${getDateLabel(currentDateKey)}</span>`;
            chatMessages.appendChild(separator);
            lastDateKey = currentDateKey;
        }
        
        const msgDiv = document.createElement('div');
        const isUnread = msg.sender === 'customer' && msg.is_read === 0;
        msgDiv.className = `chat-message ${msg.sender}${isUnread ? ' unread-message' : ''}`;
        
        const time = formatChatTime(msg.created_at);
        const typeLabel = getMessageTypeLabel(msg);
        const typeBadge = typeLabel && msg.sender === 'agent' 
            ? `<span class="msg-type-badge">${typeLabel}</span>` 
            : '';
        
        // Format message content (handles templates, images, newlines)
        const contentHtml = formatMessageContent(msg.content, msg);
        
        // Add unread indicator for unseen customer messages
        const unreadIndicator = isUnread 
            ? '<span class="unread-dot" title="Unread message"></span>' 
            : '';
        
        msgDiv.innerHTML = `
            <div class="msg-bubble">
                <div class="msg-content">${contentHtml}</div>
                <div class="msg-meta">
                    ${unreadIndicator}
                    ${typeBadge}
                    <span class="msg-time">${time}</span>
                    ${getStatusIndicator(msg)}
                </div>
            </div>
        `;
        chatMessages.appendChild(msgDiv);
    });
    
    // Only auto-scroll to bottom if user was already near bottom
    // This preserves scroll position when user scrolls up to read messages
    if (isNearBottom) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

async function sendChatMessage() {
    if (!hubRequirePerm('send_messages', 'send WhatsApp messages')) return;
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    
    if (!message || !currentChatPhone) return;
    
    // Add message to UI immediately (optimistic update)
    const chatMessages = document.getElementById('chatMessages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message agent';
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffsetMs);
    let istHours = istDate.getUTCHours();
    const istMinutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const istAmpm = istHours >= 12 ? 'PM' : 'AM';
    istHours = istHours % 12;
    istHours = istHours ? istHours : 12;
    const istTimeStr = `${istHours}:${istMinutes} ${istAmpm}`;
    
    // Handle newlines in message content
    const contentHtml = escapeHtml(message).replace(/\n/g, '<br>');
    msgDiv.innerHTML = `
        <div class="msg-bubble">
            <div class="msg-content">${contentHtml}</div>
            <div class="msg-meta">
                <span class="msg-type-badge">Manual</span>
                <span class="msg-time">${istTimeStr}</span>
                <span class="msg-check msg-sending">&#10003;</span>
            </div>
        </div>
    `;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    input.value = '';
    input.style.height = '44px';
    
    try {
        const data = await apiCall('/chat/send', 'POST', {
            phone: currentChatPhone,
            message: message,
            suggestedText: window.__aiSuggestedReply || null
        });
        window.__aiSuggestedReply = null;
        
        if (data.success) {
            // Update check mark to sent
            const sendingCheck = msgDiv.querySelector('.msg-sending');
            if (sendingCheck) sendingCheck.classList.remove('msg-sending');
        } else {
            // Mark as failed
            msgDiv.classList.add('msg-failed');
            const metaDiv = msgDiv.querySelector('.msg-meta');
            if (metaDiv) metaDiv.innerHTML += '<span class="msg-error">Failed</span>';
        }
    } catch (err) {
        // Mark as failed
        msgDiv.classList.add('msg-failed');
        const metaDiv = msgDiv.querySelector('.msg-meta');
        if (metaDiv) metaDiv.innerHTML += '<span class="msg-error">Failed</span>';
    }
}

// ==========================================
// SHARED ORDER EDITOR
// Inventory-backed product picker + pricing + COD/Prepaid toggle.
// Mounted inside the Edit modal AND the Ship modal (step 1).
// ==========================================

let oeCatalog = null;          // cached Shopify product catalog
let oeCatalogPromise = null;   // in-flight load guard
let oeState = null;            // active editor instance state

async function loadProductCatalog(force = false) {
    if (oeCatalog && !force) return oeCatalog;
    if (oeCatalogPromise) return oeCatalogPromise;
    oeCatalogPromise = apiCall(`/shopify/products${force ? '?refresh=1' : ''}`)
        .then(data => {
            oeCatalog = (data && data.success) ? (data.products || []) : (oeCatalog || []);
            return oeCatalog;
        })
        .catch(() => (oeCatalog = oeCatalog || []))
        .finally(() => { oeCatalogPromise = null; });
    return oeCatalogPromise;
}

function oeCatalogStatusText() {
    if (!oeCatalog) return 'Loading inventory…';
    if (oeCatalog.length === 0) return '⚠️ Inventory unavailable — you can still type product names manually';
    const variants = oeCatalog.reduce((n, p) => n + (p.variants || []).length, 0);
    return `${oeCatalog.length} products · ${variants} variants in inventory`;
}

function mountOrderEditor(containerId, { items = [], orderTotal = 0, paymentMethod = '' } = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Only one editor is active at a time — clear the other mount point to avoid duplicate IDs
    ['editOrderEditor', 'shipOrderEditor'].forEach(id => {
        if (id !== containerId) { const el = document.getElementById(id); if (el) el.innerHTML = ''; }
    });

    const pm = (paymentMethod || '').toLowerCase();
    const original = (pm.includes('cod') || pm.includes('cash')) ? 'COD' : 'Prepaid';
    oeState = { containerId, rowSeq: 0, originalPayment: original, payment: original, totalDirty: false };

    container.innerHTML = `
        <div class="oe-toolbar">
            <span class="oe-label">Order Items</span>
            <button type="button" class="oe-sync-btn" onclick="oeRefreshCatalog()">⟳ Refresh Inventory</button>
        </div>
        <div class="oe-catalog-status" id="oeCatalogStatus">${oeCatalogStatusText()}</div>
        <div id="oeRows"></div>
        <button type="button" class="btn-add-item" onclick="oeAddRow()">+ ADD PRODUCT FROM INVENTORY</button>
        <div class="oe-summary">
            <div class="oe-summary-row"><span>Items Subtotal</span><span id="oeSubtotal">₹0.00</span></div>
            <div class="oe-summary-row oe-total-row">
                <span>Order Total (₹)</span>
                <input type="number" step="0.01" min="0" class="oe-total-input" id="oeTotalInput" value="${Number(orderTotal) || 0}">
            </div>
            <div class="oe-summary-hint" id="oeTotalHint" style="display:none;"></div>
        </div>
        <div class="oe-payment">
            <span class="oe-label">Payment Method</span>
            <div class="oe-pay-row">
                <div class="oe-pay-toggle">
                    <button type="button" class="oe-pay-btn cod" id="oePayCod" onclick="oeSetPayment('COD')">💰 COD</button>
                    <button type="button" class="oe-pay-btn prepaid" id="oePayPrepaid" onclick="oeSetPayment('Prepaid')">✓ Prepaid</button>
                </div>
                <span class="oe-pay-note" id="oePayNote"></span>
            </div>
        </div>
    `;

    // A manually saved total that differs from the items subtotal is treated as an override
    const totalInput = document.getElementById('oeTotalInput');
    totalInput.addEventListener('input', () => { oeState.totalDirty = true; oeRecalc(); });

    let parsed = [];
    try { parsed = Array.isArray(items) ? items : JSON.parse(items || '[]'); } catch (e) {}
    if (!Array.isArray(parsed)) parsed = [];
    if (parsed.length === 0) {
        oeAddRow();
    } else {
        parsed.forEach(item => oeAddRow(item));
    }

    // If the stored total doesn't match the items subtotal, respect it as an admin override
    const subtotal = oeComputeSubtotal();
    if (Math.abs((Number(orderTotal) || 0) - subtotal) > 0.01 && (Number(orderTotal) || 0) > 0) {
        oeState.totalDirty = true;
    }
    oeSetPayment(original, true);
    oeRecalc();

    // Link rows to inventory once the catalog is ready (variant selects, stock badges)
    loadProductCatalog().then(() => {
        const status = document.getElementById('oeCatalogStatus');
        if (status) status.textContent = oeCatalogStatusText();
        document.querySelectorAll('#oeRows .oe-row').forEach(row => oeTryLinkCatalog(row));
    });
}

async function oeRefreshCatalog() {
    const status = document.getElementById('oeCatalogStatus');
    if (status) status.textContent = 'Refreshing inventory…';
    await loadProductCatalog(true);
    if (status) status.textContent = oeCatalogStatusText();
    document.querySelectorAll('#oeRows .oe-row').forEach(row => oeTryLinkCatalog(row));
}

function oeThumbHtml(src) {
    return src
        ? `<img class="oe-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;oe-thumb oe-thumb-placeholder&quot;>👕</div>'">`
        : '<div class="oe-thumb oe-thumb-placeholder">👕</div>';
}

function oeAddRow(item = {}) {
    const rowsWrap = document.getElementById('oeRows');
    if (!rowsWrap || !oeState) return;

    // Normalize the many historical items_json shapes (Shopify line_items, manual edits…)
    let size = item.size || item.variant_size || item.product_size || '';
    if (!size && item.variant_title) {
        const m = item.variant_title.match(/Size:\s*(\w+)/i) || item.variant_title.match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
        if (m) size = m[1].toUpperCase();
    }

    const rowId = 'oeRow' + (++oeState.rowSeq);
    const row = document.createElement('div');
    row.className = 'oe-row';
    row.id = rowId;
    row.dataset.productId = item.product_id || '';
    row.dataset.variantId = item.variant_id || '';
    row.innerHTML = `
        <div class="oe-row-main">
            <span class="oe-thumb-slot">${oeThumbHtml(item.image || '')}</span>
            <div class="oe-picker">
                <input type="text" class="oe-title" placeholder="Search inventory or type product name…" value="${escapeHtml(item.title || item.name || '')}" autocomplete="off">
                <div class="oe-dropdown"></div>
            </div>
            <span class="oe-variant-slot"><input type="text" class="oe-variant oe-size-input" placeholder="Size" value="${escapeHtml(size)}"></span>
            <input type="number" class="oe-qty" min="1" value="${parseInt(item.quantity) || 1}" title="Quantity">
            <div class="oe-price-wrap">₹<input type="number" class="oe-price" min="0" step="0.01" value="${Number(item.price) || 0}" title="Unit price — editable"></div>
            <div class="oe-line-total">₹0.00</div>
            <button type="button" class="btn-remove-item" title="Remove item" onclick="oeRemoveRow('${rowId}')">✕</button>
        </div>
        <div class="oe-row-meta"></div>
    `;
    rowsWrap.appendChild(row);

    const titleInput = row.querySelector('.oe-title');
    titleInput.addEventListener('input', () => {
        // Manual typing unlinks the row from the catalog until re-selected
        row.dataset.productId = '';
        row.dataset.variantId = '';
        oeRenderDropdown(row, titleInput.value.trim());
        oeSetRowMeta(row);
    });
    titleInput.addEventListener('focus', () => oeRenderDropdown(row, titleInput.value.trim()));
    titleInput.addEventListener('blur', () => setTimeout(() => row.querySelector('.oe-dropdown')?.classList.remove('open'), 180));
    row.querySelector('.oe-qty').addEventListener('input', oeRecalc);
    row.querySelector('.oe-price').addEventListener('input', oeRecalc);

    oeSetRowMeta(row);
    if (oeCatalog && (item.title || item.name || item.product_id)) oeTryLinkCatalog(row);
    oeRecalc();
    return row;
}

function oeRemoveRow(rowId) {
    document.getElementById(rowId)?.remove();
    oeRecalc();
}

function oeStockBadge(variant) {
    if (!variant || variant.inventory === null || variant.inventory === undefined) return '';
    if (variant.inventory <= 0) return '<span class="oe-stock-badge oe-stock-out">Out of stock</span>';
    if (variant.inventory <= 5) return `<span class="oe-stock-badge oe-stock-low">Low · ${variant.inventory} left</span>`;
    return `<span class="oe-stock-badge oe-stock-in">In stock · ${variant.inventory}</span>`;
}

function oeProductStock(p) {
    const total = (p.variants || []).reduce((n, v) => n + Math.max(0, v.inventory || 0), 0);
    return total;
}

function oeRenderDropdown(row, query) {
    const dd = row.querySelector('.oe-dropdown');
    if (!dd) return;
    if (!oeCatalog) { dd.innerHTML = '<div class="oe-dropdown-empty">Loading inventory…</div>'; dd.classList.add('open'); return; }
    if (oeCatalog.length === 0) { dd.classList.remove('open'); return; }

    const q = (query || '').toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const matches = oeCatalog
        .filter(p => tokens.length === 0 || tokens.every(t => p.title.toLowerCase().includes(t)))
        .slice(0, 30);

    if (matches.length === 0) {
        dd.innerHTML = '<div class="oe-dropdown-empty">No inventory match — the typed name will be saved as a custom item</div>';
        dd.classList.add('open');
        return;
    }

    dd.innerHTML = matches.map(p => {
        const prices = (p.variants || []).map(v => v.price);
        const minP = Math.min(...prices), maxP = Math.max(...prices);
        const priceLabel = prices.length ? (minP === maxP ? `₹${minP}` : `₹${minP}–₹${maxP}`) : '';
        const stock = oeProductStock(p);
        const stockLabel = stock > 0 ? `${stock} in stock` : 'out of stock';
        return `
            <div class="oe-opt" onmousedown="event.preventDefault(); oeSelectProduct('${row.id}', '${p.id}')">
                ${p.image ? `<img src="${escapeHtml(p.image)}" alt="" loading="lazy">` : '<div class="oe-thumb oe-thumb-placeholder">👕</div>'}
                <div class="oe-opt-info">
                    <div class="oe-opt-title">${escapeHtml(p.title)}</div>
                    <div class="oe-opt-sub">${priceLabel} · ${(p.variants || []).length} variant${(p.variants || []).length === 1 ? '' : 's'} · ${stockLabel}</div>
                </div>
            </div>`;
    }).join('');
    dd.classList.add('open');
}

function oeSelectProduct(rowId, productId) {
    const row = document.getElementById(rowId);
    const p = (oeCatalog || []).find(x => String(x.id) === String(productId));
    if (!row || !p) return;

    row.dataset.productId = String(p.id);
    row.querySelector('.oe-title').value = p.title;
    row.querySelector('.oe-thumb-slot').innerHTML = oeThumbHtml(p.image);
    row.querySelector('.oe-dropdown').classList.remove('open');
    oeBuildVariantSelect(row, p, null);
    oeRecalc();
}

// Swap the free-text size input for a live variant <select> with price + stock per option
function oeBuildVariantSelect(row, product, preferredSize) {
    const slot = row.querySelector('.oe-variant-slot');
    const variants = product.variants || [];
    const sel = document.createElement('select');
    sel.className = 'oe-variant';
    sel.innerHTML = variants.map(v => {
        const label = `${v.title || 'One Size'} · ₹${v.price}${v.inventory !== null && v.inventory !== undefined ? (v.inventory > 0 ? ` · ${v.inventory} left` : ' · OUT' ) : ''}`;
        return `<option value="${v.id}" data-size="${escapeHtml(v.title || '')}">${escapeHtml(label)}</option>`;
    }).join('');
    slot.innerHTML = '';
    slot.appendChild(sel);

    // Preselect: saved variant id, else match previous size, else first in-stock variant
    let target = null;
    if (row.dataset.variantId) {
        target = variants.find(v => String(v.id) === String(row.dataset.variantId));
    }
    if (!target && preferredSize) {
        target = variants.find(v => (v.title || '').toLowerCase() === preferredSize.toLowerCase())
              || variants.find(v => (v.title || '').toLowerCase().includes(preferredSize.toLowerCase()));
    }
    if (!target) target = variants.find(v => v.available) || variants[0];
    if (target) sel.value = String(target.id);

    const applyVariant = (setPrice) => {
        const v = variants.find(x => String(x.id) === sel.value);
        if (!v) return;
        row.dataset.variantId = String(v.id);
        if (setPrice) row.querySelector('.oe-price').value = v.price;
        oeSetRowMeta(row, product, v);
        oeRecalc();
    };
    sel.addEventListener('change', () => applyVariant(true));
    applyVariant(!(Number(row.querySelector('.oe-price').value) > 0) || preferredSize === null);
}

function oeSetRowMeta(row, product, variant) {
    const meta = row.querySelector('.oe-row-meta');
    if (!meta) return;
    if (!product || !variant) {
        meta.innerHTML = row.dataset.productId ? '' : '<span class="oe-stock-badge oe-custom-badge">Custom item · not linked to inventory</span>';
        return;
    }
    const parts = [oeStockBadge(variant)];
    if (variant.sku) parts.push(`SKU: ${escapeHtml(variant.sku)}`);
    if (variant.compare_at_price && variant.compare_at_price > variant.price) {
        parts.push(`MRP <span class="oe-compare-price">₹${variant.compare_at_price}</span> → ₹${variant.price}`);
    }
    meta.innerHTML = parts.filter(Boolean).join('<span style="color:#333;">·</span>');
}

// Best-effort: link an existing items_json row to the live catalog — by saved
// product_id first, then by normalized title (spacing/punctuation tolerant) —
// so the size/variant dropdown appears for previously saved items
function oeTryLinkCatalog(row) {
    if (!oeCatalog || oeCatalog.length === 0) return;
    if (row.querySelector('select.oe-variant')) return; // already linked

    let p = null;
    if (row.dataset.productId) {
        p = oeCatalog.find(x => String(x.id) === String(row.dataset.productId));
    }
    if (!p) {
        const title = row.querySelector('.oe-title')?.value.trim();
        if (!title) return;
        const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const nt = norm(title);
        if (!nt) return;
        p = oeCatalog.find(x => norm(x.title) === nt)
          || oeCatalog.find(x => norm(x.title).includes(nt) || nt.includes(norm(x.title)));
    }
    if (!p) { oeSetRowMeta(row); return; }

    row.dataset.productId = String(p.id);
    row.querySelector('.oe-title').value = p.title;
    row.querySelector('.oe-thumb-slot').innerHTML = oeThumbHtml(p.image);
    const currentSize = row.querySelector('.oe-size-input')?.value.trim() || null;
    oeBuildVariantSelect(row, p, currentSize);
}

function oeComputeSubtotal() {
    let subtotal = 0;
    document.querySelectorAll('#oeRows .oe-row').forEach(row => {
        const qty = parseInt(row.querySelector('.oe-qty').value) || 0;
        const price = parseFloat(row.querySelector('.oe-price').value) || 0;
        const line = qty * price;
        subtotal += line;
        const lt = row.querySelector('.oe-line-total');
        if (lt) lt.textContent = `₹${line.toFixed(2)}`;
    });
    return subtotal;
}

function oeRecalc() {
    if (!oeState) return;
    const subtotal = oeComputeSubtotal();
    const subEl = document.getElementById('oeSubtotal');
    if (subEl) subEl.textContent = `₹${subtotal.toFixed(2)}`;

    const totalInput = document.getElementById('oeTotalInput');
    const hint = document.getElementById('oeTotalHint');
    if (!totalInput) return;
    if (!oeState.totalDirty) {
        totalInput.value = subtotal.toFixed(2);
        if (hint) hint.style.display = 'none';
    } else if (hint) {
        const total = parseFloat(totalInput.value) || 0;
        const diff = total - subtotal;
        if (Math.abs(diff) > 0.01) {
            hint.innerHTML = `⚡ Total manually set — ${diff > 0 ? '+' : '−'}₹${Math.abs(diff).toFixed(2)} vs items subtotal. <a href="#" style="color:#25d366;" onclick="event.preventDefault(); oeState.totalDirty = false; oeRecalc();">Reset to subtotal</a>`;
            hint.style.display = 'block';
        } else {
            oeState.totalDirty = false;
            hint.style.display = 'none';
        }
    }
}

function oeSetPayment(mode, silent = false) {
    if (!oeState) return;
    oeState.payment = mode;
    document.getElementById('oePayCod')?.classList.toggle('active', mode === 'COD');
    document.getElementById('oePayPrepaid')?.classList.toggle('active', mode === 'Prepaid');
    const note = document.getElementById('oePayNote');
    if (!note) return;
    if (mode === oeState.originalPayment) {
        note.className = 'oe-pay-note';
        note.style.color = '#888';
        note.textContent = `Current method: ${oeState.originalPayment}`;
    } else if (mode === 'Prepaid') {
        note.className = 'oe-pay-note';
        note.style.color = '';
        note.textContent = '✓ Will convert COD → Prepaid on save (no cash collection)';
    } else {
        note.className = 'oe-pay-note warn';
        note.style.color = '';
        note.textContent = '⚠️ Will convert Prepaid → COD on save — courier collects the order total';
    }
    if (!silent) oeRecalc();
}

// Snapshot of the editor — what gets persisted to store_shoppers
function getOrderEditorState() {
    const items = [];
    document.querySelectorAll('#oeRows .oe-row').forEach(row => {
        const title = row.querySelector('.oe-title').value.trim();
        if (!title) return;
        const item = {
            title,
            quantity: parseInt(row.querySelector('.oe-qty').value) || 1,
            price: parseFloat(row.querySelector('.oe-price').value) || 0
        };
        const sel = row.querySelector('select.oe-variant');
        if (sel) {
            const opt = sel.options[sel.selectedIndex];
            if (opt?.dataset?.size) item.size = opt.dataset.size;
        } else {
            const sizeText = row.querySelector('.oe-size-input')?.value.trim();
            if (sizeText) item.size = sizeText;
        }
        if (row.dataset.productId) item.product_id = row.dataset.productId;
        if (row.dataset.variantId) item.variant_id = row.dataset.variantId;
        items.push(item);
    });

    const orderTotal = parseFloat(document.getElementById('oeTotalInput')?.value) || 0;
    return {
        items,
        orderTotal,
        paymentMethod: oeState ? oeState.payment : 'COD',
        paymentChanged: oeState ? oeState.payment !== oeState.originalPayment : false
    };
}

async function updateStatus(id, status) {
    if (!confirm(`Are you sure you want to change status to ${status.toUpperCase()}?`)) return;

    try {
        const data = await apiCall(`/shoppers/${id}/status`, 'POST', { status });
        if (data.success) {
            // Surface carrier cancellation outcome for shipped orders
            if (data.shipmentCancellation?.hadShipment) {
                alert(data.message);
            }
            fetchShoppersData();
            fetchInboxCounts()
        } else {
            alert('Failed to update status');
        }
    } catch (err) {
        alert('Error updating status');
    }
}

function updateStats(shoppers, total) {
    // Stats are now handled by fetchAnalytics
}

// ==========================================
// COMPREHENSIVE ANALYTICS DASHBOARD
// ==========================================

let currentAnalyticsData = null;
let analyticsDateRange = { start: null, end: null };

function showAnalyticsView() {
    // Hide dashboard, show analytics
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('analyticsView').style.display = 'block';
    
    // Reset days to show counter
    analyticsTableDaysToShow = 7;
    
    // Apply default filter (Last 7 Days)
    applyQuickAnalyticsFilter('last7');
}

function hideAnalyticsView() {
    document.getElementById('analyticsView').style.display = 'none';
    document.getElementById('dashboardView').style.display = 'block';
}

function formatDateForInput(date) {
    // Convert to IST first, then format as YYYY-MM-DD
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffsetMs);
    const year = istDate.getUTCFullYear();
    const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function applyQuickAnalyticsFilter(range) {
    // Update active button state
    document.querySelectorAll('.quick-filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.range === range) {
            btn.classList.add('active');
        }
    });
    
    // Get current time in IST (UTC + 5:30)
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    
    const endDate = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
    const startDate = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
    
    switch(range) {
        case 'today':
            // Today only in IST
            break;
        case 'yesterday':
            startDate.setUTCDate(startDate.getUTCDate() - 1);
            endDate.setUTCDate(endDate.getUTCDate() - 1);
            break;
        case 'last7':
            startDate.setUTCDate(startDate.getUTCDate() - 6);
            break;
        case 'last30':
            startDate.setUTCDate(startDate.getUTCDate() - 29);
            break;
        case 'thisMonth':
            startDate.setUTCDate(1);
            break;
    }
    
    // Format dates as YYYY-MM-DD using UTC methods
    const formatDateForInput = (d) => {
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    
    // Update date inputs
    document.getElementById('analyticsStartDate').value = formatDateForInput(startDate);
    document.getElementById('analyticsEndDate').value = formatDateForInput(endDate);
    
    // Auto-fetch data
    fetchDetailedAnalytics();
}

async function fetchDetailedAnalytics() {
    try {
        const startDate = document.getElementById('analyticsStartDate').value;
        const endDate = document.getElementById('analyticsEndDate').value;
        
        // Reset days to show counter when date filter changes
        analyticsTableDaysToShow = 7;
        
        // Use lightweight aggregated endpoint - no raw shopper records loaded into memory
        const url = `${API_BASE}/chat/analytics/overview?startDate=${startDate}&endDate=${endDate}`;
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        
        if (!data.success) {
            throw new Error('No data available');
        }
        
        // Build analytics from server-side aggregated data
        currentAnalyticsData = processAnalyticsData(data, startDate, endDate);
        
        // Render all components
        renderAnalyticsDashboard();
        
    } catch (error) {
        console.error('Failed to fetch analytics:', error);
        alert('Failed to load analytics data. Please try again.');
    }
}

function processAnalyticsData(data, startDate, endDate) {
    const overview = data.overview || {};
    const dailyRaw = data.daily || [];
    
    // Build stats from server-side aggregated counts
    // 'shipped' is tracked separately so shipped orders aren't mixed into 'confirmed'
    const stats = {
        total: overview.total_orders || 0,
        confirmed: overview.confirmed_count || 0,
        shipped: overview.shipped_count || 0,
        pending: overview.pending_count || 0,
        cancelled: overview.cancelled_count || 0,
        edit_details: overview.edit_requests_count || 0,
        daily: {}
    };
    
    // Initialize all dates in the range (fill gaps with zeros)
    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        stats.daily[dateKey] = {
            date: dateKey,
            total: 0,
            confirmed: 0,
            shipped: 0,
            pending: 0,
            cancelled: 0,
            edit_details: 0,
            responded: 0
        };
    }
    
    // Merge server-side daily aggregated data (already in IST from backend)
    dailyRaw.forEach(day => {
        if (stats.daily[day.date]) {
            stats.daily[day.date] = {
                date: day.date,
                total: day.total || 0,
                confirmed: day.confirmed || 0,
                shipped: day.shipped || 0,
                pending: day.pending || 0,
                cancelled: day.cancelled || 0,
                edit_details: day.edit_details || 0,
                responded: day.responded || 0
            };
        }
    });
    
    // Convert daily to array and sort by date
    stats.dailyArray = Object.values(stats.daily).sort((a, b) => a.date.localeCompare(b.date));
    
    // Calculate percentages from aggregated totals
    stats.percentages = {
        confirmed: stats.total > 0 ? Math.round((stats.confirmed / stats.total) * 100) : 0,
        shipped: stats.total > 0 ? Math.round((stats.shipped / stats.total) * 100) : 0,
        pending: stats.total > 0 ? Math.round((stats.pending / stats.total) * 100) : 0,
        cancelled: stats.total > 0 ? Math.round((stats.cancelled / stats.total) * 100) : 0,
        edit_details: stats.total > 0 ? Math.round((stats.edit_details / stats.total) * 100) : 0
    };
    
    return stats;
}

function renderAnalyticsDashboard() {
    if (!currentAnalyticsData) return;
    
    renderStatCards();
    renderCircularCharts();
    renderDailyBarChart();
    renderTrendChart();
    renderAnalyticsTable();
}

function renderStatCards() {
    const data = currentAnalyticsData;
    
    // Animate counters
    animateCounter('analyticsTotalOrders', data.total);
    animateCounter('analyticsConfirmed', data.confirmed);
    animateCounter('analyticsShipped', data.shipped);
    animateCounter('analyticsPending', data.pending);
    animateCounter('analyticsCancelled', data.cancelled);
    animateCounter('analyticsEdits', data.edit_details);
    
    // Update percentages
    document.getElementById('analyticsConfirmedPct').textContent = data.percentages.confirmed + '%';
    document.getElementById('analyticsShippedPct').textContent = data.percentages.shipped + '%';
    document.getElementById('analyticsPendingPct').textContent = data.percentages.pending + '%';
    document.getElementById('analyticsCancelledPct').textContent = data.percentages.cancelled + '%';
    document.getElementById('analyticsEditsPct').textContent = data.percentages.edit_details + '%';
}

function animateCounter(elementId, targetValue) {
    const element = document.getElementById(elementId);
    const duration = 1000;
    const startTime = performance.now();
    const startValue = 0;
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeProgress = 1 - Math.pow(1 - progress, 3); // Ease out cubic
        const currentValue = Math.round(startValue + (targetValue - startValue) * easeProgress);
        element.textContent = currentValue.toLocaleString();
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

function renderCircularCharts() {
    const data = currentAnalyticsData;
    const circumference = 2 * Math.PI * 45; // r=45
    
    // Update each circle
    updateCircle('circleConfirmed', 'chartConfirmedValue', data.percentages.confirmed, circumference);
    updateCircle('circleShipped', 'chartShippedValue', data.percentages.shipped, circumference);
    updateCircle('circlePending', 'chartPendingValue', data.percentages.pending, circumference);
    updateCircle('circleCancelled', 'chartCancelledValue', data.percentages.cancelled, circumference);
    updateCircle('circleEdits', 'chartEditsValue', data.percentages.edit_details, circumference);
}

function updateCircle(circleId, valueId, percentage, circumference) {
    const circle = document.getElementById(circleId);
    const valueEl = document.getElementById(valueId);
    const offset = circumference - (percentage / 100) * circumference;
    
    circle.style.strokeDashoffset = offset;
    valueEl.textContent = percentage + '%';
}

function renderDailyBarChart() {
    const container = document.getElementById('dailyBarChart');
    const data = currentAnalyticsData.dailyArray;
    
    // Get max value for scaling
    const maxValue = Math.max(...data.map(d => d.total), 1);
    
    // Show last 14 days only for readability
    const recentData = data.slice(-14);
    
    let html = '';
    recentData.forEach(day => {
        const height = day.total > 0 ? (day.total / maxValue) * 100 : 0;
        const dateLabel = formatISTDateLabel(day.date);
        
        html += `
            <div class="bar-chart-item">
                <div class="bar-chart-bar-wrapper">
                    <div class="bar-chart-bar" style="height: 0%;" data-value="${day.total}"></div>
                </div>
                <div class="bar-chart-label">${dateLabel}</div>
            </div>
        `;
    });
    
    container.innerHTML = html;
    
    // Animate bars after render
    setTimeout(() => {
        const bars = container.querySelectorAll('.bar-chart-bar');
        recentData.forEach((day, index) => {
            const height = day.total > 0 ? (day.total / maxValue) * 100 : 0;
            if (bars[index]) {
                bars[index].style.height = height + '%';
            }
        });
    }, 100);
}

function renderTrendChart() {
    const svg = document.getElementById('trendChart');
    const data = currentAnalyticsData.dailyArray;
    
    if (data.length < 2) {
        svg.innerHTML = '<text x="400" y="100" text-anchor="middle" fill="rgba(255,255,255,0.5)">Not enough data</text>';
        return;
    }
    
    const maxValue = Math.max(...data.map(d => d.total), 1);
    const width = 800;
    const height = 200;
    const padding = 20;
    
    // Generate points
    const points = data.map((day, index) => {
        const x = padding + (index / (data.length - 1)) * (width - 2 * padding);
        const y = height - padding - (day.total / maxValue) * (height - 2 * padding);
        return `${x},${y}`;
    }).join(' ');
    
    // Generate area path
    const areaPath = `${points} ${width - padding},${height - padding} ${padding},${height - padding}`;
    
    // Generate dots with animation delay
    let dotsHtml = '';
    data.forEach((day, index) => {
        const x = padding + (index / (data.length - 1)) * (width - 2 * padding);
        const y = height - padding - (day.total / maxValue) * (height - 2 * padding);
        const delay = (index / data.length) * 1.5;
        dotsHtml += `<circle class="trend-dot" cx="${x}" cy="${y}" style="animation-delay: ${delay}s" />`;
    });
    
    svg.innerHTML = `
        <defs>
            <linearGradient id="trendGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" style="stop-color:#2ed573;stop-opacity:0.4" />
                <stop offset="100%" style="stop-color:#2ed573;stop-opacity:0" />
            </linearGradient>
        </defs>
        <polygon class="trend-area" points="${areaPath}" />
        <polyline class="trend-line" points="${points}" />
        ${dotsHtml}
    `;
    
    // Update labels
    const labelsContainer = document.getElementById('trendLabels');
    const startLabel = formatISTDateLabel(data[0].date);
    const endLabel = formatISTDateLabel(data[data.length - 1].date);
    labelsContainer.innerHTML = `<span>${startLabel}</span><span>${endLabel}</span>`;
}

// Track how many days to show in the analytics table
let analyticsTableDaysToShow = 7;

function renderAnalyticsTable() {
    const tbody = document.getElementById('analyticsTableBody');
    const allData = currentAnalyticsData.dailyArray.slice().reverse(); // Most recent first
    
    // Show only the specified number of days initially
    const dataToShow = allData.slice(0, analyticsTableDaysToShow);
    const hasMoreData = allData.length > analyticsTableDaysToShow;
    
    let html = '';
    dataToShow.forEach(day => {
        const responseRate = day.total > 0 ? Math.round((day.responded / day.total) * 100) : 0;
        const dateLabel = formatISTDateLabel(day.date, 'long');
        
        // Calculate percentages relative to total orders for that day
        const confirmedPct = day.total > 0 ? Math.round((day.confirmed / day.total) * 100) : 0;
        const shippedPct = day.total > 0 ? Math.round((day.shipped / day.total) * 100) : 0;
        const pendingPct = day.total > 0 ? Math.round((day.pending / day.total) * 100) : 0;
        const cancelledPct = day.total > 0 ? Math.round((day.cancelled / day.total) * 100) : 0;
        const editsPct = day.total > 0 ? Math.round((day.edit_details / day.total) * 100) : 0;
        
        html += `
            <tr>
                <td>${dateLabel}</td>
                <td>${day.total}</td>
                <td class="status-count confirmed">${day.confirmed} <span class="status-pct">(${confirmedPct}%)</span></td>
                <td class="status-count shipped">${day.shipped} <span class="status-pct">(${shippedPct}%)</span></td>
                <td class="status-count pending">${day.pending} <span class="status-pct">(${pendingPct}%)</span></td>
                <td class="status-count cancelled">${day.cancelled} <span class="status-pct">(${cancelledPct}%)</span></td>
                <td class="status-count edits">${day.edit_details} <span class="status-pct">(${editsPct}%)</span></td>
                <td>${responseRate}%</td>
                <td>
                    <div class="day-actions">
                        <button class="btn-download-day" onclick="downloadDayReport('${day.date}')" title="Download all daily orders">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                        </button>
                        <button class="btn-download-day btn-download-confirmed" onclick="downloadDayReport('${day.date}', 'confirmed')" title="Download confirmed orders">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            <span>C</span>
                        </button>
                        <button class="btn-download-day btn-download-shipped" onclick="downloadDayReport('${day.date}', 'shipped')" title="Download shipped orders">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            <span>S</span>
                        </button>
                        <button class="btn-download-day btn-download-cancelled" onclick="downloadDayReport('${day.date}', 'cancelled')" title="Download cancelled orders">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            <span>X</span>
                        </button>
                        <button class="btn-download-day btn-download-edit" onclick="downloadDayReport('${day.date}', 'edit_details')" title="Download edit requests">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            <span>E</span>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });
    
    // Add "Show More" row if there are more days to display
    if (hasMoreData) {
        const remainingDays = allData.length - analyticsTableDaysToShow;
        html += `
            <tr class="show-more-row">
                <td colspan="9" style="text-align: center; padding: 1rem;">
                    <button class="btn-show-more" onclick="showMoreAnalyticsDays()">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 6px;">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                        Show ${Math.min(remainingDays, 7)} more days (${remainingDays} remaining)
                    </button>
                </td>
            </tr>
        `;
    }
    
    tbody.innerHTML = html;
}

function showMoreAnalyticsDays() {
    analyticsTableDaysToShow += 7;
    renderAnalyticsTable();
}

async function downloadDayReport(date, statusFilter) {
    if (!currentAnalyticsData) return;
    
    // Find the day's aggregated data
    const dayData = currentAnalyticsData.dailyArray.find(d => d.date === date);
    if (!dayData || dayData.total === 0) {
        alert('No data found for this date');
        return;
    }
    
    // Fetch shoppers for this specific day on-demand (filtered by date + status)
    try {
        let url = `${API_BASE}/shoppers?noLimit=true&startDate=${date}&endDate=${date}`;
        if (statusFilter) {
            url += `&status=${statusFilter}`;
        }
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        
        const shoppersToExport = data.shoppers || [];
        if (shoppersToExport.length === 0) {
            const label = statusFilter ? statusFilter.replace('_', ' ') : 'orders';
            alert(`No ${label} found for this date`);
            return;
        }
        
        // Build report
        const dateLabel = formatISTDateLabel(date, 'full');
        const statusLabel = statusFilter 
            ? statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1).replace('_', ' ') 
            : 'Orders';
        let csv = `${statusLabel} Report - ${dateLabel}\n`;
        csv += `Total Orders: ${dayData.total} | Confirmed: ${dayData.confirmed} | Shipped: ${dayData.shipped} | Pending: ${dayData.pending} | Cancelled: ${dayData.cancelled} | Edits: ${dayData.edit_details}\n\n`;
        
        // CSV Headers
        csv += 'Order ID,Customer Name,Phone,Email,Status,Total Amount,Delivery Type,Address,Products,Customer Message,Created At\n';
        
        // Escape fields that might contain commas
        const escapeCsv = (field) => {
            if (field === null || field === undefined) return '';
            const str = String(field);
            if (str.includes(',') || str.includes('\n') || str.includes('"')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        };
        
        // Add each shopper as a row
        shoppersToExport.forEach(s => {
            let items = [];
            try { items = JSON.parse(s.items_json || '[]'); } catch(e) {}
            const productsList = items.map(item => {
                let size = item.size || item.variant_size || item.product_size || '';
                if (!size && item.variant_title) {
                    const sizeMatch = item.variant_title.match(/Size:\s*(\w+)/i) || item.variant_title.match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
                    if (sizeMatch) size = sizeMatch[1].toUpperCase();
                }
                const sizeDisplay = size ? ` (Size: ${size})` : '';
                return `${item.title || item.name}${sizeDisplay} x${item.quantity || 1}`;
            }).join('; ');
            
            csv += `${escapeCsv(s.order_id)},${escapeCsv(s.name)},${escapeCsv(s.phone)},${escapeCsv(s.email)},${escapeCsv(s.status || 'pending')},${escapeCsv(s.order_total)},${escapeCsv(s.delivery_type || 'Standard')},${escapeCsv(s.address)},${escapeCsv(productsList)},${escapeCsv(s.customer_message || '')},${escapeCsv(formatDate(s.created_at))}\n`;
        });
        
        // Download file
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const blobUrl = URL.createObjectURL(blob);
        link.setAttribute('href', blobUrl);
        const filenamePrefix = statusFilter ? `${statusFilter}_orders` : 'daily_orders';
        link.setAttribute('download', `${filenamePrefix}_${date}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (error) {
        console.error('Failed to download day report:', error);
        alert('Failed to download report. Please try again.');
    }
}

function exportAnalyticsToExcel() {
    if (!currentAnalyticsData) {
        alert('No data to export');
        return;
    }
    
    const data = currentAnalyticsData;
    const startDate = document.getElementById('analyticsStartDate').value;
    const endDate = document.getElementById('analyticsEndDate').value;
    
    // Create CSV content
    let csv = 'Date,Total Orders,Confirmed,Shipped,Pending,Cancelled,Edit Requests,Response Rate\n';
    
    data.dailyArray.forEach(day => {
        const responseRate = day.total > 0 ? Math.round((day.responded / day.total) * 100) : 0;
        csv += `${day.date},${day.total},${day.confirmed},${day.shipped},${day.pending},${day.cancelled},${day.edit_details},${responseRate}%\n`;
    });
    
    // Add summary row
    csv += `\nSUMMARY,,,,,,,\n`;
    csv += `Total Orders,${data.total},,,,,,\n`;
    csv += `Confirmed,${data.confirmed},${data.percentages.confirmed}%,,,,,\n`;
    csv += `Shipped,${data.shipped},${data.percentages.shipped}%,,,,,\n`;
    csv += `Pending,${data.pending},${data.percentages.pending}%,,,,,\n`;
    csv += `Cancelled,${data.cancelled},${data.percentages.cancelled}%,,,,,\n`;
    csv += `Edit Requests,${data.edit_details},${data.percentages.edit_details}%,,,,,\n`;
    
    // Download file
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `analytics_report_${startDate}_to_${endDate}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Keep old function name for backward compatibility but redirect to new view
function showAnalyticsModal() {
    showAnalyticsView();
}

// ==========================================
// Quick Date Filter Functions
// ==========================================
function applyQuickDateFilter(range) {
    // Update active state on buttons
    document.querySelectorAll('.quick-date-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.range === range) {
            btn.classList.add('active');
        }
    });
    
    currentQuickDateFilter = range;
    
    // Get current time in IST (UTC + 5:30)
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    
    // Format date using UTC methods on IST-adjusted date
    const formatDateIST = (d) => {
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    
    let startDate = '';
    let endDate = '';
    
    switch(range) {
        case 'today':
            // Today in IST: from start of today to end of today
            const todayStart = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            startDate = formatDateIST(todayStart);
            endDate = formatDateIST(todayStart);
            break;
        case 'yesterday':
            // Yesterday in IST: from start of yesterday to end of yesterday
            const yesterday = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 1));
            startDate = formatDateIST(yesterday);
            endDate = formatDateIST(yesterday);
            break;
        case 'last7':
            // Last 7 days in IST: from 6 days ago to today
            const last7 = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 6));
            const today7 = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            startDate = formatDateIST(last7);
            endDate = formatDateIST(today7);
            break;
        case 'last30':
            // Last 30 days in IST: from 29 days ago to today
            const last30 = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 29));
            const today30 = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            startDate = formatDateIST(last30);
            endDate = formatDateIST(today30);
            break;
        case 'thisMonth':
            // This month in IST: from 1st of month to today
            const firstDay = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1));
            const todayMonth = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            startDate = formatDateIST(firstDay);
            endDate = formatDateIST(todayMonth);
            break;
    }
    
    console.log(`[Quick Filter] ${range}: ${startDate} to ${endDate}`);
    
    document.getElementById('startDate').value = startDate;
    document.getElementById('endDate').value = endDate;
    
    currentPageOffset = 0;
    updateClearFiltersButton();
    fetchShoppersData();
}

function clearQuickDateFilter() {
    currentQuickDateFilter = null;
    document.querySelectorAll('.quick-date-btn').forEach(btn => {
        btn.classList.remove('active');
    });
}

function clearAllFilters() {
    // Reset status
    currentStatus = 'all';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-filter="all"]')?.classList.add('active');
    
    // Reset search
    document.getElementById('searchInput').value = '';
    
    // Reset dates
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';
    clearQuickDateFilter();
    
    // Reset order ID
    document.getElementById('orderIdFrom').value = '';
    document.getElementById('orderIdTo').value = '';
    currentOrderIdFrom = '';
    currentOrderIdTo = '';
    
    // Reset advanced filters
    document.getElementById('paymentMethodFilter').value = '';
    document.getElementById('deliveryTypeFilter').value = '';
    document.getElementById('sortByFilter').value = 'newest';
    currentPaymentMethod = '';
    currentDeliveryType = '';
    currentSortBy = 'newest';
    
    // Clear any selection
    clearSelection();
    
    currentPageOffset = 0;
    allLoadedShoppers = [];
    updateClearFiltersButton();
    fetchShoppersData();
}

function updateClearFiltersButton() {
    const hasFilters = currentStatus !== 'all' || 
                       document.getElementById('searchInput')?.value ||
                       document.getElementById('startDate')?.value ||
                       document.getElementById('endDate')?.value ||
                       currentOrderIdFrom || currentOrderIdTo ||
                       currentPaymentMethod || currentDeliveryType ||
                       currentSortBy !== 'newest';
    
    const clearBtn = document.getElementById('clearFiltersBtn');
    if (clearBtn) {
        clearBtn.style.display = hasFilters ? 'inline-flex' : 'none';
    }
}

// ==========================================
// Export Modal Functions
// ==========================================
function openExportModal() {
    if (!hubRequirePerm('export', 'export data')) return;
    // Pre-fill with current filter values
    const exportModal = document.getElementById('exportModal');
    const exportDateRange = document.getElementById('exportDateRange');
    const exportOrderIdFrom = document.getElementById('exportOrderIdFrom');
    const exportOrderIdTo = document.getElementById('exportOrderIdTo');
    
    // Set current filters
    if (currentOrderIdFrom) exportOrderIdFrom.value = currentOrderIdFrom;
    if (currentOrderIdTo) exportOrderIdTo.value = currentOrderIdTo;
    
    // Set date range based on current quick filter
    if (currentQuickDateFilter) {
        exportDateRange.value = currentQuickDateFilter;
    } else if (document.getElementById('startDate')?.value) {
        exportDateRange.value = 'custom';
        document.getElementById('customDateRange').style.display = 'block';
        document.getElementById('exportStartDate').value = document.getElementById('startDate').value;
        document.getElementById('exportEndDate').value = document.getElementById('endDate').value;
    } else {
        exportDateRange.value = 'current';
    }
    
    exportModal.classList.add('active');
}

function closeExportModal() {
    document.getElementById('exportModal').classList.remove('active');
}

function setupExportModalEvents() {
    // Cancel button
    document.getElementById('cancelExport')?.addEventListener('click', closeExportModal);
    
    // Close on backdrop click
    document.getElementById('exportModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'exportModal') closeExportModal();
    });
    
    // Date range change
    document.getElementById('exportDateRange')?.addEventListener('change', (e) => {
        const customRange = document.getElementById('customDateRange');
        if (e.target.value === 'custom') {
            customRange.style.display = 'block';
        } else {
            customRange.style.display = 'none';
        }
    });
    
    // Confirm export
    document.getElementById('confirmExport')?.addEventListener('click', handleExport);
}

async function handleExport() {
    const btn = document.getElementById('confirmExport');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Exporting...';
    btn.disabled = true;

    try {
        // Get export options
        const exportType = document.getElementById('exportType')?.value || 'all';
        const exportDateRange = document.getElementById('exportDateRange')?.value || 'current';
        const exportFormat = document.getElementById('exportFormat')?.value || 'xlsx';
        const includeCustomerMessage = document.getElementById('includeCustomerMessage')?.checked;
        const includeAddress = document.getElementById('includeAddress')?.checked;
        
        // Determine status based on export type
        let exportStatus = currentStatus;
        if (exportType === 'confirmed') exportStatus = 'confirmed';
        else if (exportType === 'cancelled') exportStatus = 'cancelled';
        else if (exportType === 'pending') exportStatus = 'pending';
        
        // Determine dates based on export date range
        let startDate = '';
        let endDate = '';
        
        if (exportDateRange === 'custom') {
            startDate = document.getElementById('exportStartDate')?.value || '';
            endDate = document.getElementById('exportEndDate')?.value || '';
        } else if (exportDateRange === 'current') {
            startDate = document.getElementById('startDate')?.value || '';
            endDate = document.getElementById('endDate')?.value || '';
        } else {
            // Calculate dates for quick filters (IST-aware)
            const now = new Date();
            const istOffsetMs = 5.5 * 60 * 60 * 1000;
            const istNow = new Date(now.getTime() + istOffsetMs);
            
            // Format date using UTC methods on IST-adjusted date (same as main quick filter)
            const formatDateIST = (d) => {
                const year = d.getUTCFullYear();
                const month = String(d.getUTCMonth() + 1).padStart(2, '0');
                const day = String(d.getUTCDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            };
            
            switch(exportDateRange) {
                case 'today':
                    startDate = formatDateIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())));
                    endDate = startDate;
                    break;
                case 'yesterday':
                    const yesterday = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 1));
                    startDate = formatDateIST(yesterday);
                    endDate = startDate;
                    break;
                case 'last7':
                    startDate = formatDateIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 6)));
                    endDate = formatDateIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())));
                    break;
                case 'last30':
                    startDate = formatDateIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 29)));
                    endDate = formatDateIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())));
                    break;
                case 'thisMonth':
                    startDate = formatDateIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1)));
                    endDate = formatDateIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())));
                    break;
            }
        }
        
        // Get order ID range
        const orderIdFrom = document.getElementById('exportOrderIdFrom')?.value || currentOrderIdFrom;
        const orderIdTo = document.getElementById('exportOrderIdTo')?.value || currentOrderIdTo;
        
        const queryParams = new URLSearchParams({
            status: exportStatus,
            startDate,
            endDate,
            orderIdFrom,
            orderIdTo,
            format: exportFormat,
            includeCustomerMessage: includeCustomerMessage ? '1' : '0',
            includeAddress: includeAddress ? '1' : '0',
            exportType: exportType === 'daily' ? 'daily' : 'normal'
        });

        const res = await fetch(`${API_BASE}/shoppers/export?${queryParams.toString()}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            
            // Generate filename using IST date
            const now = new Date();
            const istOffsetMs = 5.5 * 60 * 60 * 1000;
            const istNow = new Date(now.getTime() + istOffsetMs);
            const dateStr = `${istNow.getUTCFullYear()}-${String(istNow.getUTCMonth() + 1).padStart(2, '0')}-${String(istNow.getUTCDate()).padStart(2, '0')}`;
            const ext = exportFormat === 'csv' ? 'csv' : 'xlsx';
            let filename = `shoppers_${exportStatus}_${dateStr}.${ext}`;
            if (exportType === 'daily') filename = `daily_report_${dateStr}.${ext}`;
            
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();
            closeExportModal();
        } else {
            alert('Export failed');
        }
    } catch (e) {
        console.error('Export error:', e);
        alert('Export error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function formatPhone(phone) {
    if (!phone) return 'N/A';
    return phone.replace('+', '');
}

function formatPhoneForCall(phone) {
    if (!phone) return '';
    // Remove +91 or 91 prefix for local dialing
    return phone.replace(/^\+?91/, '');
}

function formatDate(isoString) {
    if (!isoString) return 'N/A';

    // Parse the input date as UTC, then convert to IST (+5:30)
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'N/A';

    // IST is UTC+5:30
    // Add 5 hours 30 minutes
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istTime = d.getTime() + istOffsetMs;
    const istDate = new Date(istTime);

    // Format using UTC methods to avoid local timezone interference
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const month = months[istDate.getUTCMonth()];
    const day = istDate.getUTCDate();

    // Format time
    let hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;

    return `${day} ${month}, ${hours}:${minutes} ${ampm}`;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Make functions available globally for onclick handlers
window.openEditModal = openEditModal;
window.pullShopifyAddress = pullShopifyAddress;
window.openChat = openChat;
window.updateStatus = updateStatus;
window.toggleCardSelection = toggleCardSelection;
window.clearSelection = clearSelection;
window.bulkUpdateStatus = bulkUpdateStatus;
window.bulkDelete = bulkDelete;
window.selectAllVisible = selectAllVisible;
window.selectAllMatching = selectAllMatching;

// ============================================
// FOLLOW-UP SYSTEM
// ============================================

let currentFollowUpCampaign = null;
let selectedFollowUpShoppers = new Set();
let followUpCampaignsData = [];
let currentWizardStep = 1;
let campaignRecipients = [];

// Initialize Follow-Up System
document.addEventListener('DOMContentLoaded', () => {
    setupFollowUpEvents();
});

function setupFollowUpEvents() {
    // Follow-Up Button
    const followUpBtn = document.getElementById('followUpBtn');
    if (followUpBtn) {
        followUpBtn.addEventListener('click', () => {
            showFollowUpView();
            loadFollowUpCampaigns();
        });
    }
    
    // Back to Shoppers button
    const backToShoppersFromFollowUp = document.getElementById('backToShoppersFromFollowUp');
    if (backToShoppersFromFollowUp) {
        backToShoppersFromFollowUp.addEventListener('click', hideFollowUpView);
    }
    
    // Create Campaign button
    const createCampaignBtn = document.getElementById('createCampaignBtn');
    if (createCampaignBtn) {
        createCampaignBtn.addEventListener('click', openCampaignWizard);
    }
    
    // Campaign Wizard Events
    setupCampaignWizardEvents();
    
    // Follow-Up Analytics button
    const followUpAnalyticsBtn = document.getElementById('followUpAnalyticsBtn');
    if (followUpAnalyticsBtn) {
        followUpAnalyticsBtn.addEventListener('click', showFollowUpAnalytics);
    }
}

function setupCampaignWizardEvents() {
    // Close wizard
    const closeWizardBtn = document.getElementById('closeCampaignWizard');
    if (closeWizardBtn) {
        closeWizardBtn.addEventListener('click', closeCampaignWizard);
    }
    
    // Wizard navigation
    const wizardNextBtn = document.getElementById('wizardNextBtn');
    const wizardPrevBtn = document.getElementById('wizardPrevBtn');
    
    if (wizardNextBtn) {
        wizardNextBtn.addEventListener('click', () => {
            if (currentWizardStep < 3) {
                goToWizardStep(currentWizardStep + 1);
            } else {
                sendCampaign();
            }
        });
    }
    
    if (wizardPrevBtn) {
        wizardPrevBtn.addEventListener('click', () => {
            if (currentWizardStep > 1) {
                goToWizardStep(currentWizardStep - 1);
            }
        });
    }
    
    // Recipient tabs
    document.querySelectorAll('.recipient-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.recipient-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.recipient-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.querySelector(`.recipient-tab-content[data-tab="${tabName}"]`).classList.add('active');
        });
    });
    
    // File upload
    const fileUpload = document.getElementById('campaignFileUpload');
    if (fileUpload) {
        fileUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                document.getElementById('selectedFileName').textContent = file.name;
            }
        });
    }
    
    // Campaign name input - update review
    const campaignName = document.getElementById('campaignName');
    if (campaignName) {
        campaignName.addEventListener('input', updateReviewSummary);
    }
    
    // Select all pending checkbox
    const selectAllPending = document.getElementById('selectAllPending');
    if (selectAllPending) {
        selectAllPending.addEventListener('change', (e) => {
            document.querySelectorAll('.pending-shopper-checkbox').forEach(cb => {
                cb.checked = e.target.checked;
                const shopperId = cb.dataset.shopperId;
                if (e.target.checked) {
                    selectedFollowUpShoppers.add(shopperId);
                } else {
                    selectedFollowUpShoppers.delete(shopperId);
                }
            });
            updateSelectedPendingCount();
        });
    }
}

function showFollowUpView() {
    document.querySelector('.dashboard-main').style.display = 'none';
    document.getElementById('followUpView').style.display = 'block';
}

function hideFollowUpView() {
    document.getElementById('followUpView').style.display = 'none';
    document.querySelector('.dashboard-main').style.display = 'block';
}

async function loadFollowUpCampaigns() {
    const grid = document.getElementById('campaignsGrid');
    grid.innerHTML = '<div class="table-loading"><div class="spinner"></div><span>Loading campaigns...</span></div>';
    
    try {
        const response = await fetch(`${API_BASE}/follow-up/campaigns`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load campaigns');
        
        const data = await response.json();
        const campaigns = Array.isArray(data) ? data : (data.campaigns || []);
        followUpCampaignsData = campaigns;
        renderCampaigns(campaigns);
    } catch (error) {
        console.error('Error loading campaigns:', error);
        grid.innerHTML = `
            <div style="text-align: center; padding: 3rem; color: rgba(255,255,255,0.6);">
                <p>Failed to load campaigns</p>
                <button class="btn btn-outline" onclick="loadFollowUpCampaigns()" style="margin-top: 1rem;">Retry</button>
            </div>
        `;
    }
}

function renderCampaigns(campaigns) {
    const grid = document.getElementById('campaignsGrid');
    
    if (!campaigns || campaigns.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 4rem; background: rgba(255,255,255,0.03); border-radius: 12px; border: 1px dashed rgba(255,255,255,0.1);">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="opacity: 0.3; margin-bottom: 1rem;">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <h3 style="margin: 0 0 0.5rem 0; color: rgba(255,255,255,0.7);">No Campaigns Yet</h3>
                <p style="margin: 0 0 1.5rem 0; color: rgba(255,255,255,0.5); font-size: 0.9rem;">Create your first follow-up campaign to engage pending customers</p>
                <button class="btn btn-primary" onclick="openCampaignWizard()" style="background: #ffa502; color: #000; border-color: #ffa502;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 6px;">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Create Campaign
                </button>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = campaigns.map(campaign => `
        <div class="campaign-card ${campaign.status}">
            <div class="campaign-header">
                <h3 class="campaign-name">${escapeHtml(campaign.name)}</h3>
                <span class="campaign-status ${campaign.status}">${campaign.status}</span>
            </div>
            <div style="font-size: 0.8rem; color: rgba(255,255,255,0.5); margin-bottom: 1rem;">
                Created ${formatDate(campaign.created_at)}
            </div>
            <div class="campaign-stats">
                <div class="campaign-stat">
                    <div class="campaign-stat-value">${campaign.total_recipients || 0}</div>
                    <div class="campaign-stat-label">Total</div>
                </div>
                <div class="campaign-stat">
                    <div class="campaign-stat-value" style="color: #2ed573;">${campaign.responded_count || 0}</div>
                    <div class="campaign-stat-label">Responded</div>
                </div>
                <div class="campaign-stat">
                    <div class="campaign-stat-value" style="color: #ff4757;">${campaign.failed_count || 0}</div>
                    <div class="campaign-stat-label">Failed</div>
                </div>
            </div>
            <div class="campaign-actions">
                ${campaign.status === 'running' ? `
                    <button class="campaign-btn campaign-btn-outline" onclick="pauseCampaign(${campaign.id})">Pause</button>
                ` : campaign.status === 'paused' ? `
                    <button class="campaign-btn campaign-btn-primary" onclick="resumeCampaign(${campaign.id})">Resume</button>
                ` : campaign.status === 'draft' ? `
                    <button class="campaign-btn campaign-btn-primary" onclick="sendCampaignNow(${campaign.id})">Send Now</button>
                ` : ''}
                <button class="campaign-btn campaign-btn-outline" onclick="viewCampaignDetails(${campaign.id})">Details</button>
            </div>
        </div>
    `).join('');
}

function openCampaignWizard() {
    currentWizardStep = 1;
    selectedFollowUpShoppers.clear();
    campaignRecipients = [];
    
    // Reset form
    document.getElementById('campaignName').value = '';
    document.getElementById('campaignTemplate').value = 'order_follow_up_v1';
    document.getElementById('manualPhoneEntry').value = '';
    document.getElementById('selectedFileName').textContent = '';
    document.getElementById('campaignFileUpload').value = '';
    
    // Reset tabs
    document.querySelectorAll('.recipient-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.recipient-tab[data-tab="all-pending"]').classList.add('active');
    document.querySelectorAll('.recipient-tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.recipient-tab-content[data-tab="all-pending"]').classList.add('active');
    
    updateWizardUI();
    document.getElementById('campaignWizard').classList.add('active');
    
    // Load pending shoppers count
    loadPendingShoppersCount();
    loadPendingShoppersTable();
}

function closeCampaignWizard() {
    document.getElementById('campaignWizard').classList.remove('active');
}

function goToWizardStep(step) {
    currentWizardStep = step;
    updateWizardUI();
    
    if (step === 3) {
        updateReviewSummary();
    }
}

function updateWizardUI() {
    // Update step dots
    document.querySelectorAll('.step-dot').forEach(dot => {
        const dotStep = parseInt(dot.dataset.step);
        dot.classList.remove('active', 'completed');
        if (dotStep === currentWizardStep) {
            dot.classList.add('active');
        } else if (dotStep < currentWizardStep) {
            dot.classList.add('completed');
        }
    });
    
    // Show/hide steps
    document.querySelectorAll('.wizard-step').forEach(s => {
        s.classList.remove('active');
        if (parseInt(s.dataset.step) === currentWizardStep) {
            s.classList.add('active');
        }
    });
    
    // Update buttons
    const prevBtn = document.getElementById('wizardPrevBtn');
    const nextBtn = document.getElementById('wizardNextBtn');
    
    prevBtn.style.visibility = currentWizardStep === 1 ? 'hidden' : 'visible';
    nextBtn.textContent = currentWizardStep === 3 ? 'Send Campaign' : 'Next';
}

async function loadPendingShoppersCount() {
    try {
        const response = await fetch(`${API_BASE}/follow-up/pending-shoppers`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load pending shoppers');
        
        const data = await response.json();
        const shoppers = Array.isArray(data) ? data : (data.shoppers || []);
        document.getElementById('allPendingCount').textContent = shoppers.length;
    } catch (error) {
        console.error('Error loading pending count:', error);
        document.getElementById('allPendingCount').textContent = '0';
    }
}

async function loadPendingShoppersTable() {
    const tbody = document.getElementById('pendingShoppersTableBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem;">Loading...</td></tr>';
    
    try {
        const response = await fetch(`${API_BASE}/follow-up/pending-shoppers`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load pending shoppers');
        
        const data = await response.json();
        const shoppers = Array.isArray(data) ? data : (data.shoppers || []);
        
        if (!shoppers || shoppers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem; color: rgba(255,255,255,0.5);">No pending shoppers found</td></tr>';
            return;
        }
        
        tbody.innerHTML = shoppers.map(shopper => `
            <tr>
                <td><input type="checkbox" class="pending-shopper-checkbox" data-shopper-id="${shopper.id}" onchange="togglePendingShopperSelection('${shopper.id}')"></td>
                <td>${escapeHtml(shopper.order_id || 'N/A')}</td>
                <td>${escapeHtml(shopper.name || 'N/A')}</td>
                <td>${formatPhone(shopper.phone)}</td>
                <td>Rs.${shopper.order_total || 0}</td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading pending shoppers:', error);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem; color: #ff4757;">Failed to load</td></tr>';
    }
}

function togglePendingShopperSelection(shopperId) {
    const checkbox = document.querySelector(`.pending-shopper-checkbox[data-shopper-id="${shopperId}"]`);
    if (checkbox.checked) {
        selectedFollowUpShoppers.add(shopperId);
    } else {
        selectedFollowUpShoppers.delete(shopperId);
    }
    updateSelectedPendingCount();
}

function updateSelectedPendingCount() {
    document.getElementById('selectedPendingCount').textContent = selectedFollowUpShoppers.size;
}

function updateReviewSummary() {
    const name = document.getElementById('campaignName').value || 'Untitled Campaign';
    const template = document.getElementById('campaignTemplate').value;
    
    document.getElementById('reviewCampaignName').textContent = name;
    document.getElementById('reviewTemplate').textContent = template;
    
    // Calculate recipients
    let recipientCount = 0;
    const activeTab = document.querySelector('.recipient-tab.active').dataset.tab;
    
    if (activeTab === 'all-pending') {
        recipientCount = parseInt(document.getElementById('allPendingCount').textContent) || 0;
    } else if (activeTab === 'select-pending') {
        recipientCount = selectedFollowUpShoppers.size;
    } else if (activeTab === 'manual-entry') {
        const manualEntry = document.getElementById('manualPhoneEntry').value;
        recipientCount = manualEntry.split(/[\n,]/).filter(s => s.trim()).length;
    }
    
    document.getElementById('reviewRecipientCount').textContent = recipientCount;
    
    // Estimate time (3 seconds per message)
    const estMinutes = Math.ceil((recipientCount * 3) / 60);
    document.getElementById('reviewEstTime').textContent = `~${estMinutes} minute${estMinutes !== 1 ? 's' : ''}`;
}

async function sendCampaign() {
    const name = document.getElementById('campaignName').value.trim();
    if (!name) {
        alert('Please enter a campaign name');
        return;
    }
    
    const activeTab = document.querySelector('.recipient-tab.active').dataset.tab;
    let recipientData = {};
    
    if (activeTab === 'all-pending') {
        recipientData = { type: 'all_pending' };
    } else if (activeTab === 'select-pending') {
        if (selectedFollowUpShoppers.size === 0) {
            alert('Please select at least one shopper');
            return;
        }
        recipientData = { type: 'selected', shopperIds: Array.from(selectedFollowUpShoppers) };
    } else if (activeTab === 'manual-entry') {
        const manualEntry = document.getElementById('manualPhoneEntry').value;
        const entries = manualEntry.split(/[\n,]/).map(s => s.trim()).filter(s => s);
        if (entries.length === 0) {
            alert('Please enter at least one phone number or order ID');
            return;
        }
        recipientData = { type: 'manual', entries };
    } else if (activeTab === 'import-file') {
        const fileInput = document.getElementById('campaignFileUpload');
        if (!fileInput.files[0]) {
            alert('Please select a file to import');
            return;
        }
        
        // Upload file first
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        
        try {
            const uploadResponse = await fetch(`${API_BASE}/follow-up/campaigns/temp/import`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` },
                body: formData
            });
            
            if (!uploadResponse.ok) throw new Error('Failed to upload file');
            
            const uploadData = await uploadResponse.json();
            recipientData = { type: 'imported', entries: uploadData.entries };
        } catch (error) {
            alert('Failed to upload file: ' + error.message);
            return;
        }
    }
    
    // Create campaign
    try {
        const createResponse = await fetch(`${API_BASE}/follow-up/campaigns`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name,
                templateName: document.getElementById('campaignTemplate').value,
                recipients: recipientData
            })
        });
        
        if (!createResponse.ok) throw new Error('Failed to create campaign');
        
        const createData = await createResponse.json();
        const campaign = createData.campaign;
        
        if (!campaign || !campaign.id) {
            throw new Error('Invalid campaign data received');
        }
        
        // Send campaign
        const sendResponse = await fetch(`${API_BASE}/follow-up/campaigns/${campaign.id}/send`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!sendResponse.ok) throw new Error('Failed to send campaign');
        
        closeCampaignWizard();
        loadFollowUpCampaigns();
        alert('Campaign created and sending started!');
        
    } catch (error) {
        console.error('Error sending campaign:', error);
        alert('Failed to send campaign: ' + error.message);
    }
}

async function pauseCampaign(campaignId) {
    try {
        const response = await fetch(`${API_BASE}/follow-up/campaigns/${campaignId}/pause`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to pause campaign');
        
        loadFollowUpCampaigns();
    } catch (error) {
        console.error('Error pausing campaign:', error);
        alert('Failed to pause campaign');
    }
}

async function resumeCampaign(campaignId) {
    try {
        const response = await fetch(`${API_BASE}/follow-up/campaigns/${campaignId}/resume`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to resume campaign');
        
        loadFollowUpCampaigns();
    } catch (error) {
        console.error('Error resuming campaign:', error);
        alert('Failed to resume campaign');
    }
}

async function sendCampaignNow(campaignId) {
    try {
        const response = await fetch(`${API_BASE}/follow-up/campaigns/${campaignId}/send`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to send campaign');
        
        loadFollowUpCampaigns();
        alert('Campaign sending started!');
    } catch (error) {
        console.error('Error sending campaign:', error);
        alert('Failed to send campaign');
    }
}

function viewCampaignDetails(campaignId) {
    // TODO: Implement campaign details view
    alert('Campaign details view coming soon!');
}

function showFollowUpAnalytics() {
    // TODO: Implement follow-up analytics
    alert('Follow-Up Analytics coming soon!');
}

// Make follow-up functions globally available
window.loadFollowUpCampaigns = loadFollowUpCampaigns;
window.openCampaignWizard = openCampaignWizard;
window.closeCampaignWizard = closeCampaignWizard;
window.goToWizardStep = goToWizardStep;
window.togglePendingShopperSelection = togglePendingShopperSelection;
window.pauseCampaign = pauseCampaign;
window.resumeCampaign = resumeCampaign;
window.sendCampaignNow = sendCampaignNow;
window.viewCampaignDetails = viewCampaignDetails;

// ============================================================
// SHIPPING MODULE — ship confirmed orders via any configured carrier
// ============================================================
let shipState = null;          // active ship-modal wizard state
let shipCarriersCache = null;  // configured carriers (cached per session)

// Terminal shipment states — mirror the backend/DB "one open shipment per
// order" rule. Delivered/RTO are terminal too, so those orders can be re-shipped.
const SHIP_TERMINAL_STATUSES = ['cancelled', 'failed', 'delivered', 'rto'];
function isTerminalShipStatus(status) { return SHIP_TERMINAL_STATUSES.includes(status); }

function showShipToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `ship-toast ${isError ? 'error' : ''}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
}

async function loadShipCarriers(force = false) {
    if (shipCarriersCache && !force) return shipCarriersCache;
    const data = await apiCall('/shipping/carriers');
    shipCarriersCache = (data && data.success) ? data.carriers : [];
    return shipCarriersCache;
}

// ---------- Ship Modal (3-step wizard) ----------

// reshipCtx (optional) puts the wizard in re-ship mode:
// { ofShipmentId, reason, prevCarrier, prevCourierName, prevAwb }
async function openShipModal(shopperId, reshipCtx = null) {
    if (!hubRequirePerm('ship_orders', 'ship orders')) return;
    shipState = {
        shopperId,
        step: 1,
        draft: null,
        carriers: [],
        carrier: null,       // selected carrier object {key, name, capabilities}
        courier: null,       // selected courier {id, name, rate}
        serviceable: false,
        shipping: false,
        shipped: false,
        reship: reshipCtx || null
    };

    renderShipReshipBanner();
    document.getElementById('shipOrderIdLabel').textContent = '';
    const shipEditorMount = document.getElementById('shipOrderEditor');
    if (shipEditorMount) shipEditorMount.innerHTML = '<div class="ship-loading"><div class="spinner"></div><span>Loading order...</span></div>';
    document.getElementById('shipValidationErrors').style.display = 'none';
    document.getElementById('shipSuccessPanel').style.display = 'none';
    document.getElementById('shipConfirmView').style.display = 'block';
    document.getElementById('shipSubmitError').innerHTML = '';
    document.getElementById('shipNotifyCustomer').checked = false;
    setShipStep(1);
    document.getElementById('shipModal').classList.add('active');

    try {
        const [draftRes, carriers] = await Promise.all([
            apiCall(`/shipping/orders/${shopperId}/draft`),
            loadShipCarriers()
        ]);

        if (!draftRes || !draftRes.success) {
            showShipToast(draftRes?.error || 'Failed to load shipment draft', true);
            closeShipModal();
            return;
        }

        // Guard: order already has an open shipment → show history instead
        // (terminal states — cancelled/failed/delivered/rto — don't block re-shipping)
        const active = (draftRes.shipments || []).find(sh => !isTerminalShipStatus(sh.status));
        if (active) {
            closeShipModal();
            showShipToast(`Order already shipped (AWB: ${active.awb || 'pending'}). Opening shipment history.`);
            openShipmentsDrawer(shopperId, draftRes.draft.orderId);
            return;
        }

        shipState.draft = draftRes.draft;
        shipState.carriers = carriers;
        renderShipStep1();
    } catch (err) {
        console.error('[SHIP] Draft load error:', err);
        showShipToast('Error loading shipment draft', true);
        closeShipModal();
    }
}

function closeShipModal() {
    document.getElementById('shipModal').classList.remove('active');
    const wasShipped = shipState && shipState.shipped;
    shipState = null;
    if (wasShipped) {
        fetchShoppersData();
        // Also refresh the Shipped Orders view if it's open (retry / forward-ship flows)
        if (document.getElementById('shippedOrdersView')?.style.display === 'block') fetchShippedOrders();
    }
}

// Re-ship banner across all wizard steps — keeps the admin aware they're
// creating a replacement for a previous shipment (with the tracked reason)
function renderShipReshipBanner() {
    const banner = document.getElementById('shipReshipBanner');
    if (!banner) return;
    const r = shipState?.reship;
    if (!r) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
    banner.style.display = 'flex';
    banner.innerHTML = `
        <span class="reship-badge">🔄 Re-Ship</span>
        <span>Replacing ${r.prevAwb ? `AWB <b>${escapeHtml(r.prevAwb)}</b>` : `shipment #${r.ofShipmentId}`}${r.prevCourierName ? ` via ${escapeHtml(r.prevCourierName)}` : ''} · Reason: <b>${escapeHtml(r.reason)}</b></span>`;
}

function renderShipStep1() {
    const d = shipState.draft;
    document.getElementById('shipOrderIdLabel').textContent = `#${d.orderId}`;
    document.getElementById('shipName').value = d.consignee.name || '';
    document.getElementById('shipPhone').value = d.consignee.phone || '';
    document.getElementById('shipAddress').value = d.consignee.address || '';
    document.getElementById('shipCity').value = d.consignee.city || '';
    document.getElementById('shipState').value = d.consignee.state || '';
    document.getElementById('shipPincode').value = d.consignee.pincode || '';
    document.getElementById('shipWeight').value = d.package.weightGrams;
    document.getElementById('shipLength').value = d.package.lengthCm;
    document.getElementById('shipBreadth').value = d.package.breadthCm;
    document.getElementById('shipHeight').value = d.package.heightCm;

    renderShipPaymentBadge();

    // Full order editor: swap products from inventory, adjust prices, or flip COD → Prepaid pre-ship
    mountOrderEditor('shipOrderEditor', {
        items: (d.items || []).map(i => ({ title: i.name, quantity: i.quantity, price: i.price, size: i.size, sku: i.sku })),
        orderTotal: d.payment.declaredValue || 0,
        paymentMethod: d.meta?.paymentMethodRaw || d.payment.mode
    });
}

function renderShipPaymentBadge() {
    const d = shipState?.draft;
    if (!d) return;
    const isCod = d.payment.mode === 'COD';
    document.getElementById('shipPaymentBadge').innerHTML =
        `<span class="ship-pay-badge ${isCod ? 'cod' : 'prepaid'}">${isCod ? `💰 COD · ₹${d.payment.codAmount}` : `✓ Prepaid · ₹${d.payment.declaredValue}`}</span>`;
}

// Persist step-1 order edits (items / total / payment) onto the shopper row.
// Serviceability + ship rebuild their context from the DB, so the carrier
// automatically gets the corrected COD amount, declared value and items.
async function persistShipOrderEdits() {
    const st = getOrderEditorState();

    if (st.paymentChanged && !confirm(`Change payment method to ${st.paymentMethod.toUpperCase()} before shipping?`)) return false;

    try {
        const data = await apiCall(`/shoppers/${shipState.shopperId}`, 'PUT', {
            items_json: JSON.stringify(st.items),
            order_total: st.orderTotal,
            payment_method: st.paymentMethod
        });
        if (!data || !data.success) {
            showShipToast(data?.error || 'Failed to save order edits', true);
            return false;
        }

        // Shopify/GoKwik sync feedback (edits are mirrored to both platforms)
        const sync = data.shopify_sync;
        const gkSync = data.gokwik_sync;
        if (sync && sync.warnings && sync.warnings.length) {
            showShipToast(`Saved — Shopify sync: ${sync.warnings[0]}`, true);
        } else if (gkSync && !gkSync.success && !gkSync.skipped) {
            showShipToast(`Saved — GoKwik sync failed: ${gkSync.reason}`, true);
        } else if (sync && sync.actions && sync.actions.length) {
            showShipToast(gkSync && gkSync.success ? 'Order edits synced to Shopify + GoKwik' : 'Order edits synced to Shopify');
        }

        // Mirror the persisted values into the local draft so badge + summary stay truthful
        const d = shipState.draft;
        d.items = st.items.map(i => ({ name: i.title, quantity: i.quantity, price: i.price, size: i.size || null, sku: i.sku || null }));
        d.payment.mode = st.paymentMethod;
        d.payment.declaredValue = st.orderTotal;
        d.payment.codAmount = st.paymentMethod === 'COD' ? st.orderTotal : 0;
        if (d.meta) d.meta.paymentMethodRaw = st.paymentMethod;
        renderShipPaymentBadge();
        return true;
    } catch (err) {
        console.error('[SHIP] Order edit save error:', err);
        showShipToast('Error saving order edits', true);
        return false;
    }
}

// Read (possibly edited) step-1 inputs as overrides for the backend
function collectShipOverrides() {
    return {
        consigneeOverrides: {
            name: document.getElementById('shipName').value.trim(),
            phone: document.getElementById('shipPhone').value.trim(),
            address: document.getElementById('shipAddress').value.trim(),
            city: document.getElementById('shipCity').value.trim(),
            state: document.getElementById('shipState').value.trim(),
            pincode: document.getElementById('shipPincode').value.trim()
        },
        packageOverrides: {
            weightGrams: parseInt(document.getElementById('shipWeight').value) || 0,
            lengthCm: parseFloat(document.getElementById('shipLength').value) || 0,
            breadthCm: parseFloat(document.getElementById('shipBreadth').value) || 0,
            heightCm: parseFloat(document.getElementById('shipHeight').value) || 0
        }
    };
}

function validateShipStep1() {
    const o = collectShipOverrides();
    const errors = [];
    if (!o.consigneeOverrides.name) errors.push('Consignee name is required');
    if (!/^\d{10}$/.test(o.consigneeOverrides.phone.replace(/\D/g, '').slice(-10))) errors.push('Valid 10-digit phone is required');
    if (o.consigneeOverrides.address.length < 5) errors.push('Delivery address is required');
    if (!/^\d{6}$/.test(o.consigneeOverrides.pincode)) errors.push('Valid 6-digit pincode is required');
    if (!(o.packageOverrides.weightGrams > 0)) errors.push('Weight must be greater than 0');

    // Order editor checks (items / pricing / payment)
    const st = getOrderEditorState();
    if (st.items.length === 0) errors.push('At least one order item is required');
    if (st.paymentMethod === 'COD' && !(st.orderTotal > 0)) errors.push('Order total must be greater than 0 for COD shipments');

    const box = document.getElementById('shipValidationErrors');
    if (errors.length > 0) {
        box.innerHTML = errors.map(e => `⚠️ ${e}`).join('<br>');
        box.style.display = 'block';
        return false;
    }
    box.style.display = 'none';
    return true;
}

function setShipStep(step) {
    shipState && (shipState.step = step);
    for (let i = 1; i <= 3; i++) {
        document.getElementById(`shipStep${i}`).classList.toggle('active', i === step);
        const tab = document.getElementById(`shipStepTab${i}`);
        tab.classList.toggle('active', i === step);
        tab.classList.toggle('done', i < step);
    }
    const backBtn = document.getElementById('shipBackBtn');
    const nextBtn = document.getElementById('shipNextBtn');
    backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';
    nextBtn.disabled = false;
    nextBtn.textContent = step === 3 ? '🚀 Ship Now' : 'Next';
    if (shipState && shipState.shipped) {
        backBtn.style.visibility = 'hidden';
        nextBtn.textContent = 'Done';
    }
}

function shipGoBack() {
    if (!shipState || shipState.shipping || shipState.step <= 1) return;
    setShipStep(shipState.step - 1);
}

async function shipGoNext() {
    if (!shipState || shipState.shipping) return;

    if (shipState.shipped) { closeShipModal(); return; }

    if (shipState.step === 1) {
        if (!validateShipStep1()) return;

        // Save order edits (items / price / payment) so rates & ship use them
        const nextBtn = document.getElementById('shipNextBtn');
        nextBtn.disabled = true;
        nextBtn.textContent = 'Saving…';
        const saved = await persistShipOrderEdits();
        nextBtn.disabled = false;
        nextBtn.textContent = 'Next';
        if (!saved) return;

        renderShipCarrierCards();
        setShipStep(2);

        // Re-ship: preselect the previously used carrier (rates re-check fresh)
        if (shipState.reship?.prevCarrier && shipState.carriers.some(c => c.key === shipState.reship.prevCarrier)) {
            selectShipCarrier(shipState.reship.prevCarrier);
        }
    } else if (shipState.step === 2) {
        if (!shipState.carrier) { showShipToast('Select a carrier first', true); return; }
        if (!shipState.serviceable) { showShipToast('Selected carrier is not serviceable for this pincode', true); return; }
        if (shipState.carrier.capabilities.needsCourierSelection && !shipState.courier) {
            showShipToast('Pick a courier from the rate table', true);
            return;
        }
        renderShipSummary();
        setShipStep(3);
    } else if (shipState.step === 3) {
        submitShip();
    }
}

function renderShipCarrierCards() {
    const wrap = document.getElementById('shipCarrierCards');
    if (!shipState.carriers || shipState.carriers.length === 0) {
        wrap.innerHTML = '<div class="ship-error-box" style="grid-column:1/-1;">No carriers configured. Add carrier API credentials in the server environment (e.g. DELHIVERY_API_TOKEN or SHIPROCKET_PICKUP_LOCATION).</div>';
        return;
    }
    wrap.innerHTML = shipState.carriers.map(c => `
        <div class="ship-carrier-card ${shipState.carrier?.key === c.key ? 'selected' : ''}" id="carrier-card-${c.key}" onclick="selectShipCarrier('${c.key}')">
            <div class="carrier-name">${escapeHtml(c.name)}${shipState.reship?.prevCarrier === c.key ? ' <span class="reship-badge">previously used</span>' : ''}</div>
            <div class="carrier-sub">${c.capabilities.needsCourierSelection ? 'Aggregator · pick courier & rate' : 'Direct API · own network'}</div>
        </div>
    `).join('');
}

async function selectShipCarrier(key) {
    if (!shipState) return;
    const carrier = shipState.carriers.find(c => c.key === key);
    if (!carrier) return;

    shipState.carrier = carrier;
    shipState.courier = null;
    shipState.serviceable = false;
    document.querySelectorAll('.ship-carrier-card').forEach(el => el.classList.remove('selected'));
    document.getElementById(`carrier-card-${key}`)?.classList.add('selected');

    const resultBox = document.getElementById('shipServiceabilityResult');
    resultBox.innerHTML = `<div class="ship-loading"><div class="spinner"></div><span>Checking ${escapeHtml(carrier.name)} serviceability & rates...</span></div>`;

    try {
        const o = collectShipOverrides();
        const data = await apiCall('/shipping/serviceability', 'POST', {
            shopperId: shipState.shopperId,
            carrier: key,
            packageOverrides: o.packageOverrides,
            consigneeOverrides: o.consigneeOverrides
        });

        if (!data || !data.success) {
            resultBox.innerHTML = `<div class="ship-error-box">❌ ${escapeHtml(data?.error || 'Serviceability check failed')}</div>`;
            return;
        }
        if (data.serviceable === false) {
            resultBox.innerHTML = `<div class="ship-error-box">❌ Not serviceable: ${escapeHtml(data.reason || 'This pincode is not covered')}</div>`;
            return;
        }

        shipState.serviceable = true;
        const couriers = data.couriers || [];

        if (!carrier.capabilities.needsCourierSelection) {
            // Direct carrier (Delhivery): single option, auto-selected
            const c = couriers[0] || { courierId: key, courierName: carrier.name, rate: null };
            shipState.courier = { id: c.courierId, name: c.courierName, rate: c.rate };
            const codLine = data.codAvailable !== undefined
                ? `<br>COD: ${data.codAvailable ? '✓ available' : '✗ unavailable'} · Prepaid: ${data.prepaidAvailable ? '✓ available' : '✗ unavailable'}${data.city ? ` · ${escapeHtml(data.city)}, ${escapeHtml(data.state || '')}` : ''}`
                : '';
            resultBox.innerHTML = `<div class="ship-ok-box">✅ Serviceable via <b>${escapeHtml(c.courierName)}</b>${codLine}</div>`;
            return;
        }

        // Aggregator (Shiprocket): sortable courier rate table
        if (couriers.length === 0) {
            shipState.serviceable = false;
            resultBox.innerHTML = '<div class="ship-error-box">❌ No couriers available for this route</div>';
            return;
        }
        shipState.courierOptions = couriers;
        const rows = couriers.map(c => `
            <tr class="courier-row" id="courier-row-${c.courierId}" onclick="selectShipCourier('${c.courierId}')">
                <td><span class="courier-radio"></span>${escapeHtml(c.courierName)}${c.recommended ? '<span class="courier-rec-badge">RECOMMENDED</span>' : ''}</td>
                <td>₹${c.rate ?? '-'}</td>
                <td>${c.codCharges ? `₹${c.codCharges}` : '—'}</td>
                <td>${c.etd ? escapeHtml(String(c.etd)) : '—'}</td>
                <td>${c.rating ? `⭐ ${c.rating}` : '—'}</td>
            </tr>
        `).join('');
        resultBox.innerHTML = `
            <div class="ship-ok-box">✅ ${couriers.length} couriers available — pick one below (sorted by rate)</div>
            <table class="courier-table">
                <thead><tr><th>Courier</th><th>Rate</th><th>COD Fee</th><th>ETA</th><th>Rating</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`;

        // Preselect the recommended courier (or cheapest)
        const preferred = couriers.find(c => c.recommended) || couriers[0];
        if (preferred) selectShipCourier(preferred.courierId);
    } catch (err) {
        console.error('[SHIP] Serviceability error:', err);
        resultBox.innerHTML = '<div class="ship-error-box">❌ Serviceability check failed — try again</div>';
    }
}

function selectShipCourier(courierId) {
    if (!shipState || !shipState.courierOptions) return;
    const c = shipState.courierOptions.find(x => String(x.courierId) === String(courierId));
    if (!c) return;
    shipState.courier = { id: c.courierId, name: c.courierName, rate: c.rate };
    document.querySelectorAll('.courier-row').forEach(el => el.classList.remove('selected'));
    document.getElementById(`courier-row-${courierId}`)?.classList.add('selected');
}

function renderShipSummary() {
    const d = shipState.draft;
    const o = collectShipOverrides();
    const isCod = d.payment.mode === 'COD';
    const rows = [
        ['Order', `#${d.orderId}`],
        ['Consignee', `${escapeHtml(o.consigneeOverrides.name)} · ${escapeHtml(o.consigneeOverrides.phone)}`],
        ['Address', `${escapeHtml(o.consigneeOverrides.address)}, ${escapeHtml(o.consigneeOverrides.city)} — ${escapeHtml(o.consigneeOverrides.pincode)}`],
        ['Payment', isCod ? `COD · collect ₹${d.payment.codAmount}` : `Prepaid · ₹${d.payment.declaredValue}`],
        ['Package', `${o.packageOverrides.weightGrams}g · ${o.packageOverrides.lengthCm}×${o.packageOverrides.breadthCm}×${o.packageOverrides.heightCm} cm`],
        ['Carrier', escapeHtml(shipState.carrier.name)],
        ['Courier', `${escapeHtml(shipState.courier?.name || shipState.carrier.name)}${shipState.courier?.rate ? ` · ₹${shipState.courier.rate}` : ''}`]
    ];
    if (shipState.reship) {
        rows.unshift(['Re-Ship', `Replacing ${shipState.reship.prevAwb ? `AWB ${escapeHtml(shipState.reship.prevAwb)}` : `shipment #${shipState.reship.ofShipmentId}`} · ${escapeHtml(shipState.reship.reason)}`]);
    }
    document.getElementById('shipSummaryTable').innerHTML =
        rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    document.getElementById('shipSubmitError').innerHTML = '';
}

async function submitShip() {
    if (!shipState || shipState.shipping) return;
    shipState.shipping = true;

    const nextBtn = document.getElementById('shipNextBtn');
    nextBtn.disabled = true;
    nextBtn.textContent = 'Shipping...';
    document.getElementById('shipSubmitError').innerHTML = '';

    try {
        const o = collectShipOverrides();
        const data = await apiCall('/shipping/ship', 'POST', {
            shopperId: shipState.shopperId,
            carrier: shipState.carrier.key,
            courierId: shipState.carrier.capabilities.needsCourierSelection ? shipState.courier.id : undefined,
            packageOverrides: o.packageOverrides,
            consigneeOverrides: o.consigneeOverrides,
            notifyCustomer: document.getElementById('shipNotifyCustomer').checked,
            reshipOfShipmentId: shipState.reship?.ofShipmentId || undefined,
            reshipReason: shipState.reship?.reason || undefined
        });

        if (!data || !data.success) {
            document.getElementById('shipSubmitError').innerHTML =
                `<div class="ship-error-box">❌ ${escapeHtml(data?.error || 'Shipment creation failed')}</div>`;
            nextBtn.disabled = false;
            nextBtn.textContent = '🚀 Ship Now';
            shipState.shipping = false;
            return;
        }

        shipState.shipped = true;
        shipState.shipping = false;
        renderShipSuccess(data);
        setShipStep(3);
        showShipToast(`✅ ${shipState.reship ? 'Re-shipped' : 'Shipped'}! AWB ${data.awb} via ${data.courierName}`);
    } catch (err) {
        console.error('[SHIP] Ship error:', err);
        document.getElementById('shipSubmitError').innerHTML = '<div class="ship-error-box">❌ Network error while shipping — check shipment history before retrying</div>';
        nextBtn.disabled = false;
        nextBtn.textContent = '🚀 Ship Now';
        shipState.shipping = false;
    }
}

function renderShipSuccess(data) {
    const shipmentId = data.shipment?.id;
    const minDate = formatDateForInput(new Date());
    document.getElementById('shipConfirmView').style.display = 'none';
    const panel = document.getElementById('shipSuccessPanel');
    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="success-icon">${shipState?.reship ? '🔄' : '📦'}</div>
        <h4>${shipState?.reship ? 'Replacement Shipment Created' : 'Shipment Created'}</h4>
        ${shipState?.reship ? `<div style="margin-bottom: 0.6rem;"><span class="reship-badge">Replaces ${shipState.reship.prevAwb ? `AWB ${escapeHtml(shipState.reship.prevAwb)}` : `shipment #${shipState.reship.ofShipmentId}`}</span></div>` : ''}
        <div class="ship-awb-display">
            AWB: ${escapeHtml(data.awb)}
            <button class="ship-awb-copy" onclick="copyShipAwb('${escapeHtml(data.awb)}')">COPY</button>
        </div>
        <div style="margin-top: 0.9rem; color: #aaa; font-size: 0.85rem;">
            ${escapeHtml(data.courierName || '')}${data.freightCharge ? ` · Freight ₹${data.freightCharge}` : ''}
        </div>
        <div class="ship-quick-actions">
            <button class="btn btn-outline" onclick="shipGetLabel(${shipmentId})">⬇️ Download Label</button>
            ${data.trackingUrl ? `<a class="btn btn-outline" href="${escapeHtml(data.trackingUrl)}" target="_blank" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;">📍 Track</a>` : ''}
            <button class="btn btn-outline" style="border-color: rgba(255,71,87,0.5); color: #ff4757;" onclick="shipDoCancel(${shipmentId})">✕ Cancel</button>
        </div>
        <div class="ship-pickup-row">
            <input type="date" id="shipSuccessPickupDate" min="${minDate}" value="${minDate}">
            <button class="btn btn-primary" onclick="shipDoPickup(${shipmentId}, 'shipSuccessPickupDate')">📅 Schedule Pickup</button>
        </div>`;
    setShipStep(3);
}

function copyShipAwb(awb) {
    navigator.clipboard?.writeText(awb).then(
        () => showShipToast('AWB copied to clipboard'),
        () => showShipToast('Copy failed', true)
    );
}

// ---------- Post-ship actions (success panel + drawer) ----------

async function shipGetLabel(shipmentId, type = 'label') {
    showShipToast(`Generating ${type}...`);
    try {
        const data = await apiCall(`/shipping/shipments/${shipmentId}/label${type !== 'label' ? `?type=${type}` : ''}`);
        if (!data || !data.success) { showShipToast(data?.error || `Failed to generate ${type}`, true); return; }
        const url = data.labelUrl || data.manifestUrl || data.invoiceUrl;
        if (url) window.open(url, '_blank');
        else showShipToast(`${type} generated but no URL returned`, true);
    } catch (err) {
        showShipToast(`Failed to generate ${type}`, true);
    }
}

async function shipDoPickup(shipmentId, dateInputId) {
    const pickupDate = document.getElementById(dateInputId)?.value;
    if (!pickupDate) { showShipToast('Pick a pickup date first', true); return; }
    showShipToast('Scheduling pickup...');
    try {
        const data = await apiCall(`/shipping/shipments/${shipmentId}/pickup`, 'POST', { pickupDate });
        if (!data || !data.success) { showShipToast(data?.error || 'Pickup scheduling failed', true); return; }
        showShipToast(`✅ Pickup scheduled for ${data.pickupDate || pickupDate}${data.pickupToken ? ` (Token: ${data.pickupToken})` : ''}`);
        if (currentDrawerOrder) refreshShipmentsDrawer();
    } catch (err) {
        showShipToast('Pickup scheduling failed', true);
    }
}

async function shipDoCancel(shipmentId) {
    if (!confirm('Cancel this shipment at the carrier? The order becomes shippable again.')) return;
    showShipToast('Cancelling shipment...');
    try {
        let data = await apiCall(`/shipping/shipments/${shipmentId}/cancel`, 'POST');

        // Carrier refused (already delivered / RTO'd / lost) — offer to close it in
        // the hub only, so the order stops looking like it has a live shipment
        if (data && !data.success && data.carrierRejected) {
            if (!confirm(`Carrier refused to cancel:\n\n${data.error}\n\nMark it cancelled in the hub anyway? The AWB may still be live at the carrier.`)) {
                showShipToast(data.error, true);
                return;
            }
            data = await apiCall(`/shipping/shipments/${shipmentId}/cancel`, 'POST', { force: true });
        }

        if (!data || !data.success) { showShipToast(data?.error || 'Cancellation failed', true); return; }
        showShipToast(data.warning ? `⚠️ Cancelled with warning: ${data.warning}` : '✅ Shipment cancelled');
        if (shipState) { shipState.shipped = true; closeShipModal(); }
        if (currentDrawerOrder) refreshShipmentsDrawer();
        fetchShoppersData();
    } catch (err) {
        showShipToast('Cancellation failed', true);
    }
}

async function shipDoTrack(shipmentId) {
    const container = document.getElementById(`track-${shipmentId}`);
    if (!container) return;
    if (container.innerHTML.trim()) { container.innerHTML = ''; return; } // toggle off
    container.innerHTML = '<div class="ship-loading"><div class="spinner"></div><span>Fetching live tracking...</span></div>';
    try {
        const data = await apiCall(`/shipping/shipments/${shipmentId}/track`);
        if (!data || !data.success) {
            container.innerHTML = `<div class="ship-error-box">❌ ${escapeHtml(data?.error || 'Tracking failed')}</div>`;
            return;
        }
        const t = data.tracking;
        const events = (t.timeline || []).slice(0, 15).map(e => `
            <div class="tracking-event">
                <div class="dot"></div>
                <div>
                    <div class="evt-activity">${escapeHtml(e.activity || e.status || '')}</div>
                    <div class="evt-meta">${escapeHtml(e.location || '')}${e.date ? ` · ${escapeHtml(String(e.date))}` : ''}</div>
                </div>
            </div>`).join('');
        container.innerHTML = `
            <div class="tracking-timeline">
                <div style="font-size: 0.8rem; color: #25d366; margin-bottom: 0.6rem;">Current: <b>${escapeHtml(t.currentStatus || 'Unknown')}</b>${t.expectedDelivery ? ` · ETA ${escapeHtml(String(t.expectedDelivery))}` : ''}</div>
                ${events || '<div style="color:#888;font-size:0.78rem;">No scan events yet</div>'}
            </div>`;
    } catch (err) {
        container.innerHTML = '<div class="ship-error-box">❌ Tracking failed</div>';
    }
}

// ---------- Shipments Drawer ----------

let currentDrawerOrder = null; // { shopperId, orderId }

async function openShipmentsDrawer(shopperId, orderId) {
    currentDrawerOrder = { shopperId, orderId };
    document.getElementById('shipmentsDrawerOrderId').textContent = `#${orderId}`;
    document.getElementById('shipmentsDrawerBody').innerHTML = '<div class="ship-loading"><div class="spinner"></div><span>Loading shipments...</span></div>';
    document.getElementById('shipmentsDrawer').classList.add('active');
    refreshShipmentsDrawer();
}

function closeShipmentsDrawer() {
    document.getElementById('shipmentsDrawer').classList.remove('active');
    currentDrawerOrder = null;
}

async function refreshShipmentsDrawer() {
    if (!currentDrawerOrder) return;
    const body = document.getElementById('shipmentsDrawerBody');
    try {
        const data = await apiCall(`/shipping/shipments?order_id=${encodeURIComponent(currentDrawerOrder.orderId)}`);
        if (!data || !data.success) {
            body.innerHTML = `<div class="ship-error-box">❌ ${escapeHtml(data?.error || 'Failed to load shipments')}</div>`;
            return;
        }
        const shipments = data.shipments || [];
        cacheReshipShipments(shipments);
        if (shipments.length === 0) {
            body.innerHTML = `
                <div style="text-align:center; color:#888; padding: 2.5rem 0;">No shipments for this order yet.</div>
                <button class="ship-btn" onclick="closeShipmentsDrawer(); openShipModal('${currentDrawerOrder.shopperId}')">🚚 Ship This Order</button>`;
            return;
        }

        const minDate = formatDateForInput(new Date());
        const hasOpen = shipments.some(sh => !isTerminalShipStatus(sh.status));
        body.innerHTML = shipments.map(sh => {
            const open = !isTerminalShipStatus(sh.status);
            const showActions = !['cancelled', 'failed'].includes(sh.status); // delivered/rto keep label + track
            const isShiprocket = sh.carrier === 'shiprocket';
            return `
            <div class="shipment-entry">
                <div class="shipment-entry-head">
                    <span class="ship-carrier">${escapeHtml(sh.courier_name || sh.carrier)}</span>
                    <span class="shipment-status-pill ${sh.status}">${sh.status.replace(/_/g, ' ')}</span>
                    ${sh.reship_of_shipment_id ? `<span class="reship-badge" title="${escapeHtml(sh.reship_reason || '')}">🔄 Re-ship of #${sh.reship_of_shipment_id}</span>` : ''}
                </div>
                <div class="shipment-meta">
                    ${sh.awb ? `AWB: <b>${escapeHtml(sh.awb)}</b> <button class="ship-awb-copy" onclick="copyShipAwb('${escapeHtml(sh.awb)}')">COPY</button><br>` : ''}
                    Carrier: <b>${escapeHtml(sh.carrier)}</b> · ${escapeHtml(sh.payment_mode || '')}${Number(sh.cod_amount) > 0 ? ` · COD ₹${sh.cod_amount}` : ''}<br>
                    ${sh.weight_grams ? `Package: ${sh.weight_grams}g · ${sh.length_cm}×${sh.breadth_cm}×${sh.height_cm} cm<br>` : ''}
                    ${sh.freight_charge ? `Freight: ₹${sh.freight_charge}<br>` : ''}
                    ${sh.pickup_date ? `Pickup: ${sh.pickup_date}${sh.pickup_token ? ` (Token ${escapeHtml(sh.pickup_token)})` : ''}<br>` : ''}
                    ${sh.reship_reason ? `<span style="color:#ffc759;">Re-ship reason: ${escapeHtml(sh.reship_reason)}</span><br>` : ''}
                    ${sh.error_message ? `<span style="color:#ff6b7a;">Error: ${escapeHtml(sh.error_message)}</span><br>` : ''}
                    Created: ${formatDate(sh.created_at)} · by ${escapeHtml(sh.shipped_by || 'admin')}
                </div>
                ${showActions ? `
                <div class="shipment-entry-actions">
                    <button onclick="shipGetLabel(${sh.id})">Label</button>
                    ${isShiprocket ? `<button onclick="shipGetLabel(${sh.id}, 'manifest')">Manifest</button><button onclick="shipGetLabel(${sh.id}, 'invoice')">Invoice</button>` : ''}
                    <button onclick="shipDoTrack(${sh.id})">Track</button>
                    ${sh.tracking_url ? `<a href="${escapeHtml(sh.tracking_url)}" target="_blank">Open Tracking ↗</a>` : ''}
                    <button style="border-color: rgba(255,199,89,0.4); color: #ffc759;" onclick="openReshipModal(${sh.id})">🔄 Re-Ship</button>
                    ${open ? `<button class="danger" onclick="shipDoCancel(${sh.id})">Cancel</button>` : ''}
                </div>
                ${['created', 'awb_assigned'].includes(sh.status) ? `
                <div class="shipment-entry-actions" style="align-items: center;">
                    <input type="date" id="drawer-pickup-${sh.id}" min="${minDate}" value="${minDate}" style="padding: 0.35rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: #fff; color-scheme: dark;">
                    <button onclick="shipDoPickup(${sh.id}, 'drawer-pickup-${sh.id}')">Schedule Pickup</button>
                </div>` : ''}
                <div id="track-${sh.id}"></div>` : ''}
            </div>`;
        }).join('') + (!hasOpen ? `<button class="ship-btn" onclick="openReshipModal(${shipments[0].id})">🔄 Re-ship This Order</button>` : '');
    } catch (err) {
        console.error('[SHIP] Drawer error:', err);
        body.innerHTML = '<div class="ship-error-box">❌ Failed to load shipments</div>';
    }
}

// ---------- Premium Re-Ship (reason-tracked replacement shipments) ----------
//
// Every shipped order can be re-shipped:
//   • open shipments (awb_assigned → in_transit) → cancelled at the carrier
//     first, then the ship wizard reopens for the replacement
//   • terminal shipments (cancelled / failed / delivered / rto) → straight to
//     the wizard — the original stays on record
// The reason is persisted on the new shipment (reship_of_shipment_id +
// reship_reason) and the customer WhatsApp message is worded as a replacement.

const RESHIP_REASONS = [
    { label: 'RTO received', icon: '↩️', hint: 'Package came back to origin' },
    { label: 'Lost in transit', icon: '🕵️', hint: 'Courier lost the package' },
    { label: 'Damaged in transit', icon: '💥', hint: 'Product damaged before delivery' },
    { label: 'Delivery delayed / stuck', icon: '⏱️', hint: 'Ship a fresh one instead of waiting' },
    { label: 'Incorrect address', icon: '📍', hint: 'Re-ship with a corrected address' },
    { label: 'Customer requested replacement', icon: '🙋', hint: 'Replacement after delivery' },
    { label: 'Other', icon: '✏️', hint: 'Describe it in the note below' }
];

const reshipShipmentCache = new Map(); // shipments seen in the drawer / shipped view
let reshipState = null;                // { shipment, reasonIdx }

function cacheReshipShipments(shipments) {
    (shipments || []).forEach(sh => reshipShipmentCache.set(Number(sh.id), sh));
}

function openReshipModal(shipmentId) {
    const sh = reshipShipmentCache.get(Number(shipmentId));
    if (!sh) { showShipToast('Shipment details not loaded — refresh and try again', true); return; }
    if (!sh.shopper_id) { showShipToast('No linked shopper record — use New Forward Shipment instead', true); return; }

    reshipState = { shipment: sh, reasonIdx: null };
    const open = !isTerminalShipStatus(sh.status);

    document.getElementById('reshipOrderIdLabel').textContent = `#${sh.order_id}`;
    document.getElementById('reshipPrevSummary').innerHTML = `
        <div class="ship-section-title">${open ? 'Current Shipment' : 'Previous Shipment'}</div>
        <div class="reship-prev-card">
            <div class="reship-prev-head">
                <span class="ship-carrier">${escapeHtml(sh.courier_name || sh.carrier)}</span>
                <span class="shipment-status-pill ${sh.status}">${(sh.status || '').replace(/_/g, ' ')}</span>
                ${sh.reship_of_shipment_id ? `<span class="reship-badge">🔄 Re-ship of #${sh.reship_of_shipment_id}</span>` : ''}
            </div>
            ${sh.awb ? `AWB: <b>${escapeHtml(sh.awb)}</b><br>` : ''}
            Carrier: <b>${escapeHtml(sh.carrier)}</b> · ${escapeHtml(sh.payment_mode || '')}${Number(sh.cod_amount) > 0 ? ` · COD ₹${sh.cod_amount}` : ''}${sh.freight_charge ? ` · Freight ₹${sh.freight_charge}` : ''}<br>
            ${sh.reship_reason ? `Re-ship reason: ${escapeHtml(sh.reship_reason)}<br>` : ''}
            Created: ${formatDate(sh.created_at)} · by ${escapeHtml(sh.shipped_by || 'admin')}
        </div>`;

    document.getElementById('reshipReasonGrid').innerHTML = RESHIP_REASONS.map((r, idx) => `
        <div class="reship-reason-chip" id="reship-reason-${idx}" onclick="selectReshipReason(${idx})" title="${escapeHtml(r.hint)}">
            <span class="chip-icon">${r.icon}</span>${escapeHtml(r.label)}
        </div>`).join('');
    document.getElementById('reshipNote').value = '';

    const warnBox = document.getElementById('reshipWarnBox');
    if (open) {
        warnBox.innerHTML = `<div class="reship-warn-box">⚠️ The current shipment ${sh.awb ? `(AWB <b>${escapeHtml(sh.awb)}</b> via ${escapeHtml(sh.courier_name || sh.carrier)}) ` : ''}will be <b>cancelled at the carrier</b> first — then the ship wizard opens so you can pick any carrier for the replacement.</div>`;
    } else if (sh.status === 'delivered') {
        warnBox.innerHTML = '<div class="reship-warn-box info">ℹ️ This order was already <b>delivered</b> — you are creating a replacement shipment. The delivered shipment stays on record.</div>';
    } else {
        warnBox.innerHTML = '';
    }

    document.getElementById('reshipError').innerHTML = '';
    const btn = document.getElementById('reshipContinueBtn');
    btn.disabled = false;
    btn.textContent = open ? '✕ Cancel & Re-Ship' : '🔄 Continue to Re-Ship';
    document.getElementById('reshipModal').classList.add('active');
}

function closeReshipModal() {
    document.getElementById('reshipModal').classList.remove('active');
    reshipState = null;
}

function selectReshipReason(idx) {
    if (!reshipState) return;
    reshipState.reasonIdx = idx;
    document.querySelectorAll('.reship-reason-chip').forEach(el => el.classList.remove('selected'));
    document.getElementById(`reship-reason-${idx}`)?.classList.add('selected');
    document.getElementById('reshipError').innerHTML = '';
}

async function reshipContinue(force = false) {
    if (!reshipState) return;
    const sh = reshipState.shipment;
    const errBox = document.getElementById('reshipError');
    errBox.innerHTML = '';

    if (reshipState.reasonIdx === null) {
        errBox.innerHTML = '<div class="ship-error-box">⚠️ Pick a re-ship reason first</div>';
        return;
    }
    const reasonLabel = RESHIP_REASONS[reshipState.reasonIdx].label;
    const note = document.getElementById('reshipNote').value.trim();
    if (reasonLabel === 'Other' && !note) {
        errBox.innerHTML = '<div class="ship-error-box">⚠️ Add a short note describing the reason</div>';
        return;
    }
    const reason = note ? `${reasonLabel} — ${note}` : reasonLabel;

    const btn = document.getElementById('reshipContinueBtn');
    const open = !isTerminalShipStatus(sh.status);
    btn.disabled = true;

    // Open shipment: cancel at the carrier first so the order becomes shippable
    if (open) {
        btn.textContent = force ? 'Closing shipment locally…' : 'Cancelling current shipment…';
        try {
            const data = await apiCall(`/shipping/shipments/${sh.id}/cancel`, 'POST', force ? { force: true } : {});
            if (!data || !data.success) {
                // Carriers refuse to cancel packages they already closed (delivered,
                // RTO'd, lost). The replacement still has to go out, so offer to
                // close it locally instead of dead-ending the re-ship.
                const forceOption = data?.carrierRejected
                    ? `<div style="margin-top:0.6rem;">The carrier will not cancel this AWB (usually because it is already delivered, RTO'd or lost). You can close it in the hub and continue — the reason is recorded on the shipment.<br>
                       <button class="ship-btn" style="margin-top:0.5rem;" onclick="reshipContinue(true)">Close locally & continue re-ship</button></div>`
                    : '';
                errBox.innerHTML = `<div class="ship-error-box">❌ Cancellation failed: ${escapeHtml(data?.error || 'carrier rejected the request')} — the shipment was left untouched.${forceOption}</div>`;
                btn.disabled = false;
                btn.textContent = '✕ Cancel & Re-Ship';
                return;
            }
            showShipToast(data.warning ? `⚠️ Cancelled with warning: ${data.warning}` : `✅ AWB ${sh.awb || ''} cancelled — opening the re-ship wizard`);
            fetchShoppersData();
        } catch (err) {
            console.error('[RESHIP] Cancel error:', err);
            errBox.innerHTML = '<div class="ship-error-box">❌ Network error while cancelling — check shipment history before retrying</div>';
            btn.disabled = false;
            btn.textContent = '✕ Cancel & Re-Ship';
            return;
        }
    }

    const reshipCtx = {
        ofShipmentId: sh.id,
        reason,
        prevCarrier: sh.carrier,
        prevCourierName: sh.courier_name,
        prevAwb: sh.awb
    };
    closeReshipModal();
    if (currentDrawerOrder) closeShipmentsDrawer();
    if (document.getElementById('shippedOrdersView')?.style.display === 'block') fetchShippedOrders();
    openShipModal(String(sh.shopper_id), reshipCtx);
}

// ---------- Bulk Ship ----------

let bulkShipRunning = false;

async function openBulkShipModal() {
    if (!hubRequirePerm('ship_orders', 'ship orders')) return;
    if (selectedShoppers.size === 0) { showShipToast('Select some orders first', true); return; }

    const eligible = allLoadedShoppers.filter(s =>
        selectedShoppers.has(s.id) && s.status === 'confirmed' && !s.awb
    );
    if (eligible.length === 0) {
        showShipToast('No eligible orders selected — only confirmed, un-shipped orders can be bulk shipped', true);
        return;
    }

    const carriers = await loadShipCarriers();
    if (carriers.length === 0) { showShipToast('No carriers configured on the server', true); return; }

    document.getElementById('bulkShipCarrier').innerHTML =
        carriers.map(c => `<option value="${c.key}">${escapeHtml(c.name)}${c.capabilities.needsCourierSelection ? ' (auto-assigns cheapest courier)' : ''}</option>`).join('');
    document.getElementById('bulkShipCount').textContent = `${eligible.length} orders`;
    document.getElementById('bulkShipProgress').innerHTML = eligible.map(s => `
        <div class="bulk-ship-line" id="bs-line-${s.id}">
            <span class="bs-order">#${s.order_id} · ${escapeHtml(s.name || 'Customer')}</span>
            <span class="bs-result" id="bs-result-${s.id}">Queued</span>
        </div>`).join('');
    const startBtn = document.getElementById('bulkShipStartBtn');
    startBtn.disabled = false;
    startBtn.textContent = 'Start Shipping';
    document.getElementById('bulkShipModal').dataset.ids = JSON.stringify(eligible.map(s => s.id));
    document.getElementById('bulkShipModal').classList.add('active');
}

function closeBulkShipModal() {
    if (bulkShipRunning) { showShipToast('Bulk shipping in progress — wait for it to finish', true); return; }
    document.getElementById('bulkShipModal').classList.remove('active');
}

async function startBulkShip() {
    if (bulkShipRunning) return;
    const ids = JSON.parse(document.getElementById('bulkShipModal').dataset.ids || '[]');
    if (ids.length === 0) return;

    const carrier = document.getElementById('bulkShipCarrier').value;
    const packageOverrides = {
        weightGrams: parseInt(document.getElementById('bulkShipWeight').value) || 500,
        lengthCm: parseFloat(document.getElementById('bulkShipLength').value) || 30,
        breadthCm: parseFloat(document.getElementById('bulkShipBreadth').value) || 40,
        heightCm: parseFloat(document.getElementById('bulkShipHeight').value) || 2
    };

    bulkShipRunning = true;
    const startBtn = document.getElementById('bulkShipStartBtn');
    startBtn.disabled = true;
    startBtn.textContent = 'Shipping...';

    let okCount = 0, failCount = 0;
    for (const id of ids) {
        const resultEl = document.getElementById(`bs-result-${id}`);
        if (resultEl) { resultEl.textContent = 'Shipping...'; resultEl.className = 'bs-result run'; }
        try {
            // Sequential on purpose: avoids carrier rate limits and DB races
            const data = await apiCall('/shipping/ship', 'POST', {
                shopperId: id,
                carrier,
                courierId: 'auto',
                packageOverrides,
                notifyCustomer: false
            });
            if (data && data.success) {
                okCount++;
                if (resultEl) { resultEl.textContent = `✅ AWB ${data.awb}`; resultEl.className = 'bs-result ok'; }
            } else {
                failCount++;
                if (resultEl) { resultEl.textContent = `❌ ${data?.error || 'Failed'}`; resultEl.className = 'bs-result err'; }
            }
        } catch (err) {
            failCount++;
            if (resultEl) { resultEl.textContent = '❌ Network error'; resultEl.className = 'bs-result err'; }
        }
    }

    bulkShipRunning = false;
    startBtn.textContent = 'Done';
    showShipToast(`Bulk ship finished: ${okCount} shipped${failCount ? `, ${failCount} failed` : ''}`, failCount > 0);
    clearSelection();
    fetchShoppersData();
}

// Expose shipping functions for inline onclick handlers
window.openShipModal = openShipModal;
window.closeShipModal = closeShipModal;
window.shipGoNext = shipGoNext;
window.shipGoBack = shipGoBack;
window.selectShipCarrier = selectShipCarrier;
window.selectShipCourier = selectShipCourier;
window.copyShipAwb = copyShipAwb;
window.shipGetLabel = shipGetLabel;
window.shipDoPickup = shipDoPickup;
window.shipDoCancel = shipDoCancel;
window.shipDoTrack = shipDoTrack;
window.openShipmentsDrawer = openShipmentsDrawer;
window.closeShipmentsDrawer = closeShipmentsDrawer;
window.openBulkShipModal = openBulkShipModal;
window.closeBulkShipModal = closeBulkShipModal;
window.startBulkShip = startBulkShip;

// ==========================================
// PREMIUM: SHOPIFY CANCEL & REFUND (bulk)
// Cancels selected cancelled orders in Shopify and refunds prepaid ones.
// ==========================================
let shopifyCancelRunning = false;

function isPrepaidShopper(s) {
    const pm = String(s.payment_method || '').trim().toLowerCase();
    if (!pm) return false;
    return !/cod|cash on delivery/.test(pm);
}

async function openShopifyCancelModal() {
    if (!hubRequirePerm('edit_orders', 'cancel orders in Shopify')) return;
    if (selectedShoppers.size === 0) { showShipToast('Select some orders first', true); return; }

    const eligible = allLoadedShoppers.filter(s =>
        selectedShoppers.has(s.id) && s.status === 'cancelled'
    );
    if (eligible.length === 0) {
        showShipToast('No cancelled orders selected — open the Cancelled tab and select the orders to cancel in Shopify', true);
        return;
    }

    const prepaid = eligible.filter(isPrepaidShopper);
    const refundTotal = prepaid.reduce((sum, s) => sum + (parseFloat(s.order_total) || 0), 0);

    document.getElementById('scCancelCount').textContent = `${eligible.length} orders`;
    document.getElementById('scSummary').innerHTML = `
        <div class="sc-stat"><div class="sc-num">${eligible.length}</div><div class="sc-lbl">Orders</div></div>
        <div class="sc-stat"><div class="sc-num gold">${prepaid.length}</div><div class="sc-lbl">Prepaid → Refund</div></div>
        <div class="sc-stat"><div class="sc-num">${eligible.length - prepaid.length}</div><div class="sc-lbl">COD → Cancel Only</div></div>
        <div class="sc-stat"><div class="sc-num gold">₹${refundTotal.toLocaleString('en-IN')}</div><div class="sc-lbl">Refund Value</div></div>`;
    document.getElementById('scRefundToggle').checked = true;
    document.getElementById('scProgress').innerHTML = eligible.map(s => {
        const prepaidFlag = isPrepaidShopper(s);
        return `
        <div class="bulk-ship-line" id="sc-line-${s.id}">
            <span class="bs-order">#${s.order_id} · ${escapeHtml(s.name || 'Customer')}<span class="sc-pay ${prepaidFlag ? 'prepaid' : 'cod'}">${prepaidFlag ? 'PREPAID' : 'COD'}</span></span>
            <span class="bs-result" id="sc-result-${s.id}">Queued</span>
        </div>`;
    }).join('');

    const startBtn = document.getElementById('scStartBtn');
    startBtn.disabled = false;
    startBtn.textContent = 'Start Cancellation';
    document.getElementById('shopifyCancelModal').dataset.ids = JSON.stringify(eligible.map(s => s.id));
    document.getElementById('shopifyCancelModal').classList.add('active');
}

function closeShopifyCancelModal() {
    if (shopifyCancelRunning) { showShipToast('Cancellation in progress — wait for it to finish', true); return; }
    document.getElementById('shopifyCancelModal').classList.remove('active');
}

async function startShopifyCancel() {
    if (shopifyCancelRunning) return;
    const ids = JSON.parse(document.getElementById('shopifyCancelModal').dataset.ids || '[]');
    if (ids.length === 0) return;
    const refundPrepaid = document.getElementById('scRefundToggle').checked;

    shopifyCancelRunning = true;
    const startBtn = document.getElementById('scStartBtn');
    startBtn.disabled = true;
    startBtn.textContent = 'Cancelling...';

    let okCount = 0, failCount = 0, refundedCount = 0;
    for (const id of ids) {
        const resultEl = document.getElementById(`sc-result-${id}`);
        if (resultEl) { resultEl.textContent = 'Cancelling...'; resultEl.className = 'bs-result run'; }
        try {
            // Sequential on purpose: keeps Shopify API rate limits happy
            const data = await apiCall(`/shoppers/${id}/shopify-cancel`, 'POST', { refundPrepaid });
            if (data && data.success) {
                okCount++;
                const r = data.result || {};
                if (r.refunded) refundedCount++;
                const parts = [];
                if (r.refunded) parts.push(`Refunded ₹${Number(r.refundAmount || 0).toLocaleString('en-IN')}`);
                else if (r.refundSkipped) parts.push(r.refundSkipped);
                parts.push(r.alreadyCancelled ? 'Already cancelled in Shopify' : 'Cancelled in Shopify');
                if (resultEl) { resultEl.textContent = `✅ ${parts.join(' · ')}`; resultEl.className = 'bs-result ok'; }
            } else {
                failCount++;
                if (resultEl) { resultEl.textContent = `❌ ${data?.error || 'Failed'}`; resultEl.className = 'bs-result err'; }
            }
        } catch (err) {
            failCount++;
            if (resultEl) { resultEl.textContent = '❌ Network error'; resultEl.className = 'bs-result err'; }
        }
    }

    shopifyCancelRunning = false;
    startBtn.textContent = 'Done';
    showShipToast(`Shopify cancel finished: ${okCount} cancelled${refundedCount ? `, ${refundedCount} refunded` : ''}${failCount ? `, ${failCount} failed` : ''}`, failCount > 0);
    fetchShoppersData();
    fetchInboxCounts();
}

window.openShopifyCancelModal = openShopifyCancelModal;
window.closeShopifyCancelModal = closeShopifyCancelModal;
window.startShopifyCancel = startShopifyCancel;

// ==========================================
// SHIPPED ORDERS VIEW - Full shipment history
// ==========================================

function showShippedOrdersView() {
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('shippedOrdersView').style.display = 'block';

    if (soQuickDate) {
        // Re-apply the quick date selection to refresh relative dates
        document.querySelectorAll('.so-quick-date').forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.so-quick-date[data-so-range="${soQuickDate}"]`);
        if (activeBtn) activeBtn.classList.add('active');
        applySoQuickDate(soQuickDate);
    } else {
        fetchShippedOrders();
    }

    // Kick off a background carrier sync so statuses (pickup scheduled →
    // in transit → delivered) advance automatically; re-render if anything moved
    syncShipmentStatuses();
}

// Ask the server to poll carriers for active shipments and auto-advance their
// statuses. Runs silently in the background; refreshes the list on changes.
// Pass announce=true (manual Sync Status button / refresh) for visible feedback.
let soSyncInFlight = false;
async function syncShipmentStatuses(announce = false) {
    if (soSyncInFlight) return;
    soSyncInFlight = true;
    const syncBtn = document.getElementById('soSyncBtn');
    const syncLabel = document.getElementById('soSyncBtnLabel');
    if (announce && syncBtn) {
        syncBtn.disabled = true;
        syncBtn.style.opacity = '0.6';
        if (syncLabel) syncLabel.textContent = 'Syncing\u2026';
    }
    try {
        const data = await apiCall('/shipping/sync-statuses', 'POST', {});
        if (data && data.success && data.updated > 0) {
            showShipToast(`\ud83d\udd04 ${data.updated} shipment status${data.updated > 1 ? 'es' : ''} auto-updated from courier`);
            // Only re-render if the user is still on the Shipped Orders view
            if (document.getElementById('shippedOrdersView')?.style.display !== 'none') fetchShippedOrders();
        } else if (announce && data && data.success) {
            showShipToast(data.skipped ? '\u23f3 A sync is already running, try again shortly' : `\u2713 ${data.checked || 0} shipment${data.checked === 1 ? '' : 's'} checked \u2014 statuses are up to date`);
        } else if (announce) {
            showShipToast(data?.error || 'Sync failed', true);
        }
    } catch (err) {
        console.warn('Shipment status sync failed (non-blocking):', err);
        if (announce) showShipToast('Sync failed \u2014 could not reach the server', true);
    } finally {
        soSyncInFlight = false;
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.style.opacity = '';
            if (syncLabel) syncLabel.textContent = 'Sync Status';
        }
    }
}

function hideShippedOrdersView() {
    document.getElementById('shippedOrdersView').style.display = 'none';
    document.getElementById('dashboardView').style.display = 'block';
}

function buildSoParams(limit, offset) {
    const params = new URLSearchParams();
    if (soSearchQuery) params.set('search', soSearchQuery);
    if (soCarrier) params.set('carrier', soCarrier);
    if (soStatus) params.set('status', soStatus);
    if (soPayment) params.set('payment_mode', soPayment);
    if (soStartDate) params.set('date_from', soStartDate);
    if (soEndDate) params.set('date_to', soEndDate);
    params.set('limit', limit);
    params.set('offset', offset);
    return params;
}

async function fetchShippedOrders() {
    const container = document.getElementById('shippedOrdersContainer');
    if (!container) return;

    container.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4rem;">
            <div class="spinner" style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#53bdeb;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:1rem;"></div>
            <span style="font-family:'Archivo Narrow',sans-serif;letter-spacing:2px;font-weight:500;opacity:0.7;">FETCHING SHIPMENTS...</span>
        </div>
    `;

    try {
        const data = await apiCall('/shipping/history?' + buildSoParams(SO_PAGE_SIZE, soOffset).toString());
        if (data && data.success) {
            soTotal = data.total || 0;
            renderShippedOrders(data);
        } else {
            throw new Error(data?.error || 'Failed to fetch');
        }
    } catch (err) {
        console.error('Shipped orders fetch error:', err);
        container.innerHTML = `
            <div class="multi-orders-empty">
                <div class="multi-orders-empty-icon">⚠️</div>
                <div class="multi-orders-empty-title">Failed to Load</div>
                <div class="multi-orders-empty-text">${err.message || 'Could not fetch shipment history'}</div>
            </div>
        `;
        const pag = document.getElementById('soPagination');
        if (pag) pag.style.display = 'none';
    }
}

function renderShippedOrders(data) {
    const container = document.getElementById('shippedOrdersContainer');
    const shipments = data.shipments || [];
    const stats = data.stats || {};

    // Stats cards
    const fmtMoney = v => '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('soStatTotal', stats.total || 0);
    setText('soStatReady', stats.ready_to_ship || 0);
    setText('soStatPickup', stats.pickup_scheduled || 0);
    setText('soStatTransit', stats.in_transit || 0);
    setText('soStatDelivered', stats.delivered || 0);
    setText('soStatCancelled', stats.cancelled || 0);
    setText('soStatCodValue', fmtMoney(stats.cod_value));
    setText('soStatFreight', fmtMoney(stats.freight_total));

    // Status pill counts
    const setCount = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ? ` (${val})` : ''; };
    setCount('soCountAll', stats.total);
    setCount('soCountReady', stats.ready_to_ship);
    setCount('soCountPickup', stats.pickup_scheduled);
    setCount('soCountTransit', stats.in_transit);
    setCount('soCountDelivered', stats.delivered);
    setCount('soCountCancelled', stats.cancelled);

    // Carrier dropdown (populate once from server list, preserve selection)
    const carrierSel = document.getElementById('soCarrierFilter');
    if (carrierSel && data.carriers && carrierSel.options.length <= 1) {
        data.carriers.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
            carrierSel.appendChild(opt);
        });
        carrierSel.value = soCarrier;
    }

    // Results bar + active filter tags
    const resultsBar = document.getElementById('soResultsBar');
    if (resultsBar) {
        resultsBar.style.display = 'flex';
        setText('soShowingCount', shipments.length);
        setText('soTotalCount', soTotal);
    }
    renderSoActiveFilters();

    // Pagination
    const pag = document.getElementById('soPagination');
    if (pag) {
        const totalPages = Math.max(1, Math.ceil(soTotal / SO_PAGE_SIZE));
        const curPage = Math.floor(soOffset / SO_PAGE_SIZE) + 1;
        pag.style.display = soTotal > SO_PAGE_SIZE ? 'flex' : 'none';
        setText('soPageInfo', `Page ${curPage} of ${totalPages}`);
        document.getElementById('soPrevBtn').disabled = soOffset === 0;
        document.getElementById('soNextBtn').disabled = soOffset + SO_PAGE_SIZE >= soTotal;
    }

    if (shipments.length === 0) {
        container.innerHTML = `
            <div class="multi-orders-empty">
                <div class="multi-orders-empty-icon">🚚</div>
                <div class="multi-orders-empty-title">No Shipments Found</div>
                <div class="multi-orders-empty-text">${soStatus || soSearchQuery || soCarrier || soPayment || soStartDate || soEndDate ? 'No shipments match your current filters. Try adjusting or clearing them.' : 'No orders have been shipped yet.'}</div>
            </div>
        `;
        return;
    }

    const minDate = formatDateForInput(new Date());
    cacheReshipShipments(shipments);
    container.innerHTML = shipments.map(sh => {
        const active = !['cancelled', 'failed'].includes(sh.status);
        const open = !isTerminalShipStatus(sh.status); // delivered/rto are terminal → re-shippable, not cancellable
        const isShiprocket = sh.carrier === 'shiprocket';
        const isCod = (sh.payment_mode || '').toUpperCase() === 'COD';
        const canPickup = active && ['created', 'awb_assigned'].includes(sh.status);
        const items = sh.items_json ? parseItemsPreview(sh.items_json) : (sh.product_name || '—');
        const dims = sh.weight_grams ? `${sh.weight_grams}g · ${sh.length_cm}×${sh.breadth_cm}×${sh.height_cm} cm` : '—';
        const addr = [sh.customer_address, sh.customer_city, sh.customer_state, sh.customer_pincode].filter(Boolean).join(', ');
        const waPhone = (sh.customer_phone || '').replace(/[^0-9]/g, '');

        return `
        <div class="so-ship-card">
            <div class="so-ship-head">
                <span class="so-order-id">#${escapeHtml(String(sh.order_id || ''))}</span>
                <span class="shipment-status-pill ${sh.status}">${(sh.status || '').replace(/_/g, ' ')}</span>
                ${sh.reship_of_shipment_id ? `<span class="reship-badge" title="${escapeHtml(sh.reship_reason || '')}">🔄 Re-ship of #${sh.reship_of_shipment_id}</span>` : ''}
                <span class="so-badge carrier">${escapeHtml(sh.courier_name || sh.carrier || '')}</span>
                <span class="so-badge ${isCod ? 'cod' : 'prepaid'}">${isCod ? `COD${Number(sh.cod_amount) > 0 ? ` ₹${sh.cod_amount}` : ''}` : 'Prepaid'}</span>
                ${sh.awb ? `<span class="so-awb" onclick="copyShipAwb('${escapeHtml(sh.awb)}')" title="Click to copy AWB">${escapeHtml(sh.awb)} ⧉</span>` : ''}
                <span class="so-ship-date">${formatDate(sh.created_at)}${sh.shipped_by ? ` · by ${escapeHtml(sh.shipped_by)}` : ''}</span>
            </div>
            <div class="so-ship-body">
                <div>
                    <span class="so-info-label">Customer</span>
                    <div class="so-info-value">${escapeHtml(sh.customer_name || 'Unknown')}<br><span class="sub">${sh.customer_phone ? formatPhone(sh.customer_phone) : '—'}</span></div>
                </div>
                <div>
                    <span class="so-info-label">Destination</span>
                    <div class="so-info-value">${addr ? escapeHtml(addr) : '—'}</div>
                </div>
                <div>
                    <span class="so-info-label">Items</span>
                    <div class="so-info-value">${escapeHtml(String(items))}<br><span class="sub">Order value: ${sh.order_total ? '₹' + Number(sh.order_total).toLocaleString('en-IN') : '—'}</span></div>
                </div>
                <div>
                    <span class="so-info-label">Package &amp; Freight</span>
                    <div class="so-info-value">${dims}<br><span class="sub">Freight: ${sh.freight_charge ? '₹' + sh.freight_charge : '—'}${sh.pickup_date ? ` · Pickup: ${escapeHtml(String(sh.pickup_date))}` : ''}</span></div>
                </div>
                ${sh.reship_reason ? `<div><span class="so-info-label">Re-Ship Reason</span><div class="so-info-value" style="color:#ffc759;">${escapeHtml(sh.reship_reason)}</div></div>` : ''}
                ${sh.error_message ? `<div><span class="so-info-label">Error</span><div class="so-info-value" style="color:#ff6b7a;">${escapeHtml(sh.error_message)}</div></div>` : ''}
            </div>
            <div class="so-ship-actions">
                ${active ? `
                    <button class="so-act-btn track" onclick="shipDoTrack(${sh.id})">📍 Track</button>
                    ${sh.tracking_url ? `<a class="so-act-btn track" href="${escapeHtml(sh.tracking_url)}" target="_blank">Open Tracking ↗</a>` : ''}
                    <button class="so-act-btn label" onclick="shipGetLabel(${sh.id})">⬇️ Label</button>
                    ${isShiprocket ? `
                        <button class="so-act-btn label" onclick="shipGetLabel(${sh.id}, 'manifest')">Manifest</button>
                        <button class="so-act-btn label" onclick="shipGetLabel(${sh.id}, 'invoice')">Invoice</button>` : ''}
                    ${canPickup ? `
                        <input type="date" class="so-pickup-date" id="so-pickup-${sh.id}" min="${minDate}" value="${minDate}" style="color-scheme: dark;">
                        <button class="so-act-btn pickup" onclick="shipDoPickup(${sh.id}, 'so-pickup-${sh.id}')">📅 Pickup</button>` : ''}
                    ${waPhone ? `<a class="so-act-btn wa" href="https://wa.me/${waPhone}" target="_blank">WhatsApp</a>` : ''}
                    ${sh.shopper_id ? `<button class="so-act-btn reship" onclick="openReshipModal(${sh.id})" title="${open ? 'Cancel this shipment and create a replacement — reason is tracked' : 'Create a replacement shipment — reason is tracked'}">🔄 Re-Ship</button>` : ''}
                    ${open ? `<button class="so-act-btn cancel" onclick="soDoCancel(${sh.id})" style="margin-left:auto;">✕ Cancel</button>` : ''}
                ` : `
                    <span style="font-size:0.72rem;color:rgba(255,255,255,0.35);font-family:'Archivo Narrow',sans-serif;letter-spacing:1px;text-transform:uppercase;">Shipment ${escapeHtml(sh.status || '')}</span>
                    ${sh.shopper_id ? `<button class="so-act-btn reship" onclick="openReshipModal(${sh.id})" title="Re-ship this order — reason is tracked and the wizard reopens">🔄 Re-Ship</button>` : ''}
                    ${waPhone ? `<a class="so-act-btn wa" href="https://wa.me/${waPhone}" target="_blank" style="margin-left:auto;">WhatsApp</a>` : ''}
                `}
            </div>
            <div id="track-${sh.id}" style="padding: 0 1.25rem;"></div>
        </div>`;
    }).join('');
}

function renderSoActiveFilters() {
    const wrap = document.getElementById('soActiveFilters');
    if (!wrap) return;
    const tags = [];
    const statusLabels = { ready: 'Ready', pickup_scheduled: 'Pickup Scheduled', in_transit: 'In Transit', delivered: 'Delivered', cancelled: 'Cancelled', rto: 'RTO' };
    if (soStatus) tags.push(`<span class="so-filter-tag" onclick="soRemoveFilter('status')">${statusLabels[soStatus] || soStatus} <span class="tag-close">×</span></span>`);
    if (soCarrier) tags.push(`<span class="so-filter-tag" onclick="soRemoveFilter('carrier')">${escapeHtml(soCarrier)} <span class="tag-close">×</span></span>`);
    if (soPayment) tags.push(`<span class="so-filter-tag" onclick="soRemoveFilter('payment')">${escapeHtml(soPayment)} <span class="tag-close">×</span></span>`);
    if (soSearchQuery) tags.push(`<span class="so-filter-tag" onclick="soRemoveFilter('search')">“${escapeHtml(soSearchQuery)}” <span class="tag-close">×</span></span>`);
    if (soStartDate || soEndDate) tags.push(`<span class="so-filter-tag" onclick="soRemoveFilter('dates')">${soStartDate || '…'} → ${soEndDate || '…'} <span class="tag-close">×</span></span>`);
    wrap.innerHTML = tags.join('');
}

function soRemoveFilter(kind) {
    if (kind === 'status') {
        soStatus = '';
        document.querySelectorAll('.so-status-pill').forEach(p => p.classList.remove('active'));
        document.querySelector('.so-status-pill[data-so-status=""]')?.classList.add('active');
    } else if (kind === 'carrier') {
        soCarrier = '';
        const el = document.getElementById('soCarrierFilter'); if (el) el.value = '';
    } else if (kind === 'payment') {
        soPayment = '';
        const el = document.getElementById('soPaymentFilter'); if (el) el.value = '';
    } else if (kind === 'search') {
        soSearchQuery = '';
        const el = document.getElementById('soSearchInput'); if (el) el.value = '';
    } else if (kind === 'dates') {
        soStartDate = ''; soEndDate = ''; soQuickDate = null;
        const s = document.getElementById('soStartDate'); if (s) s.value = '';
        const e = document.getElementById('soEndDate'); if (e) e.value = '';
        document.querySelectorAll('.so-quick-date').forEach(b => b.classList.remove('active'));
    }
    soOffset = 0;
    fetchShippedOrders();
}

function applySoQuickDate(range) {
    // Get current time in IST (UTC + 5:30)
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    let start, end;

    switch (range) {
        case 'today':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            end = new Date(start);
            break;
        case 'yesterday':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 1));
            end = new Date(start);
            break;
        case 'last7':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 6));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'last30':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 29));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        case 'thisMonth':
            start = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1));
            end = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
            break;
        default:
            return;
    }

    const fmt = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    soStartDate = fmt(start);
    soEndDate = fmt(end);

    const startEl = document.getElementById('soStartDate');
    const endEl = document.getElementById('soEndDate');
    if (startEl) startEl.value = soStartDate;
    if (endEl) endEl.value = soEndDate;

    fetchShippedOrders();
}

function clearSoFilters() {
    soStatus = '';
    soCarrier = '';
    soPayment = '';
    soSearchQuery = '';
    soStartDate = '';
    soEndDate = '';
    soQuickDate = null;
    soOffset = 0;

    document.querySelectorAll('.so-status-pill').forEach(p => p.classList.remove('active'));
    document.querySelector('.so-status-pill[data-so-status=""]')?.classList.add('active');
    document.querySelectorAll('.so-quick-date').forEach(b => b.classList.remove('active'));
    const ids = { soCarrierFilter: '', soPaymentFilter: '', soSearchInput: '', soStartDate: '', soEndDate: '' };
    Object.keys(ids).forEach(id => { const el = document.getElementById(id); if (el) el.value = ids[id]; });

    fetchShippedOrders();
}

async function soDoCancel(shipmentId) {
    // Reuses the shared cancel flow, then refreshes this view's list + stats
    await shipDoCancel(shipmentId);
    fetchShippedOrders();
}

// Re-ship a failed/cancelled shipment — kept for backwards compatibility;
// the premium flow (openReshipModal) is what the UI buttons use now
function soRetryShipment(shopperId) {
    openShipModal(shopperId);
}

// ---------- New Forward Shipment (ship any order by its Order ID) ----------

function openSoNewShipModal() {
    const input = document.getElementById('soLookupInput');
    if (input) input.value = '';
    document.getElementById('soLookupResults').innerHTML =
        '<div style="text-align:center;color:#888;padding:2rem 0;font-size:0.85rem;">Start typing to find an order — by Order ID, name, phone or AWB.</div>';
    document.getElementById('soNewShipModal').classList.add('active');
    setTimeout(() => input?.focus(), 50);
}

function closeSoNewShipModal() {
    document.getElementById('soNewShipModal').classList.remove('active');
}

async function runSoLookup(q) {
    const box = document.getElementById('soLookupResults');
    if (!box) return;
    if (!q || q.length < 2) {
        box.innerHTML = '<div style="text-align:center;color:#888;padding:2rem 0;font-size:0.85rem;">Type at least 2 characters to search.</div>';
        return;
    }
    box.innerHTML = '<div class="ship-loading"><div class="spinner"></div><span>Searching orders...</span></div>';
    try {
        const data = await apiCall(`/shipping/orders/lookup?q=${encodeURIComponent(q)}`);
        if (!data || !data.success) {
            box.innerHTML = `<div class="ship-error-box">❌ ${escapeHtml(data?.error || 'Lookup failed')}</div>`;
            return;
        }
        renderSoLookupResults(data.orders || []);
    } catch (err) {
        console.error('[SHIP] Order lookup error:', err);
        box.innerHTML = '<div class="ship-error-box">❌ Lookup failed — try again</div>';
    }
}

function renderSoLookupResults(orders) {
    const box = document.getElementById('soLookupResults');
    if (!box) return;
    if (orders.length === 0) {
        box.innerHTML = '<div style="text-align:center;color:#888;padding:2rem 0;font-size:0.85rem;">No orders matched. Check the Order ID and try again.</div>';
        return;
    }

    box.innerHTML = orders.map(o => {
        const isCod = /cod|cash/i.test(o.payment_method || '');
        const items = o.items_json ? parseItemsPreview(o.items_json) : '—';
        const addr = [o.city, o.province, o.zip].filter(Boolean).join(', ');
        const hasActive = !!o.active_shipment_id;
        const lastFailed = !hasActive && o.last_shipment_status === 'failed';
        const lastCancelled = !hasActive && o.last_shipment_status === 'cancelled';

        let tag = '';
        if (hasActive) tag = `<span class="so-lookup-tag shipped">Shipped · ${escapeHtml(o.active_awb || 'AWB pending')}</span>`;
        else if (lastFailed) tag = '<span class="so-lookup-tag failed">Last attempt failed</span>';
        else if (lastCancelled) tag = '<span class="so-lookup-tag cancelled">Previously cancelled</span>';

        const action = hasActive
            ? `<button class="so-act-btn track" onclick="soViewShipmentsFromLookup('${escapeHtml(String(o.shopper_id))}', '${escapeHtml(String(o.order_id))}')">📦 View Shipments</button>`
            : `<button class="so-act-btn label" onclick="soShipFromLookup('${escapeHtml(String(o.shopper_id))}')">🚚 ${lastFailed || lastCancelled ? 'Re-ship' : 'Ship'} Order</button>`;

        return `
        <div class="so-lookup-item">
            <div class="so-lookup-info">
                <div class="so-lookup-order">#${escapeHtml(String(o.order_id || ''))}${tag}</div>
                <div class="so-lookup-meta">
                    ${escapeHtml(o.name || 'Unknown')} · ${o.phone ? escapeHtml(formatPhone(o.phone)) : '—'}${addr ? ` · ${escapeHtml(addr)}` : ''}<br>
                    ${escapeHtml(String(items))} · ${o.order_total ? '₹' + Number(o.order_total).toLocaleString('en-IN') : '—'} · ${isCod ? 'COD' : 'Prepaid'} · Order status: ${escapeHtml(o.shopper_status || '—')}
                    ${lastFailed && o.last_shipment_error ? `<br><span style="color:#ff6b7a;">Last error: ${escapeHtml(o.last_shipment_error)}</span>` : ''}
                </div>
            </div>
            <div class="so-lookup-actions">${action}</div>
        </div>`;
    }).join('');
}

function soShipFromLookup(shopperId) {
    closeSoNewShipModal();
    openShipModal(shopperId);
}

function soViewShipmentsFromLookup(shopperId, orderId) {
    closeSoNewShipModal();
    openShipmentsDrawer(shopperId, orderId);
}

async function exportShippedCsv() {
    showShipToast('Preparing CSV export...');
    try {
        const data = await apiCall('/shipping/history?' + buildSoParams(1000, 0).toString());
        if (!data || !data.success) { showShipToast(data?.error || 'Export failed', true); return; }
        const shipments = data.shipments || [];
        if (shipments.length === 0) { showShipToast('Nothing to export for current filters', true); return; }

        const cols = ['Order ID', 'Customer', 'Phone', 'Address', 'City', 'State', 'Pincode', 'Carrier', 'Courier', 'AWB', 'Status', 'Payment', 'COD Amount', 'Order Total', 'Weight (g)', 'Freight', 'Pickup Date', 'Tracking URL', 'Shipped By', 'Created At'];
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = shipments.map(sh => [
            sh.order_id, sh.customer_name, sh.customer_phone, sh.customer_address, sh.customer_city,
            sh.customer_state, sh.customer_pincode, sh.carrier, sh.courier_name, sh.awb, sh.status,
            sh.payment_mode, sh.cod_amount, sh.order_total, sh.weight_grams, sh.freight_charge,
            sh.pickup_date, sh.tracking_url, sh.shipped_by, sh.created_at
        ].map(esc).join(','));

        const csv = [cols.map(esc).join(','), ...rows].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `shipped-orders-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
        showShipToast(`✅ Exported ${shipments.length} shipments`);
    } catch (err) {
        console.error('Shipped CSV export error:', err);
        showShipToast('Export failed', true);
    }
}

// Expose shipped-orders functions for inline onclick handlers
window.soDoCancel = soDoCancel;
window.soRemoveFilter = soRemoveFilter;
window.soRetryShipment = soRetryShipment;
window.openReshipModal = openReshipModal;
window.closeReshipModal = closeReshipModal;
window.selectReshipReason = selectReshipReason;
window.reshipContinue = reshipContinue;
window.openSoNewShipModal = openSoNewShipModal;
window.closeSoNewShipModal = closeSoNewShipModal;
window.soShipFromLookup = soShipFromLookup;
window.soViewShipmentsFromLookup = soViewShipmentsFromLookup;

// ============================================================
// SMART LOGIN — TEAM & PERMISSIONS (admin only)
// Manage operator accounts, their permissions, and monitor
// everything they do in the hub.
// ============================================================
let teamOperatorsCache = [];
let teamPermCatalog = null;
let teamEventsBound = false;

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function teamApiFetch(path, method = 'GET', body = null) {
    const token = localStorage.getItem('authToken');
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { alert('Session expired — please log in again.'); location.reload(); throw new Error('unauthorized'); }
    if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

function showTeamView() {
    if (getHubIdentity().role !== 'admin') { alert('Team management is admin-only.'); return; }
    document.getElementById('teamView').style.display = 'block';
    loadTeamOperators();
    loadTeamActivity();
}

function hideTeamView() {
    document.getElementById('teamView').style.display = 'none';
}

function fmtTeamDate(ts) {
    if (!ts) return 'never';
    try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(ts); }
}

function fmtRelative(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

async function loadTeamOperators() {
    const listEl = document.getElementById('operatorsList');
    try {
        const data = await teamApiFetch('/operators');
        teamOperatorsCache = data.operators || [];
        renderTeamOperators();
        // Populate the activity filter dropdown
        const sel = document.getElementById('activityOperatorFilter');
        if (sel) {
            const current = sel.value;
            sel.innerHTML = '<option value="">All operators</option>' +
                teamOperatorsCache.map(op => `<option value="${op.id}">${escapeHtml(op.name || op.username)}</option>`).join('');
            sel.value = current;
        }
    } catch (err) {
        listEl.innerHTML = `<div style="color:#ff4757; font-size:0.85rem;">Failed to load team: ${escapeHtml(err.message)}</div>`;
    }
}

function renderTeamOperators() {
    const listEl = document.getElementById('operatorsList');
    if (!listEl) return;
    if (teamOperatorsCache.length === 0) {
        listEl.innerHTML = `<div style="color:rgba(255,255,255,0.5); font-size:0.85rem; padding:1rem 0;">No operators yet. Click <strong>Add Operator</strong> to create the first login.</div>`;
        return;
    }
    listEl.innerHTML = teamOperatorsCache.map(op => {
        const initials = (op.name || op.username || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2);
        const permChips = (op.permissions || []).map(p => `<span class="perm-chip">${escapeHtml(p.replace(/_/g, ' '))}</span>`).join('') || '<span style="font-size:0.68rem;color:rgba(255,255,255,0.35);">no permissions</span>';
        return `
        <div class="operator-row">
            <div class="operator-avatar">${escapeHtml(initials)}</div>
            <div class="operator-info">
                <div class="operator-name">
                    <span class="status-dot ${op.is_active ? 'active' : 'inactive'}"></span>
                    ${escapeHtml(op.name || op.username)}
                </div>
                <div class="operator-meta">
                    @${escapeHtml(op.username)} · ${op.actions_7d || 0} actions this week · last login: ${fmtTeamDate(op.last_login_at)}
                </div>
                <div class="operator-perms">${permChips}</div>
            </div>
            <div class="operator-actions">
                <button class="op-btn" onclick="openTeamOperatorModal(${op.id})">Edit</button>
                <button class="op-btn" onclick="openTeamResetPassword(${op.id})">Password</button>
                <button class="op-btn" onclick="toggleTeamOperatorActive(${op.id}, ${!op.is_active})">${op.is_active ? 'Deactivate' : 'Activate'}</button>
                <button class="op-btn" onclick="filterTeamActivity(${op.id})">Activity</button>
                <button class="op-btn danger" onclick="deleteTeamOperator(${op.id})">Delete</button>
            </div>
        </div>`;
    }).join('');
}

// Expose handlers for inline onclick buttons
window.openTeamOperatorModal = openTeamOperatorModal;
window.openTeamResetPassword = openTeamResetPassword;
window.toggleTeamOperatorActive = toggleTeamOperatorActive;
window.filterTeamActivity = filterTeamActivity;
window.deleteTeamOperator = deleteTeamOperator;

async function ensureTeamPermCatalog() {
    if (teamPermCatalog) return teamPermCatalog;
    const data = await teamApiFetch('/operators/permissions');
    teamPermCatalog = data.permissions;
    return teamPermCatalog;
}

function renderTeamPermCheckboxes(selected = []) {
    const renderGroup = (items) => items.map(p => `
        <label class="perm-check ${selected.includes(p.key) ? 'checked' : ''}">
            <input type="checkbox" value="${p.key}" ${selected.includes(p.key) ? 'checked' : ''}
                onchange="this.closest('.perm-check').classList.toggle('checked', this.checked)">
            <span>
                <span class="perm-label">${escapeHtml(p.label)}</span>
                <div class="perm-desc">${escapeHtml(p.description)}</div>
            </span>
        </label>`).join('');
    document.getElementById('opPagePerms').innerHTML = renderGroup(teamPermCatalog.pages);
    document.getElementById('opFunctionPerms').innerHTML = renderGroup(teamPermCatalog.functions);
}

function getSelectedTeamPerms() {
    return [...document.querySelectorAll('#opPagePerms input:checked, #opFunctionPerms input:checked')].map(i => i.value);
}

function setTeamModalMsg(text, type) {
    const el = document.getElementById('operatorModalMsg');
    el.textContent = text || '';
    el.className = 'op-msg' + (text ? ` ${type}` : '');
}

async function openTeamOperatorModal(operatorId = null) {
    try {
        const catalog = await ensureTeamPermCatalog();
        const op = operatorId ? teamOperatorsCache.find(o => o.id === operatorId) : null;

        document.getElementById('operatorModalTitle').textContent = op ? `Edit @${op.username}` : 'Add Operator';
        document.getElementById('opEditId').value = op ? op.id : '';
        document.getElementById('opUsername').value = op ? op.username : '';
        document.getElementById('opUsername').disabled = !!op; // IDs are immutable
        document.getElementById('opName').value = op ? (op.name || '') : '';
        document.getElementById('opPassword').value = '';
        document.getElementById('opPasswordGroup').style.display = op ? 'none' : 'block';
        document.getElementById('opPassword').required = !op;
        renderTeamPermCheckboxes(op ? (op.permissions || []) : []);
        setTeamModalMsg('', '');
        document.getElementById('operatorModal').classList.add('open');
        void catalog;
    } catch (err) {
        alert('Could not open operator form: ' + err.message);
    }
}

function closeTeamOperatorModal() {
    document.getElementById('operatorModal').classList.remove('open');
}

async function handleTeamOperatorSubmit(e) {
    e.preventDefault();
    const editId = document.getElementById('opEditId').value;
    const username = document.getElementById('opUsername').value.trim();
    const name = document.getElementById('opName').value.trim();
    const password = document.getElementById('opPassword').value;
    const permissions = getSelectedTeamPerms();

    try {
        if (editId) {
            await teamApiFetch(`/operators/${editId}`, 'PUT', { name, permissions });
            setTeamModalMsg('Operator updated successfully.', 'success');
        } else {
            await teamApiFetch('/operators', 'POST', { username, name, password, permissions });
            setTeamModalMsg('Operator created — share the ID & password with them.', 'success');
        }
        setTimeout(() => { closeTeamOperatorModal(); loadTeamOperators(); loadTeamActivity(); }, 900);
    } catch (err) {
        setTeamModalMsg(err.message, 'error');
    }
}

async function toggleTeamOperatorActive(operatorId, newActive) {
    try {
        await teamApiFetch(`/operators/${operatorId}`, 'PUT', { is_active: newActive });
        loadTeamOperators();
    } catch (err) { alert(err.message); }
}

async function deleteTeamOperator(operatorId) {
    const op = teamOperatorsCache.find(o => o.id === operatorId);
    if (!op) return;
    if (!confirm(`Delete operator @${op.username}? They will lose access immediately. Their activity history is kept.`)) return;
    try {
        await teamApiFetch(`/operators/${operatorId}`, 'DELETE');
        loadTeamOperators();
        loadTeamActivity();
    } catch (err) { alert(err.message); }
}

// Reset password modal
let teamResetPasswordId = null;
function openTeamResetPassword(operatorId) {
    const op = teamOperatorsCache.find(o => o.id === operatorId);
    if (!op) return;
    teamResetPasswordId = operatorId;
    document.getElementById('resetPasswordFor').textContent = `@${op.username}`;
    document.getElementById('resetPasswordInput').value = '';
    const msg = document.getElementById('resetPasswordMsg');
    msg.textContent = ''; msg.className = 'op-msg';
    const modal = document.getElementById('resetPasswordModal');
    modal.style.display = 'flex';
}

function closeTeamResetPassword() {
    document.getElementById('resetPasswordModal').style.display = 'none';
    teamResetPasswordId = null;
}

async function confirmTeamResetPassword() {
    const pw = document.getElementById('resetPasswordInput').value;
    const msg = document.getElementById('resetPasswordMsg');
    if (!pw || pw.length < 6) { msg.textContent = 'Password must be at least 6 characters.'; msg.className = 'op-msg error'; return; }
    try {
        await teamApiFetch(`/operators/${teamResetPasswordId}/reset-password`, 'POST', { password: pw });
        msg.textContent = '✅ Password updated — share it with the operator now, it will not be shown again.';
        msg.className = 'op-msg success';
        setTimeout(closeTeamResetPassword, 2500);
    } catch (err) {
        msg.textContent = err.message; msg.className = 'op-msg error';
    }
}

// Activity monitoring
const TEAM_ACTION_LABELS = {
    login: 'Logged in',
    login_failed: 'Failed login attempt',
    shopper_edit: 'Edited shopper',
    status_update: 'Changed status',
    shopper_delete: 'Deleted shoppers',
    chat_message: 'Sent WhatsApp message',
    export: 'Exported data',
    ship_order: 'Shipped order',
    shipment_cancel: 'Cancelled shipment',
    followup_send: 'Sent follow-up campaign'
};

async function loadTeamActivity(operatorId = null) {
    const feedEl = document.getElementById('activityFeed');
    if (!feedEl) return;
    try {
        const qs = operatorId ? `?operatorId=${operatorId}&limit=150` : '?limit=150';
        const data = await teamApiFetch(`/operators/activity${qs}`);
        const rows = data.activity || [];
        if (rows.length === 0) {
            feedEl.innerHTML = '<div style="color:rgba(255,255,255,0.5); font-size:0.85rem; padding:1rem 0;">No activity recorded yet.</div>';
            return;
        }
        feedEl.innerHTML = rows.map(a => `
            <div class="activity-item">
                <span class="activity-who">@${escapeHtml(a.username)}</span>
                <span class="activity-action"> — ${escapeHtml(TEAM_ACTION_LABELS[a.action] || a.action)}</span>
                ${a.detail ? `<div class="activity-detail">${escapeHtml(a.detail)}</div>` : ''}
                <div class="activity-time">${fmtRelative(a.created_at)} · ${fmtTeamDate(a.created_at)}${a.ip ? ` · ${escapeHtml(a.ip)}` : ''}</div>
            </div>`).join('');
    } catch (err) {
        feedEl.innerHTML = `<div style="color:#ff4757; font-size:0.85rem;">Failed to load activity: ${escapeHtml(err.message)}</div>`;
    }
}

function filterTeamActivity(operatorId) {
    const sel = document.getElementById('activityOperatorFilter');
    if (sel) sel.value = operatorId;
    loadTeamActivity(operatorId);
}

function setupTeamEvents() {
    if (teamEventsBound) return;
    teamEventsBound = true;

    document.getElementById('teamBtn')?.addEventListener('click', showTeamView);
    document.getElementById('backToShoppersFromTeam')?.addEventListener('click', hideTeamView);
    document.getElementById('createOperatorBtn')?.addEventListener('click', () => openTeamOperatorModal(null));
    document.getElementById('cancelOperatorModal')?.addEventListener('click', closeTeamOperatorModal);
    document.getElementById('operatorForm')?.addEventListener('submit', handleTeamOperatorSubmit);
    document.getElementById('cancelResetPassword')?.addEventListener('click', closeTeamResetPassword);
    document.getElementById('confirmResetPassword')?.addEventListener('click', confirmTeamResetPassword);
    document.getElementById('activityOperatorFilter')?.addEventListener('change', (e) => {
        loadTeamActivity(e.target.value ? parseInt(e.target.value) : null);
    });
    // Close modals on backdrop click
    document.getElementById('operatorModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'operatorModal') closeTeamOperatorModal();
    });
    document.getElementById('resetPasswordModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'resetPasswordModal') closeTeamResetPassword();
    });
}
setupTeamEvents();
