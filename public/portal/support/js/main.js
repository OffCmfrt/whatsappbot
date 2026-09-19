// Support Portal Pro — Three-Pane Workspace
const API_BASE = '/api';
let portalToken = localStorage.getItem('portalToken');
let portalSlug = null;
let portalInfo = null;
let allTickets = [];
let currentChannelFilter = 'all';

// ── Multi-Chat Tab System ─────────────────────────────────
// openChats: Map<ticketId, { ticket, messages, pollingInterval, lastMsgCount, lastAiReply }>
const openChats = new Map();
let activeChatId = null; // currently focused ticket id
let detailsPanelOpen = false;
const detailsCache = new Map(); // phone -> { data, at }
const DETAILS_CACHE_FRESH_MS = 60 * 1000;

let ticketPollingInterval = null;
let lastKnownTicketIds = new Set();
let unreadMessageCount = 0;

// ── Channel Helpers ───────────────────────────────────────
function channelIconSvg(channel, size = 14) {
    if (channel === 'instagram') {
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" fill="currentColor"/></svg>`;
    }
    if (channel === 'whatsapp') {
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="currentColor"/><path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a8 8 0 01-4.243-1.214l-.29-.175-3.032.795.81-2.96-.192-.305A7.963 7.963 0 014 12a8 8 0 1116 0 8 8 0 01-8 8z" fill="currentColor"/></svg>`;
    }
    return '';
}
function channelLabel(ch) { return ch === 'instagram' ? 'Instagram' : ch === 'whatsapp' ? 'WhatsApp' : ''; }

// ══════════════════════════════════════════════════════════
// INACTIVITY TIMEOUT
// ══════════════════════════════════════════════════════════
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000;
const INACTIVITY_WARN_MS = 9 * 60 * 1000;
let inactivityTimer = null, inactivityWarnTimer = null, inactivityWarnOverlay = null;
let lastInactivityReset = 0;
const INACTIVITY_RESET_THROTTLE_MS = 30 * 1000;

