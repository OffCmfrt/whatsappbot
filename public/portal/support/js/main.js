// Support Portal JavaScript
const API_BASE = '/api';
let portalToken = localStorage.getItem('portalToken');
let portalSlug = null;
let portalInfo = null;
let allTickets = [];
let currentTicket = null;
let chatPollingInterval = null;

// Get slug from URL
function getSlugFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

// Initialize
async function init() {
    portalSlug = getSlugFromUrl();
    if (!portalSlug) {
        showLoginError('Invalid portal link. Please use the correct URL.');
        return;
    }

    // If we have a token, verify it's valid by trying to load tickets
    if (portalToken) {
        const valid = await verifyToken();
        if (valid) {
            showApp();
            loadTickets();
        } else {
            portalToken = null;
            localStorage.removeItem('portalToken');
            showLogin();
        }
    } else {
        showLogin();
    }
}

// Auth
async function handleLogin(event) {
    event.preventDefault();
    const password = document.getElementById('portalPassword').value;
    const errorEl = document.getElementById('loginError');

    try {
        const response = await fetch(`${API_BASE}/portal/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: portalSlug, password })
        });

        const data = await response.json();

        if (data.success) {
            portalToken = data.token;
            portalInfo = data.portal;
            localStorage.setItem('portalToken', portalToken);
            showApp();
            loadTickets();
        } else {
            errorEl.textContent = data.error || 'Invalid password';
        }
    } catch (error) {
        errorEl.textContent = 'Connection failed. Please try again.';
    }
}

async function verifyToken() {
    try {
        const response = await fetch(`${API_BASE}/portal/${portalSlug}/tickets`, {
            headers: { 'Authorization': `Bearer ${portalToken}` }
        });
        return response.status === 200;
    } catch {
        return false;
    }
}

function logout() {
    portalToken = null;
    localStorage.removeItem('portalToken');
    if (chatPollingInterval) clearInterval(chatPollingInterval);
    showLogin();
}

// UI State
function showLogin() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('portalPassword').value = '';
    document.getElementById('loginError').textContent = '';
}

function showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'flex';
    if (portalInfo) {
        document.getElementById('portalNameDisplay').textContent = portalInfo.name || 'Support Portal';
    }
}

// API helper
async function portalApi(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${portalToken}`
        }
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${API_BASE}${endpoint}`, options);

    if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
    }

    return response.json();
}

// Tickets
async function loadTickets() {
    try {
        const data = await portalApi(`/portal/${portalSlug}/tickets`);
        if (data.success) {
            allTickets = data.tickets || [];
            filterTickets();
            updateHeaderCount();
        }
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function updateHeaderCount() {
    const count = allTickets.length;
    document.getElementById('headerTicketCount').textContent = `${count} ticket${count !== 1 ? 's' : ''}`;
}

function filterTickets() {
    const search = document.getElementById('ticketSearch').value.toLowerCase();
    const statusFilter = document.getElementById('statusFilter').value;
    const unreadOnly = document.getElementById('unreadFilterBtn')?.classList.contains('active') || false;
    const dateFrom = document.getElementById('dateFromFilter')?.value || '';
    const dateTo = document.getElementById('dateToFilter')?.value || '';
    const timeFrom = document.getElementById('timeFromFilter')?.value || '';
    const timeTo = document.getElementById('timeToFilter')?.value || '';

    let filtered = allTickets;

    // Unread filter
    if (unreadOnly) {
        filtered = filtered.filter(t => !t.is_read);
    }

    // Status filter
    if (statusFilter) {
        filtered = filtered.filter(t => t.status === statusFilter);
    }

    // Search filter
    if (search) {
        filtered = filtered.filter(t =>
            (t.ticket_number || '').toLowerCase().includes(search) ||
            (t.customer_name || '').toLowerCase().includes(search) ||
            (t.customer_phone || '').toLowerCase().includes(search) ||
            (t.message || '').toLowerCase().includes(search)
        );
    }

    // Date filter
    if (dateFrom || dateTo) {
        filtered = filtered.filter(t => {
            const ticketDate = new Date(t.created_at);
            const ticketDateStr = ticketDate.toISOString().split('T')[0];
            
            if (dateFrom && ticketDateStr < dateFrom) return false;
            if (dateTo && ticketDateStr > dateTo) return false;
            return true;
        });
    }

    // Time filter
    if (timeFrom || timeTo) {
        filtered = filtered.filter(t => {
            const ticketTime = new Date(t.created_at);
            const ticketTimeStr = ticketTime.toTimeString().split(' ')[0].substring(0, 5);
            
            if (timeFrom && ticketTimeStr < timeFrom) return false;
            if (timeTo && ticketTimeStr > timeTo) return false;
            return true;
        });
    }

    renderTickets(filtered);
}

function renderTickets(tickets) {
    const list = document.getElementById('ticketsList');
    const empty = document.getElementById('ticketsEmpty');

    if (tickets.length === 0) {
        list.style.display = 'none';
        empty.style.display = 'flex';
        return;
    }

    list.style.display = 'block';
    empty.style.display = 'none';

    list.innerHTML = tickets.map(t => {
        const isUnread = !t.is_read;
        return `
        <div class="ticket-item ${t.status === 'resolved' ? 'resolved' : ''} ${isUnread ? 'unread' : ''}" data-ticket-id="${t.id}" data-phone="${escapeJs(t.customer_phone)}" data-name="${escapeJs(t.customer_name || 'Customer')}" data-status="${t.status}">
            <div class="col-ticket-number">
                <span class="ticket-number-badge">${escapeHtml(t.ticket_number || 'N/A')}</span>
            </div>
            <div class="col-customer">
                <div class="ticket-customer-name ${isUnread ? 'unread-name' : ''}">
                    ${isUnread ? '<span class="unread-dot"></span>' : ''}
                    ${escapeHtml(t.customer_name || 'Customer')}
                </div>
                <div class="ticket-customer-phone">${escapeHtml(t.customer_phone)}</div>
            </div>
            <div class="col-message">${escapeHtml(truncate(t.message, 80))}</div>
            <div class="col-status">
                <span class="ticket-status ${t.status}">${t.status}</span>
            </div>
            <div class="col-time">${formatDate(t.created_at)}</div>
            <div class="col-actions">
                <button class="ticket-btn" data-chat="${t.id}">Chat</button>
            </div>
        </div>
    `;
    }).join('');

    // Attach event listeners to ticket items
    list.querySelectorAll('.ticket-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            openChat(item.dataset.ticketId, item.dataset.phone, item.dataset.name, item.dataset.status);
        });
    });
    list.querySelectorAll('.ticket-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = btn.closest('.ticket-item');
            openChat(item.dataset.ticketId, item.dataset.phone, item.dataset.name, item.dataset.status);
        });
    });
}

// Chat
async function openChat(ticketId, phone, name, status) {
    currentTicket = { id: ticketId, phone, name, status };

    document.getElementById('chatCustomerName').textContent = name;
    document.getElementById('chatCustomerPhone').textContent = phone;
    document.getElementById('chatMessages').innerHTML = `
        <div class="chat-loading">
            <div class="spinner"></div>
            <span>Loading conversation...</span>
        </div>
    `;
    document.getElementById('chatModal').classList.add('active');

    // Resolve button visibility
    const resolveBtn = document.getElementById('resolveChatBtn');
    if (resolveBtn) {
        resolveBtn.style.display = status === 'resolved' ? 'none' : 'inline-flex';
    }

    await loadChatMessages(phone);

    // Start polling
    if (chatPollingInterval) clearInterval(chatPollingInterval);
    chatPollingInterval = setInterval(() => {
        if (currentTicket) loadChatMessages(currentTicket.phone, false);
    }, 15000);
}

async function loadChatMessages(phone, showLoading = true) {
    try {
        const data = await portalApi(`/portal/${portalSlug}/chat/${encodeURIComponent(phone)}`);
        if (data.success) {
            renderChatMessages(data.messages);
        }
    } catch (error) {
        if (showLoading) {
            document.getElementById('chatMessages').innerHTML = `
                <div class="chat-loading">Failed to load messages</div>
            `;
        }
    }
}

function renderChatMessages(messages) {
    const container = document.getElementById('chatMessages');

    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="tickets-empty" style="padding: 40px;">
                <div class="empty-text">No messages yet</div>
            </div>
        `;
        return;
    }

    container.innerHTML = messages.map(msg => {
        const isAgent = msg.isAdmin;
        const time = formatTime(msg.timestamp);
        const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');

        return `
            <div class="chat-message ${isAgent ? 'agent' : 'customer'}">
                <div class="msg-bubble">
                    <div class="msg-content">${content}</div>
                    <div class="msg-meta">
                        ${isAgent ? '<span class="msg-type-badge">Manual</span>' : ''}
                        <span class="msg-time">${time}</span>
                        ${isAgent ? '<span class="msg-status msg-status-sent">&#10003;</span>' : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

async function sendMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();

    if (!message || !currentTicket) return;

    // Optimistic update
    const container = document.getElementById('chatMessages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message agent';
    msgDiv.innerHTML = `
        <div class="msg-bubble">
            <div class="msg-content">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
            <div class="msg-meta">
                <span class="msg-type-badge">Manual</span>
                <span class="msg-time">${formatTime(new Date().toISOString())}</span>
                <span class="msg-status msg-status-sent">&#10003;</span>
            </div>
        </div>
    `;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    input.value = '';
    input.style.height = 'auto';

    try {
        const data = await portalApi(`/portal/${portalSlug}/chat/send`, 'POST', {
            phone: currentTicket.phone,
            message
        });

        if (data.success) {
            // Refresh to get actual status
            await loadChatMessages(currentTicket.phone, false);
        } else {
            msgDiv.classList.add('msg-failed');
            const meta = msgDiv.querySelector('.msg-meta');
            if (meta) meta.innerHTML += '<span class="msg-error">Failed</span>';
        }
    } catch (error) {
        msgDiv.classList.add('msg-failed');
        const meta = msgDiv.querySelector('.msg-meta');
        if (meta) meta.innerHTML += '<span class="msg-error">Failed</span>';
    }
}

function closeChat() {
    document.getElementById('chatModal').classList.remove('active');
    currentTicket = null;
    if (chatPollingInterval) {
        clearInterval(chatPollingInterval);
        chatPollingInterval = null;
    }
}

async function resolveCurrentTicket() {
    if (!currentTicket) return;
    if (!confirm('Mark this ticket as resolved?')) return;

    try {
        const data = await portalApi(`/portal/${portalSlug}/tickets/${currentTicket.id}`, 'PUT', {
            status: 'resolved'
        });

        if (data.success) {
            showToast('Ticket resolved!', 'success');
            closeChat();
            loadTickets();
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        showToast(error.message || 'Failed to resolve ticket', 'error');
    }
}

// Utilities
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeJs(text) {
    if (!text) return '';
    return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function truncate(text, length) {
    if (!text) return '';
    return text.length > length ? text.substring(0, length) + '...' : text;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    // Convert to IST
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffsetMs);
    let hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${minutes} ${ampm}`;
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function showLoginError(msg) {
    const el = document.getElementById('loginError');
    if (el) el.textContent = msg;
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    init();

    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });
    }

    // Close modal on backdrop click
    document.getElementById('chatModal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('chatModal')) {
            closeChat();
        }
    });

    // Event listeners for elements that had inline handlers
    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('ticketSearch')?.addEventListener('input', filterTickets);
    document.getElementById('statusFilter')?.addEventListener('change', filterTickets);
    document.getElementById('refreshTicketsBtn')?.addEventListener('click', loadTickets);
    document.getElementById('resolveChatBtn')?.addEventListener('click', resolveCurrentTicket);
    document.getElementById('closeChatBtn')?.addEventListener('click', closeChat);
    document.getElementById('sendMessageBtn')?.addEventListener('click', sendMessage);
    
    // View All Orders button
    document.getElementById('viewAllOrdersBtn')?.addEventListener('click', () => {
        if (currentTicket) {
            showAllOrdersModal(currentTicket.phone);
        }
    });
    
    // Close All Orders modal
    document.getElementById('closeAllOrdersModal')?.addEventListener('click', closeAllOrdersModal);
    
    // New filter controls
    document.getElementById('unreadFilterBtn')?.addEventListener('click', toggleUnreadFilter);
    document.getElementById('dateFromFilter')?.addEventListener('change', filterTickets);
    document.getElementById('dateToFilter')?.addEventListener('change', filterTickets);
    document.getElementById('timeFromFilter')?.addEventListener('change', filterTickets);
    document.getElementById('timeToFilter')?.addEventListener('change', filterTickets);
    document.getElementById('resetFiltersBtn')?.addEventListener('click', resetAllFilters);
});

