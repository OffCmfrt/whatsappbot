// ===================================
// Professional Admin Dashboard JS
// ===================================

const API_BASE = '/api/admin';
let authToken = localStorage.getItem('authToken');
let currentPage = 'overview';
let charts = {};
let customersData = [];
let ordersData = [];
let currentCustomersPage = 1;
let customersLimit = 50;
let totalCustomers = 0;
let currentBroadcastRecipients = []; // For previews and selection
let currentBroadcastTab = 'segmentTab';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    if (authToken) {
        showDashboard();
        loadDashboardData();
    } else {
        showLogin();
    }
    setupEventListeners();
});

// ===================================
// Event Listeners
// ===================================

function setupEventListeners() {
    // Login
    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (item.dataset.page) {
                e.preventDefault();
                navigateTo(item.dataset.page);
                // Close mobile menu after navigation
                closeMobileMenu();
            }
        });
    });

    // Refresh
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        loadDashboardData();
        loadPageData(currentPage);
    });

    document.getElementById('mobileRefreshBtn')?.addEventListener('click', () => {
        loadDashboardData();
        loadPageData(currentPage);
    });

    // Mobile Menu
    document.getElementById('mobileMenuBtn')?.addEventListener('click', toggleMobileMenu);
    document.getElementById('sidebarOverlay')?.addEventListener('click', closeMobileMenu);

    // Broadcast
    document.getElementById('broadcastForm')?.addEventListener('submit', handleBroadcast);

    // Search & Filters
    document.getElementById('customerSearch')?.addEventListener('input', filterCustomers);
    document.getElementById('orderSearch')?.addEventListener('input', filterOrders);
    document.getElementById('orderStatusFilter')?.addEventListener('change', filterOrders);
    document.getElementById('messageTypeFilter')?.addEventListener('change', filterMessages);
    document.getElementById('messageDateFilter')?.addEventListener('change', filterMessages);

    // Broadcast recipients
    document.getElementById('broadcastRecipients')?.addEventListener('change', updateRecipientCount);

    // Settings
    document.getElementById('settingsForm')?.addEventListener('submit', handleSettingsSave);

    // Customer Pagination
    document.getElementById('btnPrevCustomers')?.addEventListener('click', () => changeCustomersPage(-1));
    document.getElementById('btnNextCustomers')?.addEventListener('click', () => changeCustomersPage(1));

    // Export buttons
    document.getElementById('exportCustomersBtn')?.addEventListener('click', exportCustomers);
    document.getElementById('exportReturnsBtn')?.addEventListener('click', exportReturns);
    document.getElementById('exportExchangesBtn')?.addEventListener('click', exportExchanges);
    document.getElementById('exportMessagesBtn')?.addEventListener('click', exportMessages);

    // Returns refresh
    document.getElementById('refreshReturnsBtn')?.addEventListener('click', refreshReturnsData);

    // Support tickets
    document.getElementById('openCreatePortalBtn')?.addEventListener('click', openCreatePortalModal);
    document.getElementById('openAutoDistributeBtn')?.addEventListener('click', openAutoDistributeModal);
    document.getElementById('ticketSearchInput')?.addEventListener('input', searchTickets);
    document.getElementById('ticketStatusFilter')?.addEventListener('change', filterSupportTickets);
    document.getElementById('ticketSortBy')?.addEventListener('change', sortTickets);
    document.getElementById('assignPortalSelect')?.addEventListener('change', (e) => assignSelectedToPortal(e.target.value));
    document.getElementById('bulkDeleteBtn')?.addEventListener('click', deleteSelectedTickets);
    document.getElementById('refreshTicketsBtn')?.addEventListener('click', loadSupportTickets);
    document.getElementById('selectAllTickets')?.addEventListener('change', (e) => toggleSelectAllTickets(e.target));
    document.getElementById('showMoreBtn')?.addEventListener('click', showMoreTickets);
    
    // New filter controls
    document.getElementById('unreadFilterBtn')?.addEventListener('click', toggleUnreadFilter);
    document.getElementById('dateFromFilter')?.addEventListener('change', applyFiltersAndSort);
    document.getElementById('dateToFilter')?.addEventListener('change', applyFiltersAndSort);
    document.getElementById('timeFromFilter')?.addEventListener('change', applyFiltersAndSort);
    document.getElementById('timeToFilter')?.addEventListener('change', applyFiltersAndSort);
    document.getElementById('resetFiltersBtn')?.addEventListener('click', resetAllFilters);

    // New filter controls
    document.getElementById('searchFilterToggle')?.addEventListener('click', toggleFiltersPanel);
    document.getElementById('urgentFilterBtn')?.addEventListener('click', toggleUrgentFilter);
    document.getElementById('configureUrgentBtn')?.addEventListener('click', openUrgentKeywordsModal);
    document.getElementById('addKeywordBtn')?.addEventListener('click', addUrgentKeyword);
    document.getElementById('saveKeywordsBtn')?.addEventListener('click', saveUrgentKeywords);
    
    // Quick preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => handlePreset(e.currentTarget.dataset.preset));
    });
    
    // Close modal buttons
    document.querySelectorAll('[data-action="closeModal"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modalId = e.currentTarget.dataset.modal;
            document.getElementById(modalId)?.classList.remove('active');
        });
    });

    // Portal modals
    document.getElementById('closeCreatePortalBtn')?.addEventListener('click', closeCreatePortalModal);
    document.getElementById('cancelCreatePortalBtn')?.addEventListener('click', closeCreatePortalModal);
    document.getElementById('createPortalForm')?.addEventListener('submit', submitCreatePortal);
    document.getElementById('portalType')?.addEventListener('change', togglePortalTypeFields);
    document.getElementById('generatePortalPasswordBtn')?.addEventListener('click', generatePortalPassword);
    
    // Auto Distribute Wizard
    document.getElementById('closeAutoDistributeBtn')?.addEventListener('click', closeAutoDistributeModal);
    document.getElementById('cancelAutoDistributeBtn')?.addEventListener('click', closeAutoDistributeModal);
    document.getElementById('wizardNextBtn')?.addEventListener('click', wizardNextStep);
    document.getElementById('wizardPrevBtn')?.addEventListener('click', wizardPrevStep);
    document.getElementById('confirmDistributeBtn')?.addEventListener('click', executeDistribution);
    document.getElementById('addShiftBtn')?.addEventListener('click', addShiftRow);
    document.getElementById('closeDistributeResultsBtn')?.addEventListener('click', closeDistributeResultsModal);
    document.getElementById('doneDistributeResultsBtn')?.addEventListener('click', closeDistributeResultsModal);
    document.getElementById('exportResultsBtn')?.addEventListener('click', exportDistributionResults);
    
    // Mode selection cards
    document.querySelectorAll('.mode-card').forEach(card => {
        card.addEventListener('click', () => selectDistributionMode(card.dataset.mode));
    });
    
    // Filter inputs for live preview
    ['filterDateFrom', 'filterDateTo', 'filterTimeFrom', 'filterTimeTo'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', updateFilterPreview);
    });

    // Automation
    document.getElementById('addButtonRowBtn')?.addEventListener('click', () => addButtonRow());
    document.getElementById('loadTemplatesBtn')?.addEventListener('click', loadTemplates);
    document.getElementById('syncAllDataBtn')?.addEventListener('click', syncAllData);
    document.getElementById('syncAutomationDefaultsBtn')?.addEventListener('click', syncAutomationDefaults);
    document.getElementById('openAutomationModalBtn')?.addEventListener('click', openAutomationModal);
    document.getElementById('closeAutomationModalBtn')?.addEventListener('click', closeAutomationModal);
    document.getElementById('automationForm')?.addEventListener('submit', saveAutomation);
    document.getElementById('automationType')?.addEventListener('change', toggleAutomationFields);

    // Broadcast
    document.getElementById('broadcastTemplate')?.addEventListener('change', handleTemplateSelect);
    document.getElementById('broadcastFile')?.addEventListener('change', handleBroadcastFile);
    document.getElementById('chooseBroadcastFileBtn')?.addEventListener('click', () => document.getElementById('broadcastFile').click());
    document.getElementById('previewSegmentBtn')?.addEventListener('click', previewSegment);
    document.getElementById('parseManualPhonesBtn')?.addEventListener('click', parseManualPhones);
    document.querySelectorAll('input[name="broadcastType"]').forEach(radio => {
        radio.addEventListener('change', toggleBroadcastType);
    });
    document.querySelectorAll('[data-action="switchBroadcastTab"]').forEach(btn => {
        btn.addEventListener('click', (e) => switchBroadcastTab(e, btn.dataset.tab));
    });
    
    // Template search
    initTemplateSearch();
    
    // Load templates button
    document.getElementById('loadTemplatesBtn')?.addEventListener('click', loadTemplates);
    
    // Sync templates button (if exists)
    document.getElementById('syncTemplatesBtn')?.addEventListener('click', syncTemplates);

    // Customer & recipient modals
    document.getElementById('closeCustomerModalBtn')?.addEventListener('click', closeCustomerModal);
    document.getElementById('closeSelectionPreviewBtn')?.addEventListener('click', () => {
        document.getElementById('selectionPreview').style.display = 'none';
    });
    document.getElementById('selectAllRecipients')?.addEventListener('change', (e) => toggleAllRecipients(e.target));

    // Event delegation for dynamically generated data-action elements
    document.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        switch (action) {
            case 'viewCustomer':
                viewCustomerDetails(actionEl.dataset.phone);
                break;
            case 'viewOrder':
                viewOrderDetails(actionEl.dataset.orderId);
                break;
            case 'viewReturnDetails':
                viewReturnDetails(actionEl.dataset.returnId);
                break;
            case 'viewExchangeDetails':
                viewExchangeDetails(actionEl.dataset.exchangeId);
                break;
            case 'initiateTemplateBroadcast':
                initiateTemplateBroadcast(actionEl.dataset.template);
                break;
            case 'editAutomation':
                editAutomation(actionEl.dataset.autoId);
                break;
            case 'copyPortalLink':
                copyPortalLink(actionEl.dataset.url);
                break;
            case 'clearPortalTickets':
                clearPortalTickets(actionEl.dataset.portalId);
                break;
            case 'deletePortal':
                deletePortal(actionEl.dataset.portalId);
                break;
            case 'loadPortals':
                loadPortals();
                break;
            case 'removeRow':
                actionEl.closest('.d-flex')?.remove();
                break;
            // Template management actions
            case 'closeTemplateModal':
                closeTemplateModal();
                break;
            case 'createTemplate':
                openTemplateModal();
                break;
            case 'submitTemplate':
                submitTemplate(e);
                break;
            case 'addQuickReplyButton':
                addButtonRow();
                break;
            case 'checkTemplateStatus':
                checkTemplateStatus(actionEl.dataset.id);
                break;
            case 'deleteTemplate':
                deleteTemplate(actionEl.dataset.id);
                break;
            case 'selectTemplate':
                handleTemplateSelection(actionEl.dataset.template);
                break;
            case 'formatBold':
            case 'formatItalic':
            case 'formatStrikethrough':
            case 'insertEmoji':
            case 'insertVariable':
                handleToolbarAction(action);
                break;
        }
    });

    // Event delegation for dynamically generated checkboxes
    document.addEventListener('change', (e) => {
        if (e.target.classList.contains('ticket-checkbox')) {
            toggleTicketSelection(e.target);
        }
        if (e.target.classList.contains('recipient-checkbox')) {
            updateRecipientCount();
        }
        if (e.target.classList.contains('shopper-checkbox')) {
            updateShopperSelection();
        }
    });
}

// Mobile Menu Functions
function toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const menuBtn = document.getElementById('mobileMenuBtn');
    
    if (sidebar) sidebar.classList.toggle('mobile-open');
    if (overlay) overlay.classList.toggle('active');
    if (menuBtn) menuBtn.classList.toggle('active');
}

function closeMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const menuBtn = document.getElementById('mobileMenuBtn');
    
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('active');
    if (menuBtn) menuBtn.classList.remove('active');
}

// ===================================
// Authentication
// ===================================

async function handleLogin(e) {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('loginError');
    const buttonText = document.getElementById('loginButtonText');
    const loader = document.getElementById('loginLoader');

    buttonText.style.display = 'none';
    loader.style.display = 'inline-block';

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (data.success) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            showDashboard();
            loadDashboardData();
        } else {
            throw new Error('Invalid credentials');
        }
    } catch (error) {
        errorDiv.textContent = error.message;
        buttonText.style.display = 'inline';
        loader.style.display = 'none';
    }
}

function handleLogout() {
    authToken = null;
    localStorage.removeItem('authToken');
    showLogin();
}

function showLogin() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('dashboardScreen').style.display = 'none';
}

function showDashboard() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('dashboardScreen').style.display = 'flex';
}

// ===================================
// Navigation
// ===================================

function navigateTo(page) {
    currentPage = page;

    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    // Update pages
    document.querySelectorAll('.page-section').forEach(p => {
        p.classList.remove('active');
    });
    document.getElementById(`${page}Page`)?.classList.add('active');

    // Update title
    const titles = {
        overview: 'Overview',
        customers: 'Customer Management',
        orders: 'Order Management',
        returns: 'Returns & Exchanges',
        messages: 'Message History',
        broadcast: 'Broadcast Messages',
        templates: 'Meta API Templates',
        analytics: 'Detailed Analytics',
        settings: 'Settings',
        shoppers: 'Shopper Hub'
    };

    const subtitles = {
        overview: 'WhatsApp Bot Performance Dashboard',
        customers: 'Manage and view customer information',
        orders: 'Track and manage all orders',
        returns: 'Manage returns and exchange requests',
        messages: 'View conversation history',
        broadcast: 'Send messages to customers',
        templates: 'Manage and sync Meta API templates',
        analytics: 'In-depth performance metrics',
        settings: 'Configure bot behavior and abandoned cart reminders',
        shoppers: 'Track and segment store customers'
    };

    document.getElementById('pageTitle').textContent = titles[page] || 'Dashboard';
    document.getElementById('pageSubtitle').textContent = subtitles[page] || '';

    // Load page data
    loadPageData(page);
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `wa-toast wa-toast-${type}`;
    toast.innerHTML = `
        <div class="wa-toast-content">
            <i class="fas fa-${type === 'success' ? 'check-circle' : 'info-circle'} mr-2"></i>
            <span>${message}</span>
        </div>
    `;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('active'), 10);
    setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ===================================
// Data Loading
// ===================================

async function loadDashboardData() {
    await loadStats();
    await loadRecentActivity();
    await loadCharts();
    await loadSettings();
}

async function loadPageData(page) {
    switch (page) {
        case 'customers':
            await loadCustomers();
            break;
        case 'orders':
            await loadOrders();
            break;
        case 'returns':
            await loadReturnsData();
            break;
        case 'messages':
            await loadMessages();
            break;
        case 'support':
            await loadSupportTickets();
            await loadPortals();
            break;
        case 'broadcast':
            await loadBroadcastHistory();
            await updateRecipientCount();
            break;
        case 'templates':
            await loadTemplates();
            break;
        case 'analytics':
            await loadAnalytics();
            break;
        case 'settings':
            await loadSettings();
            break;
        case 'shoppers':
            await loadShoppers();
            break;
    }
}