function resetInactivityTimer() {
    if (!portalToken) return;
    const now = Date.now();
    if (now - lastInactivityReset < INACTIVITY_RESET_THROTTLE_MS) return;
    lastInactivityReset = now;
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (inactivityWarnTimer) { clearTimeout(inactivityWarnTimer); inactivityWarnTimer = null; }
    dismissInactivityWarning();
    inactivityWarnTimer = setTimeout(() => showInactivityWarning(), INACTIVITY_WARN_MS);
    inactivityTimer = setTimeout(() => { logout(); showToast('Logged out due to inactivity.', 'info'); }, INACTIVITY_LIMIT_MS);
}
function showInactivityWarning() {
    if (inactivityWarnOverlay) return;
    let remaining = Math.ceil((INACTIVITY_LIMIT_MS - INACTIVITY_WARN_MS) / 1000);
    inactivityWarnOverlay = document.createElement('div');
    inactivityWarnOverlay.id = 'inactivityWarnOverlay';
    inactivityWarnOverlay.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;';
    inactivityWarnOverlay.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:32px 40px;text-align:center;color:#fff;max-width:380px;">
        <div style="font-size:36px;margin-bottom:12px;">⏱️</div>
        <h3 style="margin:0 0 8px;font-size:18px;">Session Expiring</h3>
        <p style="color:#aaa;font-size:14px;margin:0 0 16px;">Session expires in <span id="inactivityCountdown">${remaining}</span>s.</p>
        <button id="inactivityStayBtn" style="background:#6c5ce7;color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:14px;cursor:pointer;font-weight:600;">Stay Logged In</button>
    </div>`;
    document.body.appendChild(inactivityWarnOverlay);
    const cdEl = document.getElementById('inactivityCountdown');
    const cdInt = setInterval(() => { remaining--; if (cdEl) cdEl.textContent = Math.max(remaining, 0); if (remaining <= 0) clearInterval(cdInt); }, 1000);
    document.getElementById('inactivityStayBtn').addEventListener('click', () => resetInactivityTimer());
}
function dismissInactivityWarning() { if (inactivityWarnOverlay) { inactivityWarnOverlay.remove(); inactivityWarnOverlay = null; } }
function clearInactivityTimer() {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (inactivityWarnTimer) { clearTimeout(inactivityWarnTimer); inactivityWarnTimer = null; }
    dismissInactivityWarning();
}
function attachInactivityListeners() {
    ['mousemove','mousedown','keydown','scroll','touchstart','click'].forEach(evt =>
        document.addEventListener(evt, () => resetInactivityTimer(), { passive: true })
    );
}

// ══════════════════════════════════════════════════════════
// SINGLE-WINDOW LOCK
// ══════════════════════════════════════════════════════════
let portalWindowLockId = null, portalWindowLockChannel = null;
let portalWindowIsHolder = false, portalWindowLockHeartbeat = null;

function acquirePortalWindowLock(probeMs = 700) {
    return new Promise(resolve => {
        if (typeof BroadcastChannel === 'undefined') return resolve(true);
        portalWindowLockId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        portalWindowLockChannel = new BroadcastChannel(`offcomfrt-portal-lock-${portalSlug}`);
        let answered = false;
        portalWindowLockChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (!msg.id || msg.id === portalWindowLockId) return;
            if (msg.type === 'claim') {
                if (portalWindowIsHolder) {
                    if (msg.id < portalWindowLockId) {
                        portalWindowIsHolder = false;
                        if (portalWindowLockHeartbeat) { clearInterval(portalWindowLockHeartbeat); portalWindowLockHeartbeat = null; }
                        showPortalBlockedScreen();
                    } else {
                        portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
                    }
                } else if (!answered) { answered = true; resolve(false); }
            } else if (msg.type === 'probe' && portalWindowIsHolder) {
                portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
            }
        };
        portalWindowLockChannel.postMessage({ type: 'probe', id: portalWindowLockId });
        setTimeout(() => {
            if (answered) return;
            portalWindowIsHolder = true;
            portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
            portalWindowLockHeartbeat = setInterval(() => {
                portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
            }, 3000);
            window.addEventListener('pagehide', () => {
                try { portalWindowLockChannel.postMessage({ type: 'release', id: portalWindowLockId }); } catch (_) {}
            });
            resolve(true);
        }, probeMs);
    });
}

function showPortalBlockedScreen() {
    if (document.getElementById('portalWindowLockOverlay')) return;
    openChats.forEach(gc => { if (gc.pollingInterval) clearInterval(gc.pollingInterval); });
    stopTicketPolling();
    document.body.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.id = 'portalWindowLockOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#0b0b0b;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;';
    overlay.innerHTML = `<div style="max-width:420px;padding:32px;">
        <div style="font-size:42px;margin-bottom:16px;">⚠️</div>
        <h2 style="margin:0 0 12px;font-size:20px;letter-spacing:.5px;">ALREADY OPEN IN ANOTHER WINDOW</h2>
        <p style="color:#999;font-size:14px;line-height:1.6;margin:0 0 8px;">This portal is active in another window.<br>Only one window is allowed at a time.</p>
        <p style="color:#666;font-size:12px;line-height:1.6;margin:0;">Close the other window and this page will take over automatically.</p>
    </div>`;
    document.body.appendChild(overlay);
    setInterval(() => {
        if (portalWindowIsHolder) return;
        let gotClaim = false;
        const onMsg = (ev) => { const msg = ev.data || {}; if (msg.type === 'claim' && msg.id === portalWindowLockId) gotClaim = true; };
        portalWindowLockChannel?.addEventListener('message', onMsg, { once: true });
        portalWindowLockChannel?.postMessage({ type: 'probe', id: (Math.random().toString(36).slice(2)) });
        setTimeout(() => { if (gotClaim) location.reload(); }, 1600);
    }, 5000);
}

// ══════════════════════════════════════════════════════════
// API HELPER
// ══════════════════════════════════════════════════════════
async function portalApi(path, method = 'GET', body = null) {
    const opts = { method, headers: { 'Authorization': `Bearer ${portalToken}`, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${API_BASE}${path}`, opts);
    if (resp.status === 401) { logout(); throw new Error('Session expired'); }
    return resp.json();
}

// ══════════════════════════════════════════════════════════
// INIT & AUTH
// ══════════════════════════════════════════════════════════
function getSlugFromUrl() { return new URLSearchParams(window.location.search).get('slug'); }

async function init() {
    portalSlug = getSlugFromUrl();
    if (!portalSlug) { document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#666;">Missing portal slug in URL.</div>'; return; }
    const locked = await acquirePortalWindowLock();
    if (!locked) return;
    if (portalToken) {
        const valid = await verifyToken();
        if (valid) { showApp(); return; }
        localStorage.removeItem('portalToken'); portalToken = null;
    }
    document.getElementById('loginScreen').style.display = 'flex';
}

async function verifyToken() {
    try {
        const data = await portalApi(`/portal/${portalSlug}/verify`);
        if (data.success) {
            portalInfo = data.portal || {};
            return true;
        }
        return false;
    } catch { return false; }
}

async function handleLogin(e) {
    e.preventDefault();
    const password = document.getElementById('portalPassword').value;
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    try {
        const resp = await fetch(`${API_BASE}/portal/auth`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: portalSlug, password })
        });
        const data = await resp.json();
        if (data.success) {
            portalToken = data.token; portalInfo = data.portal;
            localStorage.setItem('portalToken', portalToken);
            const locked = await acquirePortalWindowLock();
            if (!locked) return;
            showApp();
        } else { errEl.textContent = data.error || 'Invalid password'; }
    } catch { errEl.textContent = 'Connection error'; }
}

function showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'flex';
    const name = portalInfo?.name || portalInfo?.slug || 'Support';
    const nameEl = document.getElementById('portalNameDisplay');
    if (nameEl) nameEl.textContent = name;
    startTicketPolling();
    resetInactivityTimer();
}

function logout() {
    localStorage.removeItem('portalToken'); portalToken = null;
    openChats.forEach(gc => { if (gc.pollingInterval) clearInterval(gc.pollingInterval); });
    openChats.clear(); activeChatId = null;
    stopTicketPolling(); clearInactivityTimer();
    location.reload();
}

// ══════════════════════════════════════════════════════════
// TICKET POLLING & RENDERING
// ══════════════════════════════════════════════════════════
function startTicketPolling() { loadTickets(); ticketPollingInterval = setInterval(loadTickets, 15000); }
function stopTicketPolling() { if (ticketPollingInterval) { clearInterval(ticketPollingInterval); ticketPollingInterval = null; } }

async function loadTickets() {
    try {
        const params = new URLSearchParams();
        if (currentChannelFilter !== 'all') params.set('channel', currentChannelFilter);
        const data = await portalApi(`/portal/${portalSlug}/tickets?${params}`);
        if (data.success) {
            allTickets = data.tickets || [];
            checkForNewMessages(allTickets);
            filterTickets();
            updateTicketCount();
            // Sync tab badges
            renderTabs();
        }
    } catch (e) { console.error('Load tickets error:', e); }
}

function checkForNewMessages(tickets) {
    const currentIds = new Set(tickets.map(t => t.id));
    let newCount = 0;
    tickets.forEach(t => {
        if (!t.is_read) newCount++;
        if (!lastKnownTicketIds.has(t.id) && !t.is_read) newCount++;
    });
    if (newCount > unreadMessageCount) {
        unreadMessageCount = newCount;
        updateNotificationBadge();
    }
    lastKnownTicketIds = currentIds;
}

function updateTicketCount() {
    const el = document.getElementById('headerTicketCount');
    if (el) el.textContent = allTickets.length;
}

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    if (badge) {
        if (unreadMessageCount > 0) {
            badge.textContent = unreadMessageCount > 99 ? '99+' : unreadMessageCount;
            badge.style.display = 'flex';
        } else { badge.style.display = 'none'; }
    }
}