// Toggle unread filter
function toggleUnreadFilter() {
    const btn = document.getElementById('unreadFilterBtn');
    if (btn) {
        btn.classList.toggle('active');
        filterTickets();
    }
}

// Reset all filters
function resetAllFilters() {
    const unreadBtn = document.getElementById('unreadFilterBtn');
    const statusFilter = document.getElementById('statusFilter');
    const dateFrom = document.getElementById('dateFromFilter');
    const dateTo = document.getElementById('dateToFilter');
    const timeFrom = document.getElementById('timeFromFilter');
    const timeTo = document.getElementById('timeToFilter');
    const searchInput = document.getElementById('ticketSearch');
    
    if (unreadBtn) unreadBtn.classList.remove('active');
    if (statusFilter) statusFilter.value = '';
    if (dateFrom) dateFrom.value = '';
    if (dateTo) dateTo.value = '';
    if (timeFrom) timeFrom.value = '';
    if (timeTo) timeTo.value = '';
    if (searchInput) searchInput.value = '';
    
    filterTickets();
}

// All Orders Modal Functions
async function showAllOrdersModal(phone) {
    const modal = document.getElementById('allOrdersModal');
    const container = document.getElementById('allOrdersMessages');
    const phoneDisplay = document.getElementById('allOrdersCustomerPhone');
    
    phoneDisplay.textContent = phone;
    container.innerHTML = `
        <div class="chat-loading">
            <div class="spinner"></div>
            <span>Loading orders from database...</span>
        </div>
    `;
    modal.classList.add('active');
    
    try {
        const response = await fetch(`${API_BASE}/portal/${portalSlug}/customers/${phone}/all-orders`, {
            headers: { 'Authorization': `Bearer ${portalToken}` }
        });
        
        const data = await response.json();
        
        if (data.success && data.orders && data.orders.length > 0) {
            renderAllOrders(data.orders);
        } else {
            container.innerHTML = `
                <div class="chat-empty-state">
                    <div class="chat-empty-text">No orders found</div>
                    <div class="chat-empty-sub">This customer has no order history in our database.</div>
                </div>
            `;
        }
    } catch (error) {
        container.innerHTML = `
            <div class="chat-loading">Failed to fetch orders</div>
        `;
        showToast('Failed to fetch orders', 'error');
        console.error('Error fetching all orders:', error);
    }
}

