/* ============================================================
   Offcomfrt Support Desk — agent dashboard
   Login → KPI bar → queue (left) → full ticket context (right).
   Admin settings modal: SLA, teams, canned responses, resolution
   templates, cost config, portals & shifts, ticket distribution,
   portal analytics, the access console (segments, bulk grants,
   policy), order sync.
   The portal tabs mirror the Support Command dashboard via the
   /api/admin/support-portals engine; mutations stay master-admin
   only (server-enforced), regular agents see a read-only view.
   ============================================================ */
(function () {
  'use strict';

  // The desk is served by this app (/desk), so API calls stay same-origin.
  // __DESK_API only exists for local development against another host.
  var API = String(window.__DESK_API || '').replace(/\/$/, '');
  var TOKEN_KEY = 'ofc_support_desk_token';
  var USER_KEY = 'ofc_support_desk_user';

  var S = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: localStorage.getItem(USER_KEY) || 'agent',
    role: '',               // from the JWT: 'admin' = full portal control
    stats: null,
    tickets: [],
    filters: { status: 'open', q: '', team: '', priority: '', category: '' },
    selectedId: null,
    detail: null,
    detailReady: false,      // heavy order/customer context merged into detail?
    expandedOrders: {},      // order-history rows opened by order id (per ticket)
    pendingContext: null,    // context payload that landed before the core did
    settings: { teams: {}, canned: [], templates: {}, sla: {}, cost: {}, portalRouting: {} },
    composer: { mode: 'reply', text: '', media: [], lastAiDraft: null },
    orderExpanded: true,
    customerExpanded: true,
    returnsExpanded: true,
    pollInterval: null,
    modal: null,          // { tab: 'sla'|'teams'|'canned'|'templates'|'cost'|'portals'|'distribute'|'panalytics'|'whitelist' }
    portals: null,        // cached GET /support-portals rows
    activeShifts: null,   // cached GET /support-portals/active-shifts
    distStats: null,
    analytics: null,      // cached GET /support-portals/analytics
    logins: null,         // cached GET /api/support/admin/login-stats (7d)
    loginsWide: null,     // days -> wider-window login-stats payloads (30/90)
    loginWindow: 7,       // days shown in the Logins tab (1 | 7 | 30 | 90)
    shifts: [],           // in-progress shift editor rows (Distribution tab)
    // Access tab console (settings modal). One cached overview payload drives
    // the summary chips, the segment cards and the policy form; the two row
    // sets are the segment preview and the roster.
    access: null,
    accessSection: 'segments',   // segments | roster | policy
    accessSegment: 'active_tickets',
    accessRows: null,     // preview rows (loaded for accessRowsFor)
    accessRowsFor: '',
    accessOffset: 0,
    accessSel: {},        // phone -> true, shared by preview and roster
    accessFilter: { q: '', roster: '', limit: 200 },
    accessList: null,     // roster rows
    accessListError: '',
    accessListFilter: { q: '', dormant: false, view: '' },
    mobileShow: 'queue'   // queue | detail (small screens)
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) { return '\u20B9' + (Math.round(Number(n) || 0)).toLocaleString('en-IN'); }
  function istDateKey(d) {
    return Intl.DateTimeFormat ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : '';
  }
  // "Logins today" for the KPI pill, derived from the cached 7-day trend so
  // the pill costs no extra request. null = panel data not loaded yet.
  function loginsToday() {
    if (!S.logins) return null;
    var todayKey = istDateKey(new Date());
    var rows = S.logins.trend || [];
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].date === todayKey) return rows[i].logins;
    }
    return 0;
  }
  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtShortDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + S.token }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, opts).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('Session expired \u2014 sign in again'); }
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return data;
      });
    });
  }
  // The portal engine lives on the admin API (same JWT, mounted /api/admin).
  // GETs are open to support_desk agents; the server 403s any non-admin write.
  function adminApi(path, opts) { return api('/api/admin' + path, opts); }
  // Role comes straight from the signed JWT payload (display only \u2014 the
  // server is the real gate). 'admin' = master admin = full portal control.
  function jwtRole(token) {
    try {
      var part = String(token || '').split('.')[1] || '';
      var payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
      return payload.role || '';
    } catch (e) { return ''; }
  }
  function isAdmin() { return S.role === 'admin'; }
  function dis() { return isAdmin() ? '' : ' disabled'; }
  function toast(msg, isErr) {
    var t = document.createElement('div');
    t.className = 'desk-toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t) { t.remove(); t = null; } }, 3200);
  }
  var STAGE_LABELS = {
    unshipped: 'Not shipped', shipped: 'In transit', out_for_delivery: 'Out for delivery',
    delivered: 'Delivered', exchange: 'Exchange in progress', return: 'Return pickup',
    cancelled: 'Cancelled', rto: 'RTO'
  };
  var REASON_LABELS = {
    order: 'Order', delivery: 'Delivery', product: 'Product', fit: 'Size & fit',
    return: 'Return', credit: 'Credit', other: 'Other'
  };

  // Monochrome inline SVG icon set — every surface icon is stroke-based and
  // inherits currentColor, so nothing on the desk carries hue or emoji.
  var IC = {
    person: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    box: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
    chart: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
    chat: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    image: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
    clip: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    search: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    lock: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    bulb: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>',
    pin: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    video: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
    zap: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    chevron: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
  };
  function headIcon(svg) { return '<span class="desk-head-icon">' + svg + '</span>'; }

  // ---------- auth ----------
  function logout() {
    if (S.pollInterval) {
      clearInterval(S.pollInterval);
      S.pollInterval = null;
    }
    if (S.detailPollInterval) {
      clearInterval(S.detailPollInterval);
      S.detailPollInterval = null;
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    S.token = '';
    S.detail = null;
    S.tickets = [];
    showLogin();
  }
  function showLogin(errMsg) {
    var root = $('DeskRoot');
    root.innerHTML = '<div class="desk-login"><div class="desk-login-card">'
      + '<h1>Support Desk</h1><p>Offcomfrt customer support console</p>'
      + '<input type="text" id="DeskUser" class="desk-input" placeholder="Username" autocomplete="username" onkeydown="if(event.key===\'Enter\'){event.preventDefault();document.getElementById(\'DeskPass\').focus();}">'
      + '<input type="password" id="DeskPass" class="desk-input" placeholder="Password" autocomplete="current-password" onkeydown="if(event.key===\'Enter\')DESK.login()">'
      + '<div class="desk-error">' + esc(errMsg || '') + '</div>'
      + '<button class="desk-btn" style="width:100%;justify-content:center" onclick="DESK.login()">Sign in</button>'
      + '<p class="desk-login-note">Operators need the <strong>Support Desk</strong> permission.</p>'
      + '</div></div>';
    var user = $('DeskUser');
    if (user) user.focus();
  }
  function login() {
    var user = $('DeskUser'), pass = $('DeskPass');
    if (!user || !pass || !user.value.trim() || !pass.value.trim()) return;
    fetch(API + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.value.trim(), password: pass.value })
    }).then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); }).then(function (res) {
      var d = res.d || {};
      if (!d.success || !d.token) throw new Error(res.r.status === 403 ? 'No Support Desk permission for this account' : (d.error || 'Invalid credentials'));
      S.token = d.token;
      S.user = (d.operator && d.operator.username) || d.username || 'agent';
      localStorage.setItem(TOKEN_KEY, S.token);
      localStorage.setItem(USER_KEY, S.user);
      bootDesk();
    }).catch(function (e) { showLogin(e.message); });
  }

  // ---------- boot ----------
  function bootDesk() {
    if (S.pollInterval) {
      clearInterval(S.pollInterval);
      S.pollInterval = null;
    }
    if (S.detailPollInterval) {
      clearInterval(S.detailPollInterval);
      S.detailPollInterval = null;
    }
    S.role = jwtRole(S.token);
    loadSettings().then(function () {
      renderShell();
      refreshAll();
      refreshLogins();
      // Memory & network smart polling: pause when tab is in background
      S.pollInterval = setInterval(function () {
        if (!document.hidden && S.token) refreshStats();
      }, 30000);
      // Thread freshness: while an open ticket is on screen, poll it every 15s
      // so new customer messages and media inline-status land without a reload.
      // Nothing re-renders unless the thread/media signature actually changes,
      // so the agent's in-progress draft is never interrupted.
      S.detailPollInterval = setInterval(function () {
        if (document.hidden || !S.token) return;
        if (!S.selectedId || !S.detail || !S.detail.ticket) return;
        var t = S.detail.ticket;
        if (t.status === 'closed') return;
        refreshThread(t.id);
      }, 15000);
    });
  }
  function refreshAll() { refreshStats(); loadTickets(); }
  function loadSettings() {
    return api('/api/support/admin/settings').then(function (st) {
      S.settings = {
        teams: st.teams || {},
        canned: st.canned_responses || [],
        templates: st.resolution_templates || {},
        sla: st.sla || {},
        cost: st.cost_config || {},
        portalRouting: st.portal_routing || {}
      };
    }).catch(function (e) { toast(e.message, true); });
  }
  function refreshStats() {
    api('/api/support/admin/stats').then(function (st) {
      S.stats = st;
      var k = $('DeskKpis');
      if (k) k.innerHTML = kpiHtml();
    }).catch(function () {});
  }
  // Website account logins (storefront OTP) come from the returns server via
  // the desk proxy; loaded once per boot and on demand from the Logins tab —
  // no need to poll it with the ticket stats.
  function refreshLogins() {
    return api('/api/support/admin/login-stats?days=7').then(function (d) {
      S.logins = d;
      var k = $('DeskKpis');
      if (k) k.innerHTML = kpiHtml();
    }).catch(function () {});
  }
  function loadTickets() {
    var f = S.filters;
    var qs = '?status=' + encodeURIComponent(f.status)
      + '&channel=' + encodeURIComponent(f.channel || 'website');
    if (f.q) qs += '&q=' + encodeURIComponent(f.q);
    if (f.team) qs += '&team=' + encodeURIComponent(f.team);
    if (f.priority) qs += '&priority=' + encodeURIComponent(f.priority);
    if (f.category) qs += '&category=' + encodeURIComponent(f.category);
    api('/api/support/admin/tickets' + qs).then(function (d) {
      S.tickets = d.tickets || [];
      var q = $('DeskQueue');
      if (q) q.innerHTML = queueHtml();
    }).catch(function (e) { toast(e.message, true); });
  }
  function loadDetail(id) {
    var el = $('DeskDetail');
    if (el) el.innerHTML = '<div class="desk-loading"><span class="desk-spin"></span>Loading ticket\u2026</div>';
    S.detail = null;
    S.detailReady = false;
    S.expandedOrders = {};
    S.pendingContext = null;
    // Phase 1: cheap reads only \u2014 header, thread and composer render at once.
    api('/api/support/admin/tickets/' + id).then(function (d) {
      if (S.selectedId !== id) return;
      S.detail = d;
      S.composer = { mode: 'reply', text: '', media: [], lastAiDraft: null };
      renderDetail();
      prefetchAi(id);
      // Context landed before the core did \u2014 merge it now.
      if (S.pendingContext && S.pendingContext.id === id) applyContext(S.pendingContext.data);
    }).catch(function (e) {
      if (el) el.innerHTML = '<div class="desk-empty-detail">' + esc(e.message) + '</div>';
    });
    // Phase 2: the hub aggregation fills the right rail independently, so a
    // cold customer-context build never blocks opening the ticket.
    loadContext(id);
  }
  function loadContext(id) {
    api('/api/support/admin/tickets/' + id + '/context').then(function (c) {
      if (!S.detail || S.detail.ticket.id !== id) {
        if (S.selectedId === id) S.pendingContext = { id: id, data: c };
        return;
      }
      applyContext(c);
    }).catch(function (e) {
      if (!S.detail || S.detail.ticket.id !== id) return;
      S.detail.contextError = e.message;
      renderContextCol();
    });
  }
  function applyContext(c) {
    S.pendingContext = null;
    Object.assign(S.detail, c);
    S.detailReady = true;
    renderContextCol();
    patchReqNote();
  }
  function reloadContext() {
    if (S.detail && S.detail.ticket) loadContext(S.detail.ticket.id);
  }
  function patchReqNote() {
    var el = $('DeskReqNote');
    if (el && S.detail && S.detail.requestNote) el.textContent = S.detail.requestNote;
  }

  // ---------- shell ----------
  function renderShell() {
    var root = $('DeskRoot');
    root.innerHTML = '<div class="desk-shell">'
      + '<div class="desk-topbar">'
      + '<div class="desk-topbar-brand">'
      +     '<span class="desk-wordmark">OFFCOMFRT</span>'
      +     '<h1>Support Desk</h1>'
      +     '<span class="desk-user-tag">' + esc(S.user) + '</span>'
      +   '</div>'
      +   '<div class="desk-kpi-strip" id="DeskKpis">' + kpiHtml() + '</div>'
      +   '<div class="desk-topbar-actions">'
      +     '<button class="desk-btn-plain" onclick="DESK.syncOrders()">Sync orders</button>'
      +     '<button class="desk-btn-plain" onclick="DESK.openSettings()">Settings</button>'
      +     '<button class="desk-btn-plain" onclick="DESK.logout()">Sign out</button>'
      +   '</div>'
      + '</div>'
      + '<div class="desk-main">'
      +   '<div class="desk-queue" id="DeskQueue"><div class="desk-loading"><span class="desk-spin"></span>Loading queue\u2026</div></div>'
      +   '<div class="desk-detail" id="DeskDetail"><div class="desk-empty-detail">Select a ticket from the queue to see the full order, issue and conversation context.</div></div>'
      + '</div>'
      + '</div>';
  }
  function kpiHtml() {
    var s = S.stats || {};
    return '<div class="desk-kpi-pill"><span class="lbl">Open</span><span class="val">' + (s.open || 0) + '</span></div>'
      + '<div class="desk-kpi-pill"><span class="lbl">Awaiting</span><span class="val">' + (s.awaiting || 0) + '</span></div>'
      + '<div class="desk-kpi-pill' + (s.sla > 0 ? ' bad' : '') + '"><span class="lbl">Past SLA</span><span class="val">' + (s.sla || 0) + '</span></div>'
      + '<div class="desk-kpi-pill"><span class="lbl">To approve</span><span class="val">' + (s.requests || 0) + '</span></div>'
      + '<div class="desk-kpi-pill"><span class="lbl">Closed today</span><span class="val">' + (s.closedToday || 0) + '</span></div>'
      + '<div class="desk-kpi-pill"><span class="lbl">Avg CSAT</span><span class="val">' + (s.avgCsat == null ? '\u2013' : s.avgCsat + '/5') + '</span></div>'
      + '<div class="desk-kpi-pill desk-kpi-click" title="Website account logins \u2014 click for the full panel" onclick="DESK.openSettings(\'logins\')"><span class="lbl">Logins today</span><span class="val">' + (loginsToday() == null ? '\u2013' : loginsToday()) + '</span></div>';
  }

  // ---------- queue ----------
  function queueHtml() {
    var f = S.filters;
    var counts = { open: S.stats ? S.stats.open : 0, awaiting: S.stats ? S.stats.awaiting : 0, closed: '' };
    var html = '<div class="desk-queue-head">'
      + '<div class="desk-tabs">'
      +   qTab('open', 'Open', counts.open) + qTab('awaiting', 'Awaiting', counts.awaiting) + qTab('closed', 'Closed', '\u221E')
      + '</div>'
      + '<input class="desk-search" placeholder="Search ticket, order, name, phone\u2026" value="' + esc(f.q) + '" '
      +   'onkeydown="if(event.key===\'Escape\')this.blur()" onchange="DESK.setFilter(\'q\',this.value)">'
      + '<div class="desk-filters">'
      +   '<select onchange="DESK.setFilter(\'category\',this.value)"><option value="">All categories</option>'
      +     Object.keys(REASON_LABELS).map(function (k) { return '<option value="' + k + '"' + (f.category === k ? ' selected' : '') + '>' + REASON_LABELS[k] + '</option>'; }).join('')
      +   '</select>'
      +   '<select onchange="DESK.setFilter(\'team\',this.value)"><option value="">All teams</option>'
      +     Object.keys(S.settings.teams).map(function (k) { return '<option value="' + k + '"' + (f.team === k ? ' selected' : '') + '>' + esc(S.settings.teams[k]) + '</option>'; }).join('')
      +   '</select>'
      +   '<select onchange="DESK.setFilter(\'priority\',this.value)"><option value="">Priority</option>'
      +     '<option value="high"' + (f.priority === 'high' ? ' selected' : '') + '>High</option>'
      +     '<option value="normal"' + (f.priority === 'normal' ? ' selected' : '') + '>Normal</option>'
      +   '</select>'
      + '</div>'
      + '</div><div class="desk-list">';
    if (!S.tickets.length) {
      html += '<div class="desk-loading">No tickets match.</div>';
    } else {
      S.tickets.forEach(function (t) { html += rowHtml(t); });
    }
    return html + '</div>';
  }
  function qTab(key, label, count) {
    return '<button class="desk-tab' + (S.filters.status === key ? ' active' : '') + '" onclick="DESK.setStatus(\'' + key + '\')">'
      + '<b>' + count + '</b>' + label + '</button>';
  }
  function rowHtml(t) {
    var sel = t.id === S.selectedId ? ' selected' : '';

    // Top line: Customer Name in bold alongside Ticket ID in muted monospace on left; timestamp on right
    var custName = t.customer_name || t.customer_phone || 'Customer';
    var ticketNum = t.ticket_number ? (String(t.ticket_number).charAt(0) === '#' ? t.ticket_number : '#' + t.ticket_number) : ('#' + t.id);
    var timeStr = fmtTime(t.updated_at || t.created_at);

    // Middle line: 1-line truncated preview of actual customer issue / subject
    var previewSubject = '';
    if (t.sub_label && t.preview && t.preview.text && t.preview.text !== t.sub_label) {
      previewSubject = t.sub_label + ' \u2014 ' + t.preview.text;
    } else {
      previewSubject = t.sub_label || (t.preview && t.preview.text) || t.reason_label || 'Support inquiry';
    }

    // Bottom line: Single horizontal row of compact, soft-pastel pill badges
    // 1. Ticket Type badge (REQUEST / ISSUE)
    var typeBadge = t.isRequest
      ? '<span class="desk-pill-badge pill-request">REQUEST</span>'
      : '<span class="desk-pill-badge pill-issue">ISSUE</span>';

    // 2. SLA status badge (e.g. DUE IN 11D / OVERDUE +45M)
    var slaBadge = '';
    if (t.sla) {
      var slaTxt = (t.sla.label || (t.sla.bad ? 'OVERDUE' : 'ON TIME')).toUpperCase();
      slaBadge = t.sla.bad
        ? '<span class="desk-pill-badge pill-sla-bad">' + esc(slaTxt) + '</span>'
        : '<span class="desk-pill-badge pill-sla-ok">' + esc(slaTxt) + '</span>';
    }

    // 3. Fulfillment status badge (e.g. NOT SHIPPED / DELIVERED / IN TRANSIT)
    var fBadge = '';
    if (t.order && t.order.stage) {
      var stg = String(t.order.stage).toLowerCase();
      var stgLabel = (STAGE_LABELS[stg] || stg.replace(/_/g, ' ')).toUpperCase();
      var stgClass = 'pill-stg-default';
      if (stg === 'delivered') stgClass = 'pill-stg-delivered';
      else if (stg === 'shipped' || stg === 'out_for_delivery') stgClass = 'pill-stg-transit';
      else if (stg === 'rto' || stg === 'cancelled') stgClass = 'pill-stg-rto';
      fBadge = '<span class="desk-pill-badge ' + stgClass + '">' + esc(stgLabel) + '</span>';
    }

    // 4. Portal pill: which support portal works this ticket. Filled = the
    // portal stamped on the row; outlined = a shift portal claiming it by
    // created time (visible in that portal, but portal_id is still NULL);
    // dashed = nobody has picked it up yet.
    var portalBadge = '';
    if (t.portal) {
      var assigned = t.portal.via === 'assigned';
      portalBadge = '<span class="desk-pill-badge ' + (assigned ? 'pill-portal' : 'pill-portal-shift')
        + '" title="' + esc(assigned ? 'Assigned to the ' + t.portal.name + ' portal'
          : t.portal.name + ' shows this ticket through its shift window \u2014 not stamped yet')
        + '">' + esc(t.portal.name) + '</span>';
    } else {
      portalBadge = '<span class="desk-pill-badge pill-portal-none" title="No portal has this ticket \u2014 assign it from Settings \u203a Distribution">No portal</span>';
    }

    return '<div class="desk-row' + sel + '" data-id="' + t.id + '" onclick="DESK.select(' + t.id + ')">'
      + '<div class="desk-row-line desk-row-top">'
      +   '<div class="desk-row-top-left">'
      +     '<span class="desk-row-cust">' + esc(custName) + '</span>'
      +     '<span class="desk-row-num">' + esc(ticketNum) + '</span>'
      +   '</div>'
      +   '<span class="desk-row-time">' + esc(timeStr) + '</span>'
      + '</div>'
      + '<div class="desk-row-line desk-row-mid">'
      +   '<span class="desk-row-preview" title="' + esc(previewSubject) + '">' + esc(previewSubject) + '</span>'
      + '</div>'
      + '<div class="desk-row-line desk-row-bot">'
      +   '<div class="desk-pill-strip">'
      +     typeBadge
      +     slaBadge
      +     fBadge
      +     portalBadge
      +   '</div>'
      + '</div>'
      + '</div>';
  }
  function setStatus(st) { S.filters.status = st; loadTickets(); }
  function setFilter(key, val) { S.filters[key] = val; loadTickets(); }

  // ---------- detail ----------
  function select(id) {
    S.selectedId = id;
    S.mobileShow = 'detail';
    var q = $('DeskQueue'), d = $('DeskDetail');
    if (window.innerWidth < 980) { if (q) q.classList.add('hide-mobile'); if (d) d.classList.remove('hide-mobile'); }
    var rows = document.querySelectorAll('.desk-row');
    rows.forEach(function (r) { r.classList.remove('selected'); });
    var target = document.querySelector('.desk-row[data-id="' + id + '"]');
    if (target) target.classList.add('selected');
    loadDetail(id);
  }
  function backToQueue() {
    S.mobileShow = 'queue';
    var q = $('DeskQueue'), d = $('DeskDetail');
    if (q) q.classList.remove('hide-mobile');
    if (d) d.classList.add('hide-mobile');
  }

  function renderDetail() {
    var el = $('DeskDetail');
    if (!el || !S.detail) return;
    var d = S.detail, t = d.ticket;

    // Two-column workspace:
    // 1. Unified Ticket Header (Status, Priority, Team, Category, SLA in one clean header)
    // 2. Action Column (Left): Conversation + composer, served by the core read
    // 3. Context Column (Right): customer + orders + risk, filled by the lazy
    //    context read (skeleton until it lands)
    el.innerHTML = ''
      + unifiedTicketHeader(d, t)
      + '<div class="desk-workspace-split">'
      +   '<div class="desk-action-col">'
      +     issueAndConversationCard(d, t)
      +   '</div>'
      +   '<div class="desk-context-col">'
      +     customerCard(d, t, h, o)
      +     orderHistoryCard(d, t, o)
      +     returnsExchangesCard(d)
      +     riskCard(d)
      +   '</div>'
      +   '<div class="desk-context-col" id="DeskContextCol">' + contextColHtml() + '</div>'
      + '</div>';

    // Hydrate the composer's pending-upload chips (they live in S.composer.media,
    // rebuilt here so a poll/re-render never loses them).
    renderComposerMedia();

    // Fixed app shell: panes scroll internally, so land the thread on the
    // newest message and the detail/rail regions on top when a ticket opens.
    var th = $('DeskThread');
    if (th) th.scrollTop = th.scrollHeight;
    el.scrollTop = 0;
    var cc = $('DeskContextCol');
    if (cc) cc.scrollTop = 0;

    if (window.innerWidth < 980) {
      var b = $('DeskBack');
      if (b) b.style.display = 'inline-flex';
    }
  }

  // ---------- context column (lazy) ----------
  function contextColHtml() {
    var d = S.detail;
    if (!d) return '';
    if (!S.detailReady) {
      if (d.contextError) {
        return '<div class="desk-card desk-ctx-error">'
          + '<div class="desk-card-title">' + headIcon(IC.box) + ' Order context</div>'
          + '<div class="desk-set-sub">' + esc(d.contextError) + '</div>'
          + '<button class="desk-btn desk-btn-ghost" onclick="DESK.reloadContext()">Retry</button>'
          + '</div>';
      }
      return '<div class="desk-card desk-ctx-skeleton">'
        + '<div class="sk-line" style="width:45%"></div>'
        + '<div class="sk-line" style="width:72%"></div>'
        + '<div class="sk-block"></div>'
        + '<div class="sk-block tall"></div>'
        + '<div class="sk-note"><span class="desk-spin"></span>Loading customer &amp; order context\u2026</div>'
        + '</div>';
    }
    var t = d.ticket, o = d.order || {}, h = d.history || {};
    return customerCard(d, t, h, o)
      + orderHistoryCard(d, t, o)
      + riskCard(d);
  }
  function renderContextCol() {
    var el = $('DeskContextCol');
    if (el) el.innerHTML = contextColHtml();
  }

  function priorityControls(t) {
    var teams = Object.keys(S.settings.teams);
    return '<div class="desk-control-group">'
      + '<label class="desk-control-lbl">Priority</label>'
      + '<select class="desk-select desk-select-sm" onchange="DESK.patchTicket({priority:this.value})">'
      + '<option value="normal"' + (t.priority !== 'high' ? ' selected' : '') + '>Normal</option>'
      + '<option value="high"' + (t.priority === 'high' ? ' selected' : '') + '>High</option>'
      + '</select>'
      + '</div>'
      + '<div class="desk-control-group">'
      + '<label class="desk-control-lbl">Team</label>'
      + '<select class="desk-select desk-select-sm" onchange="DESK.patchTicket({team:this.value})">'
      + '<option value="">Unassigned</option>'
      + teams.map(function (k) { return '<option value="' + k + '"' + (t.team === k ? ' selected' : '') + '>' + esc(S.settings.teams[k]) + '</option>'; }).join('')
      + '</select>'
      + '</div>';
  }

  // ── Unified Ticket Header (Single clean header bar: Status, Priority, Team, Category, SLA) ──
  function unifiedTicketHeader(d, t) {
    var sla = d.sla || t.sla;
    var slaHtml = sla ? (sla.bad
      ? '<span class="desk-pill-badge pill-sla-bad" title="Overdue SLA">' + esc((sla.label || 'OVERDUE').toUpperCase()) + '</span>'
      : '<span class="desk-pill-badge pill-sla-ok" title="Within SLA">' + esc((sla.label || 'ON TIME').toUpperCase()) + '</span>') : '';

    var chBadge = (t.channel === 'whatsapp')
      ? '<span class="desk-ch-badge ch-wa"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2z"/></svg> WhatsApp</span>'
      : '<span class="desk-ch-badge ch-web">Website</span>';

    var statusPill = '<span class="desk-pill ' + esc(t.status) + '"><span class="desk-status-indicator"></span>' + esc(t.status) + '</span>';

    // Same three states as the queue pill, spelled out: stamped owner, shift
    // claim, or still waiting for distribution.
    var pt = t.portal;
    var portalHtml = pt
      ? '<span class="desk-pill-badge ' + (pt.via === 'assigned' ? 'pill-portal' : 'pill-portal-shift') + '">' + esc(pt.name) + '</span>'
        + (pt.via !== 'assigned'
          ? ' <span class="desk-portal-note">claimed by shift window, not stamped</span>'
          : (pt.active === false ? ' <span class="desk-portal-note">portal is switched off</span>' : ''))
      : '<span class="desk-portal-note">Unassigned \u2014 distribute from Settings \u203a Distribution</span>';

    var ticketNum = t.ticket_number ? (String(t.ticket_number).charAt(0) === '#' ? t.ticket_number : '#' + t.ticket_number) : ('#' + t.id);

    return '<div class="desk-unified-head">'
      + '<div class="desk-unified-head-top">'
      +   '<div class="desk-head-left">'
      +     '<button class="desk-btn-plain desk-back-btn" id="DeskBack" style="display:none" onclick="DESK.backToQueue()">&larr; Queue</button>'
      +     '<span class="desk-ticket-tag">TICKET</span>'
      +     '<h2 class="desk-head-num">' + esc(ticketNum) + '</h2>'
      +     statusPill
      +     slaHtml
      +     chBadge
      +   '</div>'
      +   '<div class="desk-head-controls">'
      +     priorityControls(t)
      +   '</div>'
      + '</div>'
      + '<div class="desk-unified-head-meta">'
      +   '<div class="desk-meta-item"><span class="lbl">Category</span><span class="val"><strong>' + esc(t.reason_label || t.reason || 'General') + '</strong> &rsaquo; ' + esc(t.sub_label || t.sub || 'Inquiry') + '</span></div>'
      +   '<div class="desk-meta-item"><span class="lbl">Assigned Team</span><span class="val">' + esc(t.team && S.settings.teams[t.team] ? S.settings.teams[t.team] : (t.team || 'Unassigned')) + '</span></div>'
      +   '<div class="desk-meta-item"><span class="lbl">Support portal</span><span class="val">' + portalHtml + '</span></div>'
      +   '<div class="desk-meta-item"><span class="lbl">Created</span><span class="val">' + fmtTime(t.created_at) + '</span></div>'
      +   '<div class="desk-meta-item"><span class="lbl">Updated</span><span class="val">' + fmtTime(t.updated_at) + '</span></div>'
      + '</div>'
      + '</div>';
  }

  // ── 2. Customer Details (Dark Card Design matching mockup) ──
  function extractLocation(addr) {
    if (!addr || typeof addr !== 'string') return '\u2013';
    var parts = addr.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return '\u2013';
    var cleanParts = parts.filter(function (p) {
      if (/^\d{5,6}$/.test(p)) return false;
      if (/^(india|bharat|in)$/i.test(p)) return false;
      return true;
    });
    if (cleanParts.length >= 2) {
      return cleanParts[cleanParts.length - 2] + ', ' + cleanParts[cleanParts.length - 1];
    }
    if (cleanParts.length === 1) {
      return cleanParts[0];
    }
    return parts.slice(-2).join(', ');
  }

  function toggleCollapsible(stateKey, cardId, hintSel, forceExpand, scrollOnOpen) {
    S[stateKey] = typeof forceExpand === 'boolean' ? forceExpand : !S[stateKey];
    var card = $(cardId);
    if (!card) return;
    card.classList.toggle('is-expanded', S[stateKey]);
    card.classList.toggle('is-collapsed', !S[stateKey]);
    var hint = card.querySelector(hintSel || '.desk-collapse-hint');
    if (hint) hint.textContent = S[stateKey] ? 'Click to collapse' : 'Click to expand';
    if (S[stateKey] && scrollOnOpen) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function toggleCustomerInfo(forceExpand) {
    toggleCollapsible('customerExpanded', 'DeskCustomerCard', '.desk-cust-collapse-hint', forceExpand, false);
  }

  function customerCard(d, t, h, o) {
    o = o || d.order || {};
    var name = (t.customer_name || (o && o.customer_name) || 'Customer').toUpperCase();
    var phone = String(t.customer_phone || (o && o.phone) || '\u2013').replace(/^\+/, '');
    var email = t.customer_email || (o && o.email) || '\u2013';
    var location = extractLocation(o.address || t.new_address);
    var orderNum = String(o.id || t.order_id || '\u2013').replace(/^#/, '');
    var rawStage = String(o.stage || t.status || 'CONFIRMED').toLowerCase();
    var orderStatus = 'CONFIRMED';
    if (rawStage === 'unshipped') {
      orderStatus = (o.confirmed === false) ? 'UNCONFIRMED' : 'CONFIRMED';
    } else if (rawStage === 'delivered') {
      orderStatus = 'DELIVERED';
    } else if (rawStage === 'shipped') {
      orderStatus = 'SHIPPED';
    } else if (rawStage === 'in_transit') {
      orderStatus = 'IN TRANSIT';
    } else if (rawStage === 'cancelled') {
      orderStatus = 'CANCELLED';
    } else if (STAGE_LABELS[rawStage]) {
      orderStatus = STAGE_LABELS[rawStage].toUpperCase();
    } else if (rawStage) {
      orderStatus = rawStage.toUpperCase();
    }

    var ctx = d.context || {};
    var ordersCount = Number(h.orders) || (d.orders && d.orders.length) || 1;
    var returnsCount = (ctx.returns && ctx.returns.length) || (ctx.exchanges && ctx.exchanges.length) || Number(h.rto) || 0;
    var phone10 = phone.replace(/\D/g, '').slice(-10);
    var isExpanded = (S.customerExpanded !== false);

    return '<div class="desk-card desk-customer-info-card' + (isExpanded ? ' is-expanded' : ' is-collapsed') + '" id="DeskCustomerCard">'
      // Clickable Header Bar with smooth arrow animation & summary info
      + '<div class="desk-card-head desk-collapsible-bar" onclick="DESK.toggleCustomerInfo()" role="button" tabindex="0" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DESK.toggleCustomerInfo();}" title="Click to ' + (isExpanded ? 'collapse' : 'expand') + ' customer details">'
      +   '<div class="desk-card-title">'
      +     headIcon(IC.person) + ' Customer Info'
      +     '<span class="desk-collapse-hint desk-cust-collapse-hint">' + (isExpanded ? 'Click to collapse' : 'Click to expand') + '</span>'
      +   '</div>'
      +   '<div class="desk-order-bar-actions">'
      +     '<span class="desk-order-chip">' + esc(name) + '</span>'
      +     (phone !== '\u2013' ? '<span class="desk-order-chip">+' + esc(phone) + '</span>' : '')
      +     '<span class="desk-pill stage">' + ordersCount + ' ' + (ordersCount === 1 ? 'order' : 'orders') + '</span>'
      +     (phone10 ? '<a class="desk-btn desk-btn-wa desk-btn-sm" target="_blank" rel="noopener" href="https://wa.me/91' + esc(phone10) + '" onclick="event.stopPropagation()" title="Open WhatsApp Chat"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2z"/></svg> WhatsApp</a>' : '')
      +     '<span class="desk-collapse-arrow">' + IC.chevron + '</span>'
      +   '</div>'
      + '</div>'
      // Smoothly Animated Collapsible Body
      + '<div class="desk-customer-body" id="DeskCustomerBody">'
      +   '<div class="desk-ci-panel">'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Name:</span><span class="ci-val">' + esc(name) + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Phone:</span><span class="ci-val">' + (phone !== '\u2013' ? '<a href="tel:+' + esc(phone) + '">' + esc(phone) + '</a>' : '\u2013') + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Email:</span><span class="ci-val">' + (email !== '\u2013' ? '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>' : '\u2013') + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Location:</span><span class="ci-val">' + esc(location) + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Order:</span><span class="ci-val">' + orderAnchor(hubOrderHref(orderNum), '<span class="desk-order-chip">#' + esc(orderNum) + '</span>') + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Status:</span><span class="ci-val"><span class="desk-pill stage">' + esc(orderStatus) + '</span></span></div>'
      +     '<div class="desk-ci-stats-grid">'
      +       '<div class="desk-ci-stat-tile">'
      +         '<div class="ci-stat-num">' + ordersCount + '</div>'
      +         '<div class="ci-stat-lbl">ORDERS</div>'
      +       '</div>'
      +       '<div class="desk-ci-stat-tile">'
      +         '<div class="ci-stat-num">' + returnsCount + '</div>'
      +         '<div class="ci-stat-lbl">RETURNS</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="desk-ci-actions">'
      +     '<button type="button" class="desk-btn-ci-outline" onclick="DESK.toggleOrderHistory()">VIEW ORDER DETAILS</button>'
      +     '<button type="button" class="desk-btn-ci-solid" onclick="DESK.openResolve()">MARK AS RESOLVED</button>'
      +   '</div>'
      + '</div>'
      + '</div>';
  }

  // ── 3. Order History (Current Order + Past Orders Context, Collapsible) ──
  function toggleOrderHistory(forceExpand) {
    toggleCollapsible('orderExpanded', 'DeskOrderCard', '.desk-collapse-hint', forceExpand, true);
  }

  // ── 3. Order History (ticket order first, newest next; every row expands
  //    inline to its full detail from the already-loaded context) ──
  function normId(v) { return String(v == null ? '' : v).replace(/^#/, '').trim(); }

  // Order ids link straight into the Shoppers Hub: the hub's main grid
  // filters by order id through its search box (served same-origin), so one
  // anchor opens a hub tab landed on that exact order with its action
  // buttons. Plain target=_blank links — zero click-time work.
  function hubOrderHref(orderNum) {
    var id = normId(orderNum);
    return id ? '/shoppers/?search=' + encodeURIComponent(id) : '';
  }
  function orderAnchor(href, inner, title) {
    if (!href) return inner;
    return '<a class="desk-orderext" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" title="' + esc(title || 'Open in Shoppers Hub') + '" onclick="event.stopPropagation()">' + inner + '</a>';
  }

  function orderRowOpen(id, isTicket) {
    return isTicket ? S.expandedOrders[id] !== false : !!S.expandedOrders[id];
  }
  function toggleOrderRow(id) {
    if (!S.detail) return;
    var tid = normId(S.detail.ticket.order_id);
    S.expandedOrders[id] = !orderRowOpen(id, id === tid);
    renderContextCol();
  }

  function orderRowDetail(ord) {
    var items = (ord.items || []).map(function (i) {
      return '<tr>'
        + '<td><strong>' + esc(i.n) + '</strong>' + (i.v ? ' <span class="desk-item-var">(' + esc(i.v) + ')</span>' : '') + '</td>'
        + '<td class="num">x' + (i.q || 1) + '</td>'
        + '<td class="num">' + money(i.p) + '</td>'
        + '<td class="num">' + money((i.p || 0) * (i.q || 1)) + '</td>'
        + '</tr>';
    }).join('');
    var track = ord.awb && /delhivery/i.test(ord.courier || '')
      ? '<a class="desk-track-link" href="https://www.delhivery.com/track/package/' + esc(ord.awb) + '" target="_blank" rel="noopener">' + esc(ord.awb) + ' &UpperRightArrow;</a>'
      : (ord.awb ? '<span class="desk-mono">' + esc(ord.awb) + '</span>' : '<span class="desk-hint">&ndash;</span>');
    return '<div class="desk-order-details-grid">'
      + '<div class="desk-kv"><span class="k">Courier &amp; AWB</span><span class="v">' + esc(ord.courier || 'Courier') + ' &middot; ' + track + '</span></div>'
      + '<div class="desk-kv"><span class="k">Payment</span><span class="v">' + esc(ord.payment || 'COD') + ' &middot; ' + money(ord.total) + '</span></div>'
      + (ord.placed ? '<div class="desk-kv"><span class="k">Order Placed</span><span class="v">' + fmtTime(ord.placed) + '</span></div>' : '')
      + (ord.deliveredAt ? '<div class="desk-kv"><span class="k">Delivered</span><span class="v">' + fmtTime(ord.deliveredAt) + '</span></div>' : '')
      + (ord.address ? '<div class="desk-kv full-w"><span class="k">Shipping Address</span><span class="v">' + IC.pin + ' ' + esc(ord.address) + '</span></div>' : '')
      + '</div>'
      + (items
          ? '<div class="desk-items-wrap"><div class="desk-items-title">Ordered Items</div><table class="desk-items"><thead><tr><th>Item Details</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Subtotal</th></tr></thead><tbody>' + items + '</tbody></table></div>'
          : '<div class="desk-set-sub" style="margin-top:10px">No itemised record for this order.</div>');
  }

  function orderHistoryCard(d, t, o) {
    var ticketOrderId = normId((o && o.id) || t.order_id);
    var orders = (d.orders && d.orders.length ? d.orders : (o && o.id ? [o] : [])).slice();
    // The order this ticket is about leads; everything else newest-first.
    orders.sort(function (a, b) {
      var ap = normId(a.id) === ticketOrderId ? 1 : 0;
      var bp = normId(b.id) === ticketOrderId ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.placed || 0) - (a.placed || 0);
    });

    var rows = orders.map(function (ord) {
      var id = normId(ord.id);
      var isTicket = id === ticketOrderId;
      var open = orderRowOpen(id, isTicket);
      var st = String(ord.stage || '').toLowerCase();
      var stageLabel = STAGE_LABELS[st] || (st ? st.replace(/_/g, ' ') : 'processing');
      return '<div class="desk-orow' + (open ? ' open' : '') + (isTicket ? ' ticket-order' : '') + '">'
        + '<div class="desk-orow-head" role="button" tabindex="0" title="Click to ' + (open ? 'hide' : 'show') + ' order details" '
        +   'onclick="DESK.toggleOrderRow(\'' + esc(id) + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DESK.toggleOrderRow(\'' + esc(id) + '\');}">'
        +   orderAnchor(hubOrderHref(ord.id), '<span class="history-id">#' + esc(ord.id) + '</span>', 'Open order #' + normId(ord.id) + ' in Shoppers Hub')
        +   (isTicket ? '<span class="desk-tag highlight-tag">This Ticket</span>' : '')
        +   '<span class="desk-pill stage">' + esc(stageLabel) + '</span>'
        +   '<span class="desk-orow-spacer"></span>'
        +   '<span class="history-date">' + fmtTime(ord.placed) + '</span>'
        +   '<span class="history-total">' + money(ord.total) + '</span>'
        +   '<span class="desk-orow-chev">' + IC.chevron + '</span>'
        + '</div>'
        + (open ? '<div class="desk-orow-detail">' + orderRowDetail(ord) + '</div>' : '')
        + '</div>';
    }).join('');

    var totalPastCount = (ctx.orders || []).length;
    // Open/past returns & exchanges
    var ctx = d.context || {};
    var reqs = [];
    (ctx.returns || []).forEach(function (r) { reqs.push({ kind: 'Return', r: r }); });
    (ctx.exchanges || []).forEach(function (r) { reqs.push({ kind: 'Exchange', r: r }); });
    reqs.sort(function (a, b) { return new Date(b.r.created_at || 0) - new Date(a.r.created_at || 0); });

    var reqRows = reqs.map(function (x) {
      return '<div class="desk-history-row req-row">'
        + '<div class="history-main">'
        +   '<span class="desk-tag request">' + x.kind + '</span>'
        +   orderAnchor(hubOrderHref(x.r.order_id), '<span class="history-id">#' + esc(x.r.order_id) + '</span>')
        +   '<span class="desk-pill">' + esc(String(x.r.status || '').replace(/_/g, ' ')) + '</span>'
        + '</div>'
        + '<div class="history-sub">'
        +   '<span class="history-src">' + (x.r.source === 'portal' ? 'Portal request' : 'Support request') + '</span> &middot; '
        +   '<span class="history-date">' + fmtTime(x.r.created_at) + '</span>'
        + '</div>'
        + '</div>';
    }).join('');

    var isExpanded = !!S.orderExpanded;
    var orderNum = (o && o.id) || t.order_id;
    var stageLabel = o && o.stage ? (STAGE_LABELS[o.stage] || o.stage) : '';

    return '<div class="desk-card desk-order-card' + (isExpanded ? ' is-expanded' : ' is-collapsed') + '" id="DeskOrderCard">'
      // Clickable Order History Bar (goes down and shows details on click)
      + '<div class="desk-card-head desk-collapsible-bar" onclick="DESK.toggleOrderHistory()" role="button" tabindex="0" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DESK.toggleOrderHistory();}" title="Click to ' + (isExpanded ? 'collapse' : 'expand') + ' order details">'
      +   '<div class="desk-card-title">'
      +     headIcon(IC.box) + ' Order History'
      +     '<span class="desk-collapse-hint">' + (isExpanded ? 'Click to collapse' : 'Click to expand') + '</span>'
      +   '</div>'
      +   '<div class="desk-order-bar-actions">'
      +     (orderNum ? orderAnchor(hubOrderHref(orderNum), '<span class="desk-order-chip">#' + esc(orderNum) + '</span>') : '')
      +     (stageLabel ? '<span class="desk-pill stage">' + esc(stageLabel) + '</span>' : '')
      +     (o && o.total != null ? '<span class="desk-order-chip price">' + money(o.total) + '</span>' : '')
      +     '<span class="desk-collapse-arrow">' + IC.chevron + '</span>'
      +   '</div>'
      + '</div>'
      // Collapsible Order Details Body
      + '<div class="desk-order-body" id="DeskOrderBody">'
      // Current Order Details Subsection
      +   '<div class="desk-current-order-box">'
      +     '<div class="desk-order-header-row">'
      +       '<div class="order-id-group">'
      +         '<span class="order-prefix">Order</span>'
      +         '<span class="order-num">#' + esc(o.id || t.order_id || '\u2013') + '</span>'
      +         '<span class="desk-pill stage">' + esc(STAGE_LABELS[o.stage] || o.stage || 'Processing') + '</span>'
      +       '</div>'
      +       '<div class="order-finance-group">'
      +         '<span class="desk-payment-pill">' + esc(o.payment || 'COD') + '</span>'
      +         '<span class="order-total-price">' + money(o.total) + '</span>'
      +       '</div>'
      +     '</div>'
      +     '<div class="desk-order-details-grid">'
      +       '<div class="desk-kv"><span class="k">Courier &amp; AWB</span><span class="v">' + esc(o.courier || 'Courier') + ' &middot; ' + track + '</span></div>'
      +       (o.placed ? '<div class="desk-kv"><span class="k">Order Placed</span><span class="v">' + fmtTime(o.placed) + '</span></div>' : '')
      +       (o.address ? '<div class="desk-kv full-w"><span class="k">Shipping Address</span><span class="v">&#128205; ' + esc(o.address) + '</span></div>' : '')
      +     '</div>'
      +     (items ? '<div class="desk-items-wrap"><div class="desk-items-title">Ordered Items</div><table class="desk-items"><thead><tr><th>Item Details</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Subtotal</th></tr></thead><tbody>' + items + '</tbody></table></div>' : '')
      +   '</div>'
      // Past Order History Subsection (hidden when only 1 order exists)
      +   (totalPastCount > 1 && pastOrders ? (
            '<div class="desk-past-orders-section">'
            + '<div class="desk-section-subhead">Past Orders <span class="desk-muted">(' + totalPastCount + ' recorded)</span></div>'
            + '<div class="desk-history-list">' + pastOrders + '</div>'
            + '</div>'
          ) : '')
      +   '<div class="desk-section-subhead">All Orders <span class="desk-muted">(' + orders.length + ' \u2014 ticket order first)</span></div>'
      +   '<div class="desk-history-list">' + (rows || '<div class="desk-set-sub">No orders on record for this customer.</div>') + '</div>'
      +   (reqs.length ? '<div class="desk-past-orders-section"><div class="desk-sub-section-title">Returns &amp; Exchanges</div><div class="desk-history-list">' + reqRows + '</div></div>' : '')
      +   '</div>'
      + '</div>';
  }

  // ── 3b. Returns & Exchanges Portal Card (Collapsible, directly under Order History) ──
  var RETURNS_PORTAL_URL = 'https://exchange-return-tracking.onrender.com/admin';
  function toggleReturnsExchanges(forceExpand) {
    toggleCollapsible('returnsExpanded', 'DeskReturnsCard', '.desk-ret-collapse-hint', forceExpand, false);
  }
  function openReturnPortal(requestId) {
    var url = requestId ? RETURNS_PORTAL_URL + '#requestId=' + encodeURIComponent(requestId) : RETURNS_PORTAL_URL;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  function returnsExchangesCard(d) {
    var ctx = d.context || {};
    var reqs = [];
    (ctx.returns || []).forEach(function (r) { reqs.push({ kind: 'RETURN', r: r }); });
    (ctx.exchanges || []).forEach(function (r) { reqs.push({ kind: 'EXCHANGE', r: r }); });
    reqs.sort(function (a, b) { return new Date(b.r.created_at || 0) - new Date(a.r.created_at || 0); });

    var count = reqs.length;
    var isExpanded = (S.returnsExpanded !== false);

    var itemsHtml = count ? reqs.map(function (x) {
      var r = x.r || {};
      var ordId = String(r.order_id || r.order_number || '').replace(/^#/, '');
      var dateStr = fmtShortDate(r.created_at);
      var srcLabel = r.source === 'portal' ? 'Portal' : 'Local';
      var statusStr = String(r.status || 'unknown').toUpperCase();
      var reqId = String(r.id || r.request_id || '');
      var typeCls = x.kind === 'EXCHANGE' ? 'type-exchange' : 'type-return';
      var statusCls = /^(completed|delivered|approved|credited)$/.test(String(r.status || '').toLowerCase()) ? 'status-done' : 'status-active';
      return '<div class="desk-re-item" role="button" tabindex="0"'
        + ' onclick="DESK.openReturnPortal(\'' + esc(reqId) + '\')"'
        + ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DESK.openReturnPortal(\'' + esc(reqId) + '\');}"'
        + ' title="Open in Return &amp; Exchange Portal">'
        + '<div class="desk-re-top">'
        +   '<span class="desk-re-type ' + typeCls + '">' + x.kind + '</span>'
        +   '<span class="desk-re-status ' + statusCls + '">' + esc(statusStr) + '</span>'
        + '</div>'
        + '<div class="desk-re-meta">'
        +   (ordId ? '<span class="desk-re-ord">#' + esc(ordId) + '</span>' : '')
        +   (dateStr ? '<span class="desk-re-date">' + esc(dateStr) + '</span>' : '')
        +   '<span class="desk-re-source">' + esc(srcLabel) + '</span>'
        + '</div>'
        + (r.reason ? '<div class="desk-re-reason" title="' + esc(r.reason) + '">' + esc(r.reason) + '</div>' : '')
        + '</div>';
    }).join('') : '<div class="desk-re-empty">No return or exchange requests recorded for this customer.</div>';

    return '<div class="desk-card desk-returns-card' + (isExpanded ? ' is-expanded' : ' is-collapsed') + '" id="DeskReturnsCard">'
      + '<div class="desk-card-head desk-collapsible-bar" onclick="DESK.toggleReturnsExchanges()" role="button" tabindex="0"'
      +   ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DESK.toggleReturnsExchanges();}"'
      +   ' title="Click to ' + (isExpanded ? 'collapse' : 'expand') + ' returns &amp; exchanges">'
      +   '<div class="desk-card-title">'
      +     '<svg class="desk-head-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h10a8 8 0 0 1 8 8v2M3 10l6 6m-6-6l6-6"/></svg>'
      +     ' Returns / Exchanges'
      +     '<span class="desk-re-count' + (count > 0 ? ' has-items' : '') + '">' + count + '</span>'
      +     '<span class="desk-collapse-hint desk-ret-collapse-hint">' + (isExpanded ? 'Click to collapse' : 'Click to expand') + '</span>'
      +   '</div>'
      +   '<div class="desk-order-bar-actions">'
      +     '<span class="desk-collapse-arrow">&#9662;</span>'
      +   '</div>'
      + '</div>'
      + '<div class="desk-returns-body" id="DeskReturnsBody">'
      +   '<div class="desk-re-list">' + itemsHtml + '</div>'
      + '</div>'
      + '</div>';
  }

  // ── 4. Unified Conversation & Issue Details Card (Interactive Dialogue Look) ──
  function issueAndConversationCard(d, t) {
    var images = t.images || [];
    MEDIA_GROUPS = [];
    var imagesHtml = images.length ? (
      '<div class="desk-proof-section">'
      + '<div class="desk-section-subhead">' + IC.image + ' Proof &amp; Attachments <span class="desk-muted">(' + images.length + ' image' + (images.length > 1 ? 's' : '') + ')</span></div>'
      + '<div class="desk-imggrid">'
      +   images.map(function (u) {
            return '<div class="desk-proof-thumb" onclick="DESK.lightbox(\'' + esc(u) + '\')" title="Click to enlarge"><img src="' + esc(u) + '" alt="proof"><span class="zoom-icon">' + IC.search + '</span></div>';
          }).join('')
      + '</div>'
      + '</div>'
    ) : '';

    var approveHtml = d.requestKey ? approveCard(d, t) : '';

    var rawThread = Array.isArray(t.thread) ? t.thread : [];
    var notes = Array.isArray(t.notes) ? t.notes : [];

    // Inline media from the new support_media lifecycle (t.media, hydrated
    // server-side). Each thread entry carries its own media_ids list, stamped
    // when the message went out — that is the authoritative anchor. The numeric
    // thread_entry_idx is only a fallback for rows written before entries were
    // stamped. Anything with no home belongs to the opening problem statement.
    var mediaList = Array.isArray(t.media) ? t.media : [];
    var mediaById = {};
    mediaList.forEach(function (md) { mediaById[md.id] = md; });
    var anchored = rawThread.map(function () { return []; });
    var claimedMedia = {};
    rawThread.forEach(function (m, i) {
      var ids = Array.isArray(m.media_ids) ? m.media_ids : [];
      ids.forEach(function (id) {
        var md = mediaById[id];
        if (md && !claimedMedia[md.id]) { anchored[i].push(md); claimedMedia[md.id] = true; }
      });
    });
    var mediaLoose = [];
    mediaList.forEach(function (md) {
      if (claimedMedia[md.id]) return;
      var idx = md.thread_entry_idx;
      if (idx != null && idx >= 0 && idx < anchored.length) {
        anchored[idx].push(md);
        claimedMedia[md.id] = true;
      }
    });
    mediaList.forEach(function (md) {
      if (claimedMedia[md.id]) return;
      // unanchored rows (raise-form photos from before stamping, inbound media
      // the router never placed on an entry) read as part of the first message
      mediaLoose.push(md);
    });

    var custName = t.customer_name || 'Customer';
    var custInitials = custName.split(' ').map(function (w) { return w[0]; }).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'C';

    var chBadge = (t.channel === 'whatsapp')
      ? '<span class="desk-ch-badge ch-wa"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2z"/></svg> WhatsApp</span>'
      : '<span class="desk-ch-badge ch-web">Website</span>';

    // Build chronological chat stream
    // 1. Initial customer problem statement is message #1
    var threadHtml = '';
    var hasProblemInThread = rawThread.some(function (m) {
      return m.role === 'customer' && m.text && m.text.trim() === (t.message || '').trim();
    });
    // The problem statement renders as conversation starter #1, so the thread
    // entry duplicating it is folded away — and its photos move with it.
    var problemIdx = -1;
    if (hasProblemInThread) {
      for (var pi = 0; pi < rawThread.length; pi++) {
        var pm = rawThread[pi];
        if (pm && pm.kind !== 'event' && pm.role === 'customer' && pm.text
          && pm.text.trim() === (t.message || '').trim()) { problemIdx = pi; break; }
      }
    }
    if (problemIdx >= 0 && anchored[problemIdx] && anchored[problemIdx].length) {
      mediaLoose = mediaLoose.concat(anchored[problemIdx]);
      anchored[problemIdx] = [];
    }

    var problemText = t.message ? esc(t.message) : '<em>No issue description message recorded.</em>';
    var problemMeta = '';
    if (t.preference) {
      problemMeta += '<div class="desk-bubble-detail"><strong>Requested Preference:</strong> ' + esc(t.preference) + '</div>';
    }
    if (t.new_address) {
      problemMeta += '<div class="desk-bubble-detail"><strong>Requested New Address:</strong> ' + IC.pin + ' ' + esc(t.new_address) + '</div>';
    }
    if (t.video_url) {
      problemMeta += '<div class="desk-bubble-detail">' + IC.video + ' <strong>Unboxing Video Proof Attached</strong></div>';
    }
    if (imagesHtml) {
      problemMeta += imagesHtml;
    }
    problemMeta += bubbleMediaHtml(mediaLoose, '', false);

    // Always render initial customer problem as the conversation starter
    threadHtml += '<div class="desk-msg-row cust-row">'
      + '<div class="desk-chat-avatar cust" title="' + esc(custName) + '">' + esc(custInitials) + '</div>'
      + '<div class="desk-msg-content">'
      +   '<div class="desk-msg-sender">'
      +     '<span class="sender-name">' + esc(custName) + '</span>'
      +     '<span class="sender-pill">Customer</span>'
      +     '<span class="sender-tag-initial">Initial Issue</span>'
      +     chBadge
      +     '<span class="sender-time">' + fmtTime(t.created_at) + '</span>'
      +   '</div>'
      +   '<div class="desk-msg-bubble cust-bubble">'
      +     '<div class="bubble-text">' + problemText + '</div>'
      +     problemMeta
      +   '</div>'
      + '</div>'
      + '</div>';

    // Follow-up thread messages
    rawThread.forEach(function (m, idx) {
      if (idx === problemIdx) return;
      if (m.kind === 'event') {
        threadHtml += '<div class="desk-ev"><span class="ev-dot">&bull;</span> ' + esc(m.text) + ' &middot; ' + fmtTime(m.at) + '</div>';
      } else if (m.role === 'customer') {
        var custMedia = anchored[idx] || [];
        threadHtml += '<div class="desk-msg-row cust-row">'
          + '<div class="desk-chat-avatar cust" title="' + esc(custName) + '">' + esc(custInitials) + '</div>'
          + '<div class="desk-msg-content">'
          +   '<div class="desk-msg-sender">'
          +     '<span class="sender-name">' + esc(custName) + '</span>'
          +     '<span class="sender-pill">Customer</span>'
          +     '<span class="sender-time">' + fmtTime(m.at) + '</span>'
          +   '</div>'
          +   '<div class="desk-msg-bubble cust-bubble' + (custMedia.length ? ' desk-bubble-photos' : '') + '">'
          +     (String(m.text || '').trim() ? '<div class="bubble-text">' + esc(m.text) + '</div>' : '')
          +     bubbleMediaHtml(custMedia, fmtTime(m.at), false)
          +   '</div>'
          + '</div>'
          + '</div>';
      } else {
        var agentName = esc(m.agentId || 'Support Team');
        var agentInitials = agentName.split(' ').map(function (w) { return w[0]; }).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'ST';
        var agentMedia = anchored[idx] || [];
        threadHtml += '<div class="desk-msg-row agent-row">'
          + '<div class="desk-msg-content agent-content">'
          +   '<div class="desk-msg-sender agent-sender">'
          +     '<span class="sender-time">' + fmtTime(m.at) + '</span>'
          +     (m.ask ? '<span class="desk-tag ask-tag">Asked Customer</span> ' : '')
          +     '<span class="sender-pill agent-pill">Support Team</span>'
          +     '<span class="sender-name">' + agentName + '</span>'
          +   '</div>'
          +   '<div class="desk-msg-bubble agent-bubble' + (agentMedia.length ? ' desk-bubble-photos' : '') + '">'
          +     (String(m.text || '').trim() ? '<div class="bubble-text">' + esc(m.text) + '</div>' : '')
          +     bubbleMediaHtml(agentMedia, fmtTime(m.at), true)
          +   '</div>'
          + '</div>'
          + '<div class="desk-chat-avatar agent" title="' + agentName + '">' + esc(agentInitials) + '</div>'
          + '</div>';
      }
    });

    if (t.status === 'closed' && t.resolution_label) {
      threadHtml += '<div class="desk-ev desk-ev-closed">'
        + '<strong>Ticket Resolved:</strong> ' + esc(t.resolution_label) + ' &middot; ' + fmtTime(t.resolution_at)
        + (t.csat ? ' &middot; <span class="desk-csat-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span> Rated ' + t.csat + '/5' : '')
        + '</div>';
    }

    notes.forEach(function (n) {
      threadHtml += '<div class="desk-msg-row note-row">'
        + '<div class="desk-msg-note-box">'
        +   '<div class="desk-note-header">'
        +     '<span>' + IC.lock + ' Internal Team Note (Team Only &middot; Hidden from customer)</span>'
        +     '<span>' + esc(n.agentId || 'Agent') + ' &middot; ' + fmtTime(n.at) + '</span>'
        +   '</div>'
        +   '<div class="desk-note-body">' + esc(n.text) + '</div>'
        + '</div>'
        + '</div>';
    });

    var totalMsgCount = 1 + (hasProblemInThread ? rawThread.length - 1 : rawThread.length) + notes.length;

    // Composer (only when not closed)
    var composerHtml = '';
    if (t.status !== 'closed') {
      var canned = S.settings.canned.filter(function (c) { return !c.mode || c.mode === S.composer.mode; });
      var placeholder = S.composer.mode === 'note'
        ? 'Write a private internal note for the team (never sent to customer)\u2026'
        : (S.composer.mode === 'ask'
            ? 'Ask ' + esc(custName) + ' for missing details or photos\u2026'
            : 'Type your reply to ' + esc(custName) + '\u2026');

      composerHtml = '<div class="desk-composer">'
        + '<div class="desk-composer-toolbar">'
        +   '<div class="desk-composer-modes">'
        +     '<button class="desk-mode' + (S.composer.mode === 'reply' ? ' active' : '') + '" onclick="DESK.setMode(\'reply\')">Reply</button>'
        +     '<button class="desk-mode' + (S.composer.mode === 'ask' ? ' active' : '') + '" onclick="DESK.setMode(\'ask\')">Ask Customer</button>'
        +     '<button class="desk-mode mode-note' + (S.composer.mode === 'note' ? ' active' : '') + '" onclick="DESK.setMode(\'note\')">' + IC.lock + ' Internal Note</button>'
        +   '</div>'
        +   (canned.length ? '<select class="desk-select desk-canned-select" onchange="DESK.useCanned(this.value)"><option value="">&plusmn; Insert Saved Reply\u2026</option>'
        +     canned.map(function (c) { return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>'; }).join('') + '</select>' : '')
        + '</div>'
        + (S.composer.mode === 'note' ? '' : '<div class="desk-ai-box" id="DeskAiBox"></div>')
        + '<div class="desk-composer-media" id="DeskComposerMedia"></div>'
        + '<textarea id="DeskMsg" class="desk-composer-textarea" placeholder="' + esc(placeholder) + '" oninput="DESK.setMsg(this.value)">' + esc(S.composer.text) + '</textarea>'
        + '<div class="desk-composer-actions">'
        +   (S.composer.mode !== 'note' ? '<label class="desk-attach" title="Attach up to 5 images (JPG, PNG, WebP, HEIC)">' + IC.clip + '<span class="desk-attach-txt">Photos</span><input type="file" accept="image/jpeg,image/png,image/webp,image/heic" multiple onchange="DESK.onPickFiles(this)"></label>' : '')
        +   (S.composer.mode === 'note' ? '' : '<button class="desk-btn desk-btn-ghost desk-ai-btn" id="DeskAiBtn" title="Suggest a reply with AI" onclick="DESK.aiSuggest()">✨ Suggest</button>')
        +   '<button class="desk-btn desk-btn-ghost" onclick="DESK.openResolve()">Resolve &amp; Close Ticket</button>'
        +   '<button class="desk-btn' + (S.composer.mode === 'note' ? ' desk-btn-note' : '') + '" onclick="DESK.sendComposer()">'
        +     (S.composer.mode === 'note' ? 'Add Internal Note' : (S.composer.mode === 'ask' ? 'Send Question' : 'Send Reply'))
        +   '</button>'
        + '</div>'
        + '</div>';
    } else {
      composerHtml = '<div class="desk-composer-closed">'
        + '<div class="closed-notice">This ticket is currently <strong>closed</strong>. You can reopen it if the customer responds or needs further help.</div>'
        + '<button class="desk-btn desk-btn-ghost desk-btn-sm" onclick="DESK.agentReopen()">Reopen Ticket</button>'
        + '</div>';
    }

    return '<div class="desk-card desk-issue-card desk-merged-card">'
      + '<div class="desk-card-head">'
      +   '<div class="desk-card-title">' + headIcon(IC.chat) + ' Conversation</div>'
      +   '<div class="desk-card-head-right" style="display:flex;align-items:center;gap:6px">'
      +     (d.requestKey ? '<span class="desk-pill-badge pill-request">Action Required</span>' : '')
      +     '<span class="desk-tag">' + totalMsgCount + ' ' + (totalMsgCount === 1 ? 'message' : 'messages') + '</span>'
      +   '</div>'
      + '</div>'
      + approveHtml
      + '<div class="desk-thread-wrap">'
      +   '<div class="desk-thread" id="DeskThread">' + threadHtml + '</div>'
      + '</div>'
      + composerHtml
      + '</div>';
  }

  function issueDetailsCard(d, t) { return issueAndConversationCard(d, t); }
  function conversationCard(d, t) { return ''; }

  function approveCard(d, t) {
    var key = d.requestKey;
    var inner = '<div class="req-note" id="DeskReqNote">' + esc(d.requestNote || '') + '</div>';
    switch (key) {
      case 'order/cancel':
        inner += '<div class="desk-kv"><span class="k">Settlement</span><span class="v">' + (d.order && d.order.payment === 'COD' ? 'COD \u2014 nothing to refund' : 'Prepaid \u2014 confirm refund route with customer') + '</span></div>';
        break;
      case 'order/edit':
        inner += '<input class="desk-input" id="AprNote" placeholder="What should change (size, colour, qty)?">';
        break;
      case 'order/prepay':
        inner += '<div class="desk-kv"><span class="k">Amount</span><span class="v">' + money(d.order && d.order.total) + '</span></div>';
        break;
      case 'delivery/address_change':
      case 'delivery/reship_new':
      case 'delivery/pay_reship':
        inner += '<div class="desk-kv"><span class="k">New address</span><span class="v">' + esc(t.new_address || '\u2013') + '</span></div>'
          + '<div class="desk-set-sub">Optional \u2014 structured fields for a direct Shopify address update (blank = tag + note for ops):</div>'
          + '<div class="desk-form-grid">'
          +   '<div><label>Address line</label><input id="AprAddr1"></div>'
          +   '<div><label>City</label><input id="AprCity"></div>'
          +   '<div><label>Province</label><input id="AprProv"></div>'
          +   '<div><label>PIN code</label><input id="AprZip"></div>'
          + '</div>';
        break;
      case 'return/return_credit':
      case 'return/exchange_req':
        inner += '<div class="desk-kv"><span class="k">Preference</span><span class="v">' + esc(t.preference || '\u2013') + '</span></div>'
          + '<div class="desk-set-sub">Approving creates a pending entry in the returns panel; the pickup flow takes over from there.</div>';
        break;
    }
    return '<div class="desk-approve">'
      + '<div class="desk-approve-head"><span class="badge">' + IC.zap + ' Action Required</span><span class="req-title">' + esc(d.requestLabel) + '</span></div>'
      + inner
      + '<div class="desk-approve-actions">'
      +   '<button class="desk-btn" onclick="DESK.approve()">Approve Request</button>'
      +   '<button class="desk-btn desk-btn-danger" onclick="DESK.decline()">Decline</button>'
      + '</div></div>';
  }

  // ── Dedicated Context: Economic Cost & Risk Analysis Card ──
  function riskCard(d) {
    var r = d.risk || { level: 'Low', factors: [] };
    var econ = d.econ || { rows: [], tip: '' };
    var riskLvl = String(r.level || 'Low').toLowerCase();
    return '<div class="desk-card desk-risk-card">'
      + '<div class="desk-card-head">'
      +   '<div class="desk-card-title">' + headIcon(IC.chart) + ' Economic Cost &amp; Risk</div>'
      +   '<span class="desk-pill risk-' + esc(riskLvl) + '">' + esc(r.level || 'Low') + ' Risk</span>'
      + '</div>'
      + '<div class="desk-risk-factors">' + (r.factors || []).map(function (f) { return '<span class="desk-tag">' + esc(f) + '</span>'; }).join('') + '</div>'
      + ((econ.rows && econ.rows.length) ? (
          '<table class="desk-econ"><thead><tr><th>Resolution Route</th><th>Est. Cost</th><th>Rationale</th></tr></thead><tbody>'
          + econ.rows.map(function (row) {
              return '<tr><td><strong>' + esc(row[0]) + '</strong></td><td class="cost">' + money(row[1]) + '</td><td>' + esc(row[2]) + '</td></tr>';
            }).join('')
          + '</tbody></table>'
        ) : '')
      + (econ.tip ? '<div class="desk-tip">' + IC.bulb + ' <strong>Tip:</strong> ' + esc(econ.tip) + '</div>' : '')
      + '</div>';
  }


  // ---------- composer actions ----------
  function setMode(m) { S.composer.mode = m; S.composer.text = ''; S.composer.lastAiDraft = null; if (m === 'note') S.composer.media = []; renderDetail(); }
  function setMsg(v) { S.composer.text = v; }
  function useCanned(key) {
    var c = S.settings.canned.filter(function (x) { return x.key === key; })[0];
    if (!c) return;
    var d = S.detail;
    var text = String(c.text || '')
      .replace(/\{order\}/g, d.ticket.order_id || '')
      .replace(/\{courier\}/g, (d.order && d.order.courier) || 'the courier')
      .replace(/\{awb\}/g, (d.order && d.order.awb) || 'on file')
      .replace(/\{amount\}/g, money(d.order && d.order.total));
    S.composer.text = text;
    var ta = $('DeskMsg');
    if (ta) { ta.value = text; ta.focus(); }
  }
  function sendComposer() {
    var t = S.detail.ticket;
    var text = S.composer.text.trim();
    var media = S.composer.media || [];
    var ready = media.filter(function (m) { return m.status === 'uploaded' && m.media_id; });
    var busy = media.filter(function (m) { return m.status === 'uploading' || m.status === 'pending'; });
    var failed = media.filter(function (m) { return m.status === 'failed'; });
    var canAttach = S.composer.mode !== 'note';
    if (!text && !(canAttach && ready.length)) { toast('Message is empty', true); return; }
    if (busy.length) { toast('Wait for the image uploads to finish', true); return; }
    if (canAttach && failed.length) { toast('Remove or retry the failed images first', true); return; }
    var path = S.composer.mode === 'note' ? '/note' : (S.composer.mode === 'ask' ? '/ask' : '/reply');
    var body = { text: text };
    if (canAttach && ready.length) body.media_ids = ready.map(function (m) { return m.media_id; });
    if (S.composer.mode === 'reply') body.suggestedText = S.composer.lastAiDraft || null;
    api('/api/support/admin/tickets/' + t.id + path, { method: 'POST', body: body })
      .then(function () {
        S.composer.text = '';
        S.composer.media = [];
        S.composer.lastAiDraft = null;
        loadDetail(t.id);
        refreshStats();
      })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- composer media (signed Cloudinary direct upload) ----------
  var MEDIA_MAX = 5;
  var MEDIA_MAX_BYTES = 10 * 1024 * 1024;
  var MEDIA_TYPES = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;

  function newMediaKey() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // Browser -> Cloudinary direct upload with live byte progress.
  function cloudinaryUpload(intent, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var up = (intent && intent.upload_params) || {};
      if (!up.cloud_name || !up.signature) { reject(new Error('Upload was not authorised')); return; }
      var url = 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(up.cloud_name) + '/image/upload';
      var fd = new FormData();
      fd.append('file', file);
      fd.append('api_key', up.api_key);
      fd.append('timestamp', up.timestamp);
      fd.append('signature', up.signature);
      fd.append('public_id', up.public_id);
      if (up.eager) fd.append('eager', up.eager);
      if (up.transformation) fd.append('transformation', up.transformation);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      if (xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch (err) { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && !data.error) resolve(data);
        else reject(new Error((data.error && data.error.message) || ('Upload failed (' + xhr.status + ')')));
      };
      xhr.onerror = function () { reject(new Error('Network error during upload')); };
      xhr.send(fd);
    });
  }

  // Upload the already-intented row, then confirm it server-side.
  function runMediaUpload(m, file, intent) {
    m.status = 'uploading'; m.progress = 0; renderComposerMedia();
    cloudinaryUpload(intent, file, function (p) { m.progress = p; renderComposerMedia(); })
      .then(function () {
        return api('/api/support/admin/media/' + m.media_id + '/finalize', { method: 'POST', body: {} });
      })
      .then(function (r) {
        m.status = 'uploaded'; m.progress = 100;
        m.thumb_url = r && r.media && r.media.thumb_url;
        m.full_url = r && r.media && r.media.full_url;
        m.error = null;
        renderComposerMedia();
      })
      .catch(function (e) {
        m.status = 'failed'; m.error = (e && e.message) || 'Upload failed';
        renderComposerMedia();
        toast('Image upload failed: ' + m.error, true);
      });
  }

  function startMediaUpload(m, file) {
    var ticketNumber = (S.detail && S.detail.ticket && S.detail.ticket.ticket_number) || null;
    m.status = 'pending'; m.progress = 0; renderComposerMedia();
    api('/api/support/admin/media/intent', { method: 'POST', body: { ticket_ref: ticketNumber } })
      .then(function (intent) {
        m.media_id = intent.media_id;
        m.public_id = intent.public_id;
        runMediaUpload(m, file, intent);
      })
      .catch(function (e) {
        m.status = 'failed'; m.error = (e && e.message) || 'Could not start upload';
        renderComposerMedia();
        toast(m.error, true);
      });
  }

  function onPickFiles(input) {
    var files = Array.prototype.slice.call((input && input.files) || []);
    if (!files.length) return;
    if (S.composer.mode === 'note') { toast('Photos can\'t be added to internal notes', true); input.value = ''; return; }
    if (!S.composer.media) S.composer.media = [];
    var room = Math.max(0, MEDIA_MAX - S.composer.media.length);
    if (files.length > room) toast('Up to ' + MEDIA_MAX + ' images per message', true);
    files.slice(0, room).forEach(function (file) {
      if (!MEDIA_TYPES.test(file.type || '')) { toast((file.name || 'File') + ' isn\'t a supported image', true); return; }
      if (file.size > MEDIA_MAX_BYTES) { toast((file.name || 'File') + ' is over 10 MB', true); return; }
      var entry = { key: newMediaKey(), name: file.name || 'image', status: 'pending', progress: 0, media_id: null, file: file };
      S.composer.media.push(entry);
      startMediaUpload(entry, file);
    });
    renderComposerMedia();
    input.value = '';
  }

  function removeMediaChip(key) {
    S.composer.media = (S.composer.media || []).filter(function (m) { return m.key !== key; });
    renderComposerMedia();
  }

  function retryMediaChip(key) {
    var m = (S.composer.media || []).filter(function (x) { return x.key === key; })[0];
    if (!m || !m.file) { toast('Re-select the image to retry', true); return; }
    if (m.media_id) {
      api('/api/support/admin/media/' + m.media_id + '/retry', { method: 'POST', body: {} })
        .then(function (fresh) { m.status = 'uploading'; m.progress = 0; renderComposerMedia(); runMediaUpload(m, m.file, fresh); })
        .catch(function (e) { toast((e && e.message) || 'Retry failed', true); });
    } else {
      startMediaUpload(m, m.file);
    }
  }

  function composerMediaHtml() {
    var media = S.composer.media || [];
    if (!media.length) return '';
    return media.map(function (m) {
      var label = m.status === 'uploaded' ? 'Ready' :
        m.status === 'uploading' ? (m.progress + '%') :
        m.status === 'failed' ? 'Failed' : 'Queued\u2026';
      var thumb = m.thumb_url ? '<img src="' + esc(m.thumb_url) + '" alt="">' : '<span class="desk-chip-spin"></span>';
      var prog = m.status === 'uploading' ? '<i class="desk-chip-fill" style="width:' + (m.progress || 0) + '%"></i>' : '';
      var retry = m.status === 'failed' ? '<button class="desk-chip-retry" onclick="DESK.retryMediaChip(\'' + m.key + '\')">Retry</button>' : '';
      return '<div class="desk-media-chip st-' + m.status + '" title="' + esc(m.error || m.name) + '">'
        + '<span class="desk-chip-thumb">' + thumb + '</span>'
        + '<span class="desk-chip-body">'
        +   '<span class="desk-chip-name">' + esc(m.name) + '</span>'
        +   '<span class="desk-chip-bar">' + prog + '</span>'
        + '</span>'
        + '<span class="desk-chip-status">' + label + '</span>'
        + retry
        + '<button class="desk-chip-x" title="Remove" onclick="DESK.removeMediaChip(\'' + m.key + '\')">&times;</button>'
        + '</div>';
    }).join('');
  }

  function renderComposerMedia() {
    var el = $('DeskComposerMedia');
    if (el) el.innerHTML = composerMediaHtml();
  }

  // ---------- inline thread media (WhatsApp-style photo bubbles) ----------
  // Status ladder: Uploading\u2026 \u2192 Sending\u2026 \u2192 Sent \u2192 Delivered/Seen,
  // with Failed surfaced as soon as any leg reports it.
  function mediaStatusLabel(md) {
    if (md.expired) return 'Expired';
    var us = md.upload_status, ds = md.delivery_status;
    if (us === 'failed') return 'Failed';
    if (us === 'sending') return 'Sending\u2026';
    if (ds === 'read') return 'Seen';
    if (ds === 'delivered') return 'Delivered';
    if (us === 'seen') return 'Seen';
    if (us === 'sent') return 'Sent';
    if (us === 'uploaded') return 'Ready';
    if (us === 'uploading') return 'Uploading\u2026';
    if (us === 'pending') return 'Pending';
    return us || '';
  }

  // One tick set per message, not per photo: the least advanced state in the
  // group wins, so a half-finished batch never lies to the agent.
  var STATUS_RANK = { failed: 0, pending: 1, uploading: 1, uploaded: 2, sending: 2, sent: 3, expired: 3, delivered: 4, read: 5, seen: 5 };
  var I_TICK1 = '<svg class="desk-tick" viewBox="0 0 16 11" width="13" height="10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 6l3.3 3.3L13 1.4"/></svg>';
  var I_TICK2 = '<svg class="desk-tick" viewBox="0 0 23 11" width="18" height="10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 6l3.3 3.3L13 1.4"/><path d="M10.4 9.3l3.3 3.3L22 4.7"/></svg>';

  function groupRank(arr) {
    var worst = 99;
    arr.forEach(function (md) {
      var r = STATUS_RANK[md.expired ? 'expired' : (md.upload_status || '')];
      if (r == null) r = 99;
      if (r < worst) worst = r;
    });
    return worst;
  }

  // Clock + ticks ride a dark scrim in the bottom-right of the LAST tile, so a
  // four-photo message reads as one message instead of four statuses. Ticks only
  // describe photos the agent sent; incoming photos show the clock alone.
  function groupReceiptHtml(arr, timeText, own) {
    var r = groupRank(arr);
    var mark = '';
    if (own) {
      mark = r === 0 ? '<span class="desk-mb-word">Failed</span>'
        : r === 1 ? '<span class="desk-mb-word">Uploading\u2026</span>'
        : r === 2 ? '<span class="desk-mb-word">Sending\u2026</span>'
        : r >= 4 ? I_TICK2 : I_TICK1;
    } else if (r === 0) {
      mark = '<span class="desk-mb-word">Unavailable</span>';
    }
    if (!timeText && !mark) return '';
    return '<span class="desk-mb-receipt">'
      + (timeText ? '<span class="desk-mb-time">' + esc(timeText) + '</span>' : '')
      + mark + '</span>';
  }

  function mediaTileHtml(md, gid, pos, isLast, hidden, receipt) {
    var inner;
    if (md.expired) {
      // the retention cron destroyed the asset \u2014 the slot stays for the audit trail
      inner = '<span class="desk-mb-gone">' + IC.image + ' Photo removed</span>';
    } else if (md.thumb_url || md.full_url) {
      var w = Number(md.width) || 0, h = Number(md.height) || 0;
      // aspect comes from the stored metadata so the bubble never jumps on load
      var ratio = (w > 0 && h > 0) ? ' style="aspect-ratio:' + w + '/' + h + '"' : '';
      // the thread carries the lighter preview transform; the viewer loads full res
      inner = '<img src="' + esc(md.thumb_url || md.full_url) + '" alt="photo" loading="lazy" decoding="async"' + ratio + '>';
    } else {
      inner = '<span class="desk-mb-pending">' + IC.image + '</span>';
    }
    var title = md.expired ? 'Photo expired' : esc(mediaStatusLabel(md));
    var more = (isLast && hidden > 0) ? '<span class="desk-mb-more">+' + hidden + '</span>' : '';
    return '<button type="button" class="desk-mb-tile' + (md.expired ? ' is-expired' : '') + '"'
      + ' title="' + title + '"' + (md.expired ? ' disabled' : ' onclick="DESK.openViewer(' + gid + ',' + pos + ')"') + '>'
      + inner + more + (isLast ? receipt : '')
      + '</button>';
  }

  // 1 = full-bleed photo, 2 = side by side, 3 = hero + stack, 4+ = 2x2 with a
  // "+N" tile standing in for the remainder.
  function bubbleMediaHtml(arr, timeText, own) {
    if (!arr || !arr.length) return '';
    var urls = arr.map(function (md) { return md.expired ? '' : (md.full_url || md.thumb_url || ''); });
    var gid = registerMediaGroup(urls);
    var receipt = groupReceiptHtml(arr, timeText, own);
    var n = arr.length;
    var cls = n === 1 ? ' desk-mb-1' : n === 2 ? ' desk-mb-2' : n === 3 ? ' desk-mb-3' : ' desk-mb-4';
    var shown = n <= 4 ? arr : arr.slice(0, 4);
    var hidden = n <= 4 ? 0 : n - 4;
    return '<div class="desk-mb' + cls + '" role="group" aria-label="' + n + ' photo' + (n > 1 ? 's' : '') + '">'
      + shown.map(function (md, i) {
          var isLast = i === shown.length - 1;
          return mediaTileHtml(md, gid, i, isLast, isLast ? hidden : 0, receipt);
        }).join('')
      + '</div>';
  }

  // ---------- open-ticket thread poll ----------
  function threadSig(t) {
    if (!t) return '';
    var th = t.thread || [];
    var md = t.media || [];
    return th.length + '|' + (t.status || '') + '|' + md.map(function (m) {
      return m.id + ':' + (m.upload_status || '') + ':' + (m.delivery_status || '');
    }).join(',');
  }

  function refreshThread(id) {
    var prevSig = S.detail && S.detail.ticket ? threadSig(S.detail.ticket) : '';
    api('/api/support/admin/tickets/' + id).then(function (d) {
      if (!S.detail || !S.detail.ticket || S.detail.ticket.id !== id) return;
      var newSig = threadSig(d.ticket);
      if (newSig === prevSig) return;
      // Merge only the thread-bearing fields so the lazy context column and
      // the agent's composer draft survive the refresh.
      S.detail.ticket = d.ticket;
      if ('sla' in d) S.detail.sla = d.sla;
      var focus = document.activeElement && document.activeElement.id === 'DeskMsg';
      var caret = focus ? (document.getElementById('DeskMsg') || {}).selectionStart : null;
      renderDetail();
      if (focus) {
        var ta = $('DeskMsg');
        if (ta) { ta.focus(); try { if (caret != null) ta.setSelectionRange(caret, caret); } catch (e) {} }
      }
    }).catch(function () { /* transient — next tick retries */ });
  }

  // ---------- AI reply suggestions (drafts only — never auto-sent) ----------
  var aiPrefetch = {};                       // ticketId -> { promise, at }
  var AI_PREFETCH_FRESH_MS = 90 * 1000;

  function aiSuggestFetch(id, prefetch) {
    return api('/api/support/admin/tickets/' + id + '/suggest-reply', { method: 'POST', body: { prefetch: !!prefetch } })
      .then(function (d) {
        if (!d.success) throw new Error(d.error || 'AI suggestions unavailable');
        return d;
      });
  }
  // Warm the cache when a ticket opens so an explicit ✨ click is instant.
  function prefetchAi(id) {
    if (!id) return;
    var hit = aiPrefetch[id];
    if (hit && Date.now() - hit.at < AI_PREFETCH_FRESH_MS) return;
    aiPrefetch[id] = { promise: aiSuggestFetch(id, true).catch(function () { return null; }), at: Date.now() };
  }
  function aiSuggest() {
    var d = S.detail;
    if (!d || !d.ticket) { toast('Open a ticket first', true); return; }
    var id = d.ticket.id;
    var box = $('DeskAiBox'), btn = $('DeskAiBtn');
    if (!box) return;
    if (btn) btn.disabled = true;
    box.className = 'desk-ai-box open';
    box.innerHTML = '<div class="desk-ai-note">Generating suggestions…</div>';
    var hit = aiPrefetch[id];
    var p = (hit && Date.now() - hit.at < AI_PREFETCH_FRESH_MS) ? hit.promise : aiSuggestFetch(id, false);
    delete aiPrefetch[id];
    Promise.resolve(p).then(function (data) {
      // A failed/empty prefetch must not read as "nothing to suggest" — retry live.
      if (!data || !data.suggestions || !data.suggestions.length) return aiSuggestFetch(id, false);
      return data;
    }).then(function (data) {
      if (!data.suggestions || !data.suggestions.length) {
        box.innerHTML = '<div class="desk-ai-note">No suggestions available.</div>';
        return;
      }
      box.innerHTML = '<div class="desk-ai-note">✨ Tap a draft to insert it:</div>';
      data.suggestions.forEach(function (s) {
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'desk-ai-chip'; chip.textContent = s;
        chip.onclick = function () {
          S.composer.text = s; S.composer.lastAiDraft = s;
          var ta = $('DeskMsg');
          if (ta) { ta.value = s; ta.focus(); }
          box.className = 'desk-ai-box'; box.innerHTML = '';
        };
        box.appendChild(chip);
      });
    }).catch(function (e) {
      box.innerHTML = '<div class="desk-ai-note desk-ai-err">❌ ' + esc(e.message) + '</div>';
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }
  function patchTicket(patch) {
    var t = S.detail.ticket;
    api('/api/support/admin/tickets/' + t.id, { method: 'PATCH', body: patch })
      .then(function () { loadDetail(t.id); loadTickets(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- resolve ----------
  function openResolve() {
    var tpls = S.settings.templates;
    var keys = Object.keys(tpls);
    S.modal = { type: 'resolve', sel: keys[0] || '' };
    var ov = document.createElement('div');
    ov.className = 'desk-modal-overlay';
    ov.id = 'DeskModal';
    ov.innerHTML = '<div class="desk-modal"><div class="desk-modal-head"><h2>Resolve &amp; close</h2>'
      + '<button class="desk-btn-plain" onclick="DESK.closeModal()">Close</button></div>'
      + '<div class="desk-modal-body">'
      + '<label class="desk-control-lbl">Resolution</label>'
      + '<select class="desk-select" style="max-width:100%;width:100%;margin:6px 0 12px" onchange="DESK.pickResolution(this.value)">'
      + keys.map(function (k) { return '<option value="' + k + '">' + k.replace(/_/g, ' ') + '</option>'; }).join('')
      + '</select>'
      + (keys[0] === 'store_credit' ? '<div class="desk-set-sub">Create the store credit code in Shopify (titled with the order number) before closing.</div>' : '')
      + '<label class="desk-control-lbl">Message to customer</label>'
      + '<textarea id="RslMsg" class="desk-input" style="margin-top:6px;min-height:100px"></textarea>'
      + '</div><div class="desk-modal-foot">'
      + '<button class="desk-btn" onclick="DESK.confirmResolve()">Close ticket</button>'
      + '</div></div>';
    document.body.appendChild(ov);
    function onEsc(e) { if (e.key === 'Escape') closeModal(); }
    ov._escHandler = onEsc;
    document.addEventListener('keydown', onEsc);
    pickResolution(keys[0] || '');
  }
  function pickResolution(key) {
    S.modal.sel = key;
    var t = S.detail.ticket, d = S.detail;
    var text = String(S.settings.templates[key] || '')
      .replace(/\{order\}/g, t.order_id || '')
      .replace(/\{courier\}/g, (d.order && d.order.courier) || 'the courier')
      .replace(/\{awb\}/g, (d.order && d.order.awb) || 'on file')
      .replace(/\{amount\}/g, money(d.order && d.order.total));
    var ta = $('RslMsg');
    if (ta) ta.value = text;
  }
  function confirmResolve() {
    var t = S.detail.ticket;
    var msg = ($('RslMsg') || {}).value || '';
    api('/api/support/admin/tickets/' + t.id + '/resolve', { method: 'POST', body: { type: S.modal.sel, message: msg } })
      .then(function () { closeModal(); loadDetail(t.id); refreshAll(); toast('Ticket closed'); })
      .catch(function (e) { toast(e.message, true); });
  }
  function agentReopen() {
    var t = S.detail.ticket;
    api('/api/support/admin/tickets/' + t.id + '/reopen', { method: 'POST', body: {} })
      .then(function () { loadDetail(t.id); refreshAll(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- approve / decline ----------
  function approve() {
    var d = S.detail, t = d.ticket;
    var body = {};
    if (d.requestKey === 'order/edit') body.note = ($('AprNote') || {}).value || '';
    if (/address|reship/.test(d.requestKey || '')) {
      var a1 = ($('AprAddr1') || {}).value, city = ($('AprCity') || {}).value,
          prov = ($('AprProv') || {}).value, zip = ($('AprZip') || {}).value;
      if (a1) body.address = { address1: a1, city: city || '', province: prov || '', zip: zip || '', country: 'IN' };
    }
    api('/api/support/admin/tickets/' + t.id + '/approve', { method: 'POST', body: body })
      .then(function (r) {
        if (r.paymentLink) {
          toast('Payment link generated \u2014 pasted below');
          S.composer.mode = 'reply';
          S.composer.text = 'Here is a secure link to pay ' + money(r.amount) + ' online for order #' + t.order_id + ': ' + r.paymentLink + '\n\nOnce paid, your order becomes prepaid.';
          loadDetail(t.id);
        } else {
          toast('Request approved' + (r.requestId ? ' (' + r.requestId + ')' : ''));
          loadDetail(t.id);
        }
        refreshAll();
      })
      .catch(function (e) { toast(e.message, true); });
  }
  function decline() {
    var t = S.detail.ticket;
    var note = window.prompt('Decline note (required \u2014 the customer will see this):');
    if (!note || !note.trim()) return;
    api('/api/support/admin/tickets/' + t.id + '/decline', { method: 'POST', body: { note: note.trim() } })
      .then(function () { toast('Request declined'); loadDetail(t.id); refreshAll(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- settings modal ----------
  function openSettings(tab) {
    S.modal = { tab: tab || 'sla' };
    var ov = document.createElement('div');
    ov.className = 'desk-modal-overlay';
    ov.id = 'DeskModal';
    ov.innerHTML = '<div class="desk-modal"><div class="desk-modal-head"><h2>Desk settings</h2>'
      + '<button class="desk-btn-plain" onclick="DESK.closeModal()">Close</button></div>'
      + '<div class="desk-modal-body" id="DeskSetBody"></div></div>';
    document.body.appendChild(ov);
    function onEsc(e) { if (e.key === 'Escape') closeModal(); }
    ov._escHandler = onEsc;
    document.addEventListener('keydown', onEsc);
    renderSettingsTab();
  }
  function setTab(tab) { S.modal.tab = tab; renderSettingsTab(); }
  function renderSettingsTab() {
    var el = $('DeskSetBody');
    if (!el) return;
    var tabs = [['sla', 'SLA'], ['teams', 'Teams'], ['canned', 'Saved replies'], ['templates', 'Resolutions'], ['cost', 'Cost & risk'], ['portals', 'Portals & Shifts'], ['distribute', 'Distribution'], ['panalytics', 'Analytics'], ['logins', 'Logins'], ['whitelist', 'Access']];
    var html = '<div class="desk-set-nav">'
      + tabs.map(function (x) { return '<button class="desk-mode' + (S.modal.tab === x[0] ? ' active' : '') + '" onclick="DESK.setTab(\'' + x[0] + '\')">' + x[1] + '</button>'; }).join('')
      + '</div>';
    var st = S.settings;
    if (S.modal.tab === 'sla') {
      html += '<div class="desk-form-grid">'
        + '<div><label>High priority (hours)</label><input id="SlaHigh" type="number" min="1" value="' + (st.sla.high_hours != null ? st.sla.high_hours : 4) + '"></div>'
        + '<div><label>Normal (hours)</label><input id="SlaNormal" type="number" min="1" value="' + (st.sla.normal_hours != null ? st.sla.normal_hours : 12) + '"></div>'
        + '</div><div style="margin-top:14px"><button class="desk-btn" onclick="DESK.saveSla()">Save SLA</button></div>';
    } else if (S.modal.tab === 'teams') {
      html += '<div id="TeamList">' + Object.keys(st.teams).map(function (k) {
        return '<div class="desk-set-item"><div class="row"><input type="text" value="' + esc(k) + '" data-k disabled style="max-width:140px;font-family:monospace">'
          + '<input type="text" value="' + esc(st.teams[k]) + '" data-v data-k="' + esc(k) + '">'
          + '<button class="desk-btn-plain" onclick="DESK.delTeam(\'' + esc(k) + '\')">Remove</button></div></div>';
      }).join('') + '</div>'
        + '<div class="row" style="display:flex;gap:8px;margin:10px 0"><input id="NewTeamKey" class="desk-input" placeholder="key (e.g. social)" style="flex:0 0 160px;margin-bottom:0">'
        + '<input id="NewTeamLabel" class="desk-input" placeholder="Label (e.g. Social support)" style="flex:1;margin-bottom:0">'
        + '<button class="desk-btn-plain" onclick="DESK.addTeam()">Add</button></div>'
        + '<button class="desk-btn" onclick="DESK.saveTeams()">Save teams</button>';
    } else if (S.modal.tab === 'canned') {
      html += '<div class="desk-set-sub">Variables: {order} {courier} {awb} {amount}. Mode = which composer button offers it.</div>'
        + '<div id="CannedList">' + st.canned.map(function (c, i) {
          return '<div class="desk-set-item" data-i="' + i + '"><div class="row">'
            + '<input type="text" value="' + esc(c.key) + '" data-f="key" placeholder="key" style="max-width:110px;font-family:monospace">'
            + '<input type="text" value="' + esc(c.label) + '" data-f="label" placeholder="Label">'
            + '<select data-f="mode"><option value="reply"' + (c.mode !== 'ask' ? ' selected' : '') + '>Reply</option><option value="ask"' + (c.mode === 'ask' ? ' selected' : '') + '>Ask</option></select>'
            + '<button class="desk-btn-plain" onclick="DESK.delCanned(' + i + ')">Remove</button></div>'
            + '<textarea data-f="text">' + esc(c.text) + '</textarea></div>';
        }).join('') + '</div>'
        + '<button class="desk-btn-plain" onclick="DESK.addCanned()">+ Add reply</button> '
        + '<button class="desk-btn" onclick="DESK.saveCanned()">Save replies</button>';
    } else if (S.modal.tab === 'templates') {
      html += '<div class="desk-set-sub">Auto-filled message per resolution type, offered in the Resolve flow. Variables: {order} {courier} {awb}.</div>'
        + '<div id="TplList">' + Object.keys(st.templates).map(function (k) {
          return '<div class="desk-set-item"><div class="row"><input type="text" value="' + esc(k) + '" disabled style="max-width:200px;font-family:monospace"></div>'
            + '<textarea data-k="' + esc(k) + '">' + esc(st.templates[k]) + '</textarea></div>';
        }).join('') + '</div>'
        + '<button class="desk-btn" onclick="DESK.saveTemplates()">Save templates</button>';
    } else if (S.modal.tab === 'cost') {
      var c = st.cost || {};
      html += '<div class="desk-form-grid">'
        + cf('FwdShip', 'Forward shipping', c.fwd_ship) + cf('RtoShip', 'RTO shipping', c.rto_ship)
        + cf('RevPickup', 'Reverse pickup', c.reverse_pickup) + cf('Packing', 'Packing', c.packing)
        + cf('CodFee', 'COD fee', c.cod_fee) + cf('RtoRateCod', 'RTO rate COD (0-1)', c.rto_rate_cod)
        + cf('RtoRatePre', 'RTO rate prepaid (0-1)', c.rto_rate_prepaid) + cf('HighValue', 'High value threshold', c.high_value)
        + cf('ReturnWindow', 'Return window (days)', c.return_window_days) + cf('DnrDays', 'DNR report (days)', c.dnr_report_days)
        + '</div><div style="margin-top:14px"><button class="desk-btn" onclick="DESK.saveCost()">Save cost config</button></div>';
    } else if (S.modal.tab === 'portals') {
      html += '<div id="PortalsBody">' + (S.portals ? portalsHtml() : '<div class="desk-loading"><span class="desk-spin"></span>Loading portals\u2026</div>') + '</div>';
    } else if (S.modal.tab === 'distribute') {
      html += '<div id="DistributeBody">' + (S.portals ? distributeHtml() : '<div class="desk-loading"><span class="desk-spin"></span>Loading portals\u2026</div>') + '</div>';
    } else if (S.modal.tab === 'panalytics') {
      html += '<div id="AnalyticsBody">' + (S.analytics ? analyticsHtml() : '<div class="desk-loading"><span class="desk-spin"></span>Loading analytics\u2026</div>') + '</div>';
    } else if (S.modal.tab === 'logins') {
      html += '<div id="LoginsBody">' + (S.logins ? loginsHtml() : '<div class="desk-loading"><span class="desk-spin"></span>Loading login activity\u2026</div>') + '</div>';
    } else if (S.modal.tab === 'whitelist') {
      html += '<div id="AccRoot">' + accessHtml() + '</div>';
    }
    el.innerHTML = html;
    // Post-render hooks for the async portal tabs (fill containers by id).
    if (S.modal.tab === 'portals' && !S.portals) loadPortalsTab();
    if (S.modal.tab === 'distribute') loadDistributeTab();
    if (S.modal.tab === 'panalytics' && !S.analytics) loadAnalytics();
    if (S.modal.tab === 'logins' && !S.logins) loadLoginsTab();
    if (S.modal.tab === 'whitelist') loadAccessTab();
  }

  // ---------- Logins tab (website account logins, via the returns server) ----------
  var LOGIN_WINDOWS = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
  // The boot fetch is 7d; wider windows are fetched lazily and cached per
  // window in S.loginsWide. "Today" is just the 7d trend sliced client-side.
  function activeLogins() {
    var wide = S.loginsWide && S.loginsWide[S.loginWindow];
    return wide || S.logins || {};
  }
  function loginsHtml() {
    var d = activeLogins();
    var t = d.totals || {};
    var win = S.loginWindow || 7;
    var html = '<div class="desk-set-sub">How many customers logged into their website account (phone OTP) on the Offcomfrt storefront.</div>';
    html += '<div class="desk-chips">' + LOGIN_WINDOWS.map(function (w) {
      return '<button class="desk-mode' + (win === w[0] ? ' active' : '') + '" style="min-width:70px" onclick="DESK.setLoginWindow(' + w[0] + ')">' + w[1] + '</button>';
    }).join('') + '<button class="desk-mode" style="min-width:60px" onclick="DESK.refreshLoginsPanel()" title="Reload">\u21bb</button></div>';
    var rows = (d.trend || []).slice(-win);
    var winTotal = 0;
    rows.forEach(function (r) { winTotal += r.logins || 0; });
    var winDistinct = 0;
    rows.forEach(function (r) { winDistinct += r.distinct_logins || 0; });
    html += '<div class="desk-chips">' + chip(loginsToday() || 0, 'Logged in today') + chip(winTotal, 'Logins in ' + win + 'd') + chip(winDistinct, 'People (per-day) in ' + win + 'd') + chip(t.otp_sent, 'OTPs sent in window') + '</div>';
    html += '<div class="desk-set-sec">Daily logins (IST)</div>';
    if (!rows.length) {
      html += '<div class="desk-set-sub">No logins recorded in this window yet.</div>';
    } else {
      var max = 1;
      rows.forEach(function (r) { if ((r.logins || 0) > max) max = r.logins; });
      html += '<div class="desk-login-bars">' + rows.map(function (r) {
        var label = String(r.date || '').slice(5);
        return '<div class="desk-login-bar" title="' + esc(r.date) + ' \u2014 ' + r.logins + ' logins, ' + (r.distinct_logins || 0) + ' people">'
          + '<div class="bar" style="height:' + Math.max(3, Math.round((r.logins || 0) / max * 100)) + '%"></div>'
          + '<span class="n">' + (r.logins || 0) + '</span><span class="x">' + esc(label) + '</span></div>';
      }).join('') + '</div>';
    }
    var recent = (d.recent || []).slice(0, 30);
    html += '<div class="desk-set-sec">Recent logins</div>';
    html += recent.length
      ? '<div class="desk-tblwrap"><table class="desk-tbl"><tr><th>When</th><th>Customer</th><th>Phone</th></tr>'
        + recent.map(function (r) {
            return '<tr><td>' + fmtTime(r.at) + '</td><td>' + esc(r.name || '\u2013') + '</td><td style="font-family:monospace">' + esc(r.phone) + '</td></tr>';
          }).join('') + '</table></div>'
      : '<div class="desk-set-sub">No logins recorded yet \u2014 the table fills as customers sign in.</div>';
    return html;
  }
  function loadLoginsTab() {
    refreshLogins().then(function () {
      renderLoginsBody();
    });
  }
  function setLoginWindow(days) {
    S.loginWindow = days;
    if (days > 7 && !(S.loginsWide && S.loginsWide[days])) {
      var el = $('LoginsBody');
      if (el) el.innerHTML = '<div class="desk-loading"><span class="desk-spin"></span>Loading login activity\u2026</div>';
      api('/api/support/admin/login-stats?days=' + days).then(function (d) {
        S.loginsWide = S.loginsWide || {};
        S.loginsWide[days] = d;
        renderSettingsTab();
      }).catch(function (e) {
        var b = $('LoginsBody');
        if (b) b.innerHTML = '<div class="desk-set-sub">' + esc(e.message) + '</div>';
      });
    } else {
      renderSettingsTab();
    }
  }
  function refreshLoginsPanel() {
    S.loginsWide = null;
    if (S.loginWindow > 7) { S.loginWindow = 7; }
    loadLoginsTab();
  }
  function renderLoginsBody() {
    var el = $('LoginsBody');
    if (el && S.modal && S.modal.tab === 'logins') el.innerHTML = loginsHtml();
  }
  function cf(id, label, val) {
    return '<div><label>' + label + '</label><input id="Cf' + id + '" type="number" step="any" value="' + (val != null ? val : '') + '"></div>';
  }
  // ============================================================
  // Access console — who gets the storefront Help & Tickets tab.
  //
  // Three sections over one engine (/api/support/admin/access/*):
  //   Segments    audience definitions (live tickets, order stages,
  //               buyer value, roster hygiene), each previewable and
  //               grantable in one click.
  //   Access list the roster itself: selection, level and expiry edits
  //               in bulk, paste import, cleanup sweeps, CSV export.
  //   Policy      the switches around both, including the global mode.
  // Counts, previews and bulk writes all come from the same segment id
  // server-side, so a card can never disagree with what it grants.
  // ============================================================
  var ACC_SECTIONS = [['segments', 'Segments'], ['roster', 'Access list'], ['policy', 'Policy']];
  var ACC_MODES = [
    ['whitelist', 'Whitelist only', 'Only numbers on the access list see Help &amp; Tickets. The safe default.'],
    ['open', 'Open to everyone', 'Any customer with a storefront account gets in without being listed. The list still decides access level, and order caching still follows it.'],
    ['closed', 'Closed', 'Nobody sees the tab, listed or not. This is the emergency switch.']
  ];
  var ACC_TOGGLES = [
    ['syncOnGrant', 'Pull their orders when granting', 'After a number is added, sync its Shopify orders straight away so the desk has context. Slows large grants down.'],
    ['verifyBeforeGrant', 'Skip numbers we have never seen', 'Bulk grants ignore phones that appear in no ticket, no order and no shopper record.'],
    ['autoGrantNewTickets', 'Auto-grant when a ticket lands', 'Anyone who writes in is added to the list themselves, so an answer is always deliverable.'],
    ['agentMayGrant', 'Desk agents may change the list', 'Turn off and only the master admin can grant, revoke or clean up access.'],
    ['webhookCacheFollowsList', 'Order cache follows the list', 'Shopify webhooks only store orders for listed numbers. Leave on unless the cache must cover everyone.'],
    ['notifyOnGrant', 'Send the Support Desk intro on WhatsApp', 'Every grant also queues the approved support_desk_intro announcement to the new numbers. Off by default \u2014 these are Meta-billed marketing sends.']
  ];

  function accNum(n) { return (Number(n) || 0).toLocaleString('en-IN'); }
  function accSeg(id) {
    var segs = (S.access && S.access.segments) || [];
    for (var i = 0; i < segs.length; i++) { if (segs[i].id === id) return segs[i]; }
    return null;
  }
  function accExt() { return Boolean(S.access && !S.access.schemaLimited); }
  // Grants honour policy.agentMayGrant server-side; mirror it here so the
  // buttons read as disabled instead of throwing a 403 toast on click.
  function grantDis() {
    var p = (S.access && S.access.policy) || {};
    if (isAdmin() || p.agentMayGrant !== false) return '';
    return ' disabled title="Access changes are restricted to the master admin (see Access \u203a Policy)"';
  }
  function adminOnly() { return isAdmin() ? '' : ' disabled title="Master admin only"'; }
  function accSelected() { return Object.keys(S.accessSel); }
  function accNeedSel() {
    var sel = accSelected();
    if (!sel.length) toast('Tick some numbers first', true);
    return sel.length ? sel : null;
  }
  function accChip(n, l, seg) {
    return '<div class="desk-chip desk-chip-go" title="Open this segment" onclick="DESK.accJump(\'' + seg + '\')"><b>'
      + accNum(n) + '</b><span>' + l + '</span></div>';
  }

  function accessHtml() {
    if (!S.access) return '<div class="desk-loading"><span class="desk-spin"></span>Loading access console\u2026</div>';
    var p = S.access.policy || {}, c = S.access.counts || {};
    var mode = p.mode || 'whitelist';
    var modeDef = null;
    ACC_MODES.forEach(function (m) { if (m[0] === mode) modeDef = m; });
    var html = '<div class="desk-set-sub">This list is the only gate on the Help &amp; Tickets tab inside the customer account. Numbers are stored with the country code (91XXXXXXXXXX).</div>';
    if (!accExt()) {
      html += '<div class="desk-acc-warn">Access levels and expiry dates are unavailable until the extra <code>support_whitelist</code> columns exist \u2014 they are added on the next boot, or paste <code>supabase_migration_support_access_controls.sql</code>. Granting and revoking work either way.</div>';
    }
    html += '<div class="desk-set-sec">Who is allowed in</div>'
      + '<div class="desk-chips">' + ACC_MODES.map(function (m) {
        return '<button class="desk-mode' + (mode === m[0] ? ' active' : '') + '"' + adminOnly()
          + ' onclick="DESK.setAccessMode(\'' + m[0] + '\')">' + m[1] + '</button>';
      }).join('') + '</div>'
      + '<div class="desk-acc-modehint">' + (modeDef ? modeDef[2] : '') + '</div>';
    html += '<div class="desk-chips">'
      + accChip(c.granted, 'On the list', 'granted')
      + accChip(c.active_tickets, 'With a live ticket', 'active_tickets')
      + accChip(c.ungranted_known, 'Known, no access', 'ungranted_known')
      + accChip(c.live_orders, 'Order in flight', 'live_orders')
      + accChip(c.granted_expired, 'Expired', 'granted_expired')
      + accChip(c.granted_dormant, 'Dormant', 'granted_dormant')
      + accChip(c.granted_invalid, 'Unmatched numbers', 'granted_invalid')
      + '</div>';
    html += '<div class="desk-chips" id="AccNav">' + ACC_SECTIONS.map(function (x) {
      return '<button class="desk-mode' + (S.accessSection === x[0] ? ' active' : '') + '" onclick="DESK.setAccessSection(\'' + x[0] + '\')">' + x[1] + '</button>';
    }).join('') + '<button class="desk-mode" title="Reload counts" onclick="DESK.reloadAccess()">\u21bb</button>'
      + '<span class="desk-acc-status" id="AccStatus"></span></div>';
    html += '<div id="AccessBody">' + accessBodyHtml() + '</div>';
    return html;
  }

  function accessBodyHtml() {
    if (S.accessSection === 'roster') return accessRosterHtml();
    if (S.accessSection === 'policy') return accessPolicyHtml();
    return accessSegmentsHtml();
  }

  // ---------- Segments: cards + preview table ----------
  function accessSegmentsHtml() {
    var byGroup = {};
    ((S.access && S.access.segments) || []).forEach(function (s) {
      (byGroup[s.group] = byGroup[s.group] || []).push(s);
    });
    var html = accOptsBar() + '<div id="AccPreview">' + accPreviewHtml() + '</div>';
    Object.keys(byGroup).forEach(function (g) {
      html += '<div class="desk-set-sec">' + esc(g) + '</div><div class="desk-acc-cards">'
        + byGroup[g].map(accSegCard).join('') + '</div>';
    });
    return html;
  }

  function accSegCard(s) {
    var on = S.accessSegment === s.id;
    return '<div class="desk-acc-card' + (on ? ' on' : '') + '">'
      + '<div class="t">' + esc(s.label) + '</div>'
      + '<div class="n">' + accNum(s.count) + '<em>customers</em></div>'
      + '<div class="h">' + esc(s.hint || '') + '</div>'
      + '<div class="a">'
      + '<button class="desk-btn-plain" onclick="DESK.accJump(\'' + s.id + '\')">Preview</button>'
      + '<button class="desk-btn-plain"' + (s.count ? grantDis() : ' disabled title="Nobody in this segment"')
      + ' onclick="DESK.accGrantSegment(\'' + s.id + '\')">Allow all</button>'
      + (isAdmin() && s.id !== 'granted' ? '<button class="desk-btn-plain" onclick="DESK.accAllowOnly(\'' + s.id + '\')">Allow only these</button>' : '')
      + '</div></div>';
  }

  // Level / expiry / note / sync controls shared by every bulk path, so a
  // grant from a card, a selection or a paste always carries the same shape.
  function accOptsBar() {
    var p = (S.access && S.access.policy) || {};
    return '<div class="desk-acc-opts">'
      + '<label class="desk-acc-field"><span>Access level</span><select id="AccLevel"' + (accExt() ? '' : ' disabled title="Needs the extra whitelist columns"') + '>'
      + '<option value="full"' + (p.defaultLevel === 'view' ? '' : ' selected') + '>Full \u2014 can raise tickets</option>'
      + '<option value="view"' + (p.defaultLevel === 'view' ? ' selected' : '') + '>Read-only \u2014 can only look</option></select></label>'
      + '<label class="desk-acc-field"><span>Expires after</span><input id="AccDays" type="number" min="0" step="1" value="' + (p.defaultDays || 0) + '"><em>days (0 = never)</em></label>'
      + '<label class="desk-acc-field grow"><span>Note</span><input id="AccNote" type="text" placeholder="why these were added"></label>'
      + '<label class="desk-check"><input id="AccSync" type="checkbox"' + (p.syncOnGrant === false ? '' : ' checked') + '> Pull their orders now</label>'
      + '<label class="desk-check" title="WhatsApp the approved Support Desk intro to everyone this action grants"><input id="AccAnnounce" type="checkbox"' + (p.notifyOnGrant ? ' checked' : '') + '> Send intro message</label>'
      + '<button class="desk-btn"' + grantDis() + ' onclick="DESK.accAddOne()">Add one number</button>'
      + '</div>';
  }

  function accOpts() {
    return {
      level: ($('AccLevel') || {}).value || 'full',
      days: Number(($('AccDays') || {}).value) || 0,
      note: (($('AccNote') || {}).value || '').trim() || null,
      sync: !!($('AccSync') || {}).checked,
      announce: !!($('AccAnnounce') || {}).checked
    };
  }

  function accPreviewHtml() {
    var seg = accSeg(S.accessSegment);
    if (!seg) return '<div class="desk-set-sub">Pick a segment below to preview it.</div>';
    var stale = S.accessRowsFor !== seg.id;
    var rows = stale ? [] : (S.accessRows || []);
    var html = '<div class="desk-acc-preview">'
      + '<div class="desk-acc-phead"><div><b>' + esc(seg.label) + '</b><span>' + accNum(seg.count)
      + ' customers match</span></div><div class="a">'
      + '<button class="desk-btn"' + (seg.count ? grantDis() : ' disabled') + ' onclick="DESK.accGrantSegment(\'' + seg.id + '\')">Allow all of them</button>'
      + (isAdmin() && seg.id !== 'granted' ? '<button class="desk-btn-plain" onclick="DESK.accAllowOnly(\'' + seg.id + '\')">Replace the whole list with these</button>' : '')
      + '</div></div>'
      + '<div class="desk-acc-filter">'
      + '<input id="AccQ" class="desk-input" placeholder="Search digits" value="' + esc(S.accessFilter.q) + '">'
      + '<select id="AccRoster">'
      + '<option value=""' + (S.accessFilter.roster ? '' : ' selected') + '>Everyone in the segment</option>'
      + '<option value="ungranted"' + (S.accessFilter.roster === 'ungranted' ? ' selected' : '') + '>Only those without access</option>'
      + '<option value="granted"' + (S.accessFilter.roster === 'granted' ? ' selected' : '') + '>Only those already allowed</option>'
      + '</select>'
      + '<button class="desk-btn-plain" onclick="DESK.accApplyFilter()">Apply</button>'
      + '<button class="desk-btn-plain" onclick="DESK.accJump(\'' + seg.id + '\', true)">\u21bb</button>'
      + '</div>';
    if (stale) {
      html += '<div class="desk-loading"><span class="desk-spin"></span>Loading ' + esc(seg.label) + '\u2026</div></div>';
      return html;
    }
    html += accSelBar();
    if (!rows.length) {
      html += '<div class="desk-set-sub">Nobody in this segment matches the current filters.</div>';
    } else {
      html += '<div class="desk-tblwrap"><table class="desk-tbl"><tr><th></th><th>Phone</th><th>Customer</th>'
        + '<th class="num">Live</th><th class="num">Tickets</th><th class="num">Orders</th><th>Last activity</th><th>Access</th></tr>';
      rows.forEach(function (r) {
        html += '<tr><td><input type="checkbox" data-ph="' + esc(r.phone) + '"' + (S.accessSel[r.phone] ? ' checked' : '')
          + ' onchange="DESK.accPick(\'' + esc(r.phone) + '\', this.checked)"></td>'
          + '<td style="font-family:monospace">' + esc(r.phone) + '</td>'
          + '<td>' + esc(r.name || '\u2013') + '</td>'
          + '<td class="num">' + (r.openTickets || 0) + '</td>'
          + '<td class="num">' + (r.totalTickets || 0) + '</td>'
          + '<td class="num">' + (r.orders || 0) + '</td>'
          + '<td>' + fmtTime(r.lastActivity) + '</td>'
          + '<td>' + (r.granted
            ? '<span class="desk-acc-on">' + (r.level === 'view' ? 'Read-only' : 'Allowed') + '</span>'
            : '<span class="desk-acc-off">No access</span>') + '</td></tr>';
      });
      html += '</table></div>' + accPager(rows.length);
    }
    html += '</div>';
    return html;
  }

  function accPager(shown) {
    var lim = Number(S.accessFilter.limit) || 200;
    return '<div class="desk-acc-pager">'
      + '<button class="desk-btn-plain"' + (S.accessOffset > 0 ? '' : ' disabled') + ' onclick="DESK.accPage(-1)">Previous</button>'
      + '<span>' + accNum(S.accessOffset + 1) + '\u2013' + accNum(S.accessOffset + shown) + ' of at least '
      + accNum(S.accessOffset + shown + (shown === lim ? 1 : 0)) + '</span>'
      + '<button class="desk-btn-plain"' + (shown === lim ? '' : ' disabled') + ' onclick="DESK.accPage(1)">Next</button>'
      + '</div>';
  }

  // Selection toolbar: rendered in both sections over whatever is on screen.
  function accSelBar() {
    return '<div class="desk-acc-bar"><span>Selected <b id="AccSelN">' + accSelected().length + '</b></span>'
      + '<button class="desk-btn-plain"' + grantDis() + ' onclick="DESK.accPickAll(true)">Select all shown</button>'
      + '<button class="desk-btn-plain" onclick="DESK.accClearSel()">Clear</button>'
      + '<button class="desk-btn"' + grantDis() + ' onclick="DESK.accSelGrant()">Allow selected</button>'
      + '<button class="desk-btn-plain danger"' + grantDis() + ' onclick="DESK.accSelRevoke()">Revoke selected</button>'
      + '<button class="desk-btn-plain"' + (accExt() ? grantDis() : ' disabled title="Needs the extra whitelist columns"') + ' onclick="DESK.accSelLevel(\'view\')">Make read-only</button>'
      + '<button class="desk-btn-plain"' + (accExt() ? grantDis() : ' disabled') + ' onclick="DESK.accSelLevel(\'full\')">Make full access</button>'
      + '<button class="desk-btn-plain"' + (accExt() ? grantDis() : ' disabled') + ' onclick="DESK.accSelExpiry()">Set expiry\u2026</button>'
      + '<button class="desk-btn-plain" onclick="DESK.accSelResync()">Re-sync orders</button>'
      + '<button class="desk-btn-plain"' + grantDis() + ' onclick="DESK.accSelAnnounce()">Send intro message</button>'
      + '<button class="desk-btn-plain" onclick="DESK.accExport()">Export CSV</button>'
      + '</div>';
  }

  // ---------- Access list (the roster) ----------
  var ACC_LIST_VIEWS = [['', 'Everyone'], ['view-only', 'Read-only'], ['expired', 'Expired'],
    ['unknown', 'No history'], ['invalid', 'Bad format']];

  function accessRosterHtml() {
    var c = (S.access && S.access.counts) || {};
    var html = accOptsBar()
      + '<div class="desk-acc-filter">'
      + '<input id="AccRq" class="desk-input" placeholder="Filter number, name or note" value="' + esc(S.accessListFilter.q) + '"'
      + ' onkeydown="if(event.key===\'Enter\'){DESK.accListSearch();}">'
      + '<button class="desk-btn-plain" onclick="DESK.accListSearch()">Filter</button>'
      + '<label class="desk-check"><input type="checkbox"' + (S.accessListFilter.dormant ? ' checked' : '')
      + ' onchange="DESK.accListDormant(this.checked)"> Only dormant</label>'
      + '<button class="desk-btn-plain" onclick="DESK.loadAccessRoster(true)">Reload</button>'
      + '<span class="desk-acc-views">' + ACC_LIST_VIEWS.map(function (v) {
        return '<button class="desk-mode' + ((S.accessListFilter.view || '') === v[0] ? ' active' : '')
          + '" onclick="DESK.accListView(\'' + v[0] + '\')">' + v[1] + '</button>';
      }).join('') + '</span></div>';
    html += '<div class="desk-set-sec">Maintenance</div><div class="desk-acc-clean">'
      + '<button class="desk-btn-plain"' + grantDis() + ' onclick="DESK.accCleanup(\'expired\')">Remove expired' + (c.granted_expired ? ' (' + accNum(c.granted_expired) + ')' : '') + '</button>'
      + '<button class="desk-btn-plain"' + grantDis() + ' onclick="DESK.accCleanup(\'invalid\')">Remove bad numbers' + (c.granted_invalid ? ' (' + accNum(c.granted_invalid) + ')' : '') + '</button>'
      + '<button class="desk-btn-plain"' + grantDis() + ' onclick="DESK.accCleanup(\'dormant\')">Remove dormant' + (c.granted_dormant ? ' (' + accNum(c.granted_dormant) + ')' : '') + '</button>'
      + '<button class="desk-btn-plain"' + grantDis() + ' onclick="DESK.accCleanup(\'unknown\')">Remove unmatched</button>'
      + '<button class="desk-btn-plain"' + grantDis() + ' onclick="DESK.accCleanup(\'duplicates\')">Merge duplicate spellings</button>'
      + (isAdmin() ? '<button class="desk-btn-plain danger" onclick="DESK.accClearAll()">Revoke everyone</button>' : '')
      + '</div>';
    html += '<div class="desk-set-sec">Add a batch by pasting numbers</div>'
      + '<textarea id="AccImport" class="desk-acc-import" placeholder="9876543210, +91 98765 43210, 919876543210 \u2014 a whole column from a sheet works. The level, expiry and note above are applied to all of them."></textarea>'
      + '<div style="margin-top:8px"><button class="desk-btn"' + grantDis() + ' onclick="DESK.accImport()">Import and allow</button></div>';
    html += '<div id="AccRosterTable">' + accRosterTableHtml() + '</div>';
    return html;
  }

  function accListFiltered() {
    var rows = S.accessList || [];
    var f = S.accessListFilter;
    var digits = String(f.q || '').replace(/\D/g, '');
    var text = String(f.q || '').trim().toLowerCase();
    return rows.filter(function (r) {
      if (f.view && (r.flags || []).indexOf(f.view) === -1) return false;
      if (digits) return String(r.phone).indexOf(digits) !== -1;
      if (text) return (String(r.name || '') + ' ' + String(r.note || '')).toLowerCase().indexOf(text) !== -1;
      return true;
    });
  }

  function accRosterTableHtml() {
    if (S.accessList === null) return '<div class="desk-loading"><span class="desk-spin"></span>Loading the access list\u2026</div>';
    if (S.accessListError) return '<div class="desk-set-sub">' + esc(S.accessListError) + '</div>';
    var rows = accListFiltered();
    var html = accSelBar();
    if (!rows.length) return html + '<div class="desk-set-sub">Nobody on the access list matches this filter.</div>';
    html += '<div class="desk-tblwrap"><table class="desk-tbl"><tr><th></th><th>Phone</th><th>Customer</th><th>Level</th>'
      + '<th>Source</th><th>Expires</th><th class="num">Live</th><th class="num">Orders</th><th>Last activity</th><th>Note</th><th class="acts"></th></tr>';
    rows.forEach(function (r) {
      html += '<tr><td><input type="checkbox" data-ph="' + esc(r.phone) + '"' + (S.accessSel[r.phone] ? ' checked' : '')
        + ' onchange="DESK.accPick(\'' + esc(r.phone) + '\', this.checked)"></td>'
        + '<td style="font-family:monospace">' + esc(r.phone)
        + ((r.flags && r.flags.length) ? '<span class="desk-acc-flags">' + esc(r.flags.join(' \u00b7 ')) + '</span>' : '') + '</td>'
        + '<td>' + esc(r.name || '\u2013') + '</td>'
        + '<td>' + (r.level === 'view' ? 'Read-only' : 'Full') + '</td>'
        + '<td>' + esc(r.source || 'manual') + '</td>'
        + '<td>' + (r.expiresAt ? fmtTime(r.expiresAt) : '\u2013') + '</td>'
        + '<td class="num">' + (r.openTickets || 0) + '</td>'
        + '<td class="num">' + (r.orders || 0) + '</td>'
        + '<td>' + fmtTime(r.lastActivity) + '</td>'
        + '<td>' + esc(r.note || '') + '</td>'
        + '<td class="acts"><button class="desk-btn-plain danger"' + grantDis()
        + ' onclick="DESK.accRevokeOne(\'' + esc(r.phone) + '\')">Remove</button></td></tr>';
    });
    return html + '</table></div>';
  }

  function accVisibleRows() {
    return S.accessSection === 'roster' ? accListFiltered() : (S.accessRows || []);
  }

  // ---------- Policy ----------
  function accessPolicyHtml() {
    var p = (S.access && S.access.policy) || {};
    var html = isAdmin() ? '' : '<div class="desk-ro-note">Read-only \u2014 the access policy is reserved for the master admin.</div>';
    html += '<div class="desk-set-sub">Everything here applies to the next grant, plus the two dormancy/auto-grant windows used by the segments. Changes land within a minute for everyone already signed in.</div>';
    html += '<div class="desk-form-grid">'
      + '<div><label>Default access level</label><select id="ApDefaultLevel">'
      + '<option value="full"' + (p.defaultLevel === 'view' ? '' : ' selected') + '>Full \u2014 can raise tickets</option>'
      + '<option value="view"' + (p.defaultLevel === 'view' ? ' selected' : '') + '>Read-only</option></select></div>'
      + '<div><label>Default length (days, 0 = never)</label><input id="ApDefaultDays" type="number" min="0" value="' + (p.defaultDays || 0) + '"></div>'
      + '<div><label>Dormancy window (days)</label><input id="ApDormantDays" type="number" min="0" value="' + (p.dormantRevokeDays || 0) + '"></div>'
      + '<div><label>Auto-grant channel</label><select id="ApAutoGrantChannel">'
      + '<option value="website"' + (p.autoGrantChannel === 'any' ? '' : ' selected') + '>Website tickets only</option>'
      + '<option value="any"' + (p.autoGrantChannel === 'any' ? ' selected' : '') + '>Tickets from any channel</option></select></div>'
      + '</div>';
    html += '<div class="desk-set-sec">Rules</div>';
    ACC_TOGGLES.forEach(function (t) {
      html += '<label class="desk-acc-toggle"><input id="Ap' + t[0] + '" type="checkbox"' + (p[t[0]] ? ' checked' : '')
        + (isAdmin() ? '' : ' disabled') + '><span><b>' + t[1] + '</b><em>' + t[2] + '</em></span></label>';
    });
    html += '<div style="margin-top:14px"><button class="desk-btn"' + adminOnly() + ' onclick="DESK.saveAccessPolicy()">Save policy</button></div>';
    return html;
  }

  // ---------- loaders ----------
  function paintAccess() {
    var el = $('AccRoot');
    if (el && S.modal && S.modal.tab === 'whitelist') el.innerHTML = accessHtml();
  }
  function accFill() {
    if (!S.access) return;
    if (S.accessSection === 'roster') loadAccessRoster();
    else if (S.accessSection === 'segments') loadAccPreview(S.accessRowsFor !== S.accessSegment);
  }
  function loadAccessTab() {
    if (S.access) { accFill(); refreshAccessCounts(); return; }
    api('/api/support/admin/access/overview').then(function (d) {
      S.access = d;
      paintAccess();
      accFill();
    }).catch(function (e) {
      var el = $('AccRoot');
      if (el) el.innerHTML = '<div class="desk-set-sub">' + esc(e.message) + '</div>';
    });
  }
  // Re-opening the tab repaints from cache instantly, then corrects the numbers
  // in the background: another agent may have granted or cleaned up meanwhile.
  function refreshAccessCounts() {
    api('/api/support/admin/access/overview').then(function (d) {
      if (!S.modal || S.modal.tab !== 'whitelist') return;
      var act = document.activeElement;
      // never stomp on a half-typed search or filter
      if (act && /^Acc|^Ap/.test(String(act.id || ''))) return;
      S.access = d;
      // The policy form is all inputs, so a silent repaint would throw away
      // unsaved edits; it refreshes on the next real navigation instead.
      if (S.accessSection !== 'policy') paintAccess();
    }).catch(function () {});
  }
  function reloadAccess() {
    S.access = null; S.accessList = null; S.accessRows = null; S.accessRowsFor = '';
    paintAccess();
    loadAccessTab();
  }
  function setAccessSection(sec) { S.accessSection = sec; paintAccess(); accFill(); }
  function accJump(id) {
    S.accessSection = 'segments';
    S.accessSegment = id;
    S.accessOffset = 0;
    paintAccess();
    loadAccPreview(true);
  }
  function accApplyFilter() {
    S.accessFilter.q = (($('AccQ') || {}).value || '').trim();
    S.accessFilter.roster = ($('AccRoster') || {}).value || '';
    S.accessOffset = 0;
    loadAccPreview(true);
  }
  function accPage(dir) {
    var lim = Number(S.accessFilter.limit) || 200;
    S.accessOffset = Math.max(0, (Number(S.accessOffset) || 0) + dir * lim);
    loadAccPreview(true);
  }
  function loadAccPreview(force) {
    var host = $('AccPreview');
    if (!host || !S.access) return;
    if (!force && S.accessRowsFor === S.accessSegment) { host.innerHTML = accPreviewHtml(); return; }
    var seg = accSeg(S.accessSegment);
    host.innerHTML = '<div class="desk-acc-preview"><div class="desk-acc-phead"><div><b>' + esc(seg ? seg.label : S.accessSegment)
      + '</b><span>' + accNum(seg ? seg.count : 0) + ' customers match</span></div></div>'
      + '<div class="desk-loading"><span class="desk-spin"></span>Loading\u2026</div></div>';
    var f = S.accessFilter;
    var want = S.accessSegment;
    var url = '/api/support/admin/access/candidates?segment=' + encodeURIComponent(want)
      + '&limit=' + (Number(f.limit) || 200) + '&offset=' + (Number(S.accessOffset) || 0)
      + (f.q ? '&q=' + encodeURIComponent(f.q) : '')
      + (f.roster ? '&roster=' + encodeURIComponent(f.roster) : '');
    api(url).then(function (d) {
      if (S.accessSegment !== want) return;   // a newer preview won the race
      S.accessRows = d.rows || [];
      S.accessRowsFor = want;
      var h = $('AccPreview');
      if (h && S.modal && S.modal.tab === 'whitelist' && S.accessSection === 'segments') h.innerHTML = accPreviewHtml();
    }).catch(function (e) {
      var h = $('AccPreview');
      if (h && S.accessSegment === want) h.innerHTML = '<div class="desk-set-sub">' + esc(e.message) + '</div>';
    });
  }
  function loadAccessRoster(force) {
    if (force) { S.accessList = null; S.accessListError = ''; }
    accPaintRoster();
    if (S.accessList !== null) return;
    var p = (S.access && S.access.policy) || {};
    var url = '/api/support/admin/access/roster?limit=2000'
      + (S.accessListFilter.dormant ? '&dormantDays=' + (Number(p.dormantRevokeDays) || 90) : '');
    api(url).then(function (d) {
      S.accessList = d.rows || [];
      if (S.modal && S.modal.tab === 'whitelist' && S.accessSection === 'roster') accPaintRoster();
    }).catch(function (e) {
      S.accessList = [];
      S.accessListError = e.message;
      accPaintRoster();
    });
  }
  function accPaintRoster() {
    var el = $('AccRosterTable');
    if (el) el.innerHTML = accRosterTableHtml();
  }
  function accListDormant(on) { S.accessListFilter.dormant = !!on; loadAccessRoster(true); }
  function accListSearch() {
    S.accessListFilter.q = (($('AccRq') || {}).value || '').trim();
    accPaintRoster();
  }
  function accListView(v) {
    S.accessListFilter.view = v;
    accPaintRoster();
  }

  // ---------- mutations ----------
  // One status line plus one toast per action: the tab re-renders from the
  // server afterwards, so nothing here patches rows by hand.
  function accRun(p, onDone) {
    var bar = $('AccStatus');
    if (bar) bar.textContent = 'Working\u2026';
    return p.then(onDone)
      .catch(function (e) { toast(e.message, true); })
      .then(function () { var b = $('AccStatus'); if (b) b.textContent = ''; });
  }
  function accBody(extra) {
    var o = accOpts();
    var body = { level: o.level, days: o.days, note: o.note, sync: o.sync, announce: o.announce };
    for (var k in (extra || {})) { if (extra.hasOwnProperty(k)) body[k] = extra[k]; }
    return body;
  }
  function accWritten() {
    S.accessSel = {};
    S.accessList = null; S.accessListError = '';
    S.accessRows = null; S.accessRowsFor = '';
    return api('/api/support/admin/access/overview').then(function (d) {
      S.access = d;
      paintAccess();
      accFill();
    }).catch(function (e) {
      toast(e.message, true);
      paintAccess();
    });
  }
  function accGrantDone(r) {
    var bits = [accNum((r.granted || 0) + (r.updated || 0)) + ' allowed'];
    if (r.invalid && r.invalid.length) bits.push(accNum(r.invalid.length) + ' invalid skipped');
    if (r.skipped && r.skipped.length) bits.push(accNum(r.skipped.length) + ' unknown skipped');
    if (r.sync) bits.push(accNum(r.sync.orders) + ' orders pulled');
    if (r.announce) {
      if (r.announce.queued) bits.push('intro queued for ' + accNum(r.announce.queued) + (r.announce.capped ? ' (capped \u2014 use Send intro for the rest)' : ''));
      else if (r.announce.error) bits.push('intro failed: ' + r.announce.error);
    }
    if (r.schemaLimited) bits.push('level/expiry need the new columns');
    toast(bits.join(' \u00b7 '));
    accWritten();
  }
  function accGrantUrl() { return '/api/support/admin/access/grant'; }

  function accGrantSegment(id) {
    var seg = accSeg(id);
    if (!seg) return;
    if (!window.confirm('Give support access to all ' + accNum(seg.count) + ' customers in \u201c' + seg.label + '\u201d?')) return;
    accRun(api(accGrantUrl(), { method: 'POST', body: accBody({ segment: id }) }), accGrantDone);
  }
  function accSelGrant() {
    var phones = accNeedSel();
    if (!phones) return;
    accRun(api(accGrantUrl(), { method: 'POST', body: accBody({ phones: phones }) }), accGrantDone);
  }
  function accAddOne() {
    var ph = window.prompt('Number to allow (10 digits, or 91XXXXXXXXXX):');
    if (!ph || !ph.trim()) return;
    ph = ph.trim();
    // Single adds always get the intro offered explicitly: the options-bar
    // checkbox already says yes when ticked, otherwise this prompt decides
    // for just this number (a "no" here must not uncheck the bar).
    var intro = accOpts().announce || window.confirm('Send the Support Desk intro WhatsApp message to ' + ph + ' as well?');
    accRun(api(accGrantUrl(), { method: 'POST', body: accBody({ phones: [ph], announce: intro }) }), accGrantDone);
  }
  function accImport() {
    var ta = $('AccImport');
    var text = ((ta || {}).value || '').trim();
    if (!text) return toast('Paste some numbers first', true);
    accRun(api('/api/support/admin/access/import', { method: 'POST', body: accBody({ text: text }) }), function (r) {
      if (ta) ta.value = '';
      accGrantDone(r);
    });
  }
  // Re-point the list at one segment: everyone outside it loses access, so
  // this stays master-admin only and asks twice over.
  function accAllowOnly(id) {
    var seg = accSeg(id);
    if (!seg) return;
    if (!window.confirm('Replace the whole access list with \u201c' + seg.label + '\u201d?\n\nAnyone currently allowed who is NOT in this segment loses the Help & Tickets tab immediately.')) return;
    accRun(api('/api/support/admin/access/sync-to-segment', { method: 'POST', body: { segment: id, note: accOpts().note } }), function (r) {
      toast('List re-pointed: ' + accNum(r.granted) + ' added, ' + accNum(r.revoked) + ' removed');
      accWritten();
    });
  }
  function accSelRevoke() {
    var phones = accNeedSel();
    if (!phones) return;
    if (!window.confirm('Revoke access for ' + phones.length + ' numbers? Their cached orders are dropped too.')) return;
    accRun(api('/api/support/admin/access/revoke', { method: 'POST', body: { phones: phones } }), function (r) {
      toast(accNum(r.revoked) + ' revoked');
      accWritten();
    });
  }
  function accRevokeOne(ph) {
    if (!window.confirm('Revoke access for ' + ph + '?')) return;
    accRun(api('/api/support/admin/access/revoke', { method: 'POST', body: { phones: [ph] } }), function (r) {
      toast(accNum(r.revoked) + ' revoked');
      accWritten();
    });
  }
  function accClearAll() {
    if (!window.confirm('Revoke ALL support access? Every customer loses the Help & Tickets tab until they are added back.')) return;
    accRun(api('/api/support/admin/access/revoke', { method: 'POST', body: { all: true } }), function (r) {
      toast(accNum(r.revoked) + ' revoked');
      accWritten();
    });
  }
  function accSelLevel(level) {
    var phones = accNeedSel();
    if (!phones) return;
    accRun(api('/api/support/admin/access/update', { method: 'POST', body: { phones: phones, level: level } }), function (r) {
      toast(accNum(r.updated) + ' set to ' + (level === 'view' ? 'read-only' : 'full access'));
      accWritten();
    });
  }
  function accSelExpiry() {
    var phones = accNeedSel();
    if (!phones) return;
    var v = window.prompt('Access expires after how many days? (0 = never)', String((S.access.policy || {}).defaultDays || 0));
    if (v === null) return;
    accRun(api('/api/support/admin/access/update', { method: 'POST', body: { phones: phones, days: Number(v) || 0 } }), function (r) {
      toast(accNum(r.updated) + ' updated');
      accWritten();
    });
  }
  function accSelResync() {
    var phones = accNeedSel();
    if (!phones) return;
    accRun(api('/api/support/admin/access/resync', { method: 'POST', body: { phones: phones } }), function (r) {
      toast(accNum(r.orders) + ' orders pulled for ' + accNum(r.synced) + ' customers'
        + (r.failed ? ', ' + accNum(r.failed) + ' failed' : '')
        + (r.capped ? ' (capped \u2014 run again for the rest)' : ''));
    });
  }
  // WhatsApp the approved Support Desk intro to the ticked numbers without
  // touching access itself \u2014 the sends ride the shared broadcast queue.
  function accSelAnnounce() {
    var phones = accNeedSel();
    if (!phones) return;
    if (!window.confirm('Send the Support Desk intro WhatsApp message to ' + accNum(phones.length) + ' selected numbers?')) return;
    accRun(api('/api/support/admin/access/announce', { method: 'POST', body: { phones: phones } }), function (r) {
      if (r.queued) toast('Intro queued for ' + accNum(r.queued) + (r.capped ? ' (capped \u2014 run again for the rest)' : ''));
      else toast(r.error || 'Nothing queued', true);
    });
  }
  function accCleanup(kind) {
    var labels = {
      expired: 'the expired grants', invalid: 'the numbers that are not valid Indian mobiles',
      dormant: 'the grants with no order or ticket inside the dormancy window',
      unknown: 'the numbers that match no known customer',
      duplicates: 'the duplicate spellings of the same number'
    };
    var body = { kind: kind };
    if (kind === 'dormant') {
      var v = window.prompt('Revoke anyone inactive for more than how many days?', String((S.access.policy || {}).dormantRevokeDays || 90));
      if (v === null) return;
      body.days = Number(v) || 0;
    }
    if (!window.confirm('Remove ' + (labels[kind] || kind) + ' from the access list?')) return;
    accRun(api('/api/support/admin/access/cleanup', { method: 'POST', body: body }), function (r) {
      toast(accNum(r.removed) + ' removed');
      accWritten();
    });
  }

  // ---------- selection ----------
  function accPick(ph, on) {
    if (on) S.accessSel[ph] = true; else delete S.accessSel[ph];
    var el = $('AccSelN');
    if (el) el.textContent = accSelected().length;
  }
  function accPickAll(on) {
    accVisibleRows().forEach(function (r) { if (on) S.accessSel[r.phone] = true; else delete S.accessSel[r.phone]; });
    var boxes = document.querySelectorAll('#AccessBody input[data-ph]');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = !!S.accessSel[boxes[i].getAttribute('data-ph')];
    }
    var n = $('AccSelN');
    if (n) n.textContent = accSelected().length;
  }
  function accClearSel() {
    S.accessSel = {};
    accPickAll(false);
  }

  // ---------- export ----------
  function accExport() {
    var sel = accSelected();
    var src = accVisibleRows();
    var rows = sel.length ? src.filter(function (r) { return !!S.accessSel[r.phone]; }) : src;
    if (!rows.length) return toast('Nothing to export', true);
    var out = ['phone,name,level,expires_at,source,note,live_tickets,total_tickets,orders,last_activity'];
    rows.forEach(function (r) {
      out.push([r.phone, r.name || '', r.level || 'full', r.expiresAt ? new Date(r.expiresAt).toISOString() : '',
        r.source || r.grantSource || '', r.note || '', r.openTickets || 0, r.totalTickets || 0, r.orders || 0,
        r.lastActivity ? new Date(r.lastActivity).toISOString() : '']
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    });
    accDownload('support-access-' + (S.accessSection === 'roster' ? 'list' : S.accessSegment) + '.csv', out.join('\r\n'));
    toast('Exported ' + accNum(rows.length) + ' rows');
  }
  function accDownload(name, text) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) { toast('The browser blocked the download', true); }
  }

  // ---------- policy writes ----------
  function setAccessMode(m) {
    var value = {};
    var p = S.access.policy || {};
    for (var k in p) { if (p.hasOwnProperty(k)) value[k] = p[k]; }
    value.mode = m;
    accRun(api('/api/support/admin/access/policy', { method: 'PUT', body: { value: value } }), function (r) {
      if (r && r.policy) S.access.policy = r.policy;
      var def = null;
      ACC_MODES.forEach(function (x) { if (x[0] === m) def = x; });
      toast('Access mode: ' + (def ? def[1] : m));
      accWritten();
    });
  }
  function saveAccessPolicy() {
    var value = {
      defaultLevel: (($('ApDefaultLevel') || {}).value) || 'full',
      defaultDays: Number(($('ApDefaultDays') || {}).value) || 0,
      dormantRevokeDays: Number(($('ApDormantDays') || {}).value) || 0,
      autoGrantChannel: (($('ApAutoGrantChannel') || {}).value) || 'website'
    };
    ACC_TOGGLES.forEach(function (t) { value[t[0]] = !!($('Ap' + t[0]) || {}).checked; });
    accRun(api('/api/support/admin/access/policy', { method: 'PUT', body: { value: value } }), function (r) {
      if (r && r.policy) S.access.policy = r.policy;
      toast('Access policy saved');
      accWritten();
    });
  }

  function saveSla() {
    api('/api/support/admin/settings/sla', { method: 'PUT', body: { value: {
      high_hours: Number(($('SlaHigh') || {}).value) || 4,
      normal_hours: Number(($('SlaNormal') || {}).value) || 12
    } } }).then(function () { toast('SLA saved'); loadSettings(); }).catch(function (e) { toast(e.message, true); });
  }
  function collectTeams() {
    var out = {};
    document.querySelectorAll('#TeamList [data-v]').forEach(function (inp) {
      var k = inp.getAttribute('data-k'), v = inp.value.trim();
      if (k && v) out[k] = v;
    });
    var nk = ($('NewTeamKey') || {}).value, nl = ($('NewTeamLabel') || {}).value;
    if (nk && nl) out[nk.trim()] = nl.trim();
    return out;
  }
  function saveTeams() {
    api('/api/support/admin/settings/teams', { method: 'PUT', body: { value: collectTeams() } })
      .then(function () { toast('Teams saved'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function addTeam() { /* handled inside saveTeams via NewTeam inputs */ toast('Fill key + label, then Save teams'); }
  function delTeam(k) {
    var out = collectTeams();
    delete out[k];
    api('/api/support/admin/settings/teams', { method: 'PUT', body: { value: out } })
      .then(function () { return loadSettings(); }).then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function collectCanned() {
    var out = [];
    document.querySelectorAll('#CannedList .desk-set-item').forEach(function (item) {
      var rec = {};
      item.querySelectorAll('[data-f]').forEach(function (inp) { rec[inp.getAttribute('data-f')] = inp.value; });
      var ta = item.querySelector('textarea[data-f="text"]') || item.querySelector('textarea');
      if (ta) rec.text = ta.value;
      if (rec.key && rec.label) out.push(rec);
    });
    return out;
  }
  function addCanned() {
    S.settings.canned.push({ key: 'reply_' + Date.now(), label: 'New reply', text: '', mode: 'reply' });
    renderSettingsTab();
  }
  function delCanned(i) {
    S.settings.canned.splice(i, 1);
    renderSettingsTab();
  }
  function saveCanned() {
    api('/api/support/admin/settings/canned_responses', { method: 'PUT', body: { value: collectCanned() } })
      .then(function () { toast('Saved replies updated'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function saveTemplates() {
    var out = {};
    document.querySelectorAll('#TplList textarea[data-k]').forEach(function (ta) {
      out[ta.getAttribute('data-k')] = ta.value;
    });
    api('/api/support/admin/settings/resolution_templates', { method: 'PUT', body: { value: out } })
      .then(function () { toast('Templates saved'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function saveCost() {
    var v = {
      fwd_ship: Number(($('CfFwdShip') || {}).value) || 75,
      rto_ship: Number(($('CfRtoShip') || {}).value) || 75,
      reverse_pickup: Number(($('CfRevPickup') || {}).value) || 90,
      packing: Number(($('CfPacking') || {}).value) || 20,
      cod_fee: Number(($('CfCodFee') || {}).value) || 35,
      rto_rate_cod: Number(($('CfRtoRateCod') || {}).value) || 0.25,
      rto_rate_prepaid: Number(($('CfRtoRatePre') || {}).value) || 0.05,
      high_value: Number(($('CfHighValue') || {}).value) || 2500,
      return_window_days: Number(($('CfReturnWindow') || {}).value) || 7,
      dnr_report_days: Number(($('CfDnrDays') || {}).value) || 3
    };
    api('/api/support/admin/settings/cost_config', { method: 'PUT', body: { value: v } })
      .then(function () { toast('Cost config saved'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function closeModal() {
    var m = $('DeskModal');
    if (m) {
      if (m._escHandler) document.removeEventListener('keydown', m._escHandler);
      m.remove();
    }
    S.modal = null;
  }
  function syncOrders() {
    toast('Syncing orders for whitelisted customers\u2026');
    api('/api/support/admin/order-cache/sync', { method: 'POST', body: {} })
      .then(function (r) { toast('Sync done: ' + (r.customers || 0) + ' customers processed'); })
      .catch(function (e) { toast(e.message, true); });
  }
  // ---------- fullscreen photo viewer (tap a photo, page through the batch) ----------
  // Groups are registered while the thread renders, so the registry resets with
  // every conversation re-render and can never outgrow one ticket.
  var MEDIA_GROUPS = [];
  function registerMediaGroup(urls) {
    MEDIA_GROUPS.push(urls.filter(Boolean));
    return MEDIA_GROUPS.length - 1;
  }

  function openViewer(gid, pos) {
    var group = (MEDIA_GROUPS[gid] || []);
    if (!group.length) return;
    var i = Math.max(0, Math.min(group.length - 1, Number(pos) || 0));
    var lb = document.createElement('div');
    lb.className = 'desk-lightbox';
    function closeLb() {
      document.removeEventListener('keydown', onLbKey);
      lb.remove();
    }
    function onLbKey(e) {
      if (e.key === 'Escape') { closeLb(); }
      else if (group.length > 1 && e.key === 'ArrowRight') { i = (i + 1) % group.length; paint(); }
      else if (group.length > 1 && e.key === 'ArrowLeft') { i = (i - 1 + group.length) % group.length; paint(); }
    }
    function paint() {
      lb.innerHTML = '<img src="' + esc(group[i]) + '" alt="photo">'
        + '<button class="desk-lb-x" aria-label="Close">&times;</button>'
        + (group.length > 1 ? '<button class="desk-lb-nav prev" aria-label="Previous photo">&#8249;</button>'
          + '<button class="desk-lb-nav next" aria-label="Next photo">&#8250;</button>'
          + '<div class="desk-lb-count">' + (i + 1) + ' / ' + group.length + '</div>' : '');
      var x = lb.querySelector('.desk-lb-x');
      if (x) x.onclick = function (e) { e.stopPropagation(); closeLb(); };
      var p = lb.querySelector('.desk-lb-nav.prev');
      if (p) p.onclick = function (e) { e.stopPropagation(); i = (i - 1 + group.length) % group.length; paint(); };
      var nx = lb.querySelector('.desk-lb-nav.next');
      if (nx) nx.onclick = function (e) { e.stopPropagation(); i = (i + 1) % group.length; paint(); };
    }
    lb.onclick = closeLb;   // click the backdrop to dismiss
    document.addEventListener('keydown', onLbKey);
    paint();
    document.body.appendChild(lb);
  }

  function lightbox(url) {
    openViewer(registerMediaGroup([url]), 0);
  }

  // ============================================================
  // Portal engine tabs — the desk mirror of the Command dashboard.
  // Reads go to /api/admin/support-portals (same JWT). Mutations
  // are master-admin only server-side; non-admins get a read-only
  // rendering (controls hidden or disabled).
  // ============================================================
  function roNote() {
    return isAdmin() ? '' : '<div class="desk-ro-note">Read-only \u2014 portal changes and ticket distribution are reserved for the master admin.</div>';
  }
  function fmtShiftRange(start, end) {
    if (!start || !end) return '\u2013';
    return String(start) + '\u2013' + String(end);
  }
  function portalShift(p) {
    var c = p.config || {};
    if (p.type === 'time_based' && (c.time_start || c.time_end)) return fmtShiftRange(c.time_start, c.time_end);
    return fmtShiftRange(p.shift_start, p.shift_end);
  }
  function utilCell(p) {
    var open = Number(p.assigned_count || 0), max = Number(p.max_tickets || 0);
    if (!max) return '<span class="num">' + open + '</span>';
    var pct = Math.min(100, Math.round(open / max * 100));
    return '<div class="desk-util"><span class="track"><i style="width:' + pct + '%' + (pct >= 100 ? ';background:var(--desk-red)' : '') + '"></i></span><span>' + open + '/' + max + '</span></div>';
  }
  function copyText(t) {
    if (!navigator.clipboard) return toast('Clipboard unavailable', true);
    navigator.clipboard.writeText(String(t)).then(function () { toast('Copied'); });
  }
  function portalOptions(list) {
    if (!list.length) return '<option value="">no portals yet</option>';
    return list.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) + ' (' + (p.assigned_count || 0) + ' open)</option>';
    }).join('');
  }

  // ---------- Portals & Shifts tab ----------
  function portalsHtml() {
    var ps = S.portals || [], sh = S.activeShifts || {};
    var live = (sh.activePortals || []).map(function (p) { return esc(p.name); });
    var pr = S.settings.portalRouting || {};
    var html = roNote();
    html += '<div class="desk-kv"><span class="k">Live shift</span><span class="v">' + (sh.currentTime ? esc(sh.currentTime) + ' server time \u00b7 ' : '') + (live.length ? live.join(', ') : 'no auto-shift portals live right now') + '</span></div>'
      + '<div class="desk-kv"><span class="k">Auto-pilot</span><span class="v">' + (pr.enabled ? 'ON \u2014 new tickets route to the least-loaded live portal' : 'OFF \u2014 manage it in the Distribution tab') + '</span></div>';
    if (isAdmin()) {
      html += '<div class="desk-set-sec">New portal</div><div class="desk-form-grid">'
        + '<div><label>Name</label><input id="PNewName" placeholder="Morning Desk"></div>'
        + '<div><label>Type</label><select id="PNewType"><option value="time_based">Shift (time-based)</option><option value="auto">Auto (distributed)</option><option value="manual">Manual</option></select></div>'
        + '<div><label>Shift start</label><input id="PNewStart" type="time" value="09:00"></div>'
        + '<div><label>Shift end</label><input id="PNewEnd" type="time" value="17:00"></div>'
        + '<div><label>Password (optional)</label><input id="PNewPass" placeholder="auto-generated"></div>'
        + '</div><div style="margin-top:8px"><button class="desk-btn" onclick="DESK.portalCreate()">Create portal</button></div>';
    }
    html += '<div class="desk-set-sec">Portals (' + ps.length + ')</div><div class="desk-tblwrap"><table class="desk-tbl"><tr><th>Portal</th><th>Type</th><th>Shift</th><th class="num">Open</th><th class="num">Total</th><th>Load</th><th>Live</th><th></th></tr>';
    ps.forEach(function (p) {
      var actions = isAdmin()
        ? '<button class="desk-btn-plain" onclick="DESK.portalSplit(' + p.id + ')">Split</button>'
          + '<button class="desk-btn-plain" onclick="DESK.portalMax(' + p.id + ')">Cap</button>'
          + '<button class="desk-btn-plain" onclick="DESK.portalShiftEdit(' + p.id + ')">Shift</button>'
          + '<button class="desk-btn-plain" onclick="DESK.portalPass(' + p.id + ')">Pwd</button>'
          + '<button class="desk-btn-plain" onclick="DESK.portalClear(' + p.id + ')">Clear</button>'
          + '<button class="desk-btn-plain danger" onclick="DESK.portalDelete(' + p.id + ')">Del</button>'
        : '';
      html += '<tr>'
        + '<td><a href="' + esc(p.url || ('/portal/support/?slug=' + p.slug)) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a></td>'
        + '<td><span class="desk-tag">' + esc(p.type) + '</span></td>'
        + '<td>' + esc(portalShift(p)) + '</td>'
        + '<td class="num">' + (p.assigned_count || 0) + '</td>'
        + '<td class="num">' + (p.ticket_count || 0) + '</td>'
        + '<td>' + utilCell(p) + '</td>'
        + '<td><input type="checkbox"' + (p.is_active ? ' checked' : '') + dis() + ' onchange="DESK.portalActive(' + p.id + ',this.checked)"></td>'
        + '<td class="acts">' + actions + '</td></tr>';
    });
    html += '</table></div>' + (ps.length ? '' : '<div class="desk-set-sub">No portals yet \u2014 create one above or run a distribution from the Distribution tab.</div>');
    html += '<div id="PortalResult"></div>';
    return html;
  }
  function loadPortalsTab() {
    var el = $('PortalsBody');
    if (!el) return;
    el.innerHTML = '<div class="desk-loading"><span class="desk-spin"></span>Loading portals\u2026</div>';
    Promise.all([
      adminApi('/support-portals'),
      adminApi('/support-portals/active-shifts').catch(function () { return {}; })
    ]).then(function (res) {
      S.portals = res[0].portals || [];
      S.activeShifts = res[1] || {};
      el.innerHTML = portalsHtml();
    }).catch(function (e) { el.innerHTML = '<div class="desk-set-sub">' + esc(e.message) + '</div>'; });
  }
  function ensurePortals(cb) {
    if (S.portals) { cb(); return; }
    adminApi('/support-portals').then(function (d) { S.portals = d.portals || []; cb(); }).catch(function (e) { toast(e.message, true); });
  }
  function portalResult(html) { var el = $('PortalResult'); if (el) el.innerHTML = html; }
  function createdPortalsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="desk-set-sec">New portals</div>' + list.map(function (p) {
      return '<div class="desk-set-item"><b>' + esc(p.name) + '</b> \u00b7 ' + (p.ticketCount || 0) + ' tickets \u00b7 <a href="' + esc(p.url) + '" target="_blank" rel="noopener">open link</a>' + (p.password ? ' \u00b7 pw <code>' + esc(p.password) + '</code> <button class="desk-btn-plain" onclick="DESK.copyText(\'' + p.password + '\')">Copy</button>' : '') + '</div>';
    }).join('');
  }
  function portalCreate() {
    var name = (($('PNewName') || {}).value || '').trim();
    if (!name) return toast('Portal name required', true);
    var type = ($('PNewType') || {}).value || 'time_based';
    var body = { name: name, type: type };
    var pw = (($('PNewPass') || {}).value || '').trim();
    if (pw) body.password = pw;
    var st = ($('PNewStart') || {}).value, en = ($('PNewEnd') || {}).value;
    if (type !== 'manual' && st && en) body.config = { time_start: st, time_end: en, timezone: 'Asia/Kolkata' };
    adminApi('/support-portals', { method: 'POST', body: body }).then(function (d) {
      toast('Portal created');
      S.portals = null; S.activeShifts = null;
      loadPortalsTab();
      portalResult('<div class="desk-set-item"><b>' + esc(d.portal.name) + '</b> \u00b7 <a href="' + esc(d.url) + '" target="_blank" rel="noopener">open link</a> \u00b7 pw <code>' + esc(d.password) + '</code> <button class="desk-btn-plain" onclick="DESK.copyText(\'' + d.password + '\')">Copy</button> \u2014 share both with the agent.</div>');
    }).catch(function (e) { toast(e.message, true); });
  }
  function portalActive(id, on) {
    adminApi('/support-portals/' + id + '/update-rules', { method: 'POST', body: { isActive: on } })
      .then(function () { toast(on ? 'Portal is live' : 'Portal paused'); })
      .catch(function (e) { toast(e.message, true); S.portals = null; loadPortalsTab(); });
  }
  function portalMax(id) {
    var v = window.prompt('Max open tickets for this portal (blank = unlimited):');
    if (v === null) return;
    var body = {};
    if (String(v).trim()) {
      var n = Number(v);
      if (!Number.isFinite(n) || n < 0) return toast('Enter a number', true);
      body.maxTickets = n;
    } else body.maxTickets = null;
    adminApi('/support-portals/' + id + '/update-rules', { method: 'POST', body: body })
      .then(function () { toast('Capacity saved'); S.portals = null; loadPortalsTab(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function portalShiftEdit(id) {
    var v = window.prompt('Shift window (HH:MM-HH:MM, overnight ok \u2014 e.g. 17:00-01:00):');
    if (!v) return;
    var m = String(v).trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!m) return toast('Use HH:MM-HH:MM', true);
    adminApi('/support-portals/' + id, { method: 'PUT', body: { config: { time_start: m[1], time_end: m[2], timezone: 'Asia/Kolkata' } } })
      .then(function () { return adminApi('/support-portals/' + id + '/update-rules', { method: 'POST', body: { shiftStart: m[1], shiftEnd: m[2] } }); })
      .then(function () { toast('Shift window saved'); S.portals = null; S.activeShifts = null; loadPortalsTab(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function portalPass(id) {
    adminApi('/support-portals/' + id + '/password').then(function (d) {
      if (!d.password) return toast('Password not stored \u2014 set a new one first', true);
      portalResult('<div class="desk-set-item">Portal password: <code>' + esc(d.password) + '</code> <button class="desk-btn-plain" onclick="DESK.copyText(\'' + d.password + '\')">Copy</button></div>');
    }).catch(function (e) { toast(e.message, true); });
  }
  function portalSplit(id) {
    var v = window.prompt('Split this portal\u2019s open tickets across how many new portals? (2-10)');
    if (!v) return;
    var count = Number(v);
    if (!count || count < 2 || count > 10) return toast('Pick a number between 2 and 10', true);
    adminApi('/support-portals/' + id + '/split', { method: 'POST', body: { count: count, onlyOpen: true } }).then(function (d) {
      toast(d.message || 'Split done');
      S.portals = null; S.activeShifts = null; S.distStats = null;
      loadPortalsTab();
      portalResult(createdPortalsHtml(d.portals));
    }).catch(function (e) { toast(e.message, true); });
  }
  function portalClear(id) {
    if (!window.confirm('Unassign every ticket from this portal? They move to the unassigned pool.')) return;
    adminApi('/support-portals/' + id + '/clear', { method: 'POST', body: {} })
      .then(function () { toast('Tickets cleared from portal'); S.portals = null; loadPortalsTab(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function portalDelete(id) {
    if (!window.confirm('Delete this portal? Its tickets fall back to Unassigned.')) return;
    adminApi('/support-portals/' + id, { method: 'DELETE' })
      .then(function () { toast('Portal deleted'); S.portals = null; S.activeShifts = null; loadPortalsTab(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- Distribution tab ----------
  function distributeHtml() {
    var all = S.portals || [];
    var dynamic = all.filter(function (p) { return p.type !== 'manual'; });
    var pr = S.settings.portalRouting || {};
    // The server routes when the setting row has never been saved, so an absent
    // value reads as ON here too — otherwise the box lies about live traffic.
    var apOn = pr.enabled !== false;
    var html = roNote();
    html += '<div class="desk-set-sec">Auto-pilot for new tickets</div>'
      + '<div class="desk-set-sub">On by default. Every new website ticket is stamped with the live shift portal that has the fewest open tickets (caps respected, IST windows) \u2014 the same way WhatsApp and widget tickets are handed out. Only manual portals and tickets raised outside every window stay unassigned for manual distribution.</div>'
      + '<label class="desk-check"><input type="checkbox" id="ApEnabled"' + (apOn ? ' checked' : '') + dis() + '> Route new tickets automatically</label>'
      + '<div style="margin-top:8px"><button class="desk-btn" onclick="DESK.saveAutopilot()"' + (isAdmin() ? '' : ' disabled') + '>Save auto-pilot</button></div>';
    html += '<div class="desk-set-sec">Create portals &amp; distribute open tickets</div><div class="desk-form-grid">'
      + '<div><label>Mode</label><select id="DistMode" onchange="DESK.distMode()"><option value="round_robin">Round robin \u2014 N new portals</option><option value="workload_balanced">Least load \u2014 N new portals</option><option value="shift_based">By shift windows</option><option value="filter_based">Filtered slice \u2014 round robin</option></select></div>'
      + '<div id="DistCountWrap"><label>Portals (2-20)</label><input id="DistCount" type="number" min="2" max="20" value="2"></div>'
      + '<div><label>Name prefix</label><input id="DistPrefix" placeholder="Agent"></div>'
      + '<div><label>Max per portal</label><input id="DistMax" type="number" min="1" placeholder="unlimited"></div>'
      + '<div><label>From date</label><input id="DistFrom" type="date"></div>'
      + '<div><label>To date</label><input id="DistTo" type="date"></div>'
      + '<div><label>Time from</label><input id="DistTFrom" type="time"></div>'
      + '<div><label>Time to</label><input id="DistTTo" type="time"></div>'
      + '</div><div id="ShiftRows"></div>'
      + '<div style="margin-top:10px"><button class="desk-btn" onclick="DESK.runDistribute()"' + (isAdmin() ? '' : ' disabled') + '>Distribute now</button></div>'
      + '<div id="DistResult"></div>';
    html += '<div class="desk-set-sec">Rebalance across existing portals</div>'
      + '<div class="desk-filters"><select id="RbScope" onchange="var p=document.getElementById(\'RbPick\');if(p)p.style.display=this.value===\'custom\'?\'\':\'none\'">'
      + '<option value="">All auto &amp; shift portals</option><option value="morning">Morning window (09-17)</option><option value="evening">Evening window (17-21)</option>'
      + (dynamic.length > 1 ? '<option value="custom">Choose portals\u2026</option>' : '') + '</select></div>'
      + '<div id="RbPick" style="display:none">' + dynamic.map(function (p) {
          return '<label class="desk-check"><input type="checkbox" value="' + p.id + '" data-rb> ' + esc(p.name) + ' (' + (p.assigned_count || 0) + ')</label>';
        }).join('') + '</div>'
      + '<div style="margin-top:8px"><button class="desk-btn desk-btn-ghost" onclick="DESK.runRebalance()"' + (isAdmin() ? '' : ' disabled') + '>Rebalance round-robin</button></div>';
    html += '<div class="desk-set-sec">Transfer tickets between portals</div><div class="desk-form-grid">'
      + '<div><label>From</label><select id="TrFrom">' + portalOptions(all) + '</select></div>'
      + '<div><label>To</label><select id="TrTo">' + portalOptions(all) + '</select></div>'
      + '<div><label>Count (blank = all)</label><input id="TrCount" type="number" min="1"></div>'
      + '<div><label>Only open</label><select id="TrOpen"><option value="1">Yes</option><option value="0">No \u2014 include follow_up</option></select></div>'
      + '</div><div style="margin-top:8px"><button class="desk-btn desk-btn-ghost" onclick="DESK.runTransfer()"' + (isAdmin() ? '' : ' disabled') + '>Move oldest first</button></div>';
    html += '<div class="desk-set-sec">Sweep unassigned tickets</div><div class="desk-form-grid">'
      + '<div><label>To portal</label><select id="AuTo">' + portalOptions(all) + '</select></div>'
      + '<div><label>Status</label><select id="AuStatus"><option value="open">Open</option><option value="follow_up">Follow-up</option><option value="">Any</option></select></div>'
      + '<div><label>Limit (blank = all)</label><input id="AuLimit" type="number" min="1"></div>'
      + '</div><div style="margin-top:8px"><button class="desk-btn desk-btn-ghost" onclick="DESK.runAssignUnassigned()"' + (isAdmin() ? '' : ' disabled') + '>Assign</button></div>';
    html += '<div class="desk-set-sec">Recent distributions</div><div id="DistHistory"><div class="desk-loading"><span class="desk-spin"></span>Loading\u2026</div></div>';
    return html;
  }
  function loadDistributeTab() {
    ensurePortals(function () {
      var b = $('DistributeBody');
      if (!b) return;
      b.innerHTML = distributeHtml();
      syncDistMode();
      loadDistHistory();
    });
  }
  function syncDistMode() {
    var m = (($('DistMode') || {}).value) || 'round_robin';
    var isShift = m === 'shift_based';
    var c = $('DistCountWrap'); if (c) c.style.display = isShift ? 'none' : '';
    var r = $('ShiftRows');
    if (r) {
      if (isShift) {
        if (!S.shifts.length) S.shifts.push({ name: 'Morning', start: '09:00', end: '17:00', portalCount: 1 }, { name: 'Evening', start: '17:00', end: '21:00', portalCount: 1 });
        r.innerHTML = shiftRowsHtml();
      } else r.innerHTML = '';
    }
  }
  function shiftRowsHtml() {
    return '<div class="desk-set-sec">Shift windows</div><div class="desk-set-sub">Tickets inside a window split only across that window\u2019s own portals \u2014 no cross-shift mixing.</div>'
      + S.shifts.map(function (s, i) {
          return '<div class="desk-shift-row">'
            + '<input placeholder="Name" value="' + esc(s.name) + '" data-s="name">'
            + '<input type="time" value="' + esc(s.start) + '" data-s="start">'
            + '<input type="time" value="' + esc(s.end) + '" data-s="end">'
            + '<input type="number" min="1" max="10" value="' + (s.portalCount || 1) + '" data-s="count" title="Portals in this window">'
            + '<button class="desk-btn-plain danger" onclick="DESK.delShiftRow(' + i + ')">x</button></div>';
        }).join('')
      + '<button class="desk-btn-plain" onclick="DESK.addShiftRow()">+ Add window</button>';
  }
  function collectShifts() {
    var out = [];
    document.querySelectorAll('#ShiftRows .desk-shift-row').forEach(function (row) {
      var g = function (k) { var el = row.querySelector('[data-s="' + k + '"]'); return el ? el.value : ''; };
      if (g('start') && g('end')) out.push({ name: g('name') || ('Shift ' + (out.length + 1)), start: g('start'), end: g('end'), portalCount: Number(g('count')) || 1 });
    });
    return out;
  }
  function addShiftRow() {
    S.shifts = collectShifts();
    S.shifts.push({ name: 'Shift ' + (S.shifts.length + 1), start: '09:00', end: '17:00', portalCount: 1 });
    var r = $('ShiftRows'); if (r) r.innerHTML = shiftRowsHtml();
  }
  function delShiftRow(i) {
    S.shifts = collectShifts();
    S.shifts.splice(i, 1);
    var r = $('ShiftRows'); if (r) r.innerHTML = shiftRowsHtml();
  }
  function saveAutopilot() {
    var value = { enabled: !!($('ApEnabled') || {}).checked };
    api('/api/support/admin/settings/portal_routing', { method: 'PUT', body: { value: value } })
      .then(function () { toast(value.enabled ? 'Auto-pilot ON \u2014 new tickets route to live shift portals' : 'Auto-pilot off'); return loadSettings(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function runDistribute() {
    var mode = (($('DistMode') || {}).value) || 'round_robin';
    var body = { distributionMode: mode, filters: {} };
    var prefix = (($('DistPrefix') || {}).value || '').trim();
    if (prefix) body.namePrefix = prefix;
    var max = Number(($('DistMax') || {}).value);
    if (max) body.portalSettings = { maxTickets: max };
    if (($('DistFrom') || {}).value) body.filters.dateFrom = $('DistFrom').value;
    if (($('DistTo') || {}).value) body.filters.dateTo = $('DistTo').value;
    if (($('DistTFrom') || {}).value) body.filters.timeFrom = $('DistTFrom').value;
    if (($('DistTTo') || {}).value) body.filters.timeTo = $('DistTTo').value;
    if (mode === 'shift_based') {
      body.shifts = collectShifts();
      if (!body.shifts.length) return toast('Add at least one shift window', true);
    } else {
      body.count = Number(($('DistCount') || {}).value);
      if (!body.count || body.count < 2 || body.count > 20) return toast('Portals must be 2-20', true);
    }
    var el = $('DistResult');
    if (el) el.innerHTML = '<div class="desk-loading"><span class="desk-spin"></span>Distributing\u2026</div>';
    adminApi('/support-portals/auto-distribute', { method: 'POST', body: body }).then(function (d) {
      toast(d.message || 'Distributed');
      S.portals = null; S.activeShifts = null; S.distStats = null;
      if (el) el.innerHTML = createdPortalsHtml(d.portals)
        + (d.stats && d.stats.portalBreakdown ? '<table class="desk-tbl"><tr><th>Portal</th><th class="num">Tickets</th><th class="num">Utilisation</th></tr>'
          + d.stats.portalBreakdown.map(function (b) {
              return '<tr><td>' + esc(b.name) + '</td><td class="num">' + b.ticketCount + '</td><td class="num">' + (b.utilization == null ? '\u2013' : b.utilization + '%') + '</td></tr>';
            }).join('') + '</table>' : '');
      loadDistHistory();
    }).catch(function (e) { if (el) el.innerHTML = '<div class="desk-set-sub">' + esc(e.message) + '</div>'; });
  }
  function runRebalance() {
    var scope = (($('RbScope') || {}).value) || '';
    var body = {};
    if (scope === 'custom') {
      var ids = [];
      document.querySelectorAll('#RbPick [data-rb]:checked').forEach(function (c) { ids.push(Number(c.value)); });
      if (ids.length < 2) return toast('Tick at least 2 portals', true);
      body.portalIds = ids;
    } else if (scope) body.shift = scope;
    adminApi('/support-portals/rebalance', { method: 'POST', body: body }).then(function (d) {
      toast(d.message || 'Rebalanced');
      S.portals = null; S.activeShifts = null;
      loadDistHistory();
    }).catch(function (e) { toast(e.message, true); });
  }
  function runTransfer() {
    var from = ($('TrFrom') || {}).value, to = ($('TrTo') || {}).value;
    if (!from || !to) return toast('Need portals on both sides', true);
    if (String(from) === String(to)) return toast('Pick different portals', true);
    var body = { fromPortalId: Number(from), toPortalId: Number(to), onlyOpen: ($('TrOpen') || {}).value !== '0' };
    var n = Number(($('TrCount') || {}).value);
    if (n) body.count = n;
    adminApi('/support-portals/transfer', { method: 'POST', body: body }).then(function (d) {
      toast(d.message || 'Transferred');
      S.portals = null;
      loadDistHistory();
    }).catch(function (e) { toast(e.message, true); });
  }
  function runAssignUnassigned() {
    var to = ($('AuTo') || {}).value;
    if (!to) return toast('Pick a portal', true);
    var body = { portalId: Number(to) };
    if (($('AuStatus') || {}).value) body.status = $('AuStatus').value;
    var lim = Number(($('AuLimit') || {}).value);
    if (lim) body.limit = lim;
    adminApi('/support-portals/assign-unassigned', { method: 'POST', body: body }).then(function (d) {
      toast(d.message || 'Assigned');
      S.portals = null;
      loadDistHistory();
    }).catch(function (e) { toast(e.message, true); });
  }
  function loadDistHistory() {
    adminApi('/support-portals/distribution-stats').then(function (d) {
      var el = $('DistHistory');
      if (!el) return;
      var s = d.summary || {};
      var rows = (d.history || []).slice(0, 12).map(function (h) {
        return '<tr><td>' + esc(h.distribution_type) + '</td><td class="num">' + h.portal_count + '</td><td class="num">' + h.ticket_count + '</td><td>' + fmtTime(h.created_at) + '</td></tr>';
      }).join('');
      el.innerHTML = '<div class="desk-ctx-summary">' + (s.totalDistributions || 0) + ' distributions \u00b7 ' + (s.totalPortals || 0) + ' auto portals \u00b7 avg utilisation ' + (s.avgUtilization || 0) + '%</div>'
        + (rows ? '<table class="desk-tbl"><tr><th>Type</th><th class="num">Portals</th><th class="num">Tickets</th><th>When</th></tr>' + rows + '</table>' : '<div class="desk-set-sub">No distributions yet.</div>');
    }).catch(function () {});
  }

  // ---------- Analytics tab ----------
  function analyticsHtml() {
    var a = S.analytics;
    if (!a) return '<div class="desk-loading"><span class="desk-spin"></span>Loading analytics\u2026</div>';
    var g = a.global || {};
    var html = '<div class="desk-chips">' + chip(g.total_cnt, 'Total') + chip(g.open_cnt, 'Open') + chip(g.resolved_cnt, 'Resolved') + chip(g.unread_cnt, 'Unread') + chip(g.today_cnt, 'Today') + '</div>';
    html += '<div class="desk-set-sec">Per portal</div><div class="desk-tblwrap"><table class="desk-tbl"><tr><th>Portal</th><th>Type</th><th>Shift</th><th>Live</th><th class="num">Total</th><th class="num">Open</th><th class="num">Resolved</th><th class="num">Unread</th><th class="num">Today</th></tr>';
    (a.portals || []).forEach(function (p) {
      html += '<tr><td>' + esc(p.name) + '</td><td><span class="desk-tag">' + esc(p.type) + '</span></td>'
        + '<td>' + esc(fmtShiftRange(p.shift_start, p.shift_end)) + '</td>'
        + '<td>' + (p.is_active ? 'yes' : '\u2013') + '</td>'
        + '<td class="num">' + (p.total || 0) + '</td><td class="num">' + (p.open || 0) + '</td><td class="num">' + (p.resolved || 0) + '</td><td class="num">' + (p.unread || 0) + '</td><td class="num">' + (p.today || 0) + '</td></tr>';
    });
    html += '</table></div>';
    html += '<div class="desk-set-sec">Unassigned by IST hour</div>' + hoursHtml((a.unassigned || {}).byHour, 'open_cnt');
    html += '<div class="desk-set-sec">Today\u2019s volume by IST hour</div>' + hoursHtml(a.todayByHour, 'cnt');
    var daily = (a.unassigned || {}).daily || [];
    if (daily.length) {
      html += '<div class="desk-set-sec">Unassigned \u2014 last 7 days</div><table class="desk-tbl"><tr><th>Day</th><th class="num">Tickets</th><th class="num">Still open</th></tr>'
        + daily.map(function (r) { return '<tr><td>' + esc(r.ist_date) + '</td><td class="num">' + r.cnt + '</td><td class="num">' + r.open_cnt + '</td></tr>'; }).join('') + '</table>';
    }
    return html;
  }
  function chip(n, l) { return '<div class="desk-chip"><b>' + (n || 0) + '</b><span>' + l + '</span></div>'; }
  function hoursHtml(rows, key) {
    var map = {};
    (rows || []).forEach(function (r) { map[Number(r.ist_hour)] = Number(r[key] != null ? r[key] : r.cnt) || 0; });
    var max = 1;
    for (var i = 0; i < 24; i++) { map[i] = map[i] || 0; if (map[i] > max) max = map[i]; }
    var bars = '';
    for (var h = 0; h < 24; h++) {
      bars += '<div class="b" title="' + h + ':00 \u2014 ' + map[h] + '" style="height:' + Math.max(2, Math.round(map[h] / max * 100)) + '%"></div>';
    }
    return '<div class="desk-hours">' + bars + '</div><div class="desk-hours-x"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>';
  }
  function loadAnalytics() {
    var el = $('AnalyticsBody');
    if (!el) return;
    el.innerHTML = '<div class="desk-loading"><span class="desk-spin"></span>Loading analytics\u2026</div>';
    adminApi('/support-portals/analytics').then(function (d) {
      S.analytics = d;
      el.innerHTML = analyticsHtml();
    }).catch(function (e) { el.innerHTML = '<div class="desk-set-sub">' + esc(e.message) + '</div>'; });
  }

  // ---------- exports / boot ----------
  window.DESK = {
    login: login, logout: logout, setStatus: setStatus, setFilter: setFilter,
    select: select, backToQueue: backToQueue, patchTicket: patchTicket,
    toggleCustomerInfo: toggleCustomerInfo,
    toggleOrderHistory: toggleOrderHistory,
    toggleReturnsExchanges: toggleReturnsExchanges,
    openReturnPortal: openReturnPortal,
    toggleOrderRow: toggleOrderRow, reloadContext: reloadContext,
    setMode: setMode, setMsg: setMsg, useCanned: useCanned, sendComposer: sendComposer,
    onPickFiles: onPickFiles, removeMediaChip: removeMediaChip, retryMediaChip: retryMediaChip,
    aiSuggest: aiSuggest,
    openResolve: openResolve, pickResolution: pickResolution, confirmResolve: confirmResolve,
    agentReopen: agentReopen, approve: approve, decline: decline,
    openSettings: openSettings, setTab: setTab, saveSla: saveSla, saveTeams: saveTeams,
    addTeam: addTeam, delTeam: delTeam, addCanned: addCanned, delCanned: delCanned, saveCanned: saveCanned,
    saveTemplates: saveTemplates, saveCost: saveCost,
    // access console (Access tab)
    loadAccessTab: loadAccessTab, reloadAccess: reloadAccess, setAccessSection: setAccessSection,
    setAccessMode: setAccessMode, saveAccessPolicy: saveAccessPolicy,
    accJump: accJump, accApplyFilter: accApplyFilter, accPage: accPage,
    accGrantSegment: accGrantSegment, accAllowOnly: accAllowOnly, accAddOne: accAddOne, accImport: accImport,
    accPick: accPick, accPickAll: accPickAll, accClearSel: accClearSel,
    accSelGrant: accSelGrant, accSelRevoke: accSelRevoke, accRevokeOne: accRevokeOne, accClearAll: accClearAll,
    accSelLevel: accSelLevel, accSelExpiry: accSelExpiry, accSelResync: accSelResync, accSelAnnounce: accSelAnnounce, accCleanup: accCleanup,
    accExport: accExport, loadAccessRoster: loadAccessRoster, accListDormant: accListDormant, accListView: accListView,
    accListSearch: accListSearch,
    closeModal: closeModal, syncOrders: syncOrders, lightbox: lightbox, openViewer: openViewer,
    // portal engine tabs
    copyText: copyText, portalCreate: portalCreate, portalActive: portalActive, portalMax: portalMax,
    portalShiftEdit: portalShiftEdit, portalPass: portalPass, portalSplit: portalSplit,
    portalClear: portalClear, portalDelete: portalDelete,
    setLoginWindow: setLoginWindow, refreshLoginsPanel: refreshLoginsPanel,
    saveAutopilot: saveAutopilot, distMode: syncDistMode, addShiftRow: addShiftRow, delShiftRow: delShiftRow,
    runDistribute: runDistribute, runRebalance: runRebalance, runTransfer: runTransfer, runAssignUnassigned: runAssignUnassigned
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (S.token) bootDesk(); else showLogin();
    });
  } else {
    if (S.token) bootDesk(); else showLogin();
  }
})();