function filterTickets() {
    const search = (document.getElementById('ticketSearch')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('statusFilter')?.value || '';
    const unreadOnly = document.getElementById('unreadFilterBtn')?.classList.contains('active') || false;
    let filtered = allTickets;
    if (unreadOnly) filtered = filtered.filter(t => !t.is_read);
    if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
    if (search) filtered = filtered.filter(t =>
        (t.ticket_number || '').toLowerCase().includes(search) ||
        (t.customer_name || '').toLowerCase().includes(search) ||
        (t.customer_phone || '').toLowerCase().includes(search) ||
        (t.message || '').toLowerCase().includes(search)
    );
    renderSidebarTickets(filtered);
}

function renderSidebarTickets(tickets) {
    const list = document.getElementById('ticketsList');
    const empty = document.getElementById('ticketsEmpty');
    if (!list || !empty) return;

    if (tickets.length === 0) {
        list.style.display = 'none'; empty.style.display = 'flex'; return;
    }
    list.style.display = 'block'; empty.style.display = 'none';

    const html = tickets.map(t => {
        const isUnread = !t.is_read;
        const channel = t.channel || 'whatsapp';
        const chClass = channel === 'instagram' ? 'ig' : 'wa';
        const isActive = openChats.has(t.id) && t.id === activeChatId;
        return `<div class="sidebar-ticket-card${isActive ? ' active' : ''}${isUnread ? ' unread' : ''}" data-ticket-id="${t.id}" data-phone="${escapeJs(t.customer_phone)}" data-name="${escapeJs(t.customer_name || 'Customer')}" data-status="${t.status}" data-channel="${channel}">
            <div class="stc-top">
                <span class="stc-name">${isUnread ? '<span class="unread-dot-sm"></span>' : ''}${escapeHtml(t.customer_name || 'Customer')}</span>
                <span class="stc-time">${formatDate(t.created_at)}</span>
            </div>
            <div class="stc-mid">
                <span class="stc-ticket-num">${escapeHtml(t.ticket_number || 'N/A')}</span>
                <span class="stc-status ${t.status}">${t.status}</span>
                <span class="stc-channel ${chClass}">${channelIconSvg(channel, 12)}</span>
            </div>
            <div class="stc-message">${escapeHtml(truncate(t.message, 60))}</div>
        </div>`;
    }).join('');

    if (list.innerHTML !== html) list.innerHTML = html;

    list.querySelectorAll('.sidebar-ticket-card').forEach(card => {
        card.addEventListener('click', () => {
            openChat(card.dataset.ticketId, card.dataset.phone, card.dataset.name, card.dataset.status, card.dataset.channel || 'whatsapp');
        });
    });
}

// ══════════════════════════════════════════════════════════
// MULTI-CHAT TAB SYSTEM
// ══════════════════════════════════════════════════════════
function openChat(ticketId, phone, name, status, channel = 'whatsapp') {
    ticketId = String(ticketId);
    // If already open, just focus
    if (openChats.has(ticketId)) { focusTab(ticketId); return; }

    const chatState = {
        ticket: { id: ticketId, phone, name, status, channel },
        messages: [],
        pollingInterval: null,
        lastMsgCount: 0,
        lastAiReply: null
    };
    openChats.set(ticketId, chatState);
    focusTab(ticketId);
    loadChatMessages(ticketId);
    // Start polling for this chat
    chatState.pollingInterval = setInterval(() => {
        if (activeChatId === ticketId) loadChatMessages(ticketId, false);
    }, 15000);
    // Prefetch AI suggestions
    try { prefetchAiSuggestions(phone, ticketId); } catch (_) {}
}

function focusTab(ticketId) {
    ticketId = String(ticketId);
    activeChatId = ticketId;
    const chat = openChats.get(ticketId);
    if (!chat) return;

    // Update UI
    const t = chat.ticket;
    document.getElementById('chatEmptyState').style.display = 'none';
    document.getElementById('chatActiveContent').style.display = 'flex';
    document.getElementById('chatCustomerName').textContent = t.name;
    const phoneDisplay = document.getElementById('chatCustomerPhone');
    const chIcon = channelIconSvg(t.channel, 13);
    const chLbl = channelLabel(t.channel);
    if (t.channel === 'instagram') {
        phoneDisplay.innerHTML = `${escapeHtml(t.phone)} <span class="chat-channel-badge instagram">${chIcon} ${escapeHtml(chLbl)}</span>`;
    } else {
        phoneDisplay.innerHTML = `${escapeHtml(t.phone)} <span class="chat-channel-badge whatsapp">${chIcon} ${escapeHtml(chLbl)}</span>`;
    }
    // Resolve button
    const resolveBtn = document.getElementById('resolveChatBtn');
    if (resolveBtn) resolveBtn.style.display = t.status === 'resolved' ? 'none' : 'inline-flex';

    // Render messages for this chat
    renderChatMessages(chat.messages, true);
    renderTabs();
    renderSidebarTickets(getFilteredTickets());
    // Re-inject AI suggest button
    setTimeout(() => injectAiSuggestButton(), 50);
}

function closeChatTab(ticketId, e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    ticketId = String(ticketId);
    const chat = openChats.get(ticketId);
    if (!chat) return;
    if (chat.pollingInterval) clearInterval(chat.pollingInterval);
    openChats.delete(ticketId);

    if (activeChatId === ticketId) {
        // Focus adjacent tab
        const remaining = Array.from(openChats.keys());
        if (remaining.length > 0) {
            focusTab(remaining[remaining.length - 1]);
        } else {
            activeChatId = null;
            document.getElementById('chatEmptyState').style.display = 'flex';
            document.getElementById('chatActiveContent').style.display = 'none';
            // Close details panel if open
            if (detailsPanelOpen) toggleDetailsPanel();
        }
    }
    renderTabs();
    renderSidebarTickets(getFilteredTickets());
}

function renderTabs() {
    const bar = document.getElementById('chatTabs');
    if (!bar) return;
    if (openChats.size === 0) { bar.innerHTML = ''; return; }

    const html = Array.from(openChats.entries()).map(([id, chat]) => {
        const t = chat.ticket;
        const isActive = id === activeChatId;
        return `<div class="chat-tab${isActive ? ' active' : ''}" data-tab-id="${id}">
            <span>${escapeHtml(truncate(t.name, 18))}</span>
            <button class="tab-close" data-close-id="${id}" title="Close">&times;</button>
        </div>`;
    }).join('');

    if (bar.innerHTML !== html) bar.innerHTML = html;

    bar.querySelectorAll('.chat-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            if (e.target.closest('.tab-close')) return;
            focusTab(tab.dataset.tabId);
        });
    });
    bar.querySelectorAll('.tab-close').forEach(btn => {
        btn.addEventListener('click', (e) => closeChatTab(btn.dataset.closeId, e));
    });
}