// Load Statistics
async function loadStats() {
    try {
        const response = await apiCall('/stats');

        if (response.success) {
            const { stats } = response;

            // Update stat cards
            if (document.getElementById('totalCustomers')) document.getElementById('totalCustomers').textContent = stats.totalCustomers || 0;
            if (document.getElementById('segTotalCustomers')) document.getElementById('segTotalCustomers').textContent = stats.totalCustomers || 0;
            if (document.getElementById('totalOrders')) document.getElementById('totalOrders').textContent = stats.totalOrders || 0;
            document.getElementById('totalMessages').textContent = stats.totalMessages || 0;
            document.getElementById('activeToday').textContent = stats.activeToday || 0;

            // Update changes
            updateStatChange('customersChange', stats.customersGrowth);
            updateStatChange('ordersChange', stats.ordersGrowth);
            updateStatChange('messagesChange', stats.messagesGrowth);
            updateStatChange('activeChange', stats.activeGrowth);
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

function updateStatChange(elementId, growth) {
    const element = document.getElementById(elementId);
    if (!element || growth === undefined) return;

    const isPositive = growth >= 0;
    element.className = `stat-change ${isPositive ? 'positive' : 'negative'}`;
    element.innerHTML = `<span>${isPositive ? '↑' : '↓'}</span> ${Math.abs(growth)}% vs last week`;
}

// Load Recent Activity
async function loadRecentActivity() {
    try {
        const response = await apiCall('/activity/recent');

        if (response.success) {
            const container = document.getElementById('recentActivity');

            if (response.activity.length === 0) {
                container.innerHTML = '<div class="empty-state"><p class="text-muted">No recent activity</p></div>';
                return;
            }

            container.innerHTML = response.activity.map(a => `
                <div style="padding: 12px 0; border-bottom: 1px solid var(--border-color);">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                        <strong>${a.title}</strong>
                        <span class="text-small text-muted">${formatTimeAgo(a.created_at)}</span>
                    </div>
                    <p class="text-small text-muted">${a.description}</p>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Failed to load activity:', error);
    }
}

// Load Charts
async function loadCharts() {
    try {
        const response = await apiCall('/analytics/charts');

        if (response.success) {
            // Message Volume Chart
            createLineChart('messageChart', response.messageVolume);

            // Order Status Chart
            createDoughnutChart('orderStatusChart', response.orderStatus);
        }
    } catch (error) {
        console.error('Failed to load charts:', error);
    }
}

// Load Customers
async function loadCustomers(page = 1) {
    try {
        currentCustomersPage = page;
        const offset = (page - 1) * customersLimit;
        const response = await apiCall(`/customers?limit=${customersLimit}&offset=${offset}`);

        if (response.success) {
            window.customersData = response.customers;
            totalCustomers = response.total;
            renderCustomersTable(response.customers, response.total, page);
        }
    } catch (error) {
        console.error('Failed to load customers:', error);
    }
}

function renderCustomersTable(customers, total, page) {
    const tbody = document.getElementById('customersTableBody');
    const info = document.getElementById('customersPaginationInfo');
    const btnPrev = document.getElementById('btnPrevCustomers');
    const btnNext = document.getElementById('btnNextCustomers');

    if (customers.length === 0 && page === 1) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center">
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>
                        </div>
                        <div class="empty-state-title">No customers yet</div>
                        <div class="empty-state-text">Customers will appear here once they start using the bot</div>
                    </div>
                </td>
            </tr>
        `;
        if (info) info.innerText = 'Showing 0 customers';
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        return;
    }

    tbody.innerHTML = customers.map(c => `
        <tr>
            <td><strong>${c.name || 'Unknown'}</strong></td>
            <td>${formatPhone(c.phone)}</td>
            <td><span class="badge badge-info">${c.order_count || 0}</span></td>
            <td><span class="badge badge-primary">${c.message_count || 0}</span></td>
            <td class="text-small text-muted">${formatDate(c.created_at)}</td>
            <td>
                <button class="btn btn-secondary" data-action="viewCustomer" data-phone="${c.phone}">
                    View
                </button>
            </td>
        </tr>
    `).join('');

    // Update pagination UI
    if (info) {
        const start = (page - 1) * customersLimit + 1;
        const end = Math.min(page * customersLimit, total);
        info.innerText = `Showing ${start}-${end} of ${total} customers`;
    }

    if (btnPrev) btnPrev.disabled = page <= 1;
    if (btnNext) btnNext.disabled = page * customersLimit >= total;
}

function changeCustomersPage(delta) {
    loadCustomers(currentCustomersPage + delta);
}

// Load Orders
async function loadOrders() {
    try {
        const response = await apiCall('/orders');

        if (response.success) {
            window.ordersData = response.orders;
            renderOrdersTable(response.orders);
        }
    } catch (error) {
        console.error('Failed to load orders:', error);
    }
}

function renderOrdersTable(orders) {
    const tbody = document.getElementById('ordersTableBody');

    if (orders.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center">
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/></svg>
                        </div>
                        <div class="empty-state-title">No orders yet</div>
                        <div class="empty-state-text">Orders will appear here once customers place them</div>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = orders.map(o => `
        <tr>
            <td><strong>${o.order_id}</strong></td>
            <td>${o.customer_name || formatPhone(o.customer_phone)}</td>
            <td>${getStatusBadge(o.status)}</td>
            <td class="text-small">${o.awb || 'N/A'}</td>
            <td class="text-small text-muted">${formatDate(o.created_at)}</td>
            <td>
                <button class="btn btn-secondary" data-action="viewOrder" data-order-id="${o.order_id}">
                    View
                </button>
            </td>
        </tr>
    `).join('');
}

// Load Messages
async function loadMessages() {
    try {
        const response = await apiCall('/messages');

        if (response.success) {
            window.messagesData = response.messages;
            renderMessagesTable(response.messages);
        }
    } catch (error) {
        console.error('Failed to load messages:', error);
    }
}

function renderMessagesTable(messages) {
    const tbody = document.getElementById('messagesTableBody');

    // Safety check for undefined or null
    if (!messages || messages.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="text-center">
                    <div class="empty-state">
                        <div class="empty-state-icon">💬</div>
                        <div class="empty-state-title">No messages yet</div>
                        <div class="empty-state-text">Messages will appear here as customers interact with the bot</div>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = messages.map(m => `
        <tr>
            <td class="text-small text-muted">${formatTime(m.created_at)}</td>
            <td>${formatPhone(m.customer_phone)}</td>
            <td>
                <span class="badge ${m.message_type === 'incoming' ? 'badge-primary' : 'badge-success'}">
                    ${m.message_type === 'incoming' ? '📥 In' : '📤 Out'}
                </span>
            </td>
            <td class="text-small">${truncate(m.message_content, 80)}</td>
        </tr>
    `).join('');
}

// ===================================
// Professional Support Tickets System
// ===================================

let allTickets = [];
let filteredTickets = [];
let displayedTickets = [];
let selectedTickets = new Set();
let ticketsPerPage = 50;
let currentDisplayCount = 0;

// Quick reply templates for faster responses
const quickReplyTemplates = [
    { label: 'Hello', text: 'Hello! Thank you for contacting OffComfrt support. How may I assist you today?' },
    { label: 'Order Status', text: 'Let me check the status of your order. Could you please provide your order ID?' },
    { label: 'Shipping', text: 'Your order has been shipped and is on its way! You can track it using the tracking number sent to your WhatsApp.' },
    { label: 'Return Policy', text: 'We accept returns within 7 days of delivery. The item must be unworn with original tags. Would you like to initiate a return?' },
    { label: 'Exchange', text: 'For exchanges, we can arrange a pickup of your current item and deliver the new size/color. There may be a price difference to pay.' },
    { label: 'Size Help', text: 'For sizing guidance and detailed measurements, please contact our support team at support@offcomfrt.in or type your question here and we will respond within 24 hours.' },
    { label: 'Payment Issue', text: 'I understand you\'re facing a payment issue. Please try using a different payment method or contact your bank if the issue persists.' },
    { label: 'Refund', text: 'Your store credit has been issued and is now available in your account. You can use it for your next purchase.' },
    { label: 'Thanks', text: 'Thank you for choosing OffComfrt! Is there anything else I can help you with today?' },
    { label: 'Close', text: 'We\'re closing this ticket now. If you need further assistance, feel free to reach out anytime. Have a great day!' }
];

// Load Support Tickets
async function loadSupportTickets() {
    try {
        const filter = document.getElementById('ticketStatusFilter')?.value || '';
        const isReadFilter = document.getElementById('unreadFilterBtn')?.classList.contains('active') ? 'false' : undefined;
        const dateFrom = document.getElementById('dateFromFilter')?.value || '';
        const dateTo = document.getElementById('dateToFilter')?.value || '';
        const timeFrom = document.getElementById('timeFromFilter')?.value || '';
        const timeTo = document.getElementById('timeToFilter')?.value || '';

        // Build query parameters
        const params = new URLSearchParams();
        if (filter) params.append('status', filter);
        if (isReadFilter) params.append('is_read', isReadFilter);
        if (dateFrom) params.append('date_from', dateFrom);
        if (dateTo) params.append('date_to', dateTo);
        if (timeFrom) params.append('time_from', timeFrom);
        if (timeTo) params.append('time_to', timeTo);

        const queryString = params.toString();
        const response = await apiCall(`/support-tickets${queryString ? `?${queryString}` : ''}`);

        if (response.success) {
            allTickets = response.tickets || [];
            
            // Add orderId from order_id if available
            allTickets = allTickets.map(t => ({
                ...t,
                orderId: t.order_id || null
            }));
            
            updateTicketStats();
            applyFiltersAndSort();
        }
    } catch (error) {
        console.error('Failed to load support tickets:', error);
        document.getElementById('ticketsList').innerHTML = `
            <div class="tickets-empty">
                <svg class="tickets-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    <circle cx="12" cy="10" r="3"/>
                </svg>
                <div class="tickets-empty-title">Failed to load tickets</div>
                <div class="tickets-empty-text">Please try refreshing the page</div>
            </div>
        `;
    }
}

// Update statistics
function updateTicketStats() {
    const total = allTickets.length;
    const unread = allTickets.filter(t => !t.is_read).length;
    const urgent = allTickets.filter(t => isUrgentTicket(t.message)).length;
    const open = allTickets.filter(t => t.status === 'open').length;
    const resolved = allTickets.filter(t => t.status === 'resolved').length;
    
    document.getElementById('totalTicketsCount').textContent = total;
    document.getElementById('unreadTicketsCount').textContent = unread;
    document.getElementById('urgentTicketsCount').textContent = urgent;
    document.getElementById('openTicketsCount').textContent = open;
    document.getElementById('resolvedTicketsCount').textContent = resolved;
}

// Update active filters count display
function updateActiveFiltersCount() {
    let count = 0;
    const searchQuery = document.getElementById('ticketSearchInput')?.value;
    const statusFilter = document.getElementById('ticketStatusFilter')?.value;
    const dateFrom = document.getElementById('dateFromFilter')?.value;
    const dateTo = document.getElementById('dateToFilter')?.value;
    const timeFrom = document.getElementById('timeFromFilter')?.value;
    const timeTo = document.getElementById('timeToFilter')?.value;
    const unreadOnly = document.getElementById('unreadFilterBtn')?.classList.contains('active');
    const urgentOnly = document.getElementById('urgentFilterBtn')?.classList.contains('active');
    
    if (searchQuery) count++;
    if (statusFilter) count++;
    if (dateFrom || dateTo) count++;
    if (timeFrom || timeTo) count++;
    if (unreadOnly) count++;
    if (urgentOnly) count++;
    
    const countElement = document.getElementById('activeFiltersCount');
    if (countElement) {
        countElement.textContent = count > 0 ? `${count} filter${count > 1 ? 's' : ''} active` : '';
    }
}

// Apply filters and sorting
function applyFiltersAndSort() {
    const statusFilter = document.getElementById('ticketStatusFilter')?.value || '';
    const sortBy = document.getElementById('ticketSortBy')?.value || 'newest';
    const searchQuery = document.getElementById('ticketSearchInput')?.value.toLowerCase() || '';
    const unreadOnly = document.getElementById('unreadFilterBtn')?.classList.contains('active') || false;
    const urgentOnly = document.getElementById('urgentFilterBtn')?.classList.contains('active') || false;
    const dateFrom = document.getElementById('dateFromFilter')?.value || '';
    const dateTo = document.getElementById('dateToFilter')?.value || '';
    const timeFrom = document.getElementById('timeFromFilter')?.value || '';
    const timeTo = document.getElementById('timeToFilter')?.value || '';
    
    // Filter
    filteredTickets = allTickets.filter(t => {
        if (statusFilter && t.status !== statusFilter) return false;
        if (unreadOnly && t.is_read) return false;
        if (urgentOnly && !isUrgentTicket(t.message)) return false;
        
        // Enhanced search across multiple fields
        if (searchQuery) {
            const searchText = `${t.ticket_number || ''} ${t.customer_name || ''} ${t.customer_phone || ''} ${t.message || ''} ${t.orderId || ''}`.toLowerCase();
            if (!searchText.includes(searchQuery)) return false;
        }
        
        // Date filtering
        if (dateFrom || dateTo) {
            const ticketDate = new Date(t.created_at);
            const ticketDateStr = ticketDate.toISOString().split('T')[0];
            
            if (dateFrom && ticketDateStr < dateFrom) return false;
            if (dateTo && ticketDateStr > dateTo) return false;
        }
        
        // Time filtering (IST)
        if (timeFrom || timeTo) {
            const ticketTime = new Date(t.created_at);
            const ticketTimeStr = ticketTime.toTimeString().split(' ')[0].substring(0, 5);
            
            if (timeFrom && ticketTimeStr < timeFrom) return false;
            if (timeTo && ticketTimeStr > timeTo) return false;
        }
        
        return true;
    });
    
    // Sort
    filteredTickets.sort((a, b) => {
        switch(sortBy) {
            case 'oldest':
                return new Date(a.created_at) - new Date(b.created_at);
            case 'newest':
            default:
                return new Date(b.created_at) - new Date(a.created_at);
        }
    });
    
    // Reset display count and render
    currentDisplayCount = Math.min(ticketsPerPage, filteredTickets.length);
    renderTicketsList();
    updateActiveFiltersCount();
}

// Render tickets list
function renderTicketsList() {
    const container = document.getElementById('ticketsList');
    const pagination = document.getElementById('ticketsPagination');
    const selectAllCheckbox = document.getElementById('selectAllTickets');
    
    // Reset selection
    selectedTickets.clear();
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    }
    updateBulkActionButtons();
    
    if (!filteredTickets || filteredTickets.length === 0) {
        container.innerHTML = `
            <div class="tickets-empty">
                <svg class="tickets-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    <circle cx="12" cy="10" r="3"/>
                </svg>
                <div class="tickets-empty-title">No tickets found</div>
                <div class="tickets-empty-text">Customer support queries will appear here</div>
            </div>
        `;
        pagination.style.display = 'none';
        return;
    }
    
    // Get tickets to display
    displayedTickets = filteredTickets.slice(0, currentDisplayCount);
    
    container.innerHTML = displayedTickets.map(t => renderTicketItem(t)).join('');
    
    // Update pagination info
    document.getElementById('showingStart').textContent = filteredTickets.length > 0 ? 1 : 0;
    document.getElementById('showingEnd').textContent = currentDisplayCount;
    document.getElementById('showingTotal').textContent = filteredTickets.length;
    
    // Show/hide pagination
    pagination.style.display = 'flex';
    
    // Update show more button
    const showMoreBtn = document.getElementById('showMoreBtn');
    if (currentDisplayCount >= filteredTickets.length) {
        showMoreBtn.style.display = 'none';
    } else {
        showMoreBtn.style.display = 'inline-flex';
    }
    
    // Add event listeners
    attachTicketEventListeners();
}

// Render single ticket item
function renderTicketItem(t) {
    const isResolved = t.status === 'resolved';
    const isUnread = !t.is_read;
    const isUrgent = isUrgentTicket(t.message);
    const statusClass = `ticket-status-${t.status || 'open'}`;
    const date = formatTicketDate(t.created_at);
    
    // Get portal badge
    const assignedPortal = allPortals.find(p => p.id == t.portal_id);
    const portalBadge = assignedPortal 
        ? `<span class="portal-badge portal-badge-${assignedPortal.type}">${escapeHtml(assignedPortal.name)}</span>`
        : '<span class="no-portal-badge">No Portal</span>';
    
    return `
    <div class="ticket-item ${isResolved ? 'ticket-item-resolved' : ''} ${isUnread ? 'ticket-item-unread' : ''} ${isUrgent ? 'ticket-item-urgent' : ''}" 
         data-ticket-id="${t.id}" 
         data-phone="${t.customer_phone}" 
         data-name="${escapeHtml(t.customer_name || '')}" 
         data-status="${t.status}">
        <div class="ticket-checkbox-wrapper">
            <input type="checkbox" class="ticket-checkbox" value="${t.id}">
        </div>
        <div class="ticket-number-col">
            <span class="ticket-number-badge">${escapeHtml(t.ticket_number || 'N/A')}</span>
            ${isUrgent ? '<span class="urgent-badge">⚡ Urgent</span>' : ''}
        </div>
        <div class="ticket-customer">
            <div class="ticket-customer-name ${isUnread ? 'unread-name' : ''}">
                ${isUnread ? '<span class="unread-dot"></span>' : ''}
                ${escapeHtml(t.customer_name || 'Customer')}
            </div>
            <div class="ticket-customer-phone">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                <a href="tel:${t.customer_phone}">${formatPhone(t.customer_phone)}</a>
            </div>
        </div>
        <div class="ticket-message">
            <div class="ticket-message-preview">${escapeHtml(t.message || '')}</div>
            <div class="ticket-message-meta">
                <span class="ticket-message-time">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${date}
                </span>
                ${t.orderId ? `<span class="ticket-order-badge">Order #${t.orderId}</span>` : ''}
            </div>
        </div>
        <div class="ticket-meta">
            <span class="ticket-status ${statusClass}">
                ${isResolved 
                    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Resolved'
                    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Open'
                }
            </span>
        </div>
        <div class="ticket-portal-display">
            ${portalBadge}
        </div>
        <div class="ticket-actions">
            <button class="ticket-action-btn ticket-action-btn-primary btn-chat-open" data-action="chat" title="Open chat">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Chat
            </button>
            ${!isResolved ? `
            <button class="ticket-action-btn ticket-action-btn-success btn-ticket-resolve" data-action="resolve" title="Mark as resolved">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            </button>
            ` : ''}
            <button class="ticket-action-btn ticket-action-btn-danger btn-ticket-delete" data-action="delete" title="Delete ticket">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        </div>
    </div>
    `;
}

// Format ticket date
function formatTicketDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Attach event listeners to ticket items
function attachTicketEventListeners() {
    const container = document.getElementById('ticketsList');
    
    // Chat buttons
    container.querySelectorAll('.btn-chat-open').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.ticket-item');
            openSupportChat(
                item.dataset.ticketId,
                item.dataset.phone,
                item.dataset.name,
                item.dataset.status
            );
        });
    });
    
    // Resolve buttons
    container.querySelectorAll('.btn-ticket-resolve').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.ticket-item');
            resolveTicket(item.dataset.ticketId);
        });
    });
    
    // Delete buttons
    container.querySelectorAll('.btn-ticket-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.ticket-item');
            deleteTicket(item.dataset.ticketId);
        });
    });
    
    // Portal selector dropdowns
    container.querySelectorAll('.portal-select-dropdown').forEach(select => {
        select.addEventListener('change', async (e) => {
            e.stopPropagation();
            const ticketId = select.dataset.ticketId;
            const portalId = select.value || null;
            await assignTicketToPortal(ticketId, portalId, select);
        });
    });
    
    // Click on ticket item to open chat
    container.querySelectorAll('.ticket-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('input') || e.target.closest('button') || e.target.closest('select') || e.target.closest('a')) return;
            openSupportChat(
                item.dataset.ticketId,
                item.dataset.phone,
                item.dataset.name,
                item.dataset.status
            );
        });
    });
}

// Show more tickets
function showMoreTickets() {
    currentDisplayCount = Math.min(currentDisplayCount + ticketsPerPage, filteredTickets.length);
    renderTicketsList();
}

// Search tickets
function searchTickets() {
    applyFiltersAndSort();
}

// Sort tickets
function sortTickets() {
    applyFiltersAndSort();
}

// Toggle filters panel
function toggleFiltersPanel() {
    const panel = document.getElementById('filtersPanel');
    const toggle = document.getElementById('searchFilterToggle');
    
    if (panel && toggle) {
        panel.classList.toggle('open');
        toggle.classList.toggle('active');
    }
}

// Quick preset handler
function handlePreset(preset) {
    const now = new Date();
    let fromDate, toDate;
    
    // Remove active class from all presets
    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
    
    // Add active class to clicked preset
    document.querySelector(`[data-preset="${preset}"]`)?.classList.add('active');
    
    switch(preset) {
        case 'today':
            fromDate = toDate = now.toISOString().split('T')[0];
            break;
        case 'yesterday':
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            fromDate = toDate = yesterday.toISOString().split('T')[0];
            break;
        case 'week':
            const weekAgo = new Date(now);
            weekAgo.setDate(weekAgo.getDate() - 7);
            fromDate = weekAgo.toISOString().split('T')[0];
            toDate = now.toISOString().split('T')[0];
            break;
        case 'month':
            const monthAgo = new Date(now);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            fromDate = monthAgo.toISOString().split('T')[0];
            toDate = now.toISOString().split('T')[0];
            break;
    }
    
    document.getElementById('dateFromFilter').value = fromDate;
    document.getElementById('dateToFilter').value = toDate;
    
    applyFiltersAndSort();
}

// Load urgent keywords from localStorage
let urgentKeywords = JSON.parse(localStorage.getItem('urgentKeywords') || '[]');

// Default keywords if empty
if (urgentKeywords.length === 0) {
    urgentKeywords = ['refund', 'complaint', 'urgent', 'not received', 'damaged', 'defective', 'wrong item'];
    localStorage.setItem('urgentKeywords', JSON.stringify(urgentKeywords));
}

// Check if message contains urgent keywords
function isUrgentTicket(message) {
    if (!message) return false;
    const msgLower = message.toLowerCase();
    return urgentKeywords.some(keyword => msgLower.includes(keyword.toLowerCase()));
}

// Toggle urgent filter
function toggleUrgentFilter() {
    const btn = document.getElementById('urgentFilterBtn');
    if (btn) {
        btn.classList.toggle('active');
        applyFiltersAndSort();
    }
}

// Open urgent keywords modal
function openUrgentKeywordsModal() {
    renderKeywordsList();
    document.getElementById('urgentKeywordsModal')?.classList.add('active');
}

// Render keywords list
function renderKeywordsList() {
    const container = document.getElementById('keywordsList');
    if (!container) return;
    
    container.innerHTML = urgentKeywords.map((keyword, index) => `
        <div class="keyword-item">
            <span class="keyword-text">${escapeHtml(keyword)}</span>
            <button class="keyword-delete" data-action="deleteKeyword" data-index="${index}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
    `).join('');
    
    // Attach delete handlers
    container.querySelectorAll('[data-action="deleteKeyword"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.currentTarget.dataset.index);
            urgentKeywords.splice(index, 1);
            localStorage.setItem('urgentKeywords', JSON.stringify(urgentKeywords)); // Auto-save
            renderKeywordsList();
        });
    });
}

// Add new keyword
function addUrgentKeyword() {
    const input = document.getElementById('newKeywordInput');
    const keyword = input?.value.trim();
    
    if (keyword && !urgentKeywords.includes(keyword.toLowerCase())) {
        urgentKeywords.push(keyword.toLowerCase());
        localStorage.setItem('urgentKeywords', JSON.stringify(urgentKeywords)); // Auto-save
        input.value = '';
        renderKeywordsList();
    }
}

// Save urgent keywords
function saveUrgentKeywords() {
    localStorage.setItem('urgentKeywords', JSON.stringify(urgentKeywords));
    document.getElementById('urgentKeywordsModal')?.classList.remove('active');
    applyFiltersAndSort(); // Reapply filters
}

// Toggle unread filter
function toggleUnreadFilter() {
    const btn = document.getElementById('unreadFilterBtn');
    if (btn) {
        btn.classList.toggle('active');
        loadSupportTickets(); // Reload from server with new filter
    }
}

// Reset all filters
function resetAllFilters() {
    const unreadBtn = document.getElementById('unreadFilterBtn');
    const urgentBtn = document.getElementById('urgentFilterBtn');
    const statusFilter = document.getElementById('ticketStatusFilter');
    const dateFrom = document.getElementById('dateFromFilter');
    const dateTo = document.getElementById('dateToFilter');
    const timeFrom = document.getElementById('timeFromFilter');
    const timeTo = document.getElementById('timeToFilter');
    const searchInput = document.getElementById('ticketSearchInput');
    
    if (unreadBtn) unreadBtn.classList.remove('active');
    if (urgentBtn) urgentBtn.classList.remove('active');
    if (statusFilter) statusFilter.value = '';
    if (dateFrom) dateFrom.value = '';
    if (dateTo) dateTo.value = '';
    if (timeFrom) timeFrom.value = '';
    if (timeTo) timeTo.value = '';
    if (searchInput) searchInput.value = '';
    
    // Reset quick presets
    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
    
    loadSupportTickets();
}

// Filter support tickets
async function filterSupportTickets() {
    applyFiltersAndSort();
}

// Toggle ticket selection
function toggleTicketSelection(checkbox) {
    const ticketId = checkbox.value;
    const ticketItem = checkbox.closest('.ticket-item');
    
    if (checkbox.checked) {
        selectedTickets.add(ticketId);
        ticketItem?.classList.add('selected');
    } else {
        selectedTickets.delete(ticketId);
        ticketItem?.classList.remove('selected');
    }
    
    updateSelectAllState();
    updateBulkActionButtons();
}

// Toggle select all
function toggleSelectAllTickets(selectAllCheckbox) {
    const checkboxes = document.querySelectorAll('.ticket-checkbox');
    
    checkboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
        const ticketItem = checkbox.closest('.ticket-item');
        const ticketId = checkbox.value;
        
        if (selectAllCheckbox.checked) {
            selectedTickets.add(ticketId);
            ticketItem?.classList.add('selected');
        } else {
            selectedTickets.delete(ticketId);
            ticketItem?.classList.remove('selected');
        }
    });
    
    updateBulkActionButtons();
}

// Update select all checkbox state
function updateSelectAllState() {
    const selectAllCheckbox = document.getElementById('selectAllTickets');
    const allCheckboxes = document.querySelectorAll('.ticket-checkbox');
    const checkedCount = document.querySelectorAll('.ticket-checkbox:checked').length;
    
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = checkedCount === allCheckboxes.length && allCheckboxes.length > 0;
        selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
    }
}

// Update bulk action buttons visibility
function updateBulkActionButtons() {
    const bulkActionBar = document.getElementById('bulkActionBar');
    const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
    const assignPortalSelect = document.getElementById('assignPortalSelect');
    const selectedCount = document.getElementById('selectedCount');
    const hasSelection = selectedTickets.size > 0;

    // Show/hide the entire bulk action bar
    if (bulkActionBar) {
        bulkActionBar.style.display = hasSelection ? 'flex' : 'none';
    }

    // Show delete button only when tickets are selected
    if (bulkDeleteBtn) {
        bulkDeleteBtn.style.display = hasSelection ? 'inline-flex' : 'none';
    }

    // Populate and show portal select when tickets are selected
    if (assignPortalSelect) {
        const manualPortals = allPortals.filter(p => p.type === 'manual' || p.type === 'auto');
        if (hasSelection && manualPortals.length > 0) {
            assignPortalSelect.style.display = 'inline-block';
            // Populate with portal options
            assignPortalSelect.innerHTML = '<option value="">Assign to Portal...</option>' +
                manualPortals.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
        } else {
            assignPortalSelect.style.display = 'none';
        }
    }

    // Update selected count
    if (selectedCount) {
        selectedCount.textContent = selectedTickets.size;
    }
}

function toggleTicketSelection(checkbox) {
    const ticketId = checkbox.value;

    if (checkbox.checked) {
        selectedTickets.add(ticketId);
    } else {
        selectedTickets.delete(ticketId);
    }

    // Update select all checkbox state
    const selectAllCheckbox = document.getElementById('selectAllTickets');
    const allCheckboxes = document.querySelectorAll('.ticket-checkbox');
    const checkedCount = document.querySelectorAll('.ticket-checkbox:checked').length;

    if (selectAllCheckbox) {
        selectAllCheckbox.checked = checkedCount === allCheckboxes.length && allCheckboxes.length > 0;
        selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
    }

    updateBulkActionButtons();
}

function toggleSelectAllTickets(selectAllCheckbox) {
    const checkboxes = document.querySelectorAll('.ticket-checkbox');

    checkboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
        const ticketId = checkbox.value;
        if (selectAllCheckbox.checked) {
            selectedTickets.add(ticketId);
        } else {
            selectedTickets.delete(ticketId);
        }
    });

    updateBulkActionButtons();
}

async function deleteTicket(id) {
    if (!confirm('Are you sure you want to delete this ticket? This action cannot be undone.')) return;

    try {
        const response = await apiCall(`/support-tickets/${id}`, 'DELETE');
        if (response.success) {
            showToast('Ticket deleted successfully!', 'success');
            loadSupportTickets();
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        alert(error.message || 'Failed to delete ticket');
    }
}

async function deleteSelectedTickets() {
    if (selectedTickets.size === 0) return;

    if (!confirm(`Are you sure you want to delete ${selectedTickets.size} selected ticket(s)? This action cannot be undone.`)) return;

    try {
        const response = await apiCall('/support-tickets/bulk/delete', 'DELETE', {
            ids: Array.from(selectedTickets)
        });
        if (response.success) {
            showToast(`${selectedTickets.size} ticket(s) deleted successfully!`, 'success');
            selectedTickets.clear();
            loadSupportTickets();
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        alert(error.message || 'Failed to delete tickets');
    }
}

async function filterSupportTickets() {
    await loadSupportTickets();
}

async function resolveTicket(id) {
    if (!confirm('Mark this ticket as resolved?')) return;
    try {
        const response = await apiCall(`/support-tickets/${id}`, 'PUT', { status: 'resolved' });
        if (response.success) {
            showToast('Ticket marked as resolved!', 'success');
            loadSupportTickets();
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        alert(error.message);
    }
}

// Mark ticket as read
async function markTicketAsRead(ticketId) {
    try {
        await apiCall(`/support-tickets/${ticketId}/mark-read`, 'PATCH');
        
        // Update local state
        const ticket = allTickets.find(t => t.id == ticketId);
        if (ticket) {
            ticket.is_read = 1;
            updateTicketStats();
            applyFiltersAndSort();
        }
    } catch (error) {
        console.error('Failed to mark ticket as read:', error);
    }
}

// ===================================
// Support Portal Management
// ===================================

let allPortals = [];

async function loadPortals() {
    try {
        const response = await apiCall('/support-portals');
        if (response.success) {
            allPortals = response.portals || [];
            renderPortals();
            updateAssignPortalDropdown();
        }
    } catch (error) {
        console.error('Failed to load portals:', error);
        document.getElementById('portalsList').innerHTML = `
            <div class="portals-empty">Failed to load portals. <button class="btn btn-sm btn-secondary" data-action="loadPortals">Retry</button></div>
        `;
    }
}

function renderPortals() {
    const container = document.getElementById('portalsList');
    if (!container) return;

    if (allPortals.length === 0) {
        container.innerHTML = `
            <div class="portals-empty">
                No portals created yet. Create a portal to divide tickets among support agents.
            </div>
        `;
        return;
    }

    container.innerHTML = allPortals.map(portal => {
        // Parse distribution rule if exists
        let distributionRule = null;
        if (portal.distribution_rule) {
            try {
                distributionRule = JSON.parse(portal.distribution_rule);
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Calculate workload percentage
        const maxTickets = portal.max_tickets;
        const ticketCount = portal.ticket_count || portal.assigned_count || 0;
        const workloadPercent = maxTickets ? Math.round((ticketCount / maxTickets) * 100) : null;
        
        // Determine workload color
        let workloadColor = 'var(--success)';
        if (workloadPercent) {
            if (workloadPercent >= 90) {
                workloadColor = 'var(--danger)';
            } else if (workloadPercent >= 70) {
                workloadColor = 'var(--warning)';
            }
        }

        // Check if portal is currently active (for shift-based portals)
        let isActive = portal.is_active !== 0;
        let shiftInfo = null;
        
        if (distributionRule && distributionRule.shift_start && distributionRule.shift_end) {
            shiftInfo = {
                start: distributionRule.shift_start,
                end: distributionRule.shift_end
            };
            
            // Check if currently in shift time
            const now = new Date();
            const currentTime = now.getHours() * 60 + now.getMinutes();
            const [startH, startM] = shiftInfo.start.split(':').map(Number);
            const [endH, endM] = shiftInfo.end.split(':').map(Number);
            const startTime = startH * 60 + startM;
            const endTime = endH * 60 + endM;
            
            if (endTime < startTime) {
                isActive = isActive && (currentTime >= startTime || currentTime < endTime);
            } else {
                isActive = isActive && (currentTime >= startTime && currentTime < endTime);
            }
        }

        return `
            <div class="portal-card ${!isActive ? 'portal-inactive' : ''}" data-portal-id="${portal.id}">
                <div class="portal-info">
                    <div class="portal-header-row">
                        <span class="portal-name">${escapeHtml(portal.name)}</span>
                        <div class="portal-badges">
                            <span class="portal-type-badge ${portal.type}">${portal.type.replace('_', ' ')}</span>
                            ${shiftInfo ? `<span class="shift-time-badge">${shiftInfo.start} - ${shiftInfo.end}</span>` : ''}
                            ${isActive ? '<span class="active-badge">Active</span>' : '<span class="inactive-badge">Inactive</span>'}
                        </div>
                    </div>
                    <div class="portal-meta-row">
                        <span class="portal-meta">${ticketCount} tickets</span>
                        ${maxTickets ? `<span class="portal-meta">Max: ${maxTickets}</span>` : ''}
                    </div>
                    ${workloadPercent !== null ? `
                        <div class="workload-indicator">
                            <div class="workload-bar" style="width: ${workloadPercent}%; background: ${workloadColor};"></div>
                            <span class="workload-percent">${workloadPercent}%</span>
                        </div>
                    ` : ''}
                </div>
                <div class="portal-actions">
                    <span class="portal-link" data-action="copyPortalLink" data-url="${portal.url}" title="Copy link">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        Copy Link
                    </span>
                    <button class="portal-btn" data-action="clearPortalTickets" data-portal-id="${portal.id}" title="Clear all tickets">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        Clear
                    </button>
                    <button class="portal-btn portal-btn-danger" data-action="deletePortal" data-portal-id="${portal.id}" title="Delete portal">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function updateAssignPortalDropdown() {
    const select = document.getElementById('assignPortalSelect');
    if (!select) return;

    const manualPortals = allPortals.filter(p => p.type === 'manual' || p.type === 'auto');
    if (manualPortals.length === 0) {
        select.style.display = 'none';
        return;
    }

    select.innerHTML = '<option value="">Assign to Portal...</option>' +
        manualPortals.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

function openCreatePortalModal() {
    document.getElementById('createPortalModal').classList.add('active');
    generatePortalPassword();
}

function closeCreatePortalModal() {
    document.getElementById('createPortalModal').classList.remove('active');
    document.getElementById('createPortalForm').reset();
    document.getElementById('timeBasedFields').style.display = 'none';
}

function togglePortalTypeFields() {
    const type = document.getElementById('portalType').value;
    document.getElementById('timeBasedFields').style.display = type === 'time_based' ? 'block' : 'none';
}

function generatePortalPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 10; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    document.getElementById('portalPassword').value = password;
}

async function submitCreatePortal(event) {
    event.preventDefault();
    const name = document.getElementById('portalName').value.trim();
    const type = document.getElementById('portalType').value;
    const password = document.getElementById('portalPassword').value;

    const config = {};
    if (type === 'time_based') {
        config.time_start = document.getElementById('portalTimeStart').value;
        config.time_end = document.getElementById('portalTimeEnd').value;
        config.timezone = document.getElementById('portalTimezone').value;
    }

    try {
        const response = await apiCall('/support-portals', 'POST', {
            name,
            type,
            password,
            config: Object.keys(config).length > 0 ? config : null
        });

        if (response.success) {
            showToast('Portal created successfully!', 'success');
            closeCreatePortalModal();
            loadPortals();
            // Show password and link once
            setTimeout(() => {
                alert(`Portal Created!\n\nName: ${response.portal.name}\nPassword: ${response.password}\nLink: ${response.url}\n\nSave this password - it won't be shown again.`);
            }, 300);
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        showToast(error.message || 'Failed to create portal', 'error');
    }
}

// ===================================
// Auto Distribute Wizard Functions
// ===================================

let currentWizardStep = 1;
let selectedDistributionMode = 'round_robin';
let wizardShifts = [];
let distributionResults = null;

function openAutoDistributeModal() {
    currentWizardStep = 1;
    selectedDistributionMode = 'round_robin';
    wizardShifts = [];
    distributionResults = null;
    
    // Reset wizard
    updateWizardProgress();
    showWizardStep(1);
    resetWizardForm();
    
    // Add default shifts for shift-based mode
    addShiftRow('Morning Shift', '09:00', '17:00');
    addShiftRow('Evening Shift', '17:00', '01:00');
    
    document.getElementById('autoDistributeModal').classList.add('active');
}

function closeAutoDistributeModal() {
    document.getElementById('autoDistributeModal').classList.remove('active');
    resetWizardForm();
}

function resetWizardForm() {
    // Reset all form fields
    document.getElementById('distributeCount').value = 2;
    document.getElementById('distributeNamePrefix').value = 'Agent';
    document.getElementById('filterDistributeCount').value = 2;
    document.getElementById('filterNamePrefix').value = 'Agent';
    document.getElementById('maxTicketsPerPortal').value = '';
    document.getElementById('autoGeneratePasswords').checked = true;
    document.getElementById('enableWorkloadBalancing').checked = true;
    document.getElementById('autoRotate24h').checked = false;
    
    // Clear filters
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    document.getElementById('filterTimeFrom').value = '';
    document.getElementById('filterTimeTo').value = '';
    
    // Reset mode selection
    document.querySelectorAll('.mode-card').forEach(card => card.classList.remove('selected'));
    document.querySelector('.mode-card[data-mode="round_robin"]')?.classList.add('selected');
}

function selectDistributionMode(mode) {
    selectedDistributionMode = mode;
    
    // Update UI
    document.querySelectorAll('.mode-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.mode === mode);
    });
    
    // Show appropriate config section
    document.getElementById('simpleConfig').style.display = 
        (mode === 'round_robin' || mode === 'workload_balanced') ? 'block' : 'none';
    document.getElementById('filterConfig').style.display = 
        mode === 'filter_based' ? 'block' : 'none';
    document.getElementById('shiftConfig').style.display = 
        mode === 'shift_based' ? 'block' : 'none';
    
    // Update preview if on step 4
    if (currentWizardStep === 4) {
        updatePreview();
    }
}

function wizardNextStep() {
    if (!validateCurrentStep()) return;
    
    if (currentWizardStep < 4) {
        currentWizardStep++;
        updateWizardProgress();
        showWizardStep(currentWizardStep);
        
        if (currentWizardStep === 4) {
            updatePreview();
        }
    }
}

function wizardPrevStep() {
    if (currentWizardStep > 1) {
        currentWizardStep--;
        updateWizardProgress();
        showWizardStep(currentWizardStep);
    }
}

function updateWizardProgress() {
    document.querySelectorAll('.wizard-step').forEach(step => {
        const stepNum = parseInt(step.dataset.step);
        step.classList.toggle('active', stepNum === currentWizardStep);
        step.classList.toggle('completed', stepNum < currentWizardStep);
    });
}

function showWizardStep(step) {
    document.querySelectorAll('.wizard-panel').forEach(panel => panel.style.display = 'none');
    document.getElementById(`wizardStep${step}`).style.display = 'block';
    
    // Update buttons
    document.getElementById('wizardPrevBtn').style.display = step > 1 ? 'inline-block' : 'none';
    document.getElementById('wizardNextBtn').style.display = step < 4 ? 'inline-block' : 'none';
    document.getElementById('confirmDistributeBtn').style.display = step === 4 ? 'inline-block' : 'none';
}

function validateCurrentStep() {
    switch (currentWizardStep) {
        case 1:
            if (!selectedDistributionMode) {
                showToast('Please select a distribution mode', 'error');
                return false;
            }
            return true;
            
        case 2:
            if (selectedDistributionMode === 'round_robin' || selectedDistributionMode === 'workload_balanced') {
                const count = parseInt(document.getElementById('distributeCount').value);
                if (!count || count < 2 || count > 20) {
                    showToast('Number of portals must be between 2 and 20', 'error');
                    return false;
                }
            } else if (selectedDistributionMode === 'filter_based') {
                const count = parseInt(document.getElementById('filterDistributeCount').value);
                if (!count || count < 2 || count > 20) {
                    showToast('Number of portals must be between 2 and 20', 'error');
                    return false;
                }
            } else if (selectedDistributionMode === 'shift_based') {
                if (wizardShifts.length === 0) {
                    showToast('Please add at least one shift', 'error');
                    return false;
                }
            }
            return true;
            
        case 3:
            // Settings step - optional fields, always valid
            return true;
            
        default:
            return true;
    }
}

function addShiftRow(name = '', start = '', end = '') {
    const container = document.getElementById('shiftsContainer');
    const shiftIndex = wizardShifts.length;
    
    const shiftDiv = document.createElement('div');
    shiftDiv.className = 'shift-card';
    shiftDiv.dataset.index = shiftIndex;
    shiftDiv.innerHTML = `
        <div class="shift-header">
            <h6>Shift ${shiftIndex + 1}</h6>
            <button type="button" class="btn-remove-shift" onclick="removeShiftRow(${shiftIndex})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        <div class="shift-fields">
            <div class="form-group">
                <label>Shift Name</label>
                <input type="text" class="shift-name" value="${name}" placeholder="e.g. Morning Shift">
            </div>
            <div class="shift-time-row">
                <div class="form-group">
                    <label>Start Time</label>
                    <input type="time" class="shift-start" value="${start}">
                </div>
                <div class="form-group">
                    <label>End Time</label>
                    <input type="time" class="shift-end" value="${end}">
                </div>
            </div>
            <div class="form-group">
                <label>Portal Name Prefix</label>
                <input type="text" class="shift-prefix" value="${name}" placeholder="e.g. Morning Agent">
            </div>
        </div>
    `;
    
    container.appendChild(shiftDiv);
    wizardShifts.push({ name, start, end });
}

function removeShiftRow(index) {
    const container = document.getElementById('shiftsContainer');
    const shiftCard = container.querySelector(`[data-index="${index}"]`);
    if (shiftCard) {
        shiftCard.remove();
        wizardShifts.splice(index, 1);
    }
}

function updateFilterPreview() {
    // This would call backend to get ticket count matching filters
    // For now, show a placeholder
    document.getElementById('filterTicketCount').textContent = '...';
}

async function updatePreview() {
    const modeNames = {
        'round_robin': 'Round Robin',
        'filter_based': 'Filter Based',
        'shift_based': 'Shift Based',
        'workload_balanced': 'Workload Balanced'
    };
    
    document.getElementById('previewMode').textContent = modeNames[selectedDistributionMode];
    
    let portalCount = 0;
    let portalDetails = [];
    
    if (selectedDistributionMode === 'shift_based') {
        portalCount = wizardShifts.length;
        wizardShifts.forEach((shift, idx) => {
            portalDetails.push({
                name: `${shift.name || 'Agent'} ${idx + 1}`,
                config: `${shift.start} - ${shift.end}`,
                estTickets: '~',
                capacity: document.getElementById('maxTicketsPerPortal').value || 'Unlimited'
            });
        });
    } else {
        portalCount = parseInt(
            selectedDistributionMode === 'filter_based' 
                ? document.getElementById('filterDistributeCount').value 
                : document.getElementById('distributeCount').value
        );
        
        for (let i = 0; i < portalCount; i++) {
            portalDetails.push({
                name: `${selectedDistributionMode === 'filter_based' ? document.getElementById('filterNamePrefix').value : document.getElementById('distributeNamePrefix').value} ${i + 1}`,
                config: '-',
                estTickets: '~',
                capacity: document.getElementById('maxTicketsPerPortal').value || 'Unlimited'
            });
        }
    }
    
    document.getElementById('previewPortals').textContent = portalCount;
    document.getElementById('previewTickets').textContent = 'Open tickets';
    
    // Render preview table
    const tbody = document.getElementById('previewTableBody');
    tbody.innerHTML = portalDetails.map(p => `
        <tr>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td>${p.config}</td>
            <td>${p.estTickets}</td>
            <td>${p.capacity}</td>
        </tr>
    `).join('');
    
    // Show warning if needed
    const maxTickets = parseInt(document.getElementById('maxTicketsPerPortal').value);
    if (maxTickets && maxTickets < 10) {
        document.getElementById('previewWarning').style.display = 'flex';
        document.getElementById('previewWarningText').textContent = 
            `Warning: Low capacity limit (${maxTickets}) may result in unassigned tickets.`;
    } else {
        document.getElementById('previewWarning').style.display = 'none';
    }
}

async function executeDistribution() {
    try {
        const maxTickets = document.getElementById('maxTicketsPerPortal').value 
            ? parseInt(document.getElementById('maxTicketsPerPortal').value) 
            : null;
        
        let payload = {
            distributionMode: selectedDistributionMode,
            portalSettings: {
                maxTickets,
                autoRotate: document.getElementById('autoRotate24h').checked,
                rotationHours: 24
            }
        };
        
        if (selectedDistributionMode === 'round_robin' || selectedDistributionMode === 'workload_balanced') {
            payload.count = parseInt(document.getElementById('distributeCount').value);
            payload.namePrefix = document.getElementById('distributeNamePrefix').value.trim();
        } else if (selectedDistributionMode === 'filter_based') {
            payload.count = parseInt(document.getElementById('filterDistributeCount').value);
            payload.namePrefix = document.getElementById('filterNamePrefix').value.trim();
            
            // Get selected statuses
            const statusFilters = [];
            document.querySelectorAll('#filterConfig .checkbox-group input:checked').forEach(cb => {
                statusFilters.push(cb.value);
            });
            
            payload.filters = {
                dateFrom: document.getElementById('filterDateFrom').value || null,
                dateTo: document.getElementById('filterDateTo').value || null,
                timeFrom: document.getElementById('filterTimeFrom').value || null,
                timeTo: document.getElementById('filterTimeTo').value || null,
                statusFilter: statusFilters.length > 0 ? statusFilters : ['open']
            };
        } else if (selectedDistributionMode === 'shift_based') {
            // Collect shift data
            const shifts = [];
            document.querySelectorAll('.shift-card').forEach(card => {
                shifts.push({
                    name: card.querySelector('.shift-name').value.trim(),
                    start: card.querySelector('.shift-start').value,
                    end: card.querySelector('.shift-end').value
                });
            });
            
            payload.shifts = shifts;
            payload.count = shifts.length;
            payload.namePrefix = 'Agent';
        }
        
        // Show loading
        document.getElementById('confirmDistributeBtn').disabled = true;
        document.getElementById('confirmDistributeBtn').textContent = 'Distributing...';
        
        const response = await apiCall('/support-portals/auto-distribute', 'POST', payload);
        
        if (response.success) {
            showToast(`${response.portals.length} portals created and tickets distributed!`, 'success');
            closeAutoDistributeModal();
            loadPortals();
            loadSupportTickets();
            showDistributeResults(response.portals, response.stats);
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        showToast(error.message || 'Failed to distribute tickets', 'error');
    } finally {
        document.getElementById('confirmDistributeBtn').disabled = false;
        document.getElementById('confirmDistributeBtn').textContent = 'Distribute Tickets';
    }
}

function showDistributeResults(portals, stats = null) {
    distributionResults = { portals, stats };
    
    // Update stats
    if (stats) {
        document.getElementById('statTotalTickets').textContent = stats.totalTickets;
        document.getElementById('statTotalPortals').textContent = stats.totalPortals;
        document.getElementById('statDistributionMode').textContent = 
            stats.distributionMode.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
        
        document.getElementById('resultsSummary').textContent = 
            `${stats.totalTickets} tickets distributed across ${stats.totalPortals} portals`;
    }
    
    // Render portal cards
    const container = document.getElementById('distributeResultsList');
    container.innerHTML = portals.map(p => `
        <div class="result-portal-card">
            <div class="result-portal-header">
                <h5>${escapeHtml(p.name)}</h5>
                ${p.shift ? `<span class="shift-badge">${p.shift.name || 'Shift'}</span>` : ''}
            </div>
            <div class="result-portal-stats">
                <div class="result-stat">
                    <span class="result-stat-label">Tickets:</span>
                    <span class="result-stat-value">${p.ticketCount || 0}</span>
                </div>
                ${p.maxTickets ? `
                    <div class="result-stat">
                        <span class="result-stat-label">Capacity:</span>
                        <span class="result-stat-value">${Math.round((p.ticketCount / p.maxTickets) * 100)}%</span>
                    </div>
                ` : ''}
                ${p.shift ? `
                    <div class="result-stat">
                        <span class="result-stat-label">Shift:</span>
                        <span class="result-stat-value">${p.shift.start} - ${p.shift.end}</span>
                    </div>
                ` : ''}
            </div>
            <div class="result-portal-credentials">
                <div class="credential-row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span>Link:</span>
                    <code class="credential-value">${p.url}</code>
                    <button class="btn-copy" onclick="copyToClipboard('${p.url}')">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                </div>
                <div class="credential-row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <span>Password:</span>
                    <code class="credential-value">${p.password}</code>
                    <button class="btn-copy" onclick="copyToClipboard('${p.password}')">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                </div>
            </div>
        </div>
    `).join('');
    
    document.getElementById('distributeResultsModal').classList.add('active');
}

function closeDistributeResultsModal() {
    document.getElementById('distributeResultsModal').classList.remove('active');
    distributionResults = null;
}

function exportDistributionResults() {
    if (!distributionResults || !distributionResults.portals) return;
    
    const { portals, stats } = distributionResults;
    
    // Create CSV content
    let csv = 'Portal Name,Tickets,Shift Start,Shift End,Link,Password\n';
    portals.forEach(p => {
        csv += `"${p.name}",${p.ticketCount || 0},${p.shift?.start || '-'},${p.shift?.end || '-'},${p.url},${p.password}\n`;
    });
    
    // Download CSV
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `distribution-results-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
    
    showToast('Results exported successfully!', 'success');
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!', 'success');
    }).catch(() => {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('Copied to clipboard!', 'success');
    });
}

async function deletePortal(id) {
    if (!confirm('Are you sure you want to delete this portal? Assigned tickets will be unassigned.')) return;

    try {
        const response = await apiCall(`/support-portals/${id}`, 'DELETE');
        if (response.success) {
            showToast('Portal deleted successfully!', 'success');
            loadPortals();
            loadSupportTickets();
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        showToast(error.message || 'Failed to delete portal', 'error');
    }
}

async function clearPortalTickets(id) {
    if (!confirm('Clear all ticket assignments from this portal?')) return;

    try {
        const response = await apiCall(`/support-portals/${id}/clear`, 'POST');
        if (response.success) {
            showToast('Portal tickets cleared!', 'success');
            loadPortals();
            loadSupportTickets();
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        showToast(error.message || 'Failed to clear tickets', 'error');
    }
}

async function assignSelectedToPortal(portalId) {
    if (!portalId) return;
    if (selectedTickets.size === 0) {
        showToast('No tickets selected', 'error');
        document.getElementById('assignPortalSelect').value = '';
        return;
    }

    try {
        const response = await apiCall(`/support-portals/${portalId}/assign`, 'POST', {
            ticketIds: Array.from(selectedTickets)
        });

        if (response.success) {
            showToast(`${selectedTickets.size} ticket(s) assigned to portal!`, 'success');
            selectedTickets.clear();
            updateBulkActionButtons();
            loadPortals();
            loadSupportTickets();
        } else {
            throw new Error(response.error);
        }
    } catch (error) {
        showToast(error.message || 'Failed to assign tickets', 'error');
    }

    document.getElementById('assignPortalSelect').value = '';
}


function copyPortalLink(url) {
    navigator.clipboard.writeText(url).then(() => {
        showToast('Portal link copied to clipboard!', 'success');
    }).catch(() => {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('Portal link copied to clipboard!', 'success');
    });
}

// ===================================
// Support Ticket Chat Functionality
// ===================================

let currentSupportChatPhone = null;
let currentSupportTicketId = null;
let supportChatPollingInterval = null;
let pinnedMessage = null;
let isPinningMode = false;

async function openSupportChat(ticketId, phone, name, status) {
    currentSupportTicketId = ticketId;
    currentSupportChatPhone = phone;
    
    const chatModal = document.getElementById('supportChatModal');
    const chatMessages = document.getElementById('supportChatMessages');
    
    // Update sidebar info
    document.getElementById('chatCustomerName').textContent = name || 'Customer';
    document.getElementById('chatCustomerPhone').textContent = phone;
    document.getElementById('chatTicketId').textContent = '#' + ticketId;
    document.getElementById('chatTicketStatus').textContent = (status || 'open').toUpperCase();
    document.getElementById('chatHeaderTitle').textContent = name || 'Customer';
    
    chatMessages.innerHTML = `
        <div class="chat-loading">
            <div class="spinner"></div>
            <span>Loading conversation...</span>
        </div>
    `;
    
    chatModal.classList.add('active');
    
    // Mark ticket as read
    await markTicketAsRead(ticketId);
    
    // Setup event listeners
    setupSupportChatEvents();
    
    // Start polling for new messages
    if (supportChatPollingInterval) clearInterval(supportChatPollingInterval);
    supportChatPollingInterval = setInterval(async () => {
        if (!currentSupportChatPhone) return;
        try {
            const data = await apiCall(`/chat/${currentSupportChatPhone}`);
            if (data && data.success) {
                renderSupportChatMessages(data.messages);
            }
        } catch (err) {
            // Silently fail on polling errors
        }
    }, 15000); // Poll every 15 seconds (reduced from 8s to save DB reads)
    
    try {
        const data = await apiCall(`/chat/${phone}`);
        if (data && data.success) {
            renderSupportChatMessages(data.messages);
        } else {
            chatMessages.innerHTML = `
                <div class="chat-loading">Failed to load messages</div>
            `;
        }
    } catch (err) {
        chatMessages.innerHTML = `
            <div class="chat-loading">Error loading conversation</div>
        `;
    }
}

// Insert quick reply template
function insertQuickReply(templateName) {
    const template = quickReplyTemplates.find(t => t.label === templateName);
    if (!template) return;
    
    const input = document.getElementById('supportChatInput');
    if (input) {
        input.value = template.text;
        input.focus();
        // Auto-expand textarea
        input.style.height = '48px';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
}

// Update pin button visual state
function updatePinButtonState() {
    const pinBtn = document.getElementById('pinMessageBtn');
    if (pinBtn) {
        if (isPinningMode) {
            pinBtn.classList.add('active');
            pinBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l-5.5 9h11z"/><circle cx="12" cy="19" r="3"/></svg>
                Click a Message
            `;
        } else {
            pinBtn.classList.remove('active');
            pinBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l-5.5 9h11z"/><circle cx="12" cy="19" r="3"/></svg>
                Pin
            `;
        }
    }
}

// Pin a message
function pinMessage(messageContent, messageTime) {
    pinnedMessage = {
        content: messageContent,
        time: messageTime
    };
    isPinningMode = false;
    updatePinButtonState();
    updatePinnedMessageDisplay();
    showToast('Message pinned', 'success');
}

// Update pinned message display
function updatePinnedMessageDisplay() {
    const container = document.getElementById('pinnedMessageContainer');
    const content = document.getElementById('pinnedMessageContent');
    
    if (!container || !content) return;
    
    if (pinnedMessage) {
        content.textContent = pinnedMessage.content;
        container.style.display = 'flex';
    } else {
        container.style.display = 'none';
        content.textContent = '';
    }
}

function setupSupportChatEvents() {
    const closeBtn = document.getElementById('closeSupportChat');
    const closeMobileBtn = document.getElementById('closeSupportChatMobile');
    const sendBtn = document.getElementById('sendSupportChatBtn');
    const input = document.getElementById('supportChatInput');
    const markResolvedBtn = document.getElementById('markTicketResolvedBtn');
    const pinBtn = document.getElementById('pinMessageBtn');
    const unpinBtn = document.getElementById('unpinMessageBtn');

    // Close button (desktop)
    if (closeBtn) {
        closeBtn.onclick = () => {
            document.getElementById('supportChatModal').classList.remove('active');
            currentSupportChatPhone = null;
            currentSupportTicketId = null;
            pinnedMessage = null;
            isPinningMode = false;
            updatePinButtonState();
            if (supportChatPollingInterval) {
                clearInterval(supportChatPollingInterval);
                supportChatPollingInterval = null;
            }
        };
    }

    // Close button (mobile sidebar)
    if (closeMobileBtn) {
        closeMobileBtn.onclick = () => {
            document.querySelector('.chat-sidebar').classList.remove('open');
        };
    }
    
    // Send button
    if (sendBtn) {
        sendBtn.onclick = sendSupportChatMessage;
    }
    
    // Input enter key
    if (input) {
        input.onkeypress = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendSupportChatMessage();
            }
        };
        // Auto-expand textarea
        input.oninput = () => {
            input.style.height = '52px';
            input.style.height = Math.min(input.scrollHeight, 140) + 'px';
        };
    }
    
    // Mark resolved button
    if (markResolvedBtn) {
        markResolvedBtn.onclick = async () => {
            if (!currentSupportTicketId) return;
            if (confirm('Mark this ticket as resolved?')) {
                try {
                    const response = await apiCall(`/support-tickets/${currentSupportTicketId}`, 'PUT', { status: 'resolved' });
                    if (response.success) {
                        showToast('Ticket marked as resolved!', 'success');
                        document.getElementById('supportChatModal').classList.remove('active');
                        loadSupportTickets();
                    }
                } catch (error) {
                    alert('Failed to resolve ticket');
                }
            }
        };
    }
    
    // View All Orders button
    const viewAllOrdersBtn = document.getElementById('viewAllOrdersBtn');
    if (viewAllOrdersBtn) {
        viewAllOrdersBtn.onclick = () => {
            if (currentSupportChatPhone) {
                showAllOrdersModal(currentSupportChatPhone);
            }
        };
    }
    
    // Close All Orders modal
    const closeAllOrdersModalBtn = document.getElementById('closeAllOrdersModal');
    if (closeAllOrdersModalBtn) {
        closeAllOrdersModalBtn.onclick = () => {
            document.getElementById('allOrdersModal').classList.remove('active');
        };
    }
    
    // Pin button - toggles pinning mode
    if (pinBtn) {
        pinBtn.onclick = () => {
            isPinningMode = !isPinningMode;
            updatePinButtonState();
            if (isPinningMode) {
                showToast('Click on any message to pin it', 'info');
            }
        };
    }
    
    // Unpin button
    if (unpinBtn) {
        unpinBtn.onclick = () => {
            pinnedMessage = null;
            updatePinnedMessageDisplay();
            showToast('Message unpinned', 'success');
        };
    }
}

// Helper: format time only (IST) for chat messages
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

// Helper: get IST date key from ISO string
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
    const [y, m, d] = dateKey.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
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
    
    switch (status) {
        case 'sent':
            return '<span class="msg-status msg-status-sent" title="Sent">&#10003;</span>';
        case 'delivered':
            return '<span class="msg-status msg-status-delivered" title="Delivered">&#10003;&#10003;</span>';
        case 'read':
            return '<span class="msg-status msg-status-read" title="Read">&#10003;&#10003;</span>';
        case 'failed':
            return '<span class="msg-status msg-status-failed" title="Failed">!</span>';
        default:
            return '<span class="msg-status msg-status-sent" title="Sent">&#10003;</span>';
    }
}

function renderSupportChatMessages(messages) {
    const chatMessages = document.getElementById('supportChatMessages');
    
    // Check if user is near bottom before re-rendering (within 100px of bottom)
    const isNearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 100;
    
    if (!messages || messages.length === 0) {
        chatMessages.innerHTML = `
            <div class="chat-empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <div class="chat-empty-text">No messages yet</div>
                <div class="chat-empty-sub">Start the conversation by typing below</div>
            </div>
        `;
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
        msgDiv.className = `chat-message ${msg.sender}`;
        
        const time = formatChatTime(msg.created_at);
        const typeLabel = getMessageTypeLabel(msg);
        const typeBadge = typeLabel && msg.sender === 'agent' 
            ? `<span class="msg-type-badge">${typeLabel}</span>` 
            : '';
        
        // Format message content (handles templates, images, newlines)
        const contentHtml = formatMessageContent(msg.content, msg);
        
        msgDiv.innerHTML = `
            <div class="msg-bubble">
                <div class="msg-content">${contentHtml}</div>
                <div class="msg-meta">
                    ${typeBadge}
                    <span class="msg-time">${time}</span>
                    ${getStatusIndicator(msg)}
                </div>
            </div>
        `;
        
        // Add click handler for pinning messages
        msgDiv.addEventListener('click', () => {
            if (isPinningMode) {
                pinMessage(msg.content || '', time);
            }
        });
        
        // Add visual indicator when in pinning mode
        if (isPinningMode) {
            msgDiv.style.cursor = 'pointer';
            msgDiv.title = 'Click to pin this message';
        }
        
        chatMessages.appendChild(msgDiv);
    });
    
    // Only auto-scroll to bottom if user was already near bottom
    // This preserves scroll position when user scrolls up to read messages
    if (isNearBottom) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

async function sendSupportChatMessage() {
    const input = document.getElementById('supportChatInput');
    const message = input.value.trim();
    
    if (!message || !currentSupportChatPhone) return;
    
    // Add message to UI immediately (optimistic update)
    const chatMessages = document.getElementById('supportChatMessages');
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
    
    const contentHtml = escapeHtml(message).replace(/\n/g, '<br>');
    msgDiv.innerHTML = `
        <div class="msg-bubble">
            <div class="msg-content">${contentHtml}</div>
            <div class="msg-meta">
                <span class="msg-type-badge">Manual</span>
                <span class="msg-time">${istTimeStr}</span>
                <span class="msg-status msg-status-sent">&#10003;</span>
            </div>
        </div>
    `;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    input.value = '';
    input.style.height = '52px';
    
    try {
        const data = await apiCall('/chat/send', 'POST', {
            phone: currentSupportChatPhone,
            message: message
        });
        
        if (data.success) {
            // Refresh messages to get the actual status
            const refreshData = await apiCall(`/chat/${currentSupportChatPhone}`);
            if (refreshData && refreshData.success) {
                renderSupportChatMessages(refreshData.messages);
            }
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

// Helper: escape HTML
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

// Load Broadcast History
async function loadBroadcastHistory() {
    try {
        const response = await apiCall('/broadcast/history');

        if (response.success) {
            const container = document.getElementById('broadcastHistory');

            if (response.broadcasts.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                        </div>
                        <div class="empty-state-title">No broadcasts yet</div>
                        <div class="empty-state-text">Your broadcast campaigns will appear here</div>
                    </div>
                `;
                return;
            }

            container.innerHTML = response.broadcasts.map(b => `
                <div class="card" style="margin-bottom: 16px;">
                    <div class="card-body">
                        <div class="d-flex justify-between align-center mb-2">
                            <strong>${b.title || 'Broadcast Campaign'}</strong>
                            <span class="text-small text-muted">${formatDate(b.created_at)}</span>
                        </div>
                        <p class="text-small mb-2">${truncate(b.message, 100)}</p>
                        <div class="d-flex gap-2">
                            <span class="badge badge-info">${b.total_recipients} recipients</span>
                            <span class="badge badge-success">${b.sent_count} sent</span>
                        </div>
                    </div>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Failed to load broadcast history:', error);
    }
}

// Load Analytics
async function loadAnalytics() {
    try {
        const response = await apiCall('/analytics/detailed');

        if (response.success) {
            // FAQ Chart
            createBarChart('faqChart', response.faqData);

            // Growth Chart
            createAreaChart('growthChart', response.growthData);
        }
    } catch (error) {
        console.error('Failed to load analytics:', error);
    }
}

// Load Settings
async function loadSettings() {
    try {
        const response = await apiCall('/settings');
        if (response.success && response.settings) {
            const firstDelayInput = document.getElementById('abandonedCartFirstDelay');
            if (firstDelayInput) firstDelayInput.value = response.settings.abandoned_cart_first_delay_hours;
            
            const secondDelayInput = document.getElementById('abandonedCartSecondDelay');
            if (secondDelayInput) secondDelayInput.value = response.settings.abandoned_cart_second_delay_hours;

            const templateToggle = document.getElementById('autoTemplateToggle');
            if (templateToggle) {
                templateToggle.checked = response.settings.auto_template_sending;
            }
        }
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

// Toggle Auto Templates for Shopper Hub
async function toggleAutoTemplates() {
    const isEnabled = document.getElementById('autoTemplateToggle').checked;
    try {
        const response = await apiCall('/settings', 'POST', {
            auto_template_sending: isEnabled
        });
        if (response.success) {
            showToast(`Auto Templates ${isEnabled ? 'Enabled' : 'Disabled'}`, 'success');
        } else {
            document.getElementById('autoTemplateToggle').checked = !isEnabled;
            showToast('Failed to update config', 'error');
        }
    } catch (error) {
        document.getElementById('autoTemplateToggle').checked = !isEnabled;
        showToast('Error updating config', 'error');
    }
}

// ===================================
// Chart Functions
// ===================================

function createLineChart(canvasId, data) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (charts[canvasId]) {
        charts[canvasId].destroy();
    }

    charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.labels || [],
            datasets: [{
                label: 'Messages',
                data: data.values || [],
                borderColor: '#4F46E5',
                backgroundColor: 'rgba(79, 70, 229, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true }
            }
        }
    });
}

function createDoughnutChart(canvasId, data) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (charts[canvasId]) {
        charts[canvasId].destroy();
    }

    charts[canvasId] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: data.labels || [],
            datasets: [{
                data: data.values || [],
                backgroundColor: [
                    '#4F46E5',
                    '#059669',
                    '#D97706',
                    '#DC2626',
                    '#0284C7'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' }
            }
        }
    });
}

function createBarChart(canvasId, data) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (charts[canvasId]) {
        charts[canvasId].destroy();
    }

    charts[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.labels || [],
            datasets: [{
                label: 'Queries',
                data: data.values || [],
                backgroundColor: '#4F46E5'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true }
            }
        }
    });
}

function createAreaChart(canvasId, data) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (charts[canvasId]) {
        charts[canvasId].destroy();
    }

    charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.labels || [],
            datasets: [{
                label: 'Customers',
                data: data.values || [],
                borderColor: '#059669',
                backgroundColor: 'rgba(5, 150, 105, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true }
            }
        }
    });
}

// ===================================
// Actions
// ===================================

async function handleSettingsSave(e) {
    e.preventDefault();

    const saveText = document.getElementById('settingsSaveText');
    const loader = document.getElementById('settingsLoader');

    saveText.style.display = 'none';
    loader.style.display = 'inline-block';

    try {
        const firstDelay = document.getElementById('abandonedCartFirstDelay').value;
        const secondDelay = document.getElementById('abandonedCartSecondDelay').value;

        const response = await apiCall('/settings', 'POST', {
            abandoned_cart_first_delay_hours: firstDelay,
            abandoned_cart_second_delay_hours: secondDelay
        });

        if (response.success) {
            alert('✅ Settings saved successfully!');
        } else {
            throw new Error(response.error || 'Failed to save settings');
        }
    } catch (error) {
        alert(`❌ Error saving settings: ${error.message}`);
    } finally {
        saveText.style.display = 'inline-block';
        loader.style.display = 'none';
    }
}

async function handleBroadcast(e) {
    e.preventDefault();

    const type = document.querySelector('input[name="broadcastType"]:checked')?.value || 'text';
    const delay = document.getElementById('broadcastDelay').value || 5;
    
    // Determine recipients
    let segment = null;
    let phones = [];
    
    // IF preview is active (visible), respect checkboxes EVEN IF segment is selected
    const isShowingPreview = document.getElementById('selectionPreview').style.display !== 'none';

    if (currentBroadcastTab === 'segmentTab' && !isShowingPreview) {
        segment = document.getElementById('broadcastRecipients').value;
    } else {
        // Collect checked phones from preview (works for Segment, File, or Manual if previewed)
        document.querySelectorAll('.recipient-checkbox:checked').forEach(cb => {
            phones.push(cb.value);
        });
        if (phones.length === 0) {
            alert('Please select or add recipients first');
            return;
        }
    }

    const recipientDesc = segment ? `${segment} segment` : `${phones.length} selected contacts`;
    if (!confirm(`Send ${type} broadcast to ${recipientDesc}?`)) return;

    try {
        let response;
        const commonData = {
            segment,
            phones,
            delay_seconds: delay
        };

        if (type === 'text') {
            const message = document.getElementById('broadcastMessage').value;
            const imageUrl = document.getElementById('broadcastImageUrl').value;
            if (!message) throw new Error('Message is required');

            response = await apiCall('/broadcast/send', 'POST', {
                ...commonData,
                message,
                imageUrl
            });
        } else {
            // Template broadcast with variable support
            const selectedCard = document.querySelector('.template-card.selected');
            const templateName = selectedCard ? selectedCard.dataset.template : '';
            
            if (!templateName) throw new Error('Please select a template');

            const template = window.metaTemplates?.find(t => t.name === templateName);
            
            // Collect variable values if template has variables
            const varInputs = document.querySelectorAll('.template-var-input');
            const components = [];
            
            if (varInputs.length > 0) {
                const parameters = Array.from(varInputs).map(input => ({
                    type: 'text',
                    text: input.value || `[${input.dataset.var}]`
                }));
                
                components.push({
                    type: 'body',
                    parameters
                });
            }

            response = await apiCall('/broadcast/template', 'POST', {
                ...commonData,
                templateName,
                language: template?.language || 'en_US',
                components
            });
        }

        if (response.success) {
            showToast(`Broadcast queued for ${response.totalRecipients} customers!`, 'success');
            document.getElementById('broadcastForm').reset();
            currentBroadcastRecipients = [];
            document.getElementById('selectionPreview').style.display = 'none';
            document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
            document.getElementById('templateVariablesArea').style.display = 'none';
            toggleBroadcastType();
            loadBroadcastHistory();
            updateRecipientCount();
        } else {
            throw new Error(response.message || 'Failed to send broadcast');
        }
    } catch (error) {
        alert(`❌ Error: ${error.message}`);
    }
}

async function pauseBroadcast() {
    try {
        const response = await apiCall('/broadcast/pause', 'POST');
        if (response.success) {
            showToast('Broadcast queue paused', 'info');
            loadBroadcastHistory();
        }
    } catch (error) {
        alert('Failed to pause: ' + error.message);
    }
}

async function resumeBroadcast() {
    try {
        const response = await apiCall('/broadcast/resume', 'POST');
        if (response.success) {
            showToast('Broadcast queue resumed', 'success');
            loadBroadcastHistory();
        }
    } catch (error) {
        alert('Failed to resume: ' + error.message);
    }
}

// New Ultimate Broadcast Functions
function switchBroadcastTab(e, tabId) {
    currentBroadcastTab = tabId;
    
    // Update tab UI
    document.querySelectorAll('.wa-tab').forEach(t => t.classList.remove('active'));
    e.currentTarget.classList.add('active');
    
    // Update content
    document.querySelectorAll('.wa-broadcast-tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    
    // Reset selection if moving away from preview-based tabs
    if (tabId === 'segmentTab') {
        document.getElementById('selectionPreview').style.display = 'none';
        currentBroadcastRecipients = [];
    }
    
    updateRecipientCount();
}

async function previewSegment() {
    const segment = document.getElementById('broadcastRecipients').value;
    try {
        const response = await apiCall(`/broadcast/preview?segment=${segment}`);
        if (response.success) {
            renderPreviewTable(response.customers);
        }
    } catch (error) {
        showToast('Failed to load preview', 'danger');
    }
}

function renderPreviewTable(customers) {
    currentBroadcastRecipients = customers;
    const tbody = document.getElementById('previewTableBody');
    const previewArea = document.getElementById('selectionPreview');
    
    previewArea.style.display = 'block';
    tbody.innerHTML = customers.map(c => `
        <tr>
            <td><input type="checkbox" class="recipient-checkbox" value="${c.phone}" checked></td>
            <td>${c.name || 'Unknown'}</td>
            <td>${formatPhone(c.phone)}</td>
        </tr>
    `).join('');
    
    updateRecipientCount();
}

function toggleAllRecipients(cb) {
    document.querySelectorAll('.recipient-checkbox').forEach(box => {
        box.checked = cb.checked;
    });
    updateRecipientCount();
}

async function handleBroadcastFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('fileNameDisplay').textContent = `Loading ${file.name}...`;

    const reader = new FileReader();
    reader.onload = async (event) => {
        const base64 = event.target.result.split(',')[1];
        try {
            const response = await apiCall('/broadcast/import', 'POST', {
                fileBase64: base64,
                fileName: file.name
            });
            if (response.success) {
                document.getElementById('fileNameDisplay').textContent = `Imported ${response.count} contacts from ${file.name}`;
                renderPreviewTable(response.customers);
            }
        } catch (error) {
            alert('Error parsing file: ' + error.message);
        }
    };
    reader.readAsDataURL(file);
}

function parseManualPhones() {
    const text = document.getElementById('manualPhoneList').value;
    const lines = text.split(/[\n,]/);
    const customers = [];
    
    lines.forEach(line => {
        const clean = line.trim();
        if (clean.length >= 10) {
            customers.push({
                phone: clean,
                name: 'Manual Contact'
            });
        }
    });

    if (customers.length > 0) {
        renderPreviewTable(customers);
    } else {
        alert('No valid phone numbers found. Please enter at least 10 digits.');
    }
}

async function startDirectChat() {
    const phone = document.getElementById('directChatPhone').value;
    const message = document.getElementById('directChatMessage').value;
    
    if (!phone || !message) {
        alert('Please enter both phone and message');
        return;
    }

    try {
        const response = await apiCall('/chat/start', 'POST', { phone, message });
        if (response.success) {
            showToast('Message sent! Opening chat...', 'success');
            setTimeout(() => {
                viewCustomerDetails(phone);
            }, 1000);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function updateRecipientCount() {
    const countEl = document.getElementById('recipientCount');
    const selectedCountEl = document.getElementById('selectedCount');
    
    if (currentBroadcastTab === 'segmentTab' && !document.getElementById('selectionPreview').offsetParent) {
        // Normal segment count
        const segment = document.getElementById('broadcastRecipients').value;
        try {
            const data = await apiCall(`/broadcast/count?segment=${segment}`);
            countEl.textContent = data.count || 0;
        } catch (e) {
            countEl.textContent = '0';
        }
    } else {
        // Count checked boxes in preview
        const checkedCount = document.querySelectorAll('.recipient-checkbox:checked').length;
        countEl.textContent = checkedCount;
        if (selectedCountEl) selectedCountEl.textContent = checkedCount;
    }
}

function toggleBroadcastType() {
    const type = document.querySelector('input[name="broadcastType"]:checked')?.value || 'text';
    document.getElementById('customMessageArea').style.display = type === 'text' ? 'block' : 'none';
    document.getElementById('templateArea').style.display = type === 'template' ? 'block' : 'none';
    
    if (type === 'template' && (!window.metaTemplates || window.metaTemplates.length === 0)) {
        loadTemplates();
    }
}

// Template search functionality
function initTemplateSearch() {
    const searchInput = document.getElementById('templateSearch');
    if (!searchInput) return;
    
    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const filtered = window.metaTemplates?.filter(t => 
            t.status === 'APPROVED' && (
                t.name.toLowerCase().includes(searchTerm) ||
                t.category.toLowerCase().includes(searchTerm)
            )
        ) || [];
        
        renderTemplateList(filtered);
    });
}

async function loadTemplates() {
    try {
        const tbody = document.getElementById('templatesTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';

        const response = await apiCall('/templates');
        if (response.success) {
            window.metaTemplates = response.templates || [];
            renderTemplatesTable(window.metaTemplates);
            updateTemplateDropdown(window.metaTemplates);
            
            // Also render template cards for broadcast if container exists
            renderTemplateList(window.metaTemplates);
        }
    } catch (error) {
        console.error('Failed to load templates:', error);
    }
}

async function syncTemplates() {
    try {
        const btn = event.currentTarget;
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<div class="wa-spinner" style="width:16px; height:16px;"></div> Syncing...';
        btn.disabled = true;

        const response = await apiCall('/templates/sync');
        if (response.success) {
            alert(`Successfully synced ${response.count} templates from Meta!`);
            await loadTemplates();
        } else {
            alert('Failed to sync: ' + (response.error || 'Unknown error'));
        }
        
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    } catch (error) {
        console.error('Failed to sync templates:', error);
        alert('Sync failed. Please check your Meta API credentials.');
    }
}

function renderTemplatesTable(templates) {
    const tbody = document.getElementById('templatesTableBody');
    if (!tbody) return;

    if (!templates || templates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center">No Meta templates found</td></tr>';
        return;
    }

    tbody.innerHTML = templates.map(t => `
        <tr>
            <td><strong>${t.name}</strong></td>
            <td><span class="badge badge-gray">${t.category}</span></td>
            <td>${t.language || 'N/A'}</td>
            <td><span class="badge ${t.status === 'APPROVED' ? 'badge-success' : 'badge-warning'}">${t.status || 'UNKNOWN'}</span></td>
            <td>
                <button class="btn btn-sm btn-primary" data-action="initiateTemplateBroadcast" data-template="${t.name}">
                    Use
                </button>
            </td>
        </tr>
    `).join('');
}

function updateTemplateDropdown(templates) {
    const select = document.getElementById('broadcastTemplate');
    if (!select) return;

    const approved = templates.filter(t => t.status === 'APPROVED');
    
    select.innerHTML = '<option value="">-- Select Template --</option>' + 
        approved.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
}

function handleTemplateSelect() {
    const name = document.getElementById('broadcastTemplate').value;
    const preview = document.getElementById('templatePreview');
    if (!preview) return;

    if (!name) {
        preview.style.display = 'none';
        return;
    }

    const template = window.metaTemplates?.find(t => t.name === name);
    if (template) {
        const bodyComp = template.components?.find(c => c.type === 'BODY');
        preview.textContent = bodyComp?.text || 'No preview available';
        preview.style.display = 'block';
    }
}

function initiateTemplateBroadcast(name) {
    navigateTo('broadcast');
    const radio = document.querySelector('input[name="broadcastType"][value="template"]');
    if (radio) {
        radio.checked = true;
        toggleBroadcastType();
        setTimeout(() => {
            const select = document.getElementById('broadcastTemplate');
            if (select) {
                select.value = name;
                handleTemplateSelect();
            }
        }, 100);
    }
}


function viewCustomerDetails(phone) {
    // Show modal with customer details
    const modal = document.getElementById('customerModal');
    const modalBody = document.getElementById('customerModalBody');

    modalBody.innerHTML = '<div class="loading"></div>';
    modal.classList.add('active');

    apiCall(`/customers/${phone}/details`).then(response => {
        if (response.success) {
            const customer = response.customer;
            modalBody.innerHTML = `
                <div>
                    <h4>${customer.name || 'Unknown'}</h4>
                    <p class="text-muted">${formatPhone(customer.phone)}</p>
                    <hr>
                    <div class="stats-grid" style="margin-top: 20px;">
                        <div>
                            <div class="text-small text-muted">Total Orders</div>
                            <div style="font-size: 24px; font-weight: 700;">${customer.order_count || 0}</div>
                        </div>
                        <div>
                            <div class="text-small text-muted">Total Messages</div>
                            <div style="font-size: 24px; font-weight: 700;">${customer.message_count || 0}</div>
                        </div>
                    </div>
                    <hr>
                    <h5 class="mt-3">Recent Orders</h5>
                    ${customer.orders && customer.orders.length > 0 ?
                    customer.orders.map(o => `
                            <div style="padding: 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px;">
                                <div class="d-flex justify-between">
                                    <strong>${o.order_id}</strong>
                                    ${getStatusBadge(o.status)}
                                </div>
                                <div class="text-small text-muted mt-1">${formatDate(o.created_at)}</div>
                            </div>
                        `).join('') :
                    '<p class="text-muted">No orders yet</p>'
                }
                </div>
            `;
        }
    });
}

function closeCustomerModal() {
    document.getElementById('customerModal').classList.remove('active');
}

function viewOrderDetails(orderId) {
    alert(`Order Details: ${orderId}\n\nThis will show full order information, tracking timeline, and customer details.`);
}

// ===================================
// Filters & Search
// ===================================

function filterCustomers() {
    const searchTerm = document.getElementById('customerSearch').value.toLowerCase();
    const filtered = window.customersData.filter(c =>
        (c.name && c.name.toLowerCase().includes(searchTerm)) ||
        c.phone.includes(searchTerm)
    );
    renderCustomersTable(filtered);
}

function filterOrders() {
    const searchTerm = document.getElementById('orderSearch').value.toLowerCase();
    const statusFilter = document.getElementById('orderStatusFilter').value;

    let filtered = window.ordersData;

    if (searchTerm) {
        filtered = filtered.filter(o =>
            o.order_id.toLowerCase().includes(searchTerm) ||
            (o.customer_name && o.customer_name.toLowerCase().includes(searchTerm))
        );
    }

    if (statusFilter) {
        filtered = filtered.filter(o => o.status === statusFilter);
    }

    renderOrdersTable(filtered);
}

function filterMessages() {
    const typeFilter = document.getElementById('messageTypeFilter').value;
    const dateFilter = document.getElementById('messageDateFilter').value;

    // Safety check for undefined window.messagesData
    let filtered = window.messagesData || [];

    if (typeFilter) {
        filtered = filtered.filter(m => m.message_type === typeFilter);
    }

    if (dateFilter) {
        filtered = filtered.filter(m => m.created_at && m.created_at.startsWith(dateFilter));
    }

    renderMessagesTable(filtered);
}

// ===================================
// Export Functions
// ===================================

function exportCustomers() {
    const csv = convertToCSV(window.customersData, ['phone', 'name', 'order_count', 'message_count', 'created_at']);
    downloadCSV(csv, 'customers.csv');
}

function exportMessages() {
    const csv = convertToCSV(window.messagesData, ['created_at', 'customer_phone', 'message_type', 'message_content']);
    downloadCSV(csv, 'messages.csv');
}

function convertToCSV(data, fields) {
    const header = fields.join(',');
    const rows = data.map(item =>
        fields.map(field => `"${item[field] || ''}"`).join(',')
    );
    return [header, ...rows].join('\n');
}

function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
}

// ===================================
// Utility Functions
// ===================================

async function apiCall(endpoint, method = 'GET', body = null) {
    // Always read fresh token from localStorage to handle page reloads
    const token = localStorage.getItem('authToken') || authToken;
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_BASE}${endpoint}`, options);

    if (response.status === 401) {
        handleLogout();
        throw new Error('Unauthorized');
    }

    return await response.json();
}

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return 'N/A';
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(d.getTime() + istOffsetMs);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${istDate.getUTCDate()} ${months[istDate.getUTCMonth()]} ${istDate.getUTCFullYear()}`;
}

function formatTime(dateString) {
    if (!dateString) return 'N/A';
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return 'N/A';
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(d.getTime() + istOffsetMs);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${istDate.getUTCDate()} ${months[istDate.getUTCMonth()]}, ${hours}:${minutes} ${ampm}`;
}

function formatTimeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function formatPhone(phone) {
    return phone.replace(/(\d{2})(\d{5})(\d{5})/, '+$1 $2-$3');
}

function truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '...';
}

function getStatusBadge(status) {
    const badges = {
        pending: '<span class="badge badge-warning">Pending</span>',
        confirmed: '<span class="badge badge-info">Confirmed</span>',
        shipped: '<span class="badge badge-primary">Shipped</span>',
        delivered: '<span class="badge badge-success">Delivered</span>',
        cancelled: '<span class="badge badge-danger">Cancelled</span>'
    };
    return badges[status] || `<span class="badge badge-gray">${status}</span>`;
}

// ===================================
// Returns & Exchanges Functions
// ===================================

async function loadReturnsData() {
    try {
        const token = localStorage.getItem('authToken') || authToken;
        const [returnsRes, exchangesRes] = await Promise.all([
            fetch(`${API_BASE}/returns`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
            fetch(`${API_BASE}/exchanges`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })
        ]);

        const returnsData = await returnsRes.json();
        const exchangesData = await exchangesRes.json();

        if (returnsData.success) {
            window.allReturns = returnsData.returns || [];
            displayReturns(window.allReturns);
        }

        if (exchangesData.success) {
            window.allExchanges = exchangesData.exchanges || [];
            displayExchanges(window.allExchanges);
        }
    } catch (error) {
        console.error('Error loading returns/exchanges:', error);
    }
}

function displayReturns(returns) {
    const tbody = document.getElementById('returnsTableBody');
    if (!tbody) return;

    if (returns.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center">No returns found</td></tr>';
        return;
    }

    tbody.innerHTML = returns.map(ret => `
        <tr>
            <td><strong>${ret.return_id}</strong></td>
            <td>${ret.order_id}</td>
            <td>${ret.customer_phone}</td>
            <td>${ret.reason}</td>
            <td>${getReturnStatusBadge(ret.status)}</td>
            <td>₹${ret.refund_amount || 0}</td>
            <td>${getRefundStatusBadge(ret.refund_status)}</td>
            <td>${formatDate(ret.created_at)}</td>
            <td>
                <button class="btn btn-sm btn-primary" data-action="viewReturnDetails" data-return-id="${ret.return_id}">
                    View
                </button>
            </td>
        </tr>
    `).join('');
}

function displayExchanges(exchanges) {
    const tbody = document.getElementById('exchangesTableBody');
    if (!tbody) return;

    if (exchanges.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center">No exchanges found</td></tr>';
        return;
    }

    tbody.innerHTML = exchanges.map(exc => `
        <tr>
            <td><strong>${exc.exchange_id}</strong></td>
            <td>${exc.order_id}</td>
            <td>${exc.customer_phone}</td>
            <td>${exc.reason}</td>
            <td class="${exc.price_difference >= 0 ? 'text-success' : 'text-danger'}">
                ${exc.price_difference >= 0 ? '+' : ''}₹${exc.price_difference || 0}
            </td>
            <td>${getPaymentStatusBadge(exc.payment_status)}</td>
            <td>${getExchangeStatusBadge(exc.status)}</td>
            <td>${formatDate(exc.created_at)}</td>
            <td>
                <button class="btn btn-sm btn-primary" data-action="viewExchangeDetails" data-exchange-id="${exc.exchange_id}">
                    View
                </button>
            </td>
        </tr>
    `).join('');
}

function getReturnStatusBadge(status) {
    const badges = {
        'initiated': '<span class="badge badge-info">Initiated</span>',
        'pickup_scheduled': '<span class="badge badge-warning">Pickup Scheduled</span>',
        'picked_up': '<span class="badge badge-primary">Picked Up</span>',
        'delivered_to_warehouse': '<span class="badge badge-info">At Warehouse</span>',
        'qc_passed': '<span class="badge badge-success">QC Passed</span>',
        'qc_failed': '<span class="badge badge-danger">QC Failed</span>',
        'refund_processed': '<span class="badge badge-success">Refund Processed</span>',
        'completed': '<span class="badge badge-success">Completed</span>'
    };
    return badges[status] || `<span class="badge badge-gray">${status}</span>`;
}

function getExchangeStatusBadge(status) {
    const badges = {
        'initiated': '<span class="badge badge-info">Initiated</span>',
        'payment_pending': '<span class="badge badge-warning">Payment Pending</span>',
        'payment_completed': '<span class="badge badge-success">Payment Completed</span>',
        'pickup_scheduled': '<span class="badge badge-warning">Pickup Scheduled</span>',
        'picked_up': '<span class="badge badge-primary">Picked Up</span>',
        'qc_passed': '<span class="badge badge-success">QC Passed</span>',
        'qc_failed': '<span class="badge badge-danger">QC Failed</span>',
        'new_order_created': '<span class="badge badge-primary">New Order Created</span>',
        'completed': '<span class="badge badge-success">Completed</span>'
    };
    return badges[status] || `<span class="badge badge-gray">${status}</span>`;
}

function getRefundStatusBadge(status) {
    const badges = {
        'pending': '<span class="badge badge-warning">Pending</span>',
        'processing': '<span class="badge badge-info">Processing</span>',
        'completed': '<span class="badge badge-success">Completed</span>',
        'failed': '<span class="badge badge-danger">Failed</span>'
    };
    return badges[status] || `<span class="badge badge-gray">${status}</span>`;
}

function getPaymentStatusBadge(status) {
    const badges = {
        'pending': '<span class="badge badge-warning">Pending</span>',
        'completed': '<span class="badge badge-success">Completed</span>',
        'failed': '<span class="badge badge-danger">Failed</span>',
        'not_required': '<span class="badge badge-gray">Not Required</span>'
    };
    return badges[status] || `<span class="badge badge-gray">${status}</span>`;
}

function filterReturns() {
    const statusFilter = document.getElementById('returnStatusFilter')?.value || '';
    const searchTerm = document.getElementById('returnSearch')?.value.toLowerCase() || '';

    const filtered = (window.allReturns || []).filter(ret => {
        const matchesStatus = !statusFilter || ret.status === statusFilter;
        const matchesSearch = !searchTerm ||
            ret.return_id.toLowerCase().includes(searchTerm) ||
            ret.order_id.toLowerCase().includes(searchTerm) ||
            ret.customer_phone.includes(searchTerm);
        return matchesStatus && matchesSearch;
    });

    displayReturns(filtered);
}

function filterExchanges() {
    const statusFilter = document.getElementById('exchangeStatusFilter')?.value || '';
    const searchTerm = document.getElementById('exchangeSearch')?.value.toLowerCase() || '';

    const filtered = (window.allExchanges || []).filter(exc => {
        const matchesStatus = !statusFilter || exc.status === statusFilter;
        const matchesSearch = !searchTerm ||
            exc.exchange_id.toLowerCase().includes(searchTerm) ||
            exc.order_id.toLowerCase().includes(searchTerm) ||
            exc.customer_phone.includes(searchTerm);
        return matchesStatus && matchesSearch;
    });

    displayExchanges(filtered);
}

function refreshReturnsData() {
    loadReturnsData();
}

function viewReturnDetails(returnId) {
    alert(`View details for return: ${returnId}\n\nFull details modal coming soon!`);
}

function viewExchangeDetails(exchangeId) {
    alert(`View details for exchange: ${exchangeId}\n\nFull details modal coming soon!`);
}

function exportReturns() {
    const returns = window.allReturns || [];
    if (returns.length === 0) {
        alert('No returns to export');
        return;
    }

    const csv = [
        ['Return ID', 'Order ID', 'Customer', 'Reason', 'Status', 'Refund Amount', 'Refund Status', 'Date'],
        ...returns.map(r => [
            r.return_id,
            r.order_id,
            r.customer_phone,
            r.reason,
            r.status,
            r.refund_amount || 0,
            r.refund_status,
            formatDate(r.created_at)
        ])
    ].map(row => row.join(',')).join('\n');

    downloadCSV(csv, 'returns.csv');
}

function exportExchanges() {
    const exchanges = window.allExchanges || [];
    if (exchanges.length === 0) {
        alert('No exchanges to export');
        return;
    }

    const csv = [
        ['Exchange ID', 'Order ID', 'Customer', 'Reason', 'Price Diff', 'Payment Status', 'Status', 'Date'],
        ...exchanges.map(e => [
            e.exchange_id,
            e.order_id,
            e.customer_phone,
            e.reason,
            e.price_difference || 0,
            e.payment_status,
            e.status,
            formatDate(e.created_at)
        ])
    ].map(row => row.join(',')).join('\n');

    downloadCSV(csv, 'exchanges.csv');
}

// Setup tab switching
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;

            // Update active tab button
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update active tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(tabId)?.classList.add('active');
        });
    });

    // Setup filters
    document.getElementById('returnStatusFilter')?.addEventListener('change', filterReturns);
    document.getElementById('returnSearch')?.addEventListener('input', filterReturns);
    document.getElementById('exchangeStatusFilter')?.addEventListener('change', filterExchanges);
    document.getElementById('exchangeSearch')?.addEventListener('input', filterExchanges);

    // Automation & Customer Segmentation init
    if (document.getElementById('automationTableBody')) loadAutomation();
    if (document.getElementById('customersTableBody')) { loadSegments(); loadRecentCustomers(); }
});


