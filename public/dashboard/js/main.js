// ===================================
// OffComfrt Support Command Center
// Premium Monochrome Dashboard JS
// ===================================

const API = '/api/admin';
let authToken = localStorage.getItem('authToken');
let currentPage = 'support';
let currentChannel = 'all';
let ticketsPage = 1;
let ticketsLimit = 50;
let ticketsMeta = {};
let urgentKeywords = JSON.parse(localStorage.getItem('urgentKeywords') || '[]');
let portalsCache = [];

// ===================================
// Init
// ===================================
document.addEventListener('DOMContentLoaded', () => {
    if (authToken) { showDashboard(); loadPageData('support'); }
    else { showLogin(); }
    setupEventListeners();
});

function setupEventListeners() {
    // Login
    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
    document.getElementById('headerLogoutBtn')?.addEventListener('click', handleLogout);

    // Navigation
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.addEventListener('click', e => {
            e.preventDefault();
            navigateTo(item.dataset.page);
            closeMobileMenu();
        });
    });

    // Refresh
    document.getElementById('refreshBtn')?.addEventListener('click', () => loadPageData(currentPage));
    document.getElementById('mobileRefreshBtn')?.addEventListener('click', () => loadPageData(currentPage));

    // Mobile
    document.getElementById('mobileMenuBtn')?.addEventListener('click', toggleMobileMenu);
    document.getElementById('sidebarOverlay')?.addEventListener('click', closeMobileMenu);
    document.getElementById('sidebarToggle')?.addEventListener('click', toggleSidebar);

    // Channel tabs
    document.querySelectorAll('.channel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.channel-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentChannel = tab.dataset.channel;
            ticketsPage = 1;
            loadTickets();
        });
    });

    // Ticket filters
    document.getElementById('ticketSearchInput')?.addEventListener('input', debounce(() => { ticketsPage = 1; loadTickets(); }, 350));
    document.getElementById('ticketStatusFilter')?.addEventListener('change', () => { ticketsPage = 1; loadTickets(); });
    document.getElementById('portalFilter')?.addEventListener('change', () => { ticketsPage = 1; loadTickets(); });
    document.getElementById('ticketSortBy')?.addEventListener('change', () => { ticketsPage = 1; loadTickets(); });
    document.getElementById('urgentFilterBtn')?.addEventListener('click', function() { this.classList.toggle('active'); ticketsPage = 1; loadTickets(); });
    document.getElementById('unreadFilterBtn')?.addEventListener('click', function() { this.classList.toggle('active'); ticketsPage = 1; loadTickets(); });
    document.getElementById('resetFiltersBtn')?.addEventListener('click', resetTicketFilters);
    document.getElementById('showMoreBtn')?.addEventListener('click', () => { ticketsPage++; loadTickets(true); });
    document.getElementById('selectAllTickets')?.addEventListener('change', toggleSelectAll);

    // Settings
    document.getElementById('openCreatePortalBtn')?.addEventListener('click', () => openPortalModal());
    document.getElementById('openAutoDistributeBtn')?.addEventListener('click', openAutoDistributeModal);
    document.getElementById('configureUrgentBtn')?.addEventListener('click', openUrgentKeywordsModal);
    document.getElementById('savePortalBtn')?.addEventListener('click', savePortal);
    document.getElementById('rebalancePortalsBtn')?.addEventListener('click', rebalancePortals);
    document.getElementById('confirmSplitBtn')?.addEventListener('click', confirmSplitPortal);
    document.getElementById('confirmTransferBtn')?.addEventListener('click', confirmTransferPortal);
    document.getElementById('confirmMergeBtn')?.addEventListener('click', confirmMergePortal);
    document.getElementById('saveKeywordsBtn')?.addEventListener('click', saveUrgentKeywords);
    document.getElementById('addKeywordBtn')?.addEventListener('click', addKeyword);
    document.getElementById('newKeywordInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') addKeyword(); });
    document.getElementById('portalType')?.addEventListener('change', function() {
        document.getElementById('timeBasedConfig').style.display = this.value === 'time_based' ? 'block' : 'none';
    });

    // Templates
    document.getElementById('loadTemplatesBtn')?.addEventListener('click', loadTemplates);

    // Chat modal
    document.getElementById('sendMessageBtn')?.addEventListener('click', sendChatMessage);
    document.getElementById('chatInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
    document.getElementById('chatStatusSelect')?.addEventListener('change', function() {
        const ticketId = this.dataset.ticketId;
        if (ticketId) updateTicketStatus(ticketId, this.value);
    });

    // Assign portal modal
    document.getElementById('confirmAssignBtn')?.addEventListener('click', confirmAssignPortal);

    // AI Analytics
    document.getElementById('refreshAiInsights')?.addEventListener('click', loadAiAnalytics);

    // Widget Chats
    document.querySelectorAll('.wc-sub-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.wc-sub-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.wctab;
            document.querySelectorAll('.wc-tab-panel').forEach(p => p.classList.remove('active'));
            if (target === 'conversations') { document.getElementById('wcTabConversations')?.classList.add('active'); }
            else if (target === 'wc-analytics') { document.getElementById('wcTabAnalytics')?.classList.add('active'); loadWidgetChatAnalytics(); }
            else if (target === 'wc-settings') { document.getElementById('wcTabSettings')?.classList.add('active'); loadWidgetChatSettings(); }
        });
    });
    document.getElementById('wcSearchInput')?.addEventListener('input', debounce(() => { wcPage = 1; loadWidgetChats(); }, 350));
    document.getElementById('wcTicketFilter')?.addEventListener('change', () => { wcPage = 1; loadWidgetChats(); });
    document.getElementById('wcSortBy')?.addEventListener('change', () => { wcPage = 1; loadWidgetChats(); });
    document.getElementById('wcRefreshBtn')?.addEventListener('click', () => loadWidgetChats());
    document.getElementById('wcShowMoreBtn')?.addEventListener('click', () => { wcPage++; loadWidgetChats(true); });
    document.getElementById('wcPurgeBtn')?.addEventListener('click', purgeWidgetChats);

    // Widget chat related sessions toggle
    document.getElementById('wcRelatedToggle')?.addEventListener('click', function() {
        const content = document.getElementById('wcRelatedContent');
        const svg = this.querySelector('svg');
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'flex' : 'none';
        if (svg) svg.style.transform = isHidden ? 'rotate(180deg)' : '';
    });

    // Admin override send
    document.getElementById('wcAdminSendBtn')?.addEventListener('click', sendAdminMessage);
    document.getElementById('wcAdminInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdminMessage(); }
    });
    document.getElementById('wcAdminReleaseBtn')?.addEventListener('click', releaseAdminControl);

    // Modal close buttons
    document.querySelectorAll('[data-action="closeModal"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = document.getElementById(btn.dataset.modal);
            if (modal) modal.classList.remove('active');
        });
    });
    document.querySelectorAll('[data-action="closeTemplateModal"]').forEach(btn => {
        btn.addEventListener('click', () => document.getElementById('templateModal')?.classList.remove('active'));
    });

    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
    });
}

// ===================================
// Auth
// ===================================
async function handleLogin(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    document.getElementById('loginError').textContent = '';
    btn.disabled = true;
    btn.querySelector('#loginButtonText').textContent = 'Signing in...';

    try {
        const res = await fetch(`${API}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success && data.token) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            showDashboard();
            loadPageData('support');
        } else {
            document.getElementById('loginError').textContent = data.error || 'Invalid credentials';
        }
    } catch (err) {
        document.getElementById('loginError').textContent = 'Connection error';
    } finally {
        btn.disabled = false;
        btn.querySelector('#loginButtonText').textContent = 'Sign In';
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
    loadPortals();
    loadUnreadCount();
}

// ===================================
// Navigation
// ===================================
function navigateTo(page) {
    // Stop live refresh when leaving widget chats
    if (currentPage === 'widget-chats' && page !== 'widget-chats') {
        stopLiveRefresh();
    }
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    const section = document.getElementById(`${page}Page`);
    if (section) section.classList.add('active');

    const titles = {
        'support': ['Support Tickets', 'Manage customer conversations across all channels'],
        'widget-chats': ['Widget Chats', 'Website bot conversations, token usage and analytics'],
        'ai-analytics': ['AI Analytics', 'Intelligent insights from all support conversations'],
        'templates': ['Templates', 'Meta API message templates'],
        'ig-comments': ['Instagram Comments', 'Monitor and manage Instagram comment interactions'],
        'settings': ['Settings', 'Configure portals, distribution rules and keywords']
    };
    const [title, subtitle] = titles[page] || ['Dashboard', ''];
    document.getElementById('pageTitle').textContent = title;
    document.getElementById('pageSubtitle').textContent = subtitle;

    loadPageData(page);
}

function loadPageData(page) {
    switch (page) {
        case 'support': loadTickets(); loadPortals(); break;
        case 'widget-chats': loadWidgetChats(); break;
        case 'ai-analytics': initAnalyticsDateFilter(); loadAiAnalytics(); break;
        case 'templates': loadTemplates(); break;
        case 'ig-comments': if (window.CommentsCenter && typeof window.CommentsCenter.load === 'function') window.CommentsCenter.load(); break;
        case 'settings': loadPortals(); loadUrgentKeywordsPreview(); break;
    }
}

// ===================================
// API Helper
// ===================================
async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${authToken}` };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }
    const res = await fetch(`${API}${url}`, { ...options, headers });
    if (res.status === 401) { handleLogout(); return null; }
    return res.json();
}

// ===================================
// Support Tickets
// ===================================
async function loadTickets(append = false) {
    const list = document.getElementById('ticketsList');
    if (!append) list.innerHTML = '<div class="tickets-loading"><div class="spinner"></div><span>Loading tickets...</span></div>';

    const params = new URLSearchParams({ page: ticketsPage, limit: ticketsLimit });
    const status = document.getElementById('ticketStatusFilter')?.value;
    const portal = document.getElementById('portalFilter')?.value;
    const sort = document.getElementById('ticketSortBy')?.value;
    const search = document.getElementById('ticketSearchInput')?.value.trim();
    const urgentActive = document.getElementById('urgentFilterBtn')?.classList.contains('active');
    const unreadActive = document.getElementById('unreadFilterBtn')?.classList.contains('active');

    if (status) params.set('status', status);
    if (portal) params.set('portal', portal);
    if (sort) params.set('sort', sort);
    if (search) params.set('search', search);
    if (currentChannel && currentChannel !== 'all') params.set('channel', currentChannel);
    if (urgentActive) params.set('urgent_filter', '1');
    if (unreadActive) params.set('is_read', 'false');
    if (urgentKeywords.length) params.set('urgent', urgentKeywords.join(','));

    try {
        const data = await apiFetch(`/support-tickets?${params}`);
        if (!data?.success) { list.innerHTML = '<div class="tickets-loading"><span>Failed to load tickets</span></div>'; return; }

        ticketsMeta = data.meta || {};
        updateStatsRow(ticketsMeta);
        renderTickets(data.tickets || [], append);
        updatePagination();
        updatePortalDistBar(data.tickets || []);
    } catch (err) {
        list.innerHTML = '<div class="tickets-loading"><span>Error loading tickets</span></div>';
    }
}

