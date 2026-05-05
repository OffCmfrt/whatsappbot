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
            setupLoginEvents();
            return;
        }

        document.getElementById('loginView').style.display = 'none';
        document.getElementById('dashboardView').style.display = 'block';
        setupEventListeners();
        setupModalEvents();
        setupChatEvents();
        fetchShoppersData();
        fetchAnalytics();
        fetchInboxCounts();
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
        const btn = document.querySelector('#shopperLoginForm .btn-primary span');
        const err = document.getElementById('errorMessage');
        
        btn.textContent = "VERIFYING...";
        err.style.display = 'none';
        
        try {
            const res = await fetch('https://whatsappbot-4l4b.onrender.com/api/internal/shoppers/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: input.value })
            });
            const data = await res.json();
            
            if (data.success) {
                localStorage.setItem('authToken', data.token);
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
            const products = getProductsFromEditor();

            try {
                const data = await apiCall(`/shoppers/${id}`, 'PUT', { 
                    name, 
                    phone, 
                    order_id, 
                    address, 
                    items_json: JSON.stringify(products) 
                });
                if (data.success) {
                    hideModal();
                    fetchShoppersData();
                } else {
                    alert('Update failed');
                }
            } catch (err) {
                alert('Error updating details');
            }
        });
    }

    // Add Product Row Button
    const addRowBtn = document.getElementById('addProductRowBtn');
    if (addRowBtn) {
        addRowBtn.onclick = () => addProductRow();
    }
}

let chatPollingInterval = null;

function setupChatEvents() {
    const chatModal = document.getElementById('chatModal');
    const closeChat = document.getElementById('closeChat');
    const sendChatBtn = document.getElementById('sendChatBtn');
    const chatInput = document.getElementById('chatInput');
    const markResolvedBtn = document.getElementById('markResolvedBtn');

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
    
    if (res.status === 401 || res.status === 403) {
        console.error('[API] Auth failed, clearing token');
        localStorage.removeItem('authToken');
        window.location.reload();
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
        const data = await apiCall('/chat/analytics/overview');
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
                        <button class="btn btn-warning" onclick="editMultiOrder('${order.id}', '${encodeURIComponent(order.name || '')}', '${order.phone}', '${order.order_id}', '${encodeURIComponent(order.address || '')}', '${encodeURIComponent(order.items_json || '')}')">Edit</button>
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
            fetchMultiOrdersData();
        } else {
            alert('Failed to cancel order');
        }
    } catch (err) {
        alert('Error cancelling order');
    }
}