// --- Automation Management ---
let currentAutoId = null;
let automationConfigs = [];

async function loadAutomation() {
    try {
        const tbody = document.getElementById('automationTableBody');
        if (!tbody) return;
        
        const response = await apiCall('/automation');
        if (response.success) {
            automationConfigs = response.configs.map(c => {
                try {
                    c.content = typeof c.content === 'string' ? JSON.parse(c.content) : c.content;
                } catch (e) {
                    c.content = { answer: c.content };
                }
                return c;
            });
            tbody.innerHTML = automationConfigs.map(c => `
                <tr>
                    <td><strong>${c.key}</strong></td>
                    <td><span class="badge badge-info">${c.type}</span></td>
                    <td>${c.description || 'No description'}</td>
                    <td>${formatDate(c.updated_at)}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm" data-action="editAutomation" data-auto-id="${c.id}">✏️ Edit</button>
                    </td>
                </tr>
            `).join('');
        }
    } catch (error) {
        console.error('Failed to load automation:', error);
    }
}

function openAutomationModal() {
    currentAutoId = null;
    document.getElementById('automationModalTitle').innerText = 'Add New Automation';
    document.getElementById('automationForm').reset();
    document.getElementById('automationId').value = '';
    document.getElementById('buttonBuilder').innerHTML = '';
    toggleAutomationFields();
    document.getElementById('automationModal').style.display = 'block';
}