function getFilteredTickets() {
    const search = (document.getElementById('ticketSearch')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('statusFilter')?.value || '';
    const unreadOnly = document.getElementById('unreadFilterBtn')?.classList.contains('active') || false;
    let filtered = allTickets;
    if (unreadOnly) filtered = filtered.filter(t => !t.is_read);
    if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
    if (search) filtered = filtered.filter(t =>
        (t.ticket_number || '').toLowerCase().includes(search) ||
        (t.customer_name || '').toLowerCase().includes(search) ||
        (t.customer_phone || '').toLowerCase().includes(search) ||
        (t.message || '').toLowerCase().includes(search)
    );
    return filtered;
}

// ══════════════════════════════════════════════════════════
// CHAT MESSAGES
// ══════════════════════════════════════════════════════════
async function loadChatMessages(ticketId, showLoading = true) {
    const chat = openChats.get(String(ticketId));
    if (!chat) return;
    try {
        const data = await portalApi(`/portal/${portalSlug}/chat/${encodeURIComponent(chat.ticket.phone)}`);
        if (data.success) {
            chat.messages = data.messages || [];
            if (String(ticketId) === activeChatId) {
                renderChatMessages(chat.messages, showLoading);
            }
        }
    } catch (error) {
        if (showLoading && String(ticketId) === activeChatId) {
            document.getElementById('chatMessages').innerHTML = '<div class="chat-loading">Failed to load messages</div>';
        }
    }
}

function renderChatMessages(messages, isInitialLoad = true) {
    const container = document.getElementById('chatMessages');
    if (!messages || messages.length === 0) {
        container.innerHTML = `<div class="chat-loading" style="padding:40px;"><div class="sidebar-empty-text">No messages yet</div></div>`;
        const chat = activeChatId ? openChats.get(String(activeChatId)) : null;
        if (chat) chat.lastMsgCount = 0;
        return;
    }
    const chat = activeChatId ? openChats.get(String(activeChatId)) : null;
    const lastCount = chat ? chat.lastMsgCount : 0;

    // Append-only optimization
    if (!isInitialLoad && messages.length > lastCount && lastCount > 0) {
        const newMsgs = messages.slice(lastCount);
        const newHtml = newMsgs.map(msg => renderOneMessage(msg)).join('');
        container.insertAdjacentHTML('beforeend', newHtml);
        if (chat) chat.lastMsgCount = messages.length;
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        if (isNearBottom) container.scrollTop = container.scrollHeight;
        return;
    }

    // Full render
    container.innerHTML = messages.map(msg => renderOneMessage(msg)).join('');
    if (chat) chat.lastMsgCount = messages.length;
    if (isInitialLoad) container.scrollTop = container.scrollHeight;
}

function renderOneMessage(msg) {
    const isAgent = msg.isAdmin;
    const time = formatTime(msg.timestamp);
    const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');
    return `<div class="chat-message ${isAgent ? 'agent' : 'customer'}">
        <div class="msg-bubble">
            <div class="msg-content">${content}</div>
            <div class="msg-meta">
                ${isAgent ? '<span class="msg-type-badge">Manual</span>' : ''}
                <span class="msg-time">${time}</span>
                ${isAgent ? '<span class="msg-status msg-status-sent">&#10003;</span>' : ''}
            </div>
        </div>
    </div>`;
}

async function sendMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message || !activeChatId) return;
    const chat = openChats.get(String(activeChatId));
    if (!chat) return;

    // Optimistic
    const container = document.getElementById('chatMessages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message agent';
    msgDiv.innerHTML = `<div class="msg-bubble"><div class="msg-content">${escapeHtml(message).replace(/\n/g, '<br>')}</div><div class="msg-meta"><span class="msg-type-badge">Manual</span><span class="msg-time">${formatTime(new Date().toISOString())}</span><span class="msg-status msg-status-sent">&#10003;</span></div></div>`;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    input.value = ''; input.style.height = 'auto';

    try {
        const data = await portalApi(`/portal/${portalSlug}/chat/send`, 'POST', {
            phone: chat.ticket.phone, message, suggestedText: chat.lastAiReply
        });
        chat.lastAiReply = null;
        if (data.success) {
            await loadChatMessages(activeChatId, false);
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

// ══════════════════════════════════════════════════════════
// AI REPLY SUGGESTIONS
// ══════════════════════════════════════════════════════════
const aiSuggestPrefetch = new Map();
const AI_PREFETCH_FRESH_MS = 90 * 1000;

function aiSuggestKey(phone, ticketId) { return `${phone}:${ticketId || ''}`; }

async function aiSuggestFetch(phone, ticketId, prefetch = false) {
    const data = await portalApi(`/portal/${portalSlug}/ai/suggest-reply`, 'POST', { phone, ticketId, prefetch });
    if (!data.success) throw new Error(data.error || 'AI suggestions unavailable');
    return data;
}

function prefetchAiSuggestions(phone, ticketId) {
    if (!phone || !portalToken) return;
    const key = aiSuggestKey(phone, ticketId);
    const existing = aiSuggestPrefetch.get(key);
    if (existing && Date.now() - existing.at < AI_PREFETCH_FRESH_MS) return;
    aiSuggestPrefetch.set(key, { promise: aiSuggestFetch(phone, ticketId, true).catch(() => null), at: Date.now() });
}

function injectAiSuggestButton() {
    const inputArea = document.querySelector('#chatActiveContent .chat-input-area');
    if (!inputArea || document.getElementById('aiSuggestReplyBtn')) return;
    const suggestionsBox = document.createElement('div');
    suggestionsBox.id = 'aiSuggestions';
    inputArea.parentNode.insertBefore(suggestionsBox, inputArea);

    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'aiSuggestReplyBtn';
    btn.title = 'AI: suggest replies'; btn.innerHTML = '✨';
    const sendBtn = document.getElementById('sendMessageBtn');
    inputArea.insertBefore(btn, sendBtn);

    btn.onclick = async () => {
        if (!activeChatId) { showToast('Open a chat first', 'error'); return; }
        const chat = openChats.get(String(activeChatId));
        if (!chat) return;
        const phone = chat.ticket.phone;
        const ticketId = chat.ticket.id;

        btn.disabled = true; btn.innerHTML = '…';
        suggestionsBox.classList.add('open');
        suggestionsBox.innerHTML = '<div class="ai-suggestions-note">Generating suggestions…</div>';
        try {
            const key = aiSuggestKey(phone, ticketId);
            const pre = aiSuggestPrefetch.get(key);
            let data = (pre && Date.now() - pre.at < AI_PREFETCH_FRESH_MS) ? await pre.promise : null;
            aiSuggestPrefetch.delete(key);
            if (!data || !data.suggestions) data = await aiSuggestFetch(phone, ticketId);

            if (!data.suggestions || !data.suggestions.length) {
                suggestionsBox.innerHTML = '<div class="ai-suggestions-note">No suggestions available.</div>';
            } else {
                suggestionsBox.innerHTML = '<div class="ai-suggestions-note">✨ Tap a draft to insert it:</div>';
                data.suggestions.forEach(s => {
                    const chip = document.createElement('button');
                    chip.type = 'button'; chip.className = 'ai-suggestion-chip';
                    chip.textContent = s;
                    chip.onclick = () => {
                        const inp = document.getElementById('chatInput');
                        if (inp) { inp.value = s; inp.focus(); inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'; }
                        chat.lastAiReply = s;
                        suggestionsBox.classList.remove('open'); suggestionsBox.innerHTML = '';
                    };
                    suggestionsBox.appendChild(chip);
                });
            }
        } catch (e) {
            suggestionsBox.innerHTML = `<div class="ai-suggestions-note">❌ ${e.message}</div>`;
        } finally { btn.disabled = false; btn.innerHTML = '✨'; }
    };
}

// ══════════════════════════════════════════════════════════
// RESOLVE TICKET
// ══════════════════════════════════════════════════════════
async function resolveCurrentTicket() {
    if (!activeChatId) return;
    const chat = openChats.get(String(activeChatId));
    if (!chat) return;
    if (!confirm('Mark this ticket as resolved?')) return;
    try {
        const data = await portalApi(`/portal/${portalSlug}/tickets/${chat.ticket.id}`, 'PUT', { status: 'resolved' });
        if (data.success) {
            showToast('Ticket resolved!', 'success');
            chat.ticket.status = 'resolved';
            closeChatTab(activeChatId);
            loadTickets();
        } else throw new Error(data.error);
    } catch (error) { showToast(error.message || 'Failed to resolve', 'error'); }
}

// ══════════════════════════════════════════════════════════
// CUSTOMER DETAILS PANEL
// ══════════════════════════════════════════════════════════
function toggleDetailsPanel() {
    const panel = document.getElementById('detailsPanel');
    detailsPanelOpen = !detailsPanelOpen;
    panel.classList.toggle('open', detailsPanelOpen);
    if (detailsPanelOpen && activeChatId) {
        const chat = openChats.get(String(activeChatId));
        if (chat) loadCustomerDetails(chat.ticket.phone);
    }
}

async function loadCustomerDetails(phone, forceRefresh = false) {
    const body = document.getElementById('detailsPanelBody');
    if (!body) return;

    // Check cache
    const cached = detailsCache.get(phone);
    if (!forceRefresh && cached && Date.now() - cached.at < DETAILS_CACHE_FRESH_MS) {
        renderDetailsPanel(cached.data);
        return;
    }

    body.innerHTML = '<div class="chat-loading"><div class="spinner"></div><span>Loading customer details...</span></div>';

    try {
        const data = await portalApi(`/portal/${portalSlug}/customers/${encodeURIComponent(phone)}/details`);
        if (data.success) {
            detailsCache.set(phone, { data, at: Date.now() });
            renderDetailsPanel(data);
        } else {
            body.innerHTML = '<div class="details-placeholder"><p>Failed to load details</p></div>';
        }
    } catch (error) {
        body.innerHTML = '<div class="details-placeholder"><p>Failed to load details</p></div>';
    }
}

function renderDetailsPanel(data) {
    const body = document.getElementById('detailsPanelBody');
    if (!body) return;
    const { customer, orders, returns, returnsConnected } = data;

    let html = '';

    // ── Customer Info Section ──
    html += `<div class="detail-section">
        <div class="detail-section-header expanded" data-section="customer">
            <h4>Customer Info</h4>
            <svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="detail-section-body">
            <div class="customer-info-grid">
                ${customer.name ? `<div class="ci-row"><div class="ci-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div><div><div class="ci-label">Name</div><div class="ci-value">${escapeHtml(customer.name)}</div></div></div>` : ''}
                <div class="ci-row"><div class="ci-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></div><div><div class="ci-label">Phone</div><div class="ci-value">${escapeHtml(customer.phone)}</div></div></div>
                ${customer.email ? `<div class="ci-row"><div class="ci-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div><div><div class="ci-label">Email</div><div class="ci-value">${escapeHtml(customer.email)}</div></div></div>` : ''}
                ${customer.city ? `<div class="ci-row"><div class="ci-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></div><div><div class="ci-label">Location</div><div class="ci-value">${escapeHtml(customer.city)}${customer.province ? ', ' + escapeHtml(customer.province) : ''}</div></div></div>` : ''}
            </div>
            <div class="ci-stats" style="margin-top:12px;">
                <div class="ci-stat"><div class="ci-stat-value">${customer.totalOrders || 0}</div><div class="ci-stat-label">Orders</div></div>
                <div class="ci-stat"><div class="ci-stat-value">${returns?.length || 0}</div><div class="ci-stat-label">Returns</div></div>
            </div>
        </div>
    </div>`;

    // ── Orders Section ──
    html += `<div class="detail-section">
        <div class="detail-section-header expanded" data-section="orders">
            <h4>Orders (${(orders || []).length})</h4>
            <svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="detail-section-body">`;

    if (!orders || orders.length === 0) {
        html += '<div style="font-size:13px;color:var(--text-tertiary);padding:8px 0;">No orders found</div>';
    } else {
        orders.forEach((order, idx) => {
            const statusClass = (order.status || 'pending').toLowerCase().replace(/\s+/g, '_');
            const collapsed = idx > 0 ? ' collapsed' : '';
            // Build items list HTML
            let itemsHtml = '';
            if (order.items && order.items.length) {
                itemsHtml = order.items.map(item => {
                    const name = escapeHtml(item.name || item.title || 'Item');
                    const qty = item.quantity || item.qty || 1;
                    const price = item.price ? `₹${parseFloat(item.price).toFixed(2)}` : '';
                    return `<div class="doc-row"><span class="doc-row-label">${name} ×${qty}</span><span class="doc-row-value">${price}</span></div>`;
                }).join('');
            }
            html += `<div class="detail-order-card">
                <div class="doc-header" data-order-toggle>
                    <span class="doc-order-id">${escapeHtml(order.order_id || 'N/A')}</span>
                    <span class="doc-status ${statusClass}">${escapeHtml(order.status || 'unknown')}</span>
                </div>
                <div class="doc-body${collapsed}">
                    <div class="doc-row"><span class="doc-row-label">Date</span><span class="doc-row-value">${formatDate(order.created_at)}</span></div>
                    ${order.total ? `<div class="doc-row"><span class="doc-row-label">Amount</span><span class="doc-row-value">₹${parseFloat(order.total).toFixed(2)}</span></div>` : ''}
                    ${order.payment_method ? `<div class="doc-row"><span class="doc-row-label">Payment</span><span class="doc-row-value">${escapeHtml(order.payment_method)}</span></div>` : ''}
                    ${order.delivery_type ? `<div class="doc-row"><span class="doc-row-label">Delivery</span><span class="doc-row-value">${escapeHtml(order.delivery_type)}</span></div>` : ''}
                    ${order.product_name && !itemsHtml ? `<div class="doc-row"><span class="doc-row-label">Product</span><span class="doc-row-value">${escapeHtml(order.product_name)}</span></div>` : ''}
                    ${itemsHtml}
                    ${order.address ? `<div class="doc-row"><span class="doc-row-label">Address</span><span class="doc-row-value" style="font-size:11px;max-width:200px;text-align:right;">${escapeHtml(order.address)}</span></div>` : ''}
                    ${order.awb ? `<div class="doc-row"><span class="doc-row-label">AWB</span><span class="doc-row-value">${escapeHtml(order.awb)}</span></div>` : ''}
                    ${order.courier_name ? `<div class="doc-row"><span class="doc-row-label">Courier</span><span class="doc-row-value">${escapeHtml(order.courier_name)}</span></div>` : ''}
                    ${order.tracking_url ? `<div class="doc-row"><span class="doc-row-label">Tracking</span><span class="doc-row-value"><a href="${escapeHtml(order.tracking_url)}" target="_blank" class="doc-tracking-link">Track →</a></span></div>` : ''}
                </div>
            </div>`;
        });
    }
    html += '</div></div>';

    // ── Returns & Exchanges Section ──
    html += `<div class="detail-section">
        <div class="detail-section-header expanded" data-section="returns">
            <h4>Returns & Exchanges (${(returns || []).length})</h4>
            <svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="detail-section-body">`;

    if (!returnsConnected) {
        html += '<div style="font-size:12px;color:var(--text-tertiary);padding:8px 0;">Returns server not connected</div>';
    } else if (!returns || returns.length === 0) {
        html += '<div style="font-size:13px;color:var(--text-tertiary);padding:8px 0;">No return/exchange requests</div>';
    } else {
        returns.forEach(r => {
            const typeClass = (r.type || 'return').toLowerCase();
            html += `<div class="detail-return-card">
                <div class="drc-top">
                    <span class="drc-type ${typeClass}">${escapeHtml(r.type || 'return')}</span>
                    <span class="drc-status">${escapeHtml(r.status || 'unknown')}</span>
                </div>
                <div class="drc-order">Order: ${escapeHtml(r.order_number || 'N/A')}</div>
                <div class="drc-items">
                    ${(r.items || []).map(item => `<div class="drc-item"><span class="drc-item-name">${escapeHtml(item.name || 'Item')}</span><span>×${item.quantity || 1}</span></div>`).join('')}
                </div>
                ${r.created_at ? `<div class="drc-date">${formatDate(r.created_at)}</div>` : ''}
            </div>`;
        });
    }
    html += '</div></div>';

    body.innerHTML = html;

    // Attach accordion toggles
    body.querySelectorAll('.detail-section-header').forEach(header => {
        header.addEventListener('click', () => {
            header.classList.toggle('expanded');
            const bodyEl = header.nextElementSibling;
            if (bodyEl) bodyEl.classList.toggle('collapsed');
        });
    });
    // Attach order card toggles
    body.querySelectorAll('[data-order-toggle]').forEach(header => {
        header.addEventListener('click', () => {
            const docBody = header.nextElementSibling;
            if (docBody) docBody.classList.toggle('collapsed');
        });
    });
}

// ══════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
function escapeJs(text) { if (!text) return ''; return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"'); }
function truncate(text, length) { if (!text) return ''; return text.length > length ? text.substring(0, length) + '...' : text; }

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffsetMs);
    let hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12; hours = hours ? hours : 12;
    return `${hours}:${minutes} ${ampm}`;
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    init();

    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });
    }

    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('ticketSearch')?.addEventListener('input', filterTickets);
    document.getElementById('statusFilter')?.addEventListener('change', filterTickets);
    document.getElementById('refreshTicketsBtn')?.addEventListener('click', loadTickets);
    document.getElementById('resolveChatBtn')?.addEventListener('click', resolveCurrentTicket);
    document.getElementById('toggleDetailsBtn')?.addEventListener('click', toggleDetailsPanel);
    document.getElementById('closeDetailsBtn')?.addEventListener('click', toggleDetailsPanel);
    document.getElementById('refreshDetailsBtn')?.addEventListener('click', () => {
        if (activeChatId) {
            const chat = openChats.get(String(activeChatId));
            if (chat) { detailsCache.delete(chat.ticket.phone); loadCustomerDetails(chat.ticket.phone, true); }
        }
    });
    document.getElementById('sendMessageBtn')?.addEventListener('click', sendMessage);

    // AI suggestions
    injectAiSuggestButton();

    // Inactivity
    attachInactivityListeners();

    // Unread filter
    document.getElementById('unreadFilterBtn')?.addEventListener('click', () => {
        document.getElementById('unreadFilterBtn')?.classList.toggle('active');
        filterTickets();
    });

    // Channel toggles
    document.querySelectorAll('.channel-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.channel-toggle').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentChannelFilter = btn.dataset.channel;
            loadTickets();
        });
    });
});