function editMultiOrder(id, nameEnc, phone, orderId, addressEnc, itemsEnc) {
    document.getElementById('editShopperId').value = id;
    document.getElementById('editName').value = nameEnc ? decodeURIComponent(nameEnc) : '';
    document.getElementById('editPhone').value = phone || '';
    document.getElementById('editOrderId').value = orderId || '';
    document.getElementById('editAddress').value = addressEnc ? decodeURIComponent(addressEnc) : '';

    // Hide customer message box for multi-order edit
    const msgBox = document.getElementById('editCustomerMessage');
    if (msgBox) msgBox.style.display = 'none';

    // Render product editor
    const itemsJson = itemsEnc ? decodeURIComponent(itemsEnc) : '[]';
    if (typeof renderProductEditor === 'function') {
        renderProductEditor(itemsJson);
    }

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
        limit: 10000, // Get all matching records
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
        
        if (currentViewMode === 'cards') {
            card.innerHTML = `
                <div class="card-select-checkbox ${isSelected ? 'checked' : ''}" id="select-${s.id}" onclick="toggleCardSelection('${s.id}', event)"></div>
                <span class="card-select-hint">Click to select</span>

                <div class="card-header-main">
                    <div class="source-info">
                        <span class="badge badge-shopify">Shopify</span>
                        <span class="badge badge-status ${statusBadgeClass}">${statusLabel}</span>
                        <span class="badge badge-delivery">${s.delivery_type || 'Standard'}</span>
                    </div>
                    <div class="amount-info">
                        <div class="price-big">₹${s.order_total || '0.00'}</div>
                        <span class="pay-method-badge">${s.payment_method || 'COD'}</span>
                    </div>
                </div>

                <div class="customer-basics">
                    <h2 class="customer-name-big">
                        ${s.name || 'Customer'}
                        <button class="btn-text-edit" onclick="openEditModal('${s.id}', '${encodeURIComponent(s.name || '')}', '${s.phone}', '${s.order_id}', '${encodeURIComponent(s.address || '')}', '${encodeURIComponent(s.items_json || '')}', '${encodeURIComponent(s.customer_message || '')}', '${s.last_response_at || ''}')">EDIT</button>
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
            `;
        } else {
            card.innerHTML = `
            <div class="card-select-checkbox ${isSelected ? 'checked' : ''}" id="select-${s.id}" onclick="toggleCardSelection('${s.id}', event)"></div>

            <div class="row-status">
                <span class="badge badge-status ${statusBadgeClass}">${statusLabel}</span>
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
                <button class="action-icon-btn" onclick="openEditModal('${s.id}', '${encodeURIComponent(s.name || '')}', '${s.phone}', '${s.order_id}', '${encodeURIComponent(s.address || '')}', '${encodeURIComponent(s.items_json || '')}', '${encodeURIComponent(s.customer_message || '')}', '${s.last_response_at || ''}')" title="Edit">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                </button>
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

function openEditModal(id, nameEnc, phone, orderId, addressEnc, itemsEnc, messageEnc, msgTime) {
    document.getElementById('editShopperId').value = id;
    document.getElementById('editName').value = nameEnc ? decodeURIComponent(nameEnc) : '';
    document.getElementById('editPhone').value = phone;
    document.getElementById('editOrderId').value = orderId;
    document.getElementById('editAddress').value = addressEnc ? decodeURIComponent(addressEnc) : '';
    
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
    
    // Structured Editor
    const itemsJson = itemsEnc ? decodeURIComponent(itemsEnc) : '[]';
    renderProductEditor(itemsJson);

    document.getElementById('editModal').classList.add('active');
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
            message: message
        });
        
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

function renderProductEditor(itemsJson) {
    const container = document.getElementById('productEditorItems');
    container.innerHTML = '';
    let items = [];
    try { items = JSON.parse(itemsJson); } catch(e) {}

    if (items.length === 0) {
        addProductRow();
    } else {
        items.forEach(item => {
            // Check for size in multiple properties, including variant_title fallback
            let size = item.size || item.variant_size || item.product_size || '';
            // Fallback: extract size from variant_title
            if (!size && item.variant_title) {
                const sizeMatch = item.variant_title.match(/Size:\s*(\w+)/i) || item.variant_title.match(/\b(S|M|L|XL|XXS|XS|XXL|XXXL|Free Size|One Size)\b/i);
                if (sizeMatch) size = sizeMatch[1].toUpperCase();
            }
            addProductRow(item.title || item.name, item.quantity, size);
        });
    }
}

function addProductRow(title = '', qty = 1, size = '') {
    const container = document.getElementById('productEditorItems');
    const row = document.createElement('div');
    row.className = 'product-item-row';
    row.innerHTML = `
        <input type="text" placeholder="Product Name" value="${escapeHtml(title)}" class="item-title">
        <input type="text" placeholder="Size" value="${escapeHtml(size)}" class="item-size" style="width: 80px;">
        <input type="number" placeholder="Qty" value="${qty}" class="item-qty">
        <button type="button" class="btn-remove-item" onclick="this.parentElement.remove()">✕</button>
    `;
    container.appendChild(row);
}

function getProductsFromEditor() {
    const rows = document.querySelectorAll('.product-item-row');
    const products = [];
    rows.forEach(row => {
        const title = row.querySelector('.item-title').value.trim();
        const size = row.querySelector('.item-size')?.value.trim() || '';
        const qty = parseInt(row.querySelector('.item-qty').value) || 1;
        if (title) {
            const product = { title, quantity: qty };
            if (size) product.size = size;
            products.push(product);
        }
    });
    return products;
}

async function updateStatus(id, status) {
    if (!confirm(`Are you sure you want to change status to ${status.toUpperCase()}?`)) return;

    try {
        const data = await apiCall(`/shoppers/${id}/status`, 'POST', { status });
        if (data.success) {
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
        
        // Fetch shoppers data for the date range
        const url = `${API_BASE}/shoppers?limit=10000&start_date=${startDate}&end_date=${endDate}`;
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        
        if (!data.shoppers) {
            throw new Error('No data available');
        }
        
        // Process data for analytics
        currentAnalyticsData = processAnalyticsData(data.shoppers, startDate, endDate);
        
        // Render all components
        renderAnalyticsDashboard();
        
    } catch (error) {
        console.error('Failed to fetch analytics:', error);
        alert('Failed to load analytics data. Please try again.');
    }
}

function processAnalyticsData(shoppers, startDate, endDate) {
    const stats = {
        total: shoppers.length,
        confirmed: 0,
        pending: 0,
        cancelled: 0,
        edit_details: 0,
        daily: {},
        byDate: {},
        allShoppers: shoppers // Store all shoppers for daily export
    };
    
    // Initialize daily breakdown
    const start = new Date(startDate);
    const end = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateKey = formatDateForInput(d);
        stats.daily[dateKey] = {
            date: dateKey,
            total: 0,
            confirmed: 0,
            pending: 0,
            cancelled: 0,
            edit_details: 0,
            responded: 0,
            shoppers: [] // Store shoppers for this day
        };
    }
    
    // Process each shopper
    shoppers.forEach(s => {
        const status = s.status || 'pending';
        if (stats.hasOwnProperty(status)) {
            stats[status]++;
        }
        
        // Daily breakdown - convert UTC to IST date
        let dateKey;
        if (s.created_at) {
            // Parse the UTC date and convert to IST date
            const utcDate = new Date(s.created_at);
            const istOffsetMs = 5.5 * 60 * 60 * 1000;
            const istDate = new Date(utcDate.getTime() + istOffsetMs);
            // Format as YYYY-MM-DD in IST
            dateKey = `${istDate.getUTCFullYear()}-${String(istDate.getUTCMonth() + 1).padStart(2, '0')}-${String(istDate.getUTCDate()).padStart(2, '0')}`;
        } else {
            dateKey = formatDateForInput(new Date());
        }
        
        if (stats.daily[dateKey]) {
            stats.daily[dateKey].total++;
            if (stats.daily[dateKey].hasOwnProperty(status)) {
                stats.daily[dateKey][status]++;
            }
            if (status !== 'pending') {
                stats.daily[dateKey].responded++;
            }
            // Store shopper data for export
            stats.daily[dateKey].shoppers.push(s);
        }
    });
    
    // Convert daily to array and sort
    stats.dailyArray = Object.values(stats.daily).sort((a, b) => a.date.localeCompare(b.date));
    
    // Calculate percentages
    stats.percentages = {
        confirmed: stats.total > 0 ? Math.round((stats.confirmed / stats.total) * 100) : 0,
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
    animateCounter('analyticsPending', data.pending);
    animateCounter('analyticsCancelled', data.cancelled);
    animateCounter('analyticsEdits', data.edit_details);
    
    // Update percentages
    document.getElementById('analyticsConfirmedPct').textContent = data.percentages.confirmed + '%';
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
        const pendingPct = day.total > 0 ? Math.round((day.pending / day.total) * 100) : 0;
        const cancelledPct = day.total > 0 ? Math.round((day.cancelled / day.total) * 100) : 0;
        const editsPct = day.total > 0 ? Math.round((day.edit_details / day.total) * 100) : 0;
        
        html += `
            <tr>
                <td>${dateLabel}</td>
                <td>${day.total}</td>
                <td class="status-count confirmed">${day.confirmed} <span class="status-pct">(${confirmedPct}%)</span></td>
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
                <td colspan="8" style="text-align: center; padding: 1rem;">
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

function downloadDayReport(date, statusFilter) {
    if (!currentAnalyticsData) return;
    
    // Find the day's data
    const dayData = currentAnalyticsData.dailyArray.find(d => d.date === date);
    if (!dayData) {
        alert('No data found for this date');
        return;
    }
    
    // Filter shoppers by status if specified
    let shoppersToExport = dayData.shoppers || [];
    if (statusFilter) {
        shoppersToExport = shoppersToExport.filter(s => (s.status || 'pending') === statusFilter);
    }
    
    // Check if there are shoppers to export
    if (shoppersToExport.length === 0) {
        const label = statusFilter ? statusFilter.replace('_', ' ') : 'orders';
        alert(`No ${label} found for this date`);
        return;
    }
    
    // Build report title and filename based on filter
    const dateLabel = formatISTDateLabel(date, 'full');
    const statusLabel = statusFilter 
        ? statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1).replace('_', ' ') 
        : 'Orders';
    let csv = `${statusLabel} Report - ${dateLabel}\n`;
    csv += `Total Orders: ${dayData.total} | Confirmed: ${dayData.confirmed} | Pending: ${dayData.pending} | Cancelled: ${dayData.cancelled} | Edits: ${dayData.edit_details}\n\n`;
    
    // CSV Headers
    csv += 'Order ID,Customer Name,Phone,Email,Status,Total Amount,Delivery Type,Address,Products,Customer Message,Created At\n';
    
    // Add each shopper as a row
    shoppersToExport.forEach(s => {
        // Parse items for product list
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
        
        // Escape fields that might contain commas
        const escapeCsv = (field) => {
            if (field === null || field === undefined) return '';
            const str = String(field);
            if (str.includes(',') || str.includes('\n') || str.includes('"')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        };
        
        csv += `${escapeCsv(s.order_id)},${escapeCsv(s.name)},${escapeCsv(s.phone)},${escapeCsv(s.email)},${escapeCsv(s.status || 'pending')},${escapeCsv(s.total)},${escapeCsv(s.delivery_type || 'Standard')},${escapeCsv(s.address)},${escapeCsv(productsList)},${escapeCsv(s.customer_message || '')},${escapeCsv(formatDate(s.created_at))}\n`;
    });
    
    // Download file
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    const filenamePrefix = statusFilter ? `${statusFilter}_orders` : 'daily_orders';
    link.setAttribute('download', `${filenamePrefix}_${date}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    let csv = 'Date,Total Orders,Confirmed,Pending,Cancelled,Edit Requests,Response Rate\n';
    
    data.dailyArray.forEach(day => {
        const responseRate = day.total > 0 ? Math.round((day.responded / day.total) * 100) : 0;
        csv += `${day.date},${day.total},${day.confirmed},${day.pending},${day.cancelled},${day.edit_details},${responseRate}%\n`;
    });
    
    // Add summary row
    csv += `\nSUMMARY,,,,,,\n`;
    csv += `Total Orders,${data.total},,,,,\n`;
    csv += `Confirmed,${data.confirmed},${data.percentages.confirmed}%,,,,\n`;
    csv += `Pending,${data.pending},${data.percentages.pending}%,,,,\n`;
    csv += `Cancelled,${data.cancelled},${data.percentages.cancelled}%,,,,\n`;
    csv += `Edit Requests,${data.edit_details},${data.percentages.edit_details}%,,,,\n`;
    
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