function closeAutomationModal() {
    document.getElementById('automationModal').style.display = 'none';
}

function toggleAutomationFields() {
    const type = document.getElementById('automationType').value;
    
    // Always show available areas instead of strict type checks
    document.getElementById('automationImageArea').style.display = 'block';
    document.getElementById('automationButtonArea').style.display = 'block';
    document.getElementById('automationCtaArea').style.display = 'flex';
}

function getCurrentEditContent() {
    const id = document.getElementById('automationId').value;
    if (!id) return null;
    const config = automationConfigs.find(c => c.id == id);
    if (!config) return null;
    try {
        return typeof config.content === 'string' ? JSON.parse(config.content) : config.content;
    } catch (e) {
        return { answer: config.content };
    }
}

function addButtonRow(text = '', action = '') {
    const builder = document.getElementById('buttonBuilder');
    if (builder.children.length >= 3) {
        alert('Maximum 3 buttons allowed');
        return;
    }
    const div = document.createElement('div');
    div.className = 'd-flex gap-2 mb-2';
    div.innerHTML = `
        <input type="text" class="wa-input btn-text" style="flex:1" placeholder="Button Text" value="${text}">
        <input type="text" class="wa-input btn-action" style="flex:1" placeholder="URL or ID" value="${action}">
        <button type="button" class="btn btn-danger btn-sm btn-remove-row">×</button>
    `;
    builder.appendChild(div);
}