function renderTickets(tickets, append) {
    const list = document.getElementById('ticketsList');
    if (!append) list.innerHTML = '';
    if (!tickets.length && !append) {
        list.innerHTML = '<div class="tickets-loading"><span>No tickets found</span></div>';
        return;
    }

    tickets.forEach(t => {
        const row = document.createElement('div');
        row.className = `ticket-row${t.is_read ? '' : ' unread'}${isUrgent(t.message) ? ' urgent' : ''}`;
        row.dataset.id = t.id;

        const channel = t.channel || 'whatsapp';
        const channelLabel = channel === 'instagram' ? 'IG' : channel === 'website' ? 'Web' : 'WA';
        const timeAgo = formatTimeAgo(t.created_at);
        const statusClass = t.status || 'open';

        row.innerHTML = `
            <div class="ticket-col checkbox"><input type="checkbox" class="ticket-check" data-id="${t.id}"></div>
            <div class="ticket-col"><span class="ticket-number-text">#${t.ticket_number || t.id}</span></div>
            <div class="ticket-col">
                <div class="ticket-customer-name">${esc(t.customer_name || 'Unknown')}</div>
                <div class="ticket-customer-phone">${esc(t.customer_phone || '')}</div>
            </div>
            <div class="ticket-col"><div class="ticket-message-text">${esc(t.message || '')}</div></div>
            <div class="ticket-col ticket-meta">
                <span class="ticket-channel-badge ${channel}">${channelLabel}</span>
                <span class="ticket-time">${timeAgo}</span>
            </div>
            <div class="ticket-col"><span class="ticket-status-badge ${statusClass}">${statusClass}</span></div>
            <div class="ticket-col">
                <div class="ticket-portal-name">${esc(t.portal_name || 'Unassigned')}</div>
                <div class="ticket-actions">
                    <button class="ticket-action-btn" onclick="openChat(${t.id},'${esc(t.customer_phone || '')}','${esc(t.customer_name || '')}','${channel}')" title="Open Chat">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    </button>
                    <button class="ticket-action-btn" onclick="openAssignModal(${t.id})" title="Assign Portal">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                    </button>
                    <button class="ticket-action-btn danger" onclick="deleteTicket(${t.id})" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </div>
        `;
        list.appendChild(row);
    });
}

function updateStatsRow(meta) {
    document.getElementById('statTotal').textContent = meta.total || 0;
    document.getElementById('statOpen').textContent = meta.open || 0;
    document.getElementById('statUnread').textContent = meta.unread || 0;
    document.getElementById('statResolved').textContent = meta.resolved || 0;
    document.getElementById('statUrgent').textContent = meta.urgent || 0;
}

function updatePagination() {
    const pag = document.getElementById('ticketsPagination');
    if (!ticketsMeta.total || ticketsMeta.total === 0) { pag.style.display = 'none'; return; }
    pag.style.display = 'flex';
    const end = ticketsPage * ticketsLimit;
    document.getElementById('showingStart').textContent = ((ticketsPage - 1) * ticketsLimit) + 1;
    document.getElementById('showingEnd').textContent = Math.min(end, ticketsMeta.total);
    document.getElementById('showingTotal').textContent = ticketsMeta.total;
    document.getElementById('showMoreBtn').style.display = ticketsMeta.has_more ? '' : 'none';
}