function renderAllOrders(orders) {
    const container = document.getElementById('allOrdersMessages');
    
    // Summary header
    let html = `
        <div class="orders-summary-card">
            <strong>${orders.length}</strong> total order${orders.length !== 1 ? 's' : ''}
        </div>
    `;
    
    // Orders list
    orders.forEach(order => {
        html += `
            <div class="order-card">
                <div class="order-card-header">
                    <span class="order-id">${escapeHtml(order.order_id || 'N/A')}</span>
                    <span class="order-status ${order.status}">${escapeHtml(order.status || 'unknown')}</span>
                </div>
                <div class="order-card-details">
                    <div class="order-detail">
                        <span class="order-label">Date:</span>
                        <span>${formatDate(order.created_at)}</span>
                    </div>
                    ${order.total ? `
                        <div class="order-detail">
                            <span class="order-label">Amount:</span>
                            <span>₹${parseFloat(order.total).toFixed(2)}</span>
                        </div>
                    ` : ''}
                    ${order.payment_method ? `
                        <div class="order-detail">
                            <span class="order-label">Payment:</span>
                            <span>${escapeHtml(order.payment_method)}</span>
                        </div>
                    ` : ''}
                    ${order.product_name ? `
                        <div class="order-detail">
                            <span class="order-label">Product:</span>
                            <span>${escapeHtml(order.product_name)}</span>
                        </div>
                    ` : ''}
                    ${order.awb ? `
                        <div class="order-detail">
                            <span class="order-label">AWB:</span>
                            <span>${escapeHtml(order.awb)}</span>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function closeAllOrdersModal() {
    document.getElementById('allOrdersModal').classList.remove('active');
}