function editAutomation(id) {
    const config = automationConfigs.find(c => c.id == id);
    if (!config) return;
    
    currentAutoId = config.id;
    document.getElementById('automationModalTitle').innerText = 'Edit Automation: ' + config.key;
    document.getElementById('automationId').value = config.id;
    document.getElementById('automationKey').value = config.key;
    document.getElementById('automationType').value = config.type;
    document.getElementById('automationDesc').value = config.description || '';
    
    const content = config.content || {};
    
    document.getElementById('automationContent').value = content.answer || content.message || '';
    document.getElementById('automationImageUrl').value = content.image_url || content.imageUrl || '';
    document.getElementById('automationCtaText').value = content.cta_text || '';
    document.getElementById('automationCtaUrl').value = content.cta_url || '';
    
    const builder = document.getElementById('buttonBuilder');
    builder.innerHTML = '';
    
    if (content.buttons && Array.isArray(content.buttons)) {
        content.buttons.forEach(btn => addButtonRow(btn.text || btn.title, btn.url || btn.id || btn.action || ''));
    }
    
    toggleAutomationFields();
    document.getElementById('automationModal').style.display = 'block';
}

async function saveAutomation(event) {
    if (event) event.preventDefault();
    
    const id = document.getElementById('automationId').value;
    const key = document.getElementById('automationKey').value;
    const type = document.getElementById('automationType').value;
    const description = document.getElementById('automationDesc').value;
    const answer = document.getElementById('automationContent').value;
    const image_url = document.getElementById('automationImageUrl').value;
    
    const buttons = Array.from(document.querySelectorAll('#buttonBuilder .d-flex')).map(row => {
        const text = row.querySelector('.btn-text').value;
        const action = row.querySelector('.btn-action').value;
        return {
            text,
            url: action.startsWith('http') ? action : undefined,
            id: action.startsWith('http') ? undefined : action
        };
    }).filter(b => b.text);

    const content = {
        answer,
        image_url: image_url || undefined,
        buttons: buttons.length > 0 ? buttons : undefined,
        cta_text: document.getElementById('automationCtaText').value || undefined,
        cta_url: document.getElementById('automationCtaUrl').value || undefined
    };
    
    try {
        const body = { id, key, type, description, content };
        const response = await apiCall('/automation', 'POST', body);
        if (response.success) {
            showToast('Automation saved successfully!');
            closeAutomationModal();
            loadAutomation();
        }
    } catch (error) {
        alert('Failed to save automation: ' + error.message);
    }
}