function updatePortalDistBar(tickets) {
    const bar = document.getElementById('portalDistBar');
    const portalCounts = {};
    tickets.forEach(t => {
        const name = t.portal_name || 'Unassigned';
        portalCounts[name] = (portalCounts[name] || 0) + 1;
    });
    const entries = Object.entries(portalCounts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = entries.map(([name, count]) =>
        `<div class="portal-chip"><span>${esc(name)}</span><span class="portal-chip-count">${count}</span></div>`
    ).join('');
}

function resetTicketFilters() {
    document.getElementById('ticketSearchInput').value = '';
    document.getElementById('ticketStatusFilter').value = '';
    document.getElementById('portalFilter').value = '';
    document.getElementById('ticketSortBy').value = 'newest';
    document.getElementById('urgentFilterBtn').classList.remove('active');
    document.getElementById('unreadFilterBtn').classList.remove('active');
    ticketsPage = 1;
    loadTickets();
}

function isUrgent(msg) {
    if (!msg || !urgentKeywords.length) return false;
    const lower = msg.toLowerCase();
    return urgentKeywords.some(k => lower.includes(k.toLowerCase()));
}

async function deleteTicket(id) {
    if (!confirm('Delete this ticket?')) return;
    await apiFetch(`/support-tickets/${id}`, { method: 'DELETE' });
    loadTickets();
    loadUnreadCount();
}

async function updateTicketStatus(id, status) {
    await apiFetch(`/support-tickets/${id}`, { method: 'PUT', body: { status } });
    loadTickets();
}

// ===================================
// Chat Modal
// ===================================
let currentChatPhone = null;
let currentChatChannel = 'whatsapp';

async function openChat(ticketId, phone, name, channel) {
    if (!phone) { alert('No customer phone available for this ticket.'); return; }
    currentChatPhone = phone;
    currentChatChannel = channel || 'whatsapp';
    document.getElementById('chatModalTitle').textContent = name || phone;
    document.getElementById('chatModalSubtitle').textContent = phone;
    document.getElementById('chatStatusSelect').dataset.ticketId = ticketId;

    // Mark as read
    await apiFetch(`/support-tickets/${ticketId}/mark-read`, { method: 'PATCH' });
    loadUnreadCount();

    const modal = document.getElementById('chatModal');
    modal.classList.add('active');
    document.getElementById('chatMessages').innerHTML = '<div class="chat-loading"><div class="spinner"></div><span>Loading...</span></div>';

    // Load chat history
    try {
        const data = await apiFetch(`/chat/${phone}?limit=200`);
        if (data?.success) renderChatMessages(data.messages || []);
        else document.getElementById('chatMessages').innerHTML = '<div class="chat-loading"><span>No messages found</span></div>';
    } catch {
        document.getElementById('chatMessages').innerHTML = '<div class="chat-loading"><span>Error loading chat</span></div>';
    }

    // Prefetch AI suggestions
    prefetchAiSuggestions(phone, ticketId);
}

function renderChatMessages(messages) {
    const container = document.getElementById('chatMessages');
    container.innerHTML = '';
    messages.forEach(m => {
        const div = document.createElement('div');
        div.className = `chat-msg ${m.sender === 'customer' ? 'incoming' : 'outgoing'}`;
        div.innerHTML = `<div>${esc(m.content || '')}</div><div class="chat-msg-time">${formatTime(m.created_at)}</div>`;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message || !currentChatPhone) return;
    input.value = '';

    const data = await apiFetch('/chat/send', {
        method: 'POST',
        body: { phone: currentChatPhone, message, channel: currentChatChannel }
    });

    if (data?.success) {
        const container = document.getElementById('chatMessages');
        const div = document.createElement('div');
        div.className = 'chat-msg outgoing';
        div.innerHTML = `<div>${esc(message)}</div><div class="chat-msg-time">Just now</div>`;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
}

async function prefetchAiSuggestions(phone, ticketId) {
    try {
        const data = await apiFetch('/ai/suggest-reply', {
            method: 'POST',
            body: { phone, ticketId, actor: 'admin' }
        });
        if (data?.success && data.suggestions?.length) {
            const row = document.getElementById('aiSuggestionsRow');
            const chips = document.getElementById('aiSuggestionsChips');
            chips.innerHTML = data.suggestions.map(s =>
                `<span class="ai-suggestion-chip" onclick="document.getElementById('chatInput').value=this.textContent">${esc(s)}</span>`
            ).join('');
            row.style.display = '';
        } else {
            document.getElementById('aiSuggestionsRow').style.display = 'none';
        }
    } catch { /* silent */ }
}

// ===================================
// Assign Portal
// ===================================
let assignTicketId = null;

function openAssignModal(ticketId) {
    assignTicketId = ticketId;
    const select = document.getElementById('assignPortalSelectModal');
    select.innerHTML = '<option value="">Select portal...</option>' +
        portalsCache.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    document.getElementById('assignPortalModal').classList.add('active');
}

async function confirmAssignPortal() {
    const portalId = document.getElementById('assignPortalSelectModal').value;
    if (!assignTicketId) return;
    await apiFetch(`/support-tickets/${assignTicketId}/assign-portal`, {
        method: 'POST',
        body: { portalId: portalId || null }
    });
    document.getElementById('assignPortalModal').classList.remove('active');
    loadTickets();
}

// ===================================
// Portals — Premium Shift-Based Management
// ===================================
async function loadPortals() {
    try {
        const data = await apiFetch('/support-portals');
        if (data?.success) {
            portalsCache = data.portals || [];
            renderPortalManagement();
            populatePortalFilters();
        }
    } catch { /* silent */ }
}

function classifyPortal(p) {
    if (p.type === 'time_based' && p.config) {
        const start = p.config.time_start || p.shift_start || '';
        const end = p.config.time_end || p.shift_end || '';
        // Overnight shift: end is earlier than start (e.g. 17:00–09:00)
        if (end && start && end < start) {
            // Classify by the START time: 17:00+ → evening, otherwise morning
            return start >= '17:00' ? 'evening' : 'morning';
        }
        if (start >= '09:00' && end <= '17:00') return 'morning';
        if (start >= '17:00' && end <= '21:00') return 'evening';
        return 'other';
    }
    return 'other';
}

function renderPortalManagement() {
    const morning = portalsCache.filter(p => classifyPortal(p) === 'morning');
    const evening = portalsCache.filter(p => classifyPortal(p) === 'evening');
    const other = portalsCache.filter(p => classifyPortal(p) === 'other');

    // Summary bar
    const totalOpen = portalsCache.reduce((s, p) => s + (Number(p.assigned_count) || 0), 0);
    document.getElementById('pmTotalPortals').textContent = portalsCache.length;
    document.getElementById('pmTotalTickets').textContent = totalOpen;
    const now = new Date();
    const istH = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();
    const activeShift = (istH >= 9 && istH < 17) ? 'Morning' : (istH >= 17 && istH < 21) ? 'Evening' : 'Off-hours';
    document.getElementById('pmActiveNow').textContent = activeShift;

    renderShiftGrid('pmMorningPortals', morning, 'morning');
    renderShiftGrid('pmEveningPortals', evening, 'evening');
    renderShiftGrid('pmOtherGrid', other, 'other');

    // Highlight active shift
    document.getElementById('pmMorningShift').classList.toggle('pm-shift-active', activeShift === 'Morning');
    document.getElementById('pmEveningShift').classList.toggle('pm-shift-active', activeShift === 'Evening');
}

function renderShiftGrid(containerId, portals, shift) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!portals.length) {
        container.innerHTML = `<div class="pm-empty-shift">
            <span class="pm-empty-icon">${shift === 'other' ? '⚙' : shift === 'morning' ? '☀' : '🌙'}</span>
            <span>No portals in this ${shift === 'other' ? 'group' : 'shift'}</span>
            <button class="btn btn-secondary btn-xs" onclick="openPortalModal(null, '${shift}')">+ Add Portal</button>
        </div>`;
        return;
    }
    container.innerHTML = portals.map(p => {
        const openCount = Number(p.assigned_count) || 0;
        const totalCount = Number(p.ticket_count) || 0;
        const isActive = isPortalCurrentlyActive(p);
        const typeLabel = p.type === 'time_based' ? 'TIME-BASED' : p.type === 'auto' ? 'AUTO' : 'MANUAL';
        const timeRange = p.config?.time_start ? `${p.config.time_start} – ${p.config.time_end}` : '';
        return `<div class="pm-card ${isActive ? 'pm-card-active' : ''}">
            <div class="pm-card-header">
                <div class="pm-card-title-row">
                    <span class="pm-card-name">${esc(p.name)}</span>
                    ${isActive ? '<span class="pm-live-dot" title="Currently active"></span>' : ''}
                </div>
                <span class="pm-card-type-badge">${typeLabel}</span>
            </div>
            ${timeRange ? `<div class="pm-card-time">${timeRange} IST</div>` : ''}
            <div class="pm-card-stats">
                <div class="pm-card-stat">
                    <span class="pm-card-stat-val">${openCount}</span>
                    <span class="pm-card-stat-lbl">Open</span>
                </div>
                <div class="pm-card-stat">
                    <span class="pm-card-stat-val">${totalCount}</span>
                    <span class="pm-card-stat-lbl">Total</span>
                </div>
            </div>
            <div class="pm-card-meta">
                <div class="pm-card-pw" id="pw-${p.id}">
                    <span class="portal-pw-masked">••••••••</span>
                    <button class="pm-icon-btn" onclick="revealPortalPassword(${p.id})" title="Show password">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                    <button class="pm-icon-btn" onclick="copyPortalPassword(${p.id})" title="Copy password">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                </div>
                ${p.url ? `<div class="pm-card-link" id="plink-${p.id}">
                    <a href="${esc(p.url)}" target="_blank" rel="noopener" class="pm-link-text" title="${esc(p.url)}">${esc(p.slug)}</a>
                    <button class="pm-icon-btn" onclick="copyPortalLink(${p.id})" title="Copy link">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    </button>
                </div>` : ''}
            </div>
            <div class="pm-card-actions">
                <button class="pm-action-btn" onclick="openPortalModal(${p.id})" title="Edit portal">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                </button>
                <button class="pm-action-btn" onclick="openSplitModalForPortal(${p.id})" title="Split into multiple portals">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="2" x2="12" y2="22"/><polyline points="4 10 12 2 20 10"/></svg>
                    Split
                </button>
                <button class="pm-action-btn" onclick="openMergeModalForPortal(${p.id})" title="Merge into another portal">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M16 3l5 5-5 5"/><line x1="21" y1="8" x2="9" y2="8"/></svg>
                    Merge
                </button>
                <button class="pm-action-btn pm-action-danger" onclick="deletePortal(${p.id})" title="Delete portal">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    Delete
                </button>
            </div>
        </div>`;
    }).join('');
}

function isPortalCurrentlyActive(p) {
    if (p.type !== 'time_based' || !p.config?.time_start) return false;
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const [sh, sm] = (p.config.time_start || '').split(':').map(Number);
    const [eh, em] = (p.config.time_end || '').split(':').map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em;
    if (start <= end) return mins >= start && mins < end;
    return mins >= start || mins < end; // overnight
}

function populatePortalFilters() {
    const filter = document.getElementById('portalFilter');
    if (!filter) return;
    const current = filter.value;
    filter.innerHTML = '<option value="">All Portals</option><option value="unassigned">Unassigned</option>' +
        portalsCache.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    filter.value = current;
}

function openPortalModal(id, presetShift) {
    const modal = document.getElementById('createPortalModal');
    document.getElementById('portalModalTitle').textContent = id ? 'Edit Portal' : 'Create Support Portal';
    document.getElementById('editPortalId').value = id || '';

    if (id) {
        const p = portalsCache.find(x => x.id === id);
        if (p) {
            document.getElementById('portalName').value = p.name || '';
            document.getElementById('portalSlug').value = p.slug || '';
            document.getElementById('portalPassword').value = '';
            document.getElementById('portalType').value = p.type || 'manual';
            document.getElementById('portalShiftStart').value = p.config?.time_start || '';
            document.getElementById('portalShiftEnd').value = p.config?.time_end || '';
            document.getElementById('timeBasedConfig').style.display = p.type === 'time_based' ? 'block' : 'none';
        }
    } else {
        document.getElementById('portalForm').reset();
        // Pre-fill shift times based on which section the + button was in
        if (presetShift === 'morning') {
            document.getElementById('portalType').value = 'time_based';
            document.getElementById('portalShiftStart').value = '09:00';
            document.getElementById('portalShiftEnd').value = '17:00';
            document.getElementById('timeBasedConfig').style.display = 'block';
        } else if (presetShift === 'evening') {
            document.getElementById('portalType').value = 'time_based';
            document.getElementById('portalShiftStart').value = '17:00';
            document.getElementById('portalShiftEnd').value = '21:00';
            document.getElementById('timeBasedConfig').style.display = 'block';
        } else {
            document.getElementById('timeBasedConfig').style.display = 'none';
        }
    }
    modal.classList.add('active');
}

async function savePortal() {
    const id = document.getElementById('editPortalId').value;
    const body = {
        name: document.getElementById('portalName').value.trim(),
        slug: document.getElementById('portalSlug').value.trim(),
        type: document.getElementById('portalType').value
    };
    const password = document.getElementById('portalPassword').value;
    if (password) body.password = password;
    if (body.type === 'time_based') {
        body.config = {
            time_start: document.getElementById('portalShiftStart').value,
            time_end: document.getElementById('portalShiftEnd').value
        };
    }

    const url = id ? `/support-portals/${id}` : '/support-portals';
    const method = id ? 'PUT' : 'POST';
    const data = await apiFetch(url, { method, body });
    if (data?.success) {
        document.getElementById('createPortalModal').classList.remove('active');
        loadPortals();
    } else {
        alert(data?.error || 'Failed to save portal');
    }
}

async function revealPortalPassword(id) {
    const container = document.getElementById(`pw-${id}`);
    if (!container) return;
    const mask = container.querySelector('.portal-pw-masked');
    try {
        const data = await apiFetch(`/support-portals/${id}/password`);
        if (data?.success && data.password) {
            mask.textContent = data.password;
            mask.classList.add('revealed');
        } else {
            mask.textContent = data?.message || 'N/A';
        }
    } catch {
        mask.textContent = 'Failed';
    }
    // Auto-hide after 4s
    clearTimeout(container._hideTimer);
    container._hideTimer = setTimeout(() => hidePortalPassword(id), 4000);
}

function hidePortalPassword(id) {
    const container = document.getElementById(`pw-${id}`);
    if (!container) return;
    container.querySelector('.portal-pw-masked').textContent = '••••••••';
    container.querySelector('.portal-pw-masked').classList.remove('revealed');
}

async function copyPortalPassword(id) {
    const data = await apiFetch(`/support-portals/${id}/password`);
    if (data?.success && data.password) {
        await navigator.clipboard.writeText(data.password);
        flashCopied();
    }
}

async function copyPortalLink(id) {
    const p = portalsCache.find(x => x.id === id);
    if (!p?.url) return;
    await navigator.clipboard.writeText(p.url);
    flashCopied();
}

function flashCopied() {
    const el = document.createElement('div');
    el.className = 'pm-toast';
    el.textContent = 'Copied to clipboard';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('pm-toast-show'));
    setTimeout(() => { el.classList.remove('pm-toast-show'); setTimeout(() => el.remove(), 300); }, 1800);
}

async function deletePortal(id) {
    if (!confirm('Delete this portal? Its tickets will be unassigned.')) return;
    await apiFetch(`/support-portals/${id}`, { method: 'DELETE' });
    loadPortals();
}

// --- Split ---
function openSplitModal(shift) {
    const sel = document.getElementById('splitSourcePortal');
    const group = shift === 'morning' ? portalsCache.filter(p => classifyPortal(p) === 'morning')
        : shift === 'evening' ? portalsCache.filter(p => classifyPortal(p) === 'evening')
        : portalsCache;
    sel.innerHTML = '<option value="">Select portal...</option>' +
        group.map(p => `<option value="${p.id}">${esc(p.name)} (${p.assigned_count || 0} open)</option>`).join('');
    document.getElementById('splitNamePrefix').value = '';
    document.getElementById('splitCount').value = 2;
    document.getElementById('splitKeepSource').checked = false;
    document.getElementById('splitPortalModal').classList.add('active');
}

function openSplitModalForPortal(id) {
    const sel = document.getElementById('splitSourcePortal');
    sel.innerHTML = '<option value="">Select portal...</option>' +
        portalsCache.map(p => `<option value="${p.id}" ${p.id === id ? 'selected' : ''}>${esc(p.name)} (${p.assigned_count || 0} open)</option>`).join('');
    const p = portalsCache.find(x => x.id === id);
    document.getElementById('splitNamePrefix').value = p?.name || '';
    document.getElementById('splitCount').value = 2;
    document.getElementById('splitKeepSource').checked = false;
    document.getElementById('splitPortalModal').classList.add('active');
}