async function syncAutomationDefaults() {
    try {
        if (!confirm('This will restore all active messages to their original state. Any custom edits might be overwritten if the key matches. Continue?')) return;
        
        showToast('Syncing defaults...');
        const response = await apiCall('/automation/sync', 'POST');
        if (response.success) {
            alert(`Successfully synced ${response.count} messages!`);
            loadAutomation();
        }
    } catch (error) {
        alert('Failed to sync defaults');
    }
}

// --- Unified Data Sync ---
async function syncAllData() {
    try {
        const text = document.getElementById('syncBtnText');
        const loader = document.getElementById('syncLoader');
        
        text.style.display = 'none';
        loader.style.display = 'inline-block';
        
        const response = await apiCall('/sync/all', 'POST');
        
        text.style.display = 'inline-block';
        loader.style.display = 'none';
        
        if (response.success) {
            alert(response.message || '✅ Synchronization started in background!\nRefresh the page in a few minutes to see updated data.');
            
            // Refresh dashboard data occasionally to show progress
            setTimeout(() => {
                if (typeof loadOverviewStats === 'function') loadOverviewStats();
                if (activePage === 'customers' && typeof loadCustomers === 'function') loadCustomers();
            }, 5000);
        }
    } catch (error) {
        document.getElementById('syncBtnText').style.display = 'inline-block';
        document.getElementById('syncLoader').style.display = 'none';
        alert('❌ Synchronization failed: ' + error.message);
    }
}

// --- Customer Segmentation Utils ---
async function loadSegments() {
    try {
        const response = await apiCall('/customers/segments'); // We might need to ensure this endpoint exists or use /stats
        if (response.success && response.segments) {
            if (document.getElementById('oneTimeCustomers')) document.getElementById('oneTimeCustomers').textContent = response.segments.oneTime || 0;
            if (document.getElementById('repeatCustomers')) document.getElementById('repeatCustomers').textContent = response.segments.repeat || 0;
            if (document.getElementById('inactiveCustomers')) document.getElementById('inactiveCustomers').textContent = response.segments.inactive || 0;
        }
    } catch (e) {
        console.error('Failed to load segments:', e);
    }
}

async function loadRecentCustomers() {
    // This is already handled by loadCustomers() which populates customersTableBody
    await loadCustomers();
}

// Ensure loadAutomation is called when the page is switched
if (typeof navigateTo === 'function') {
    const originalNavigateTo = navigateTo;
    window.navigateTo = function(page) {
        originalNavigateTo(page);
        if (page === 'automation') loadAutomation();
        if (page === 'customers') { loadSegments(); }
    };
}

// ===================================
// Shopper Hub Logic
// ===================================

let shopperLimit = 50;
let shopperOffset = 0;
let currentShopperStatus = 'all';
let shopperSearchTimeout = null;