async function confirmSplitPortal() {
    const sourceId = document.getElementById('splitSourcePortal').value;
    if (!sourceId) return alert('Select a source portal');
    const body = {
        count: parseInt(document.getElementById('splitCount').value) || 2,
        namePrefix: document.getElementById('splitNamePrefix').value.trim() || undefined,
        keepSource: document.getElementById('splitKeepSource').checked
    };
    const data = await apiFetch(`/support-portals/${sourceId}/split`, { method: 'POST', body });
    if (data?.success) {
        document.getElementById('splitPortalModal').classList.remove('active');
        loadPortals();
    } else {
        alert(data?.error || 'Split failed');
    }
}

// --- Transfer ---
function openTransferModal(shift) {
    const group = shift === 'morning' ? portalsCache.filter(p => classifyPortal(p) === 'morning')
        : shift === 'evening' ? portalsCache.filter(p => classifyPortal(p) === 'evening')
        : portalsCache;
    const opts = group.map(p => `<option value="${p.id}">${esc(p.name)} (${p.assigned_count || 0})</option>`).join('');
    const allOpts = portalsCache.map(p => `<option value="${p.id}">${esc(p.name)} (${p.assigned_count || 0})</option>`).join('');
    document.getElementById('transferFromPortal').innerHTML = '<option value="">Select source...</option>' + (shift === 'other' ? allOpts : opts);
    document.getElementById('transferToPortal').innerHTML = '<option value="">Select destination...</option>' + allOpts;
    document.getElementById('transferCount').value = '';
    document.getElementById('transferPortalModal').classList.add('active');
}

async function confirmTransferPortal() {
    const from = document.getElementById('transferFromPortal').value;
    const to = document.getElementById('transferToPortal').value;
    if (!from || !to) return alert('Select both source and destination');
    if (from === to) return alert('Source and destination must differ');
    const count = document.getElementById('transferCount').value;
    const body = { fromPortalId: from, toPortalId: to };
    if (count) body.count = parseInt(count);
    const data = await apiFetch('/support-portals/transfer', { method: 'POST', body });
    if (data?.success) {
        document.getElementById('transferPortalModal').classList.remove('active');
        loadPortals();
    } else {
        alert(data?.error || 'Transfer failed');
    }
}

// --- Merge ---
function openMergeModalForPortal(id) {
    const sel = document.getElementById('mergeSourcePortal');
    const dest = document.getElementById('mergeDestPortal');
    sel.innerHTML = '<option value="">Select source...</option>' +
        portalsCache.map(p => `<option value="${p.id}" ${p.id === id ? 'selected' : ''}>${esc(p.name)} (${p.assigned_count || 0} open)</option>`).join('');
    dest.innerHTML = '<option value="">Select destination...</option>' +
        portalsCache.filter(p => p.id !== id).map(p => `<option value="${p.id}">${esc(p.name)} (${p.assigned_count || 0} open)</option>`).join('');
    document.getElementById('mergePortalModal').classList.add('active');
}

async function confirmMergePortal() {
    const sourceId = document.getElementById('mergeSourcePortal').value;
    const destId = document.getElementById('mergeDestPortal').value;
    if (!sourceId || !destId) return alert('Select both portals');
    if (sourceId === destId) return alert('Must be different portals');
    // Transfer all tickets then delete source
    const tData = await apiFetch('/support-portals/transfer', { method: 'POST', body: { fromPortalId: sourceId, toPortalId: destId } });
    if (!tData?.success) return alert(tData?.error || 'Merge failed');
    const dData = await apiFetch(`/support-portals/${sourceId}`, { method: 'DELETE' });
    if (dData?.success) {
        document.getElementById('mergePortalModal').classList.remove('active');
        loadPortals();
    } else {
        alert('Tickets transferred but source deletion failed');
        loadPortals();
    }
}

// --- Rebalance ---
async function rebalancePortals() {
    if (!confirm('Rebalance open tickets across all auto-distribute portals?')) return;
    const data = await apiFetch('/support-portals/rebalance', { method: 'POST', body: {} });
    if (data?.success) {
        loadPortals();
    } else {
        alert(data?.error || 'Rebalance failed');
    }
}

// ===================================
// Auto Distribute
// ===================================
function openAutoDistributeModal() {
    const body = document.getElementById('autoDistributeBody');
    body.innerHTML = portalsCache.map(p => `
        <div class="portal-item" style="margin-bottom:8px">
            <div>
                <div class="portal-item-name">${esc(p.name)}</div>
                <div class="portal-item-type">${p.type} · ${p.assigned_count || 0} open tickets</div>
            </div>
        </div>
    `).join('') || '<p class="text-muted">No portals configured</p>';
    document.getElementById('autoDistributeModal').classList.add('active');
}

// ===================================
// Urgent Keywords
// ===================================
function openUrgentKeywordsModal() {
    renderKeywordsList();
    document.getElementById('urgentKeywordsModal').classList.add('active');
}

function renderKeywordsList() {
    const list = document.getElementById('keywordsList');
    list.innerHTML = urgentKeywords.map((k, i) =>
        `<span class="keyword-tag">${esc(k)}<span class="remove-keyword" onclick="removeKeyword(${i})">&times;</span></span>`
    ).join('') || '<p class="text-muted text-small">No keywords configured</p>';
}

function addKeyword() {
    const input = document.getElementById('newKeywordInput');
    const val = input.value.trim();
    if (val && !urgentKeywords.includes(val)) {
        urgentKeywords.push(val);
        input.value = '';
        renderKeywordsList();
    }
}

function removeKeyword(i) {
    urgentKeywords.splice(i, 1);
    renderKeywordsList();
}

function saveUrgentKeywords() {
    localStorage.setItem('urgentKeywords', JSON.stringify(urgentKeywords));
    document.getElementById('urgentKeywordsModal').classList.remove('active');
    loadUrgentKeywordsPreview();
    loadTickets();
}

function loadUrgentKeywordsPreview() {
    const el = document.getElementById('urgentKeywordsPreview');
    if (!el) return;
    el.innerHTML = urgentKeywords.length
        ? urgentKeywords.map(k => `<span class="keyword-tag">${esc(k)}</span>`).join('')
        : '<p class="text-muted text-small">No keywords configured</p>';
}

// ===================================
// AI Analytics
// ===================================
let analyticsDateRange = 'all';