async function loadShoppers() {
    const tbody = document.getElementById('shoppersTableBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" class="text-center"><div class="loading"></div></td></tr>';

    const search = document.getElementById('shopperSearch')?.value || '';
    const startDate = document.getElementById('shopperStartDate')?.value || '';
    const endDate = document.getElementById('shopperEndDate')?.value || '';

    try {
        const query = new URLSearchParams({
            limit: shopperLimit,
            offset: shopperOffset,
            status: currentShopperStatus,
            search,
            startDate,
            endDate
        });

        const response = await apiCall(`/shoppers?${query.toString()}`);
        if (response.success) {
            renderShoppersTable(response.shoppers, response.total, Math.floor(shopperOffset / shopperLimit) + 1);
        }
    } catch (error) {
        console.error('Failed to load shoppers:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load data</td></tr>';
    }
}

function renderShoppersTable(shoppers, total, page) {
    const tbody = document.getElementById('shoppersTableBody');
    const info = document.getElementById('shoppersPaginationInfo');
    const btnPrev = document.getElementById('btnPrevShoppers');
    const btnNext = document.getElementById('btnNextShoppers');

    if (!shoppers || shoppers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding: 40px;">No shoppers found</td></tr>';
        if (info) info.innerText = 'SHOWING 0-0 OF 0 SHOPPERS';
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        return;
    }

    tbody.innerHTML = shoppers.map(s => `
        <tr>
            <td style="padding: 12px;"><input type="checkbox" class="shopper-checkbox" value="${s.id}"></td>
            <td style="padding: 12px; font-weight: bold;">${s.name || 'Unknown'}</td>
            <td style="padding: 12px;">${formatPhone(s.phone)}</td>
            <td style="padding: 12px;"><span style="font-family: monospace;">${s.order_id || 'N/A'}</span></td>
            <td style="padding: 12px;">
                <span class="badge ${getShopperStatusClass(s.status)}" style="border: 1px solid #000; border-radius: 0;">
                    ${s.status.toUpperCase().replace('_', ' ')}
                </span>
            </td>
            <td style="padding: 12px; font-size: 12px;">${formatDate(s.created_at)}</td>
        </tr>
    `).join('');

    if (info) {
        const start = shopperOffset + 1;
        const end = Math.min(shopperOffset + shopperLimit, total);
        info.innerText = `SHOWING ${start}-${end} OF ${total} SHOPPERS`;
    }

    if (btnPrev) btnPrev.disabled = shopperOffset <= 0;
    if (btnNext) btnNext.disabled = shopperOffset + shopperLimit >= total;

    // Handle checkboxes
    const selectAll = document.getElementById('selectAllShoppers');
    if (selectAll) {
        selectAll.checked = false;
        selectAll.onchange = (e) => {
            document.querySelectorAll('.shopper-checkbox').forEach(cb => cb.checked = e.target.checked);
            updateShopperSelection();
        };
    }
}

function getShopperStatusClass(status) {
    switch (status) {
        case 'confirmed': return 'badge-success';
        case 'cancelled': return 'badge-danger';
        case 'edit_details': return 'badge-warning';
        default: return 'badge-gray';
    }
}

function filterShoppersByStatus(status) {
    currentShopperStatus = status;
    shopperOffset = 0;
    
    // Update active tab
    document.querySelectorAll('#shoppersPage .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.status === status);
        if (btn.dataset.status === status) {
            btn.style.fontWeight = 'bold';
            btn.style.borderBottom = '3px solid #000';
        } else {
            btn.style.fontWeight = 'normal';
            btn.style.borderBottom = 'none';
        }
    });
    
    loadShoppers();
}

function debounceShopperSearch() {
    clearTimeout(shopperSearchTimeout);
    shopperSearchTimeout = setTimeout(() => {
        shopperOffset = 0;
        loadShoppers();
    }, 500);
}

function updateShopperSelection() {
    const selected = document.querySelectorAll('.shopper-checkbox:checked');
    const deleteBtn = document.getElementById('btnDeleteShoppers');
    if (deleteBtn) {
        deleteBtn.style.display = selected.length > 0 ? 'inline-block' : 'none';
        deleteBtn.innerHTML = `<span>🗑️</span> DELETE SELECTED (${selected.length})`;
    }
}

async function deleteSelectedShoppers() {
    const selected = Array.from(document.querySelectorAll('.shopper-checkbox:checked')).map(cb => cb.value);
    if (selected.length === 0) return;

    if (!confirm(`Are you sure you want to delete ${selected.length} records? This cannot be undone.`)) return;

    try {
        const response = await apiCall('/shoppers/bulk', 'DELETE', { ids: selected });
        if (response.success) {
            showToast(`Successfully deleted ${selected.length} records`, 'success');
            loadShoppers();
        }
    } catch (error) {
        alert('Failed to delete shooters: ' + error.message);
    }
}

async function exportShoppers() {
    const search = document.getElementById('shopperSearch')?.value || '';
    const startDate = document.getElementById('shopperStartDate')?.value || '';
    const endDate = document.getElementById('shopperEndDate')?.value || '';

    const query = new URLSearchParams({
        status: currentShopperStatus,
        search,
        startDate,
        endDate
    });

    try {
        const token = localStorage.getItem('authToken') || authToken;
        const response = await fetch(`${API_BASE}/shoppers/export?${query.toString()}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `shoppers_${currentShopperStatus}_${new Date().toISOString().split('T')[0]}.xlsx`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();
        } else {
            alert('Failed to export Excel');
        }
    } catch (error) {
        console.error('Export error:', error);
    }
}

// Pagination listeners
document.getElementById('btnPrevShoppers')?.addEventListener('click', () => {
    if (shopperOffset >= shopperLimit) {
        shopperOffset -= shopperLimit;
        loadShoppers();
    }
});

document.getElementById('btnNextShoppers')?.addEventListener('click', () => {
    shopperOffset += shopperLimit;
    loadShoppers();
});

// All Orders Modal Functions
async function showAllOrdersModal(phone) {
    const modal = document.getElementById('allOrdersModal');
    const loading = document.getElementById('allOrdersLoading');
    const content = document.getElementById('allOrdersContent');
    const empty = document.getElementById('allOrdersEmpty');
    const phoneDisplay = document.getElementById('allOrdersCustomerPhone');
    const sourceDisplay = document.getElementById('allOrdersSource');
    
    // Reset state
    loading.style.display = 'flex';
    content.style.display = 'none';
    empty.style.display = 'none';
    phoneDisplay.textContent = formatPhone(phone);
    modal.classList.add('active');
    
    // Update loading message to indicate fetching from database
    loading.innerHTML = `
        <div class="spinner"></div>
        <span>Loading orders from database...</span>
    `;
    
    try {
        const data = await apiCall(`/customers/${phone}/all-orders`);
        loading.style.display = 'none';
        
        if (data.success && data.orders && data.orders.length > 0) {
            content.style.display = 'block';
            if (sourceDisplay) {
                sourceDisplay.textContent = `(from synced database)`;
            }
            renderAllOrders(data.orders);
        } else {
            empty.style.display = 'flex';
        }
    } catch (error) {
        loading.style.display = 'none';
        empty.style.display = 'flex';
        showToast('Failed to fetch orders', 'error');
        console.error('Error fetching all orders:', error);
    }
}

function renderAllOrders(orders) {
    const summary = document.getElementById('allOrdersSummary');
    const list = document.getElementById('allOrdersList');
    
    // Summary stats
    const totalOrders = orders.length;
    const statusCounts = orders.reduce((acc, o) => {
        acc[o.status] = (acc[o.status] || 0) + 1;
        return acc;
    }, {});
    
    summary.innerHTML = `
        <div class="stats-grid">
            <div>
                <div class="text-small text-muted">Total Orders</div>
                <div style="font-size: 24px; font-weight: 700;">${totalOrders}</div>
            </div>
            ${Object.entries(statusCounts).map(([status, count]) => `
                <div>
                    <div class="text-small text-muted">${status.charAt(0).toUpperCase() + status.slice(1)}</div>
                    <div style="font-size: 24px; font-weight: 700;">${count}</div>
                </div>
            `).join('')}
        </div>
    `;
    
    // Orders list
    list.innerHTML = orders.map(order => `
        <div class="order-item">
            <div class="order-item-header">
                <strong>${order.order_id || 'N/A'}</strong>
                ${getStatusBadge(order.status)}
            </div>
            <div class="order-item-details">
                <div class="text-small text-muted">
                    ${formatDate(order.created_at)} 
                    ${order.total ? `• ₹${parseFloat(order.total).toFixed(2)}` : ''}
                    ${order.payment_method ? `• ${order.payment_method}` : ''}
                </div>
                ${order.product_name ? `<div class="text-small">${escapeHtml(order.product_name)}</div>` : ''}
                ${order.awb ? `<div class="text-small">AWB: ${order.awb}</div>` : ''}
            </div>
        </div>
    `).join('');
}

// ===================================
// Template Editor & Management Functions
// ===================================

// Initialize template editor when modal opens
function initTemplateEditor() {
    // Toolbar actions
    document.querySelectorAll('.toolbar-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = e.currentTarget.dataset.action;
            handleToolbarAction(action);
        });
    });
    
    // Auto-detect variables
    const bodyTextarea = document.getElementById('templateBody');
    if (bodyTextarea) {
        bodyTextarea.addEventListener('input', updateVariables);
        bodyTextarea.addEventListener('input', updateTemplatePreview);
    }
    
    // Header type change
    const headerType = document.getElementById('headerType');
    if (headerType) {
        headerType.addEventListener('change', handleHeaderTypeChange);
    }
    
    // Footer change
    const footerInput = document.getElementById('templateFooter');
    if (footerInput) {
        footerInput.addEventListener('input', updateTemplatePreview);
    }
    
    // Initialize emoji picker
    initEmojiPicker();
}

function handleToolbarAction(action) {
    const textarea = document.getElementById('templateBody');
    if (!textarea) return;
    
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);
    let replacement = '';
    
    switch(action) {
        case 'formatBold':
            replacement = `*${selectedText || 'bold text'}*`;
            break;
        case 'formatItalic':
            replacement = `_${selectedText || 'italic text'}_`;
            break;
        case 'formatStrikethrough':
            replacement = `~${selectedText || 'strikethrough'}~`;
            break;
        case 'insertEmoji':
            toggleEmojiPicker();
            return;
        case 'insertVariable':
            replacement = insertNextVariable();
            break;
    }
    
    textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + replacement.length;
    updateVariables();
    updateTemplatePreview();
}

function insertNextVariable() {
    const body = document.getElementById('templateBody').value;
    const existingVars = body.match(/\{\{(\d+)\}\}/g) || [];
    const nextNum = existingVars.length + 1;
    return `{{${nextNum}}}`;
}

function updateVariables() {
    const body = document.getElementById('templateBody').value;
    const variables = body.match(/\{\{(\d+)\}\}/g) || [];
    const uniqueVars = [...new Set(variables)];
    
    const variablesList = document.getElementById('variablesList');
    if (!variablesList) return;
    
    if (uniqueVars.length === 0) {
        variablesList.innerHTML = '<p class="text-small text-muted">Variables will appear here as you type them in the body</p>';
        return;
    }
    
    variablesList.innerHTML = uniqueVars.map(v => `
        <div class="variable-item">
            <span>${v}</span>
            <input type="text" class="wa-input variable-example" data-var="${v}" 
                   placeholder="Example value for ${v}">
        </div>
    `).join('');
}

function updateTemplatePreview() {
    const body = document.getElementById('templateBody').value;
    const headerType = document.getElementById('headerType').value;
    const headerText = document.getElementById('headerText').value;
    const footer = document.getElementById('templateFooter').value;
    
    if (!body) {
        document.getElementById('templateLivePreview').innerHTML = `
            <div class="preview-body" style="color: #999;">
                Start typing to see preview...
            </div>
        `;
        return;
    }
    
    // Convert WhatsApp markdown to HTML for preview
    let htmlBody = escapeHtml(body)
        .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
        .replace(/_([^_]+)_/g, '<em>$1</em>')
        .replace(/~([^~]+)~/g, '<s>$1</s>')
        .replace(/```([^`]+)```/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
    
    let previewHTML = '';
    
    if (headerType === 'TEXT' && headerText) {
        previewHTML += `<div class="preview-header">${escapeHtml(headerText)}</div>`;
    } else if (headerType === 'IMAGE') {
        previewHTML += `<div class="preview-header">[Image Header]</div>`;
    }
    
    previewHTML += `<div class="preview-body">${htmlBody}</div>`;
    
    if (footer) {
        previewHTML += `<div class="preview-footer">${escapeHtml(footer)}</div>`;
    }
    
    document.getElementById('templateLivePreview').innerHTML = previewHTML;
}

function handleHeaderTypeChange() {
    const headerType = document.getElementById('headerType').value;
    const headerContentArea = document.getElementById('headerContentArea');
    const textHeaderArea = document.getElementById('textHeaderArea');
    const imageHeaderArea = document.getElementById('imageHeaderArea');
    
    if (headerType === 'NONE') {
        headerContentArea.style.display = 'none';
    } else {
        headerContentArea.style.display = 'block';
        textHeaderArea.style.display = headerType === 'TEXT' ? 'block' : 'none';
        imageHeaderArea.style.display = headerType === 'IMAGE' ? 'block' : 'none';
    }
}

// Simple emoji picker
function initEmojiPicker() {
    const emojis = [
        '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊',
        '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😗',
        '👍', '👎', '👏', '🙏', '💪', '❤️', '🔥', '⭐',
        '✅', '❌', '⚡', '🎉', '🎊', '💯', '📦', '🛒',
        '📞', '📧', '💬', '👋', '🤝', '🎁', '💰', '📱'
    ];
    
    const picker = document.getElementById('emojiPicker');
    if (!picker) return;
    
    picker.innerHTML = emojis.map(emoji => 
        `<button type="button" class="emoji-btn" data-emoji="${emoji}">${emoji}</button>`
    ).join('');
    
    picker.addEventListener('click', (e) => {
        if (e.target.classList.contains('emoji-btn')) {
            const emoji = e.target.dataset.emoji;
            const textarea = document.getElementById('templateBody');
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            
            textarea.value = textarea.value.substring(0, start) + emoji + textarea.value.substring(end);
            textarea.focus();
            toggleEmojiPicker();
            updateTemplatePreview();
        }
    });
}

function toggleEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (picker) {
        picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
    }
}

// Button management
function addButtonRow(text = '') {
    const builder = document.getElementById('quickReplyBuilder');
    if (!builder) return;
    
    if (builder.children.length >= 3) {
        alert('Maximum 3 buttons allowed');
        return;
    }
    
    const div = document.createElement('div');
    div.className = 'd-flex gap-2 mb-2';
    div.innerHTML = `
        <input type="text" class="wa-input btn-text" style="flex:1" placeholder="Button text" maxlength="25" value="${text}">
        <button type="button" class="btn btn-danger btn-sm btn-remove-row">×</button>
    `;
    builder.appendChild(div);
    
    // Add remove handler
    div.querySelector('.btn-remove-row').addEventListener('click', () => {
        div.remove();
    });
}

// Submit template to Meta
async function submitTemplate(e) {
    e.preventDefault();
    
    const name = document.getElementById('templateNameInput').value.trim();
    const category = document.getElementById('templateCategory').value;
    const language = document.getElementById('templateLanguage').value;
    const headerType = document.getElementById('headerType').value;
    const headerText = document.getElementById('headerText').value;
    const headerImageUrl = document.getElementById('headerImageUrl').value;
    const body = document.getElementById('templateBody').value.trim();
    const footer = document.getElementById('templateFooter').value.trim();
    
    if (!name || !body) {
        alert('Template name and body content are required');
        return;
    }
    
    // Collect buttons
    const buttons = Array.from(document.querySelectorAll('#quickReplyBuilder .d-flex')).map(row => {
        const text = row.querySelector('.btn-text').value.trim();
        return text ? { text } : null;
    }).filter(b => b);
    
    // Collect example values
    const exampleInputs = document.querySelectorAll('.variable-example');
    const exampleValues = Array.from(exampleInputs).map(input => input.value || `Example ${input.dataset.var}`);
    
    const payload = {
        name,
        category,
        language,
        headerType,
        headerText,
        headerImageUrl,
        body,
        footer,
        buttons,
        exampleValues
    };
    
    try {
        const submitBtn = document.getElementById('submitTemplateBtn');
        const originalHTML = submitBtn.innerHTML;
        submitBtn.innerHTML = '<div class="wa-spinner" style="width:16px;height:16px;"></div> Submitting...';
        submitBtn.disabled = true;
        
        const response = await apiCall('/templates/create', 'POST', payload);
        
        submitBtn.innerHTML = originalHTML;
        submitBtn.disabled = false;
        
        if (response.success) {
            alert('✅ ' + response.message);
            closeTemplateModal();
            loadTemplates(); // Refresh template list
        } else {
            alert('❌ ' + (response.error || 'Failed to create template'));
        }
    } catch (error) {
        console.error('Template submission error:', error);
        alert('Failed to submit template: ' + error.message);
        document.getElementById('submitTemplateBtn').disabled = false;
    }
}

function openTemplateModal() {
    document.getElementById('createTemplateModal').style.display = 'block';
    initTemplateEditor();
    updateTemplatePreview();
}

function closeTemplateModal() {
    document.getElementById('createTemplateModal').style.display = 'none';
    document.getElementById('createTemplateForm').reset();
    document.getElementById('quickReplyBuilder').innerHTML = '';
    document.getElementById('variablesList').innerHTML = '<p class="text-small text-muted">Variables will appear here as you type them in the body</p>';
    updateTemplatePreview();
}

// Enhanced template table rendering
function renderTemplatesTable(templates) {
    const tbody = document.getElementById('templatesTableBody');
    if (!tbody) return;

    if (!templates || templates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">No templates found. Click "Refresh" to sync from Meta or "Create New" to build a template.</td></tr>';
        return;
    }

    tbody.innerHTML = templates.map(t => {
        const components = typeof t.components === 'string' ? JSON.parse(t.components) : t.components;
        const bodyComp = components?.find(c => c.type === 'BODY');
        const buttons = components?.find(c => c.type === 'BUTTONS')?.buttons || [];
        
        return `
        <tr>
            <td>
                <strong>${t.name}</strong>
                <div class="text-small text-muted">${bodyComp?.text?.substring(0, 50) || 'No body'}...</div>
            </td>
            <td><span class="badge badge-gray">${t.category}</span></td>
            <td>${t.language || 'N/A'}</td>
            <td>
                <span class="badge ${
                    t.status === 'APPROVED' ? 'badge-success' : 
                    t.status === 'PENDING' ? 'badge-warning' : 
                    t.status === 'REJECTED' ? 'badge-danger' : 'badge-gray'
                }">${t.status || 'UNKNOWN'}</span>
                ${t.status === 'REJECTED' && t.rejection_reason ? 
                    `<div class="text-small text-danger" title="${escapeHtml(t.rejection_reason)}">⚠️ Rejected</div>` : ''}
            </td>
            <td>
                <div class="d-flex gap-1">
                    ${t.status === 'APPROVED' ? 
                        `<button class="btn btn-sm btn-primary" data-action="initiateTemplateBroadcast" data-template="${t.name}">Use</button>` : ''}
                    ${t.status === 'PENDING' ? 
                        `<button class="btn btn-sm btn-secondary" data-action="checkTemplateStatus" data-id="${t.id}">Check Status</button>` : ''}
                    ${t.status !== 'APPROVED' ? 
                        `<button class="btn btn-sm btn-danger" data-action="deleteTemplate" data-id="${t.id}">Delete</button>` : ''}
                </div>
            </td>
        </tr>
        `;
    }).join('');
}

// Enhanced template list for broadcast
function renderTemplateList(templates) {
    const container = document.getElementById('templateList');
    if (!container) return;
    
    const approved = templates.filter(t => t.status === 'APPROVED');
    
    if (approved.length === 0) {
        container.innerHTML = '<p class="text-center text-muted">No approved templates available</p>';
        return;
    }
    
    container.innerHTML = approved.map(t => {
        const components = typeof t.components === 'string' ? JSON.parse(t.components) : t.components;
        const bodyComp = components?.find(c => c.type === 'BODY');
        const buttons = components?.find(c => c.type === 'BUTTONS')?.buttons || [];
        
        return `
        <div class="template-card" data-template="${t.name}" data-action="selectTemplate">
            <div class="template-card-header">
                <strong>${t.name}</strong>
                <span class="badge badge-success">${t.category}</span>
            </div>
            <div class="template-card-body">
                ${bodyComp?.text?.substring(0, 100) || 'No preview'}...
            </div>
            ${buttons.length > 0 ? `
                <div class="template-card-buttons">
                    ${buttons.map(b => `<span class="badge badge-gray">${b.text}</span>`).join(' ')}
                </div>
            ` : ''}
        </div>
        `;
    }).join('');
}

// Handle template selection in broadcast
function handleTemplateSelection(templateName) {
    const template = window.metaTemplates?.find(t => t.name === templateName);
    if (!template) return;
    
    // Highlight selected template
    document.querySelectorAll('.template-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.template === templateName);
    });
    
    // Show variables area
    const components = typeof template.components === 'string' ? JSON.parse(template.components) : template.components;
    const bodyComp = components?.find(c => c.type === 'BODY');
    const variables = bodyComp?.text?.match(/\{\{(\d+)\}\}/g) || [];
    const uniqueVars = [...new Set(variables)];
    
    const variablesArea = document.getElementById('templateVariablesArea');
    const variablesInputs = document.getElementById('templateVariablesInputs');
    
    if (uniqueVars.length > 0 && variablesArea && variablesInputs) {
        variablesArea.style.display = 'block';
        variablesInputs.innerHTML = uniqueVars.map(v => `
            <div class="form-group">
                <label>Variable ${v}</label>
                <input type="text" class="wa-input template-var-input" data-var="${v}" 
                       placeholder="Enter value for ${v}">
            </div>
        `).join('');
    } else if (variablesArea) {
        variablesArea.style.display = 'none';
    }
    
    // Update broadcast form
    document.getElementById('broadcastTemplate').value = templateName;
}

// Check template status
async function checkTemplateStatus(id) {
    try {
        const response = await apiCall(`/templates/${id}/status`);
        if (response.success) {
            alert(`Template status: ${response.status}${response.rejection_reason ? '\nReason: ' + response.rejection_reason : ''}`);
            loadTemplates();
        }
    } catch (error) {
        alert('Failed to check template status: ' + error.message);
    }
}

// Delete template
async function deleteTemplate(id) {
    if (!confirm('Are you sure you want to delete this template? This action cannot be undone.')) {
        return;
    }
    
    try {
        const response = await apiCall(`/templates/${id}`, 'DELETE');
        if (response.success) {
            alert('Template deleted successfully');
            loadTemplates();
        }
    } catch (error) {
        alert('Failed to delete template: ' + error.message);
    }
}

// Enhanced broadcast with template variables
async function startTemplateBroadcast(phones) {
    const templateName = document.getElementById('broadcastTemplate').value;
    if (!templateName) {
        alert('Please select a template');
        return;
    }
    
    // Collect variable values
    const varInputs = document.querySelectorAll('.template-var-input');
    const components = [];
    
    if (varInputs.length > 0) {
        const parameters = Array.from(varInputs).map(input => ({
            type: 'text',
            text: input.value || `[${input.dataset.var}]`
        }));
        
        components.push({
            type: 'body',
            parameters
        });
    }
    
    const payload = {
        templateName,
        language: 'en_US',
        components,
        delay_seconds: parseInt(document.getElementById('broadcastDelay').value) || 5,
        phones
    };
    
    const response = await apiCall('/broadcast/template', 'POST', payload);
    if (response.success) {
        showToast(`✅ Template broadcast queued for ${response.totalRecipients} recipients!`, 'success');
        return true;
    } else {
        alert('❌ ' + (response.error || 'Failed to start broadcast'));
        return false;
    }
}