function initAnalyticsDateFilter() {
    const group = document.getElementById('analyticsDateFilter');
    if (!group) return;
    group.addEventListener('click', (e) => {
        const btn = e.target.closest('.date-filter-btn');
        if (!btn) return;
        group.querySelectorAll('.date-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        analyticsDateRange = btn.dataset.range;
        const info = document.getElementById('analyticsDateInfo');
        if (info) info.textContent = `Showing ${btn.textContent.toLowerCase()}`;
        loadAiAnalytics();
    });
}

function getDateRangeParams() {
    const now = new Date();
    const fmt = d => d.toISOString().split('T')[0];
    switch (analyticsDateRange) {
        case 'today':
            return { date_from: fmt(now), date_to: fmt(now) };
        case 'yesterday': {
            const y = new Date(now); y.setDate(y.getDate() - 1);
            return { date_from: fmt(y), date_to: fmt(y) };
        }
        case '7d': {
            const s = new Date(now); s.setDate(s.getDate() - 6);
            return { date_from: fmt(s), date_to: fmt(now) };
        }
        case '30d': {
            const s = new Date(now); s.setDate(s.getDate() - 29);
            return { date_from: fmt(s), date_to: fmt(now) };
        }
        case '90d': {
            const s = new Date(now); s.setDate(s.getDate() - 89);
            return { date_from: fmt(s), date_to: fmt(now) };
        }
        case 'this_month': {
            const s = new Date(now.getFullYear(), now.getMonth(), 1);
            return { date_from: fmt(s), date_to: fmt(now) };
        }
        case 'last_month': {
            const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const e = new Date(now.getFullYear(), now.getMonth(), 0);
            return { date_from: fmt(s), date_to: fmt(e) };
        }
        default:
            return {};
    }
}

async function loadAiAnalytics() {
    const container = document.getElementById('aiInsightsList');
    if (container) container.innerHTML = '<div class="ai-insight-empty"><p>Loading AI insights...</p></div>';

    try {
        const dateParams = getDateRangeParams();
        const qs = new URLSearchParams(dateParams).toString();
        const [aiOverview, recentTickets] = await Promise.all([
            apiFetch(`/support-analytics/ai-overview${qs ? '?' + qs : ''}`),
            apiFetch(`/support-tickets?limit=200&sort=newest${qs ? '&' + qs : ''}`)
        ]);

        const ov = aiOverview?.overview || {};
        const tickets = recentTickets?.tickets || [];

        // ── KPI Cards ──
        setText('aiTotalConvos', ov.total || 0);
        setText('aiResolved', ov.resolved || 0);
        setText('aiEscalated', ov.open || 0);
        setText('aiTodayTotal', `${ov.todayTotal || 0} today`);
        setText('aiTodayResolved', `${ov.todayResolved || 0} today`);
        setText('aiTodayOpen', `${ov.todayOpen || 0} today`);
        setText('aiNegativeToday', ov.todayNegative || 0);
        setText('aiNegativeTotal', `${ov.negativeCount || 0} total`);
        setText('aiAvgResponse', ov.avgResponseFormatted || '\u2014');
        setText('aiResolutionRate', `${ov.resolutionRate || 0}%`);
        if (ov.peakHour !== null && ov.peakHour !== undefined) {
            const h = ov.peakHour;
            setText('aiPeakHour', `${h}:00`);
            setText('aiPeakHourCount', `${ov.peakHourCount || 0} tickets`);
        }
        if (ov.peakDay) {
            const d = new Date(ov.peakDay + 'T00:00:00');
            setText('aiPeakDay', d.toLocaleDateString('en', { month: 'short', day: 'numeric' }));
            setText('aiPeakDayCount', `${ov.peakDayCount || 0} tickets`);
        }

        // ── Volume trend badge ──
        const dv = aiOverview?.dailyVolume || [];
        renderVolumeFromApi(dv);
        if (dv.length >= 2) {
            const last = dv[dv.length - 1].count;
            const prev = dv[dv.length - 2].count;
            const diff = last - prev;
            const badge = document.getElementById('volumeTrendBadge');
            if (badge) badge.textContent = diff >= 0 ? `\u2191${diff} vs yesterday` : `\u2193${Math.abs(diff)} vs yesterday`;
        }

        // ── Hourly Heatmap ──
        renderHourlyHeatmap(aiOverview?.hourlyPattern || []);

        // ── Channel + Sentiment ──
        renderChannelBreakdownFromApi(aiOverview?.channels || []);
        renderSentimentFromApi(aiOverview?.sentiments || [], ov);

        // ── Cross-tab + Confidence ──
        renderChannelSentimentMatrix(aiOverview?.channelSentiment || []);
        renderConfidenceDist(aiOverview?.confidenceDist || []);

        // ── Channel Resolution + Escalation ──
        renderChannelResolution(aiOverview?.channelResolution || []);
        renderEscalationChart(aiOverview?.escalationByChannel || []);

        // ── Resolution Trend ──
        renderResolutionTrend(aiOverview?.resolutionTrend || []);

        // ── Top Scenarios + Portal Perf ──
        renderTopScenarios(aiOverview?.topScenarios || []);
        renderPortalPerformance(aiOverview?.portalPerformance || []);

        // ── Conversations + Insights ──
        renderAiConversations(tickets);
        generateAiInsights(tickets, ov);

    } catch (err) {
        console.error('AI Analytics error:', err);
    }
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function renderChannelBreakdownFromApi(channels) {
    const el = document.getElementById('channelBreakdown');
    if (!el) return;
    const total = channels.reduce((s, c) => s + (c.count || 0), 0) || 1;
    const labels = { whatsapp: 'WhatsApp', instagram: 'Instagram', website: 'Website Bot', widget: 'Website Bot' };
    el.innerHTML = channels.length
        ? channels.map(c => {
            const key = (c.channel || 'other').toLowerCase();
            const pct = Math.round((c.count / total) * 100);
            return `<div class="channel-bar-item">
                <div class="channel-bar-header">
                    <span class="channel-bar-label">${labels[key] || key}</span>
                    <span class="channel-bar-count">${c.count} (${pct}%)</span>
                </div>
                <div class="channel-bar-track"><div class="channel-bar-fill" style="width:${pct}%"></div></div>
            </div>`;
        }).join('')
        : '<p class="text-muted text-small">No channel data</p>';
}

function renderSentimentFromApi(sentiments, overview) {
    const el = document.getElementById('sentimentBars');
    if (!el) return;
    const total = (overview.positiveCount || 0) + (overview.neutralCount || 0) + (overview.negativeCount || 0);
    if (total === 0) { el.innerHTML = '<p class="text-muted text-small">No sentiment data available</p>'; return; }
    const items = [
        { key: 'positive', count: overview.positiveCount || 0 },
        { key: 'neutral', count: overview.neutralCount || 0 },
        { key: 'negative', count: overview.negativeCount || 0 }
    ];
    el.innerHTML = items.map(({ key, count }) => `
        <div class="sentiment-item">
            <div class="sentiment-header">
                <span class="sentiment-label">${key.charAt(0).toUpperCase() + key.slice(1)}</span>
                <span class="sentiment-value">${count} (${Math.round(count / total * 100)}%)</span>
            </div>
            <div class="sentiment-track"><div class="sentiment-fill ${key}" style="width:${count / total * 100}%"></div></div>
        </div>
    `).join('');
}

function renderVolumeFromApi(dailyVolume) {
    const el = document.getElementById('volumeChart');
    if (!el) return;
    if (!dailyVolume.length) { el.innerHTML = '<p class="text-muted text-small" style="text-align:center;padding:24px">No volume data</p>'; return; }
    const max = Math.max(...dailyVolume.map(d => d.count), 1);
    el.innerHTML = dailyVolume.map(d => {
        const label = new Date(d.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short' });
        return `<div class="volume-bar-group"><div class="volume-bar" style="height:${d.count / max * 100}%"></div><span class="volume-bar-label">${label}</span></div>`;
    }).join('');
}

function renderTopScenarios(scenarios) {
    const el = document.getElementById('topIssuesList');
    if (!el) return;
    const badge = document.getElementById('scenariosBadge');
    if (badge) badge.textContent = `${scenarios.length} scenarios`;
    if (!scenarios.length) { el.innerHTML = '<p class="text-muted text-small">No AI scenarios detected yet</p>'; return; }
    el.innerHTML = scenarios.map((s, i) => {
        const conf = s.avg_confidence ? Math.round(s.avg_confidence * 100) + '%' : '';
        return `<div class="issue-item">
            <span class="issue-rank">${i + 1}</span>
            <span class="issue-name">${esc(s.ai_scenario || 'Unknown')}</span>
            ${conf ? `<span class="issue-count" style="color:var(--text-tertiary)">${conf} conf</span>` : ''}
            <span class="issue-count">${s.count}</span>
        </div>`;
    }).join('');
}

function renderAiConversations(tickets) {
    const el = document.getElementById('aiConversationsList');
    if (!el) return;
    const badge = document.getElementById('conversationsBadge');
    if (badge) badge.textContent = `${tickets.length} recent`;
    const recent = tickets.slice(0, 10);
    el.innerHTML = recent.length
        ? recent.map(t => {
            const ch = (t.channel || 'whatsapp').toLowerCase();
            const icon = ch === 'instagram' ? 'IG' : ch === 'website' ? 'Web' : 'WA';
            return `
                <div class="ai-convo-item" onclick="openChat(${t.id},'${esc(t.customer_phone || '')}','${esc(t.customer_name || '')}','${ch}')">
                    <div class="ai-convo-channel ${ch}">${icon}</div>
                    <div class="ai-convo-info">
                        <div class="ai-convo-name">${esc(t.customer_name || t.customer_phone || 'Unknown')}</div>
                        <div class="ai-convo-preview">${esc((t.message || '').substring(0, 80))}</div>
                    </div>
                    <div class="ai-convo-meta">
                        <div class="ai-convo-time">${formatTimeAgo(t.created_at)}</div>
                        <div class="ai-convo-status ${t.status || 'open'}">${t.status || 'open'}</div>
                    </div>
                </div>
            `;
        }).join('')
        : '<p class="text-muted text-small" style="text-align:center;padding:24px">No conversations yet</p>';
}

function generateAiInsights(tickets, overview) {
    const el = document.getElementById('aiInsightsList');
    if (!el) return;
    const insights = [];

    const total = overview.total || tickets.length || 0;
    const open = overview.open || 0;
    const resolved = overview.resolved || 0;
    const urgent = tickets.filter(t => isUrgent(t.message)).length;
    const resolutionRate = overview.resolutionRate || (total > 0 ? Math.round(resolved / total * 100) : 0);
    const negativeCount = overview.negativeCount || 0;

    if (urgent > 0) {
        insights.push({ icon: '', title: `${urgent} urgent ticket${urgent > 1 ? 's' : ''} need attention`, desc: 'Tickets flagged with urgent keywords require immediate response. Review and prioritize.' });
    }
    if (open > 10) {
        insights.push({ icon: '📋', title: `${open} open tickets pending resolution`, desc: 'Consider distributing across portals or escalating to reduce backlog.' });
    }
    if (resolutionRate < 50 && total > 5) {
        insights.push({ icon: '📉', title: `Resolution rate at ${resolutionRate}%`, desc: 'Below 50% resolution rate. Review common issues and improve AI auto-responses.' });
    }
    if (resolutionRate >= 70 && total > 5) {
        insights.push({ icon: '✅', title: `Strong ${resolutionRate}% resolution rate`, desc: 'Your support team is performing well. Consider documenting successful resolution patterns.' });
    }

    // Channel-specific insights
    const waCount = tickets.filter(t => (t.channel || 'whatsapp') === 'whatsapp').length;
    const igCount = tickets.filter(t => t.channel === 'instagram').length;
    const webCount = tickets.filter(t => t.channel === 'website' || t.channel === 'widget').length;
    if (igCount > 0 && igCount > waCount * 0.3) {
        insights.push({ icon: '', title: `Instagram tickets rising (${igCount})`, desc: 'Instagram channel is generating significant volume. Ensure adequate staffing for IG responses.' });
    }
    if (webCount > 0) {
        insights.push({ icon: '🌐', title: `${webCount} website bot tickets`, desc: 'Website bot escalations are being tracked. Review bot responses to reduce unnecessary escalations.' });
    }

    // Sentiment insight from API overview
    if (negativeCount > total * 0.2 && total > 5) {
        insights.push({ icon: '😟', title: `${Math.round(negativeCount / total * 100)}% negative sentiment detected`, desc: 'Higher than usual negative sentiment. Review recent conversations for systemic issues.' });
    }

    if (!insights.length) {
        insights.push({ icon: '✨', title: 'All systems running smoothly', desc: 'No critical issues detected. Continue monitoring ticket volume and response times.' });
    }

    el.innerHTML = insights.map(ins => `
        <div class="ai-insight-item">
            <div class="ai-insight-icon"><span style="font-size:18px">${ins.icon}</span></div>
            <div class="ai-insight-content">
                <div class="ai-insight-title">${ins.title}</div>
                <div class="ai-insight-desc">${ins.desc}</div>
            </div>
        </div>
    `).join('');
}

// ===================================
// Hourly Heatmap
// ===================================
function renderHourlyHeatmap(hourly) {
    const el = document.getElementById('hourlyHeatmap');
    if (!el) return;
    if (!hourly.length) { el.innerHTML = '<p class="text-muted text-small" style="text-align:center;padding:24px;width:100%">No hourly data</p>'; return; }
    const max = Math.max(...hourly.map(h => h.count), 1);
    const badge = document.getElementById('hourlyBadge');
    const peak = hourly.reduce((m, h) => h.count > (m?.count || 0) ? h : m, null);
    if (badge && peak) badge.textContent = `Peak: ${peak.hour}:00`;

    let html = '';
    for (let h = 0; h < 24; h++) {
        const data = hourly.find(x => x.hour === h);
        const count = data ? data.count : 0;
        const ratio = count / max;
        let heat = 'heat-1';
        if (ratio > 0.8) heat = 'heat-5';
        else if (ratio > 0.6) heat = 'heat-4';
        else if (ratio > 0.4) heat = 'heat-3';
        else if (ratio > 0.2) heat = 'heat-2';
        html += `<div class="heatmap-cell ${heat}" title="${h}:00 — ${count} tickets">${count || ''}</div>`;
    }
    el.innerHTML = html + '<div class="heatmap-labels" style="width:100%"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>';
}

// ===================================
// Channel x Sentiment Matrix
// ===================================
function renderChannelSentimentMatrix(data) {
    const el = document.getElementById('channelSentimentMatrix');
    if (!el) return;
    if (!data.length) { el.innerHTML = '<p class="text-muted text-small">No data</p>'; return; }
    const channels = [...new Set(data.map(d => d.channel))];
    const sentiments = ['positive', 'neutral', 'negative'];
    const labels = { whatsapp: 'WhatsApp', instagram: 'Instagram', website: 'Website', widget: 'Website' };
    const max = Math.max(...data.map(d => d.count), 1);

    let html = '<table class="cross-tab-table"><thead><tr><th>Channel</th>';
    sentiments.forEach(s => html += `<th>${s}</th>`);
    html += '</tr></thead><tbody>';
    channels.forEach(ch => {
        const key = (ch || 'other').toLowerCase();
        html += `<tr><td>${labels[key] || key}</td>`;
        sentiments.forEach(s => {
            const row = data.find(d => d.channel === ch && d.sentiment === s);
            const count = row ? row.count : 0;
            const ratio = count / max;
            const cls = ratio > 0.6 ? 'ct-high' : ratio > 0.3 ? 'ct-med' : 'ct-low';
            html += `<td><span class="cross-tab-cell ${cls}">${count}</span></td>`;
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
}

// ===================================
// Confidence Distribution
// ===================================
function renderConfidenceDist(data) {
    const el = document.getElementById('confidenceDist');
    if (!el) return;
    if (!data.length) { el.innerHTML = '<p class="text-muted text-small">No confidence data</p>'; return; }
    const total = data.reduce((s, d) => s + d.count, 0) || 1;
    const order = ['high', 'medium', 'low', 'none'];
    const labels = { high: 'High (>80%)', medium: 'Med (50-80%)', low: 'Low (<50%)', none: 'Unclassified' };
    const sorted = order.map(tier => data.find(d => d.tier === tier) || { tier, count: 0 });

    el.innerHTML = sorted.map(d => {
        const pct = Math.round(d.count / total * 100);
        return `<div class="confidence-tier">
            <span class="confidence-label">${labels[d.tier] || d.tier}</span>
            <div class="confidence-bar-track">
                <div class="confidence-bar-fill conf-${d.tier}" style="width:${Math.max(pct, 3)}%">${pct}%</div>
            </div>
            <span class="confidence-count">${d.count}</span>
        </div>`;
    }).join('');
}

// ===================================
// Channel Resolution
// ===================================
function renderChannelResolution(data) {
    const el = document.getElementById('channelResolution');
    if (!el) return;
    if (!data.length) { el.innerHTML = '<p class="text-muted text-small">No data</p>'; return; }
    const labels = { whatsapp: 'WhatsApp', instagram: 'Instagram', website: 'Website', widget: 'Website' };
    el.innerHTML = data.map(d => {
        const key = (d.channel || 'other').toLowerCase();
        const rate = d.total > 0 ? Math.round(d.resolved / d.total * 100) : 0;
        const resPct = d.total > 0 ? (d.resolved / d.total * 100) : 0;
        const openPct = d.total > 0 ? (d.open_count / d.total * 100) : 0;
        return `<div class="channel-res-item">
            <div class="channel-res-header">
                <span class="channel-res-name">${labels[key] || key}</span>
                <span class="channel-res-rate">${rate}%</span>
            </div>
            <div class="channel-res-track">
                <div class="channel-res-fill-resolved" style="width:${resPct}%"></div>
                <div class="channel-res-fill-open" style="width:${openPct}%"></div>
            </div>
            <div class="channel-res-legend">
                <span class="leg-resolved">${d.resolved} resolved</span>
                <span class="leg-open">${d.open_count} open</span>
            </div>
        </div>`;
    }).join('');
}

// ===================================
// Escalation Chart
// ===================================
function renderEscalationChart(data) {
    const el = document.getElementById('escalationChart');
    if (!el) return;
    if (!data.length) { el.innerHTML = '<p class="text-muted text-small">No data</p>'; return; }
    const labels = { whatsapp: 'WhatsApp', instagram: 'Instagram', website: 'Website', widget: 'Website' };
    el.innerHTML = data.map(d => {
        const key = (d.channel || 'other').toLowerCase();
        const escPct = d.total > 0 ? Math.round(d.escalated / d.total * 100) : 0;
        const selfPct = d.total > 0 ? Math.round(d.self_served / d.total * 100) : 0;
        return `<div class="escalation-item">
            <div class="escalation-header">
                <span class="escalation-name">${labels[key] || key}</span>
                <span class="escalation-pct">${escPct}% escalated</span>
            </div>
            <div class="escalation-track">
                <div class="escalation-fill-escalated" style="width:${escPct}%"></div>
                <div class="escalation-fill-self" style="width:${selfPct}%"></div>
            </div>
        </div>`;
    }).join('');
}

// ===================================
// Resolution Trend
// ===================================
function renderResolutionTrend(data) {
    const el = document.getElementById('resolutionTrend');
    if (!el) return;
    if (!data.length) { el.innerHTML = '<p class="text-muted text-small" style="text-align:center;padding:24px;width:100%">No trend data</p>'; return; }
    const max = Math.max(...data.map(d => d.total), 1);
    el.innerHTML = data.map(d => {
        const totalH = (d.total / max) * 100;
        const resH = d.total > 0 ? (d.resolved / d.total) * totalH : 0;
        const openH = totalH - resH;
        const label = new Date(d.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short' });
        return `<div class="res-trend-bar">
            <span class="res-trend-count">${d.total}</span>
            <div class="res-trend-stack" style="height:${totalH}%">
                <div class="res-trend-resolved" style="flex:${d.resolved || 0.1}"></div>
                <div class="res-trend-open" style="flex:${(d.total - d.resolved) || 0.1}"></div>
            </div>
            <span class="res-trend-label">${label}</span>
        </div>`;
    }).join('');
}

// ===================================
// Portal Performance
// ===================================
function renderPortalPerformance(data) {
    const el = document.getElementById('portalPerformance');
    if (!el) return;
    if (!data.length) { el.innerHTML = '<p class="text-muted text-small">No portals configured</p>'; return; }
    el.innerHTML = data.map(d => {
        const rate = d.assigned > 0 ? Math.round(d.resolved / d.assigned * 100) : 0;
        return `<div class="portal-perf-item">
            <span class="portal-perf-name">${esc(d.portal_name || 'Unknown')}</span>
            <div class="portal-perf-stats">
                <div class="portal-perf-stat">
                    <div class="portal-perf-stat-val">${d.assigned}</div>
                    <div class="portal-perf-stat-label">Total</div>
                </div>
                <div class="portal-perf-stat">
                    <div class="portal-perf-stat-val" style="color:var(--success)">${d.resolved}</div>
                    <div class="portal-perf-stat-label">Resolved</div>
                </div>
                <div class="portal-perf-stat">
                    <div class="portal-perf-stat-val" style="color:var(--warning)">${d.open_count}</div>
                    <div class="portal-perf-stat-label">Open</div>
                </div>
                <div class="portal-perf-stat">
                    <div class="portal-perf-stat-val">${rate}%</div>
                    <div class="portal-perf-stat-label">Rate</div>
                </div>
            </div>
            <div class="portal-perf-bar">
                <div class="portal-perf-bar-fill" style="width:${rate}%"></div>
            </div>
        </div>`;
    }).join('');
}

// ===================================
// Templates
// ===================================
async function loadTemplates() {
    const tbody = document.getElementById('templatesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px">Loading...</td></tr>';
    try {
        const data = await apiFetch('/templates');
        if (data?.success && data.templates?.length) {
            tbody.innerHTML = data.templates.map(t => `
                <tr>
                    <td style="font-weight:600;color:var(--text-primary)">${esc(t.name || '')}</td>
                    <td>${esc(t.category || '')}</td>
                    <td>${esc(t.language || '')}</td>
                    <td><span class="ticket-status-badge ${t.status === 'APPROVED' ? 'resolved' : 'open'}">${esc(t.status || '')}</span></td>
                    <td><button class="btn btn-secondary btn-sm" onclick="useTemplate('${esc(t.name || '')}')">Use</button></td>
                </tr>
            `).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px">No templates found</td></tr>';
        }
    } catch {
        tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px">Error loading templates</td></tr>';
    }
}

function useTemplate(name) {
    // Could open broadcast with pre-filled template
    alert(`Template "${name}" selected`);
}

// ===================================
// Unread Count
// ===================================
async function loadUnreadCount() {
    try {
        const data = await apiFetch('/chat/unread');
        const badge = document.getElementById('navBadgeUnread');
        if (badge && data?.count > 0) {
            badge.textContent = data.count;
            badge.style.display = '';
        } else if (badge) {
            badge.style.display = 'none';
        }
    } catch { /* silent */ }
}

// ===================================
// Bulk Select
// ===================================
function toggleSelectAll(e) {
    document.querySelectorAll('.ticket-check').forEach(cb => { cb.checked = e.target.checked; });
}

// ===================================
// Widget Chats
// ===================================
let wcPage = 1;
const wcLimit = 50;
let wcMeta = {};

async function loadWidgetChats(append = false) {
    const list = document.getElementById('wcSessionsList');
    if (!append) list.innerHTML = '<div class="tickets-loading"><div class="spinner"></div><span>Loading sessions...</span></div>';

    const params = new URLSearchParams({ page: wcPage, limit: wcLimit });
    const search = document.getElementById('wcSearchInput')?.value.trim();
    const ticketFilter = document.getElementById('wcTicketFilter')?.value;
    if (search) params.set('search', search);
    if (ticketFilter) params.set('has_ticket', ticketFilter);

    try {
        const [sessionsData, analyticsData] = await Promise.all([
            apiFetch(`/widget-chats/sessions?${params}`),
            wcPage === 1 ? apiFetch('/widget-chats/analytics') : Promise.resolve(null)
        ]);

        if (!sessionsData?.success) { list.innerHTML = '<div class="tickets-loading"><span>Failed to load</span></div>'; return; }
        wcMeta = sessionsData.meta || {};
        renderWidgetSessions(sessionsData.sessions || [], append);
        updateWcPagination();

        if (analyticsData?.success) updateWcStatsRow(analyticsData.analytics);
        // Start live session refresh when on conversations tab
        startLiveRefresh();
    } catch (err) {
        list.innerHTML = '<div class="tickets-loading"><span>Error loading sessions</span></div>';
    }
}

function renderWidgetSessions(sessions, append) {
    const list = document.getElementById('wcSessionsList');
    if (!append) list.innerHTML = '';
    if (!sessions.length && !append) {
        list.innerHTML = '<div class="tickets-loading"><span>No widget chat sessions found</span></div>';
        return;
    }
    sessions.forEach(s => {
        const row = document.createElement('div');
        row.className = 'wc-session-row';
        const sid = esc(s.session_id || '');
        const shortSid = sid.length > 20 ? sid.substring(0, 20) + '...' : sid;
        const ticketBadge = s.has_ticket
            ? `<span class="wc-ticket-badge" title="${esc(s.ticket_number || '')}">${esc(s.ticket_number || 'Ticket')}</span>`
            : '<span class="wc-no-ticket">No ticket</span>';
        const tokens = (s.total_prompt_tokens || 0) + (s.total_completion_tokens || 0);
        const cost = parseFloat(s.total_cost_usd || 0);
        const visitorBadge = s.visitor_id
            ? `<span class="wc-visitor-badge" title="Visitor: ${esc(s.visitor_id)}">&#x1f464; same device</span>`
            : '';

        row.innerHTML = `
            <div class="wc-session-main">
                <div class="wc-session-id" title="${sid}">${shortSid}</div>
                <div class="wc-session-meta">
                    <span class="wc-msg-count">${s.message_count || 0} msgs</span>
                    ${ticketBadge}
                    ${visitorBadge}
                    <span class="wc-token-badge" title="${tokens} tokens">${formatTokens(tokens)} tok</span>
                    <span class="wc-cost-badge">$${cost.toFixed(4)}</span>
                </div>
            </div>
            <div class="wc-session-time">
                <div>${formatTimeAgo(s.last_message_at || s.created_at)}</div>
                <button class="ticket-action-btn" onclick="openWidgetChat('${sid}')" title="View conversation">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </button>
            </div>
        `;
        list.appendChild(row);
    });
}

function updateWcPagination() {
    const pag = document.getElementById('wcPagination');
    if (!wcMeta.total) { pag.style.display = 'none'; return; }
    pag.style.display = 'flex';
    const end = wcPage * wcLimit;
    document.getElementById('wcShowStart').textContent = ((wcPage - 1) * wcLimit) + 1;
    document.getElementById('wcShowEnd').textContent = Math.min(end, wcMeta.total);
    document.getElementById('wcShowTotal').textContent = wcMeta.total;
    document.getElementById('wcShowMoreBtn').style.display = wcMeta.has_more ? '' : 'none';
}

function updateWcStatsRow(a) {
    if (!a) return;
    setText('wcStatSessions', a.totalSessions || 0);
    setText('wcStatTickets', a.sessionsWithTickets || 0);
    setText('wcStatEscRate', `${a.escalationRate || 0}%`);
    setText('wcStatCost', `$${(a.totalCostUsd || 0).toFixed(4)}`);
    setText('wcStatTokens', formatTokens(a.totalTokens || 0));
}

async function openWidgetChat(sessionId) {
    const modal = document.getElementById('wcConversationModal');
    document.getElementById('wcConvoTitle').textContent = 'Widget Chat';
    document.getElementById('wcConvoSubtitle').textContent = sessionId;
    document.getElementById('wcConvoStats').textContent = '';
    document.getElementById('wcConvoMessages').innerHTML = '<div class="chat-loading"><div class="spinner"></div><span>Loading...</span></div>';
    // Hide related sessions bar until we know the visitor_id
    const relatedBar = document.getElementById('wcRelatedBar');
    relatedBar.style.display = 'none';
    document.getElementById('wcRelatedContent').style.display = 'none';
    document.getElementById('wcRelatedContent').innerHTML = '';
    // Track current session for admin actions
    currentWcSessionId = sessionId;
    currentWcAdminActive = false;
    updateAdminStatusUI();
    modal.classList.add('active');

    try {
        const data = await apiFetch(`/widget-chats/session/${encodeURIComponent(sessionId)}`);
        if (!data?.success) {
            document.getElementById('wcConvoMessages').innerHTML = '<div class="chat-loading"><span>Not found</span></div>';
            return;
        }
        const sess = data.session;
        const tokens = (sess.total_prompt_tokens || 0) + (sess.total_completion_tokens || 0);
        document.getElementById('wcConvoStats').textContent =
            `${sess.message_count || 0} msgs · ${formatTokens(tokens)} tok · $${parseFloat(sess.total_cost_usd || 0).toFixed(4)}` +
            (sess.has_ticket ? ` · ${esc(sess.ticket_number || 'ticket')}` : '');

        // Track admin state from session
        currentWcAdminActive = sess.admin_active || false;
        updateAdminStatusUI();

        renderWidgetConversation(data.messages || []);

        // Load related sessions if visitor_id exists
        if (sess.visitor_id) {
            loadRelatedSessions(sess.visitor_id, sessionId);
        }
    } catch {
        document.getElementById('wcConvoMessages').innerHTML = '<div class="chat-loading"><span>Error loading</span></div>';
    }
}

async function loadRelatedSessions(visitorId, currentSessionId) {
    const bar = document.getElementById('wcRelatedBar');
    const content = document.getElementById('wcRelatedContent');
    const label = document.getElementById('wcRelatedLabel');

    try {
        const data = await apiFetch(`/widget-chats/related/${encodeURIComponent(visitorId)}?exclude=${encodeURIComponent(currentSessionId)}`);
        if (!data?.success || !data.sessions?.length) {
            bar.style.display = 'none';
            return;
        }

        label.textContent = `${data.sessions.length} other session${data.sessions.length > 1 ? 's' : ''} from this visitor`;
        bar.style.display = 'flex';

        // Render collapsed list
        content.innerHTML = data.sessions.map(s => {
            const sid = esc(s.session_id || '');
            const shortSid = sid.length > 18 ? sid.substring(0, 18) + '...' : sid;
            const ticketBadge = s.has_ticket
                ? `<span class="wc-ticket-badge" style="font-size:10px">${esc(s.ticket_number || 'T')}</span>`
                : '';
            const tokens = (s.total_prompt_tokens || 0) + (s.total_completion_tokens || 0);
            return `<div class="wc-related-item" onclick="openWidgetChat('${sid}')">
                <span class="wc-related-item-id" title="${sid}">${shortSid}</span>
                <span class="wc-related-item-meta">${s.message_count || 0} msgs · ${formatTokens(tokens)} tok</span>
                ${ticketBadge}
                <span class="wc-related-item-time">${formatTimeAgo(s.last_message_at || s.created_at)}</span>
            </div>`;
        }).join('');
    } catch {
        bar.style.display = 'none';
    }
}

function dashboardSafeUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
}

function renderWidgetRichContent(value) {
    if (!value) return '';
    let rich = value;
    if (typeof rich === 'string') {
        try { rich = JSON.parse(rich); } catch { return ''; }
    }
    const data = rich?.data || {};
    if (rich?.type === 'tracking') {
        const rows = [
            ['Order', data.orderId ? '#' + data.orderId : null], ['AWB', data.awb], ['Location', data.location],
            ['Expected', data.expectedDelivery], ['Delivered', data.deliveredDate], ['Note', data.note]
        ].filter(([, value]) => value).map(([label, value]) => `<div class="wc-card-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`).join('');
        const timeline = Array.isArray(data.timeline) && data.timeline.length
            ? `<div class="wc-card-timeline">${data.timeline.slice(0, 6).map(item => `<div><strong>${esc(item.activity || item.status || 'Update')}</strong><span>${esc([item.date, item.location].filter(Boolean).join(' · '))}</span></div>`).join('')}</div>` : '';
        const url = dashboardSafeUrl(data.trackingUrl);
        return `<section class="wc-rich-card wc-tracking-card"><header><strong>${esc(data.carrierName || 'Tracking')}</strong><b>${esc(data.status || 'Unknown')}</b></header>${rows}${timeline}${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Track Live ↗</a>` : ''}</section>`;
    }
    if (rich?.type === 'return_request' || rich?.type === 'return_status') {
        const requestId = data.request_id || data.returnId;
        const order = data.order_number || data.orderId;
        const rows = [['Request ID', requestId], ['Order', order ? '#' + order : null], ['Reason', data.reason], ['Pickup', data.eta], ['Refund', data.refundAmount], ['Note', data.note]]
            .filter(([, value]) => value).map(([label, value]) => `<div class="wc-card-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`).join('');
        return `<section class="wc-rich-card wc-return-card"><header><strong>${esc(data.type || 'Return')}</strong><b>${esc(data.status || 'Pending')}</b></header>${rows}</section>`;
    }
    if (rich?.type === 'ticket') {
        const url = dashboardSafeUrl(data.whatsappLink);
        return `<section class="wc-rich-card wc-ticket-card"><strong>Ticket created</strong><span>${esc(data.ticketNumber || '')}</span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open WhatsApp ↗</a>` : ''}</section>`;
    }
    return '';
}

function renderWidgetConversation(messages) {
    const container = document.getElementById('wcConvoMessages');
    container.innerHTML = '';
    messages.forEach(m => {
        const div = document.createElement('div');
        const isAdmin = m.sender === 'admin';
        const isBot = m.sender === 'bot';
        if (isAdmin) {
            div.className = 'chat-msg outgoing wc-admin-msg';
            div.innerHTML = `<div class="wc-admin-sender-label">Admin (You)</div><div>${esc(m.content || '')}</div><div class="chat-msg-time">${formatTime(m.created_at)}</div>`;
        } else {
            div.className = `chat-msg ${isBot ? 'outgoing' : 'incoming'}`;
            let metaHtml = '';
            if (isBot && (m.prompt_tokens || m.completion_tokens)) {
                const tok = (m.prompt_tokens || 0) + (m.completion_tokens || 0);
                metaHtml = `<div class="wc-msg-meta">${formatTokens(tok)} tok · $${parseFloat(m.cost_usd || 0).toFixed(4)}${m.model ? ' · ' + esc(m.model) : ''}${m.suggested_action ? ' · ' + esc(m.suggested_action) : ''}</div>`;
            }
            div.innerHTML = `<div>${esc(m.content || '')}${renderWidgetRichContent(m.rich_content)}${metaHtml}</div><div class="chat-msg-time">${formatTime(m.created_at)}</div>`;
        }
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

async function loadWidgetChatAnalytics() {
    try {
        const data = await apiFetch('/widget-chats/analytics');
        if (!data?.success) return;
        const a = data.analytics;

        setText('wcAnaSessions', a.totalSessions || 0);
        setText('wcAnaMessages', a.totalMessages || 0);
        setText('wcAnaTokens', formatTokens(a.totalTokens || 0));
        setText('wcAnaTokensBreakdown', `prompt: ${formatTokens(a.totalPromptTokens || 0)} / completion: ${formatTokens(a.totalCompletionTokens || 0)}`);
        setText('wcAnaCost', `$${(a.totalCostUsd || 0).toFixed(4)}`);
        setText('wcAnaAvgCost', `avg $${(a.avgCostPerSession || 0).toFixed(4)}/session`);
        setText('wcAnaEscRate', `${a.escalationRate || 0}%`);
        setText('wcAnaEscCount', `${a.sessionsWithTickets || 0} of ${a.totalSessions || 0} sessions`);
        setText('wcAnaAvgTokens', formatTokens(a.avgTokensPerSession || 0));

        renderWcDailyChart(a.dailyUsage || []);
        renderWcHourlyHeatmap(a.hourlyDistribution || []);
        renderWcModelUsage(a.modelUsage || []);
    } catch (err) {
        console.error('Widget chat analytics error:', err);
    }
}

function renderWcDailyChart(daily) {
    const el = document.getElementById('wcDailyChart');
    if (!el) return;
    if (!daily.length) { el.innerHTML = '<p class="text-muted text-small" style="text-align:center;padding:24px">No data yet</p>'; return; }
    const maxMsg = Math.max(...daily.map(d => d.messages || 0), 1);
    const maxCost = Math.max(...daily.map(d => parseFloat(d.cost) || 0), 0.001);
    el.innerHTML = `<div class="wc-daily-bars">${daily.map(d => {
        const msgH = Math.max(((d.messages || 0) / maxMsg) * 100, 2);
        const label = new Date(d.day + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
        return `<div class="wc-daily-bar-group">
            <div class="wc-daily-bar" style="height:${msgH}%" title="${d.messages || 0} msgs · ${formatTokens(d.tokens || 0)} tok · $${parseFloat(d.cost || 0).toFixed(4)}"></div>
            <span class="wc-daily-label">${label}</span>
        </div>`;
    }).join('')}</div>`;
}

function renderWcHourlyHeatmap(hourly) {
    const el = document.getElementById('wcHourlyHeatmap');
    if (!el) return;
    if (!hourly.length) { el.innerHTML = '<p class="text-muted text-small" style="text-align:center;padding:24px;width:100%">No data</p>'; return; }
    const max = Math.max(...hourly.map(h => h.count), 1);
    let html = '';
    for (let h = 0; h < 24; h++) {
        const data = hourly.find(x => x.hour === h);
        const count = data ? data.count : 0;
        const ratio = count / max;
        let heat = 'heat-1';
        if (ratio > 0.8) heat = 'heat-5';
        else if (ratio > 0.6) heat = 'heat-4';
        else if (ratio > 0.4) heat = 'heat-3';
        else if (ratio > 0.2) heat = 'heat-2';
        html += `<div class="heatmap-cell ${heat}" title="${h}:00 — ${count} messages">${count || ''}</div>`;
    }
    el.innerHTML = html + '<div class="heatmap-labels" style="width:100%"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>';
}

function renderWcModelUsage(models) {
    const el = document.getElementById('wcModelUsage');
    if (!el) return;
    if (!models.length) { el.innerHTML = '<p class="text-muted text-small">No model data yet</p>'; return; }
    el.innerHTML = models.map(m => {
        const tok = (m.prompt_tokens || 0) + (m.completion_tokens || 0);
        return `<div class="wc-model-row">
            <span class="wc-model-name">${esc(m.model)}</span>
            <span class="wc-model-stats">${m.calls || 0} calls · ${formatTokens(tok)} tok · $${parseFloat(m.cost || 0).toFixed(4)}</span>
        </div>`;
    }).join('');
}

async function loadWidgetChatSettings() {
    try {
        const data = await apiFetch('/widget-chats/settings');
        if (!data?.success) return;
        const s = data.settings;
        setText('wcSetProvider', s.provider || '—');
        setText('wcSetModel', s.model || '—');
        setText('wcSetInputCost', `$${s.inputCostPer1M || 0} per 1M`);
        setText('wcSetOutputCost', `$${s.outputCostPer1M || 0} per 1M`);
        setText('wcSetTTL', `${s.sessionTtlMinutes || 15} min`);
        setText('wcSetMaxSess', s.maxSessions || 200);
        setText('wcSetHistory', s.maxHistoryTurns || 10);
        setText('wcSetRetention', `${s.retentionDays || 90} days`);
    } catch { /* silent */ }
}

async function purgeWidgetChats() {
    const days = document.getElementById('wcPurgeDays')?.value || 90;
    if (!confirm(`Purge all widget chats older than ${days} days?`)) return;
    const result = document.getElementById('wcPurgeResult');
    try {
        const data = await apiFetch(`/widget-chats/purge?days=${days}`, { method: 'DELETE' });
        if (data?.success) {
            result.textContent = `Purged ${data.purged.chats} messages and ${data.purged.sessions} sessions.`;
            loadWidgetChats();
        } else {
            result.textContent = data?.error || 'Failed to purge';
        }
    } catch {
        result.textContent = 'Error purging data';
    }
}

// ===================================
// Live Sessions + Admin Override
// ===================================
let liveRefreshTimer = null;
let currentWcSessionId = null;
let currentWcAdminActive = false;
const LIVE_REFRESH_MS = 15000; // 15 seconds

function startLiveRefresh() {
    stopLiveRefresh();
    loadLiveSessions();
    liveRefreshTimer = setInterval(loadLiveSessions, LIVE_REFRESH_MS);
}
function stopLiveRefresh() {
    if (liveRefreshTimer) { clearInterval(liveRefreshTimer); liveRefreshTimer = null; }
}

async function loadLiveSessions() {
    try {
        const data = await apiFetch('/widget-chats/live');
        if (!data?.success) return;
        const sessions = data.sessions || [];
        const section = document.getElementById('wcLiveSection');
        const container = document.getElementById('wcLiveSessions');
        const countEl = document.getElementById('wcLiveCount');

        if (!sessions.length) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'flex';
        countEl.textContent = sessions.length;
        container.innerHTML = sessions.map(s => {
            const sid = esc(s.session_id || '');
            const shortSid = sid.length > 18 ? sid.substring(0, 18) + '…' : sid;
            const adminBadge = s.admin_active
                ? '<span class="wc-live-admin-badge" title="Admin in control">Admin</span>'
                : '<span class="wc-live-ai-badge">AI</span>';
            const ticketBadge = s.has_ticket
                ? `<span class="wc-live-admin-badge" style="background:rgba(16,185,129,0.12);color:#10b981" title="Ticket ${esc(s.ticket_number || '')}">${esc(s.ticket_number || 'T')}</span>`
                : '';
            const msgs = s.preview_messages || [];
            const adminClass = s.admin_active ? ' admin-active' : '';

            // Build chat preview bubbles
            let previewHTML = '';
            if (msgs.length) {
                previewHTML = msgs.map(m => {
                    const sender = m.sender || 'bot';
                    const bubbleClass = sender === 'customer' ? 'wc-live-bubble-customer' : sender === 'admin' ? 'wc-live-bubble-admin' : 'wc-live-bubble-bot';
                    const text = esc((m.content || '').substring(0, 120));
                    const time = formatTimeAgo(m.created_at);
                    return `<div class="wc-live-bubble ${bubbleClass}">${text}</div>`;
                }).join('');
            } else {
                previewHTML = '<div style="font-size:11px;color:var(--text-tertiary);padding:4px 0">No messages yet</div>';
            }

            const takeoverBtn = s.admin_active
                ? `<button class="wc-live-takeover-btn" onclick="event.stopPropagation();openWidgetChat('${sid}')" title="Open chat"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Open</button>`
                : `<button class="wc-live-takeover-btn" onclick="event.stopPropagation();quickTakeover('${sid}')" title="Take over this chat"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Takeover</button>`;

            return `<div class="wc-live-card${adminClass}" onclick="openWidgetChat('${sid}')">
                <div class="wc-live-card-header">
                    <div class="wc-live-card-header-left">
                        <span class="wc-live-card-session-id" title="${sid}">${shortSid}</span>
                        <span class="wc-live-card-meta">${s.message_count || 0} msgs</span>
                    </div>
                    <div class="wc-live-card-badges">
                        ${adminBadge}
                        ${ticketBadge}
                    </div>
                </div>
                <div class="wc-live-card-preview">
                    ${previewHTML}
                </div>
                <div class="wc-live-card-footer">
                    <span class="wc-live-card-time">${formatTimeAgo(s.last_message_at)}</span>
                    <div class="wc-live-card-actions">
                        ${takeoverBtn}
                        <button class="wc-live-expand-btn" onclick="event.stopPropagation();openWidgetChat('${sid}')" title="Expand full conversation">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                            Expand
                        </button>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch { /* silent */ }
}

async function quickTakeover(sessionId) {
    // Open the conversation modal and immediately focus the admin input
    await openWidgetChat(sessionId);
    setTimeout(() => {
        const input = document.getElementById('wcAdminInput');
        if (input) input.focus();
    }, 300);
}

async function sendAdminMessage() {
    const input = document.getElementById('wcAdminInput');
    const message = input?.value?.trim();
    if (!message || !currentWcSessionId) return;

    const btn = document.getElementById('wcAdminSendBtn');
    btn.disabled = true;

    try {
        const data = await apiFetch('/widget-chats/admin-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentWcSessionId, message })
        });
        if (data?.success) {
            input.value = '';
            currentWcAdminActive = true;
            updateAdminStatusUI();
            // Append the admin message to the conversation view immediately
            const container = document.getElementById('wcConvoMessages');
            const div = document.createElement('div');
            div.className = 'chat-msg wc-admin-msg';
            div.innerHTML = `<div class="wc-admin-sender-label">Admin (You)</div><div>${esc(message)}</div><div class="chat-msg-time">${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</div>`;
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }
    } catch { /* silent */ }
    btn.disabled = false;
}

async function releaseAdminControl() {
    if (!currentWcSessionId) return;
    try {
        await apiFetch(`/widget-chats/release/${encodeURIComponent(currentWcSessionId)}`, { method: 'POST' });
        currentWcAdminActive = false;
        updateAdminStatusUI();
    } catch { /* silent */ }
}

function updateAdminStatusUI() {
    const modeEl = document.getElementById('wcAdminMode');
    const releaseBtn = document.getElementById('wcAdminReleaseBtn');
    if (currentWcAdminActive) {
        modeEl.innerHTML = '<span class="wc-admin-active-dot"></span> You are controlling this chat';
        modeEl.className = 'wc-admin-mode wc-admin-mode-active';
        releaseBtn.style.display = 'inline-flex';
    } else {
        modeEl.innerHTML = 'AI is handling this chat';
        modeEl.className = 'wc-admin-mode wc-admin-mode-ai';
        releaseBtn.style.display = 'none';
    }
}

function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

// ===================================
// Utilities
// ===================================
function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const now = new Date();
    const d = new Date(dateStr);
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function formatTime(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ===================================
// Sidebar / Mobile
// ===================================
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('collapsed');
}

function toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('active');
}

function closeMobileMenu() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarOverlay').classList.remove('active');
}
