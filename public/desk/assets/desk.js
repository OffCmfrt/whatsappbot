/* ============================================================
   Offcomfrt Support Desk — agent dashboard
   Login → KPI bar → queue (left) → full ticket context (right).
   Admin settings modal: SLA, teams, canned responses, resolution
   templates, cost config, whitelist, order sync.
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
    stats: null,
    tickets: [],
    filters: { status: 'open', q: '', team: '', priority: '', category: '' },
    selectedId: null,
    detail: null,
    settings: { teams: {}, canned: [], templates: {}, sla: {} },
    composer: { mode: 'reply', text: '' },
    orderExpanded: false,
    customerExpanded: true,
    pollInterval: null,
    modal: null,          // { tab: 'sla'|'teams'|'canned'|'templates'|'cost'|'whitelist' }
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
  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + S.token }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, opts).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('Session expired — sign in again'); }
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return data;
      });
    });
  }
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

  // ---------- auth ----------
  function logout() {
    if (S.pollInterval) {
      clearInterval(S.pollInterval);
      S.pollInterval = null;
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
    loadSettings().then(function () {
      renderShell();
      refreshAll();
      // Memory & network smart polling: pause when tab is in background
      S.pollInterval = setInterval(function () {
        if (!document.hidden && S.token) refreshStats();
      }, 30000);
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
        cost: st.cost_config || {}
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
    if (el) el.innerHTML = '<div class="desk-loading"><span class="desk-spin"></span>Loading full ticket context\u2026</div>';
    api('/api/support/admin/tickets/' + id).then(function (d) {
      S.detail = d;
      S.composer = { mode: 'reply', text: '' };
      renderDetail();
    }).catch(function (e) {
      if (el) el.innerHTML = '<div class="desk-empty-detail">' + esc(e.message) + '</div>';
    });
  }

  // ---------- shell ----------
  function renderShell() {
    var root = $('DeskRoot');
    root.innerHTML = '<div class="desk-shell">'
      + '<div class="desk-topbar">'
      +   '<div class="desk-topbar-brand">'
      +     '<span class="desk-logo-mark">OF</span>'
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
      + '<div class="desk-kpi-pill"><span class="lbl">Avg CSAT</span><span class="val">' + (s.avgCsat == null ? '\u2013' : s.avgCsat + '/5') + '</span></div>';
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
    var d = S.detail, t = d.ticket, o = d.order || {}, h = d.history || {};

    // Reorganized Main Workspace:
    // 1. Unified Ticket Header (Status, Priority, Team, Category, SLA in one clean header)
    // 2. Action Column (Left): Unified Issue & Reply Box (Problem Statement + Conversation + Reply in ONE card)
    // 3. Context Column (Right): Customer Details + Order History (hides past orders if 1 order) + Economic Cost & Risk
    el.innerHTML = ''
      + unifiedTicketHeader(d, t)
      + '<div class="desk-workspace-split">'
      +   '<div class="desk-action-col">'
      +     issueAndConversationCard(d, t)
      +   '</div>'
      +   '<div class="desk-context-col">'
      +     customerCard(d, t, h, o)
      +     orderHistoryCard(d, t, o)
      +     riskCard(d)
      +   '</div>'
      + '</div>';

    if (window.innerWidth < 980) {
      var b = $('DeskBack');
      if (b) b.style.display = 'inline-flex';
    }
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

  function toggleCustomerInfo(forceExpand) {
    if (typeof forceExpand === 'boolean') {
      S.customerExpanded = forceExpand;
    } else {
      S.customerExpanded = (S.customerExpanded === undefined) ? false : !S.customerExpanded;
    }
    var card = $('DeskCustomerCard');
    if (card) {
      if (S.customerExpanded) {
        card.classList.remove('is-collapsed');
        card.classList.add('is-expanded');
        var hint = card.querySelector('.desk-cust-collapse-hint');
        if (hint) hint.textContent = 'Click to collapse';
      } else {
        card.classList.remove('is-expanded');
        card.classList.add('is-collapsed');
        var hint = card.querySelector('.desk-cust-collapse-hint');
        if (hint) hint.textContent = 'Click to expand';
      }
    }
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
    var ordersCount = Number(h.orders) || (ctx.orders && ctx.orders.length) || 1;
    var returnsCount = (ctx.returns && ctx.returns.length) || (ctx.exchanges && ctx.exchanges.length) || Number(h.rto) || 0;
    var phone10 = phone.replace(/\D/g, '').slice(-10);
    var isExpanded = (S.customerExpanded !== false);

    return '<div class="desk-card desk-customer-info-card' + (isExpanded ? ' is-expanded' : ' is-collapsed') + '" id="DeskCustomerCard">'
      // Clickable Header Bar with smooth arrow animation & summary info
      + '<div class="desk-card-head desk-collapsible-bar" onclick="DESK.toggleCustomerInfo()" role="button" tabindex="0" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DESK.toggleCustomerInfo();}" title="Click to ' + (isExpanded ? 'collapse' : 'expand') + ' customer details">'
      +   '<div class="desk-card-title">'
      +     '<span class="desk-head-icon">&#128100;</span> Customer Info'
      +     '<span class="desk-collapse-hint desk-cust-collapse-hint">' + (isExpanded ? 'Click to collapse' : 'Click to expand') + '</span>'
      +   '</div>'
      +   '<div class="desk-order-bar-actions">'
      +     '<span class="desk-order-chip">' + esc(name) + '</span>'
      +     (phone !== '\u2013' ? '<span class="desk-order-chip">+' + esc(phone) + '</span>' : '')
      +     '<span class="desk-pill stage">' + ordersCount + ' ' + (ordersCount === 1 ? 'order' : 'orders') + '</span>'
      +     (phone10 ? '<a class="desk-btn desk-btn-wa desk-btn-sm" target="_blank" rel="noopener" href="https://wa.me/91' + esc(phone10) + '" onclick="event.stopPropagation()" title="Open WhatsApp Chat"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2z"/></svg> WhatsApp</a>' : '')
      +     '<span class="desk-collapse-arrow">&#9662;</span>'
      +   '</div>'
      + '</div>'
      // Smoothly Animated Collapsible Body
      + '<div class="desk-customer-body" id="DeskCustomerBody">'
      +   '<div class="desk-ci-panel">'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Name:</span><span class="ci-val">' + esc(name) + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Phone:</span><span class="ci-val">' + (phone !== '\u2013' ? '<a href="tel:+' + esc(phone) + '">' + esc(phone) + '</a>' : '\u2013') + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Email:</span><span class="ci-val">' + (email !== '\u2013' ? '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>' : '\u2013') + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Location:</span><span class="ci-val">' + esc(location) + '</span></div>'
      +     '<div class="desk-ci-row"><span class="ci-lbl">Order:</span><span class="ci-val"><span class="desk-order-chip">#' + esc(orderNum) + '</span></span></div>'
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
    if (typeof forceExpand === 'boolean') {
      S.orderExpanded = forceExpand;
    } else {
      S.orderExpanded = !S.orderExpanded;
    }
    var card = $('DeskOrderCard');
    if (card) {
      if (S.orderExpanded) {
        card.classList.remove('is-collapsed');
        card.classList.add('is-expanded');
        var hint = card.querySelector('.desk-collapse-hint');
        if (hint) hint.textContent = 'Click to collapse';
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        card.classList.remove('is-expanded');
        card.classList.add('is-collapsed');
        var hint = card.querySelector('.desk-collapse-hint');
        if (hint) hint.textContent = 'Click to expand';
      }
    }
  }

  function orderHistoryCard(d, t, o) {
    var items = (o.items || []).map(function (i) {
      return '<tr>'
        + '<td><strong>' + esc(i.n) + '</strong>' + (i.v ? ' <span class="desk-item-var">(' + esc(i.v) + ')</span>' : '') + '</td>'
        + '<td class="num">x' + (i.q || 1) + '</td>'
        + '<td class="num">' + money(i.p) + '</td>'
        + '<td class="num">' + money((i.p || 0) * (i.q || 1)) + '</td>'
        + '</tr>';
    }).join('');

    var track = o.awb && /delhivery/i.test(o.courier || '')
      ? '<a class="desk-track-link" href="https://www.delhivery.com/track/package/' + esc(o.awb) + '" target="_blank" rel="noopener">' + esc(o.awb) + ' &UpperRightArrow;</a>'
      : (o.awb ? '<span class="desk-mono">' + esc(o.awb) + '</span>' : '<span class="desk-hint">&ndash;</span>');

    var currentOrderId = String(o.id || t.order_id || '').replace(/^#/, '');

    // Past orders from Shoppers Hub context
    var ctx = d.context || {};
    var pastOrders = (ctx.orders || []).map(function (po) {
      var st = String(po.status || '').toLowerCase();
      var label = STAGE_LABELS[st] || st.replace(/_/g, ' ');
      var isCurrent = String(po.order_id || '').replace(/^#/, '') === currentOrderId;
      var awbStr = po.awb ? (po.courier_name ? po.courier_name + ': ' : '') + po.awb : '';
      return '<div class="desk-history-row' + (isCurrent ? ' current-order-highlight' : '') + '">'
        + '<div class="history-main">'
        +   '<span class="history-id">#' + esc(po.order_id) + '</span>'
        +   (isCurrent ? '<span class="desk-tag highlight-tag">This Ticket</span>' : '')
        +   '<span class="desk-pill stage">' + esc(label) + '</span>'
        + '</div>'
        + '<div class="history-sub">'
        +   (awbStr ? '<span class="history-awb">' + esc(awbStr) + '</span> &middot; ' : '')
        +   (po.created_at ? '<span class="history-date">' + fmtTime(po.created_at) + '</span> &middot; ' : '')
        +   '<span class="history-total">' + money(po.total) + '</span>'
        + '</div>'
        + '</div>';
    }).join('');

    // Open/past returns & exchanges
    var reqs = [];
    (ctx.returns || []).forEach(function (r) { reqs.push({ kind: 'Return', r: r }); });
    (ctx.exchanges || []).forEach(function (r) { reqs.push({ kind: 'Exchange', r: r }); });
    reqs.sort(function (a, b) { return new Date(b.r.created_at || 0) - new Date(a.r.created_at || 0); });

    var reqRows = reqs.map(function (x) {
      return '<div class="desk-history-row req-row">'
        + '<div class="history-main">'
        +   '<span class="desk-tag request">' + x.kind + '</span>'
        +   '<span class="history-id">#' + esc(x.r.order_id) + '</span>'
        +   '<span class="desk-pill">' + esc(String(x.r.status || '').replace(/_/g, ' ')) + '</span>'
        + '</div>'
        + '<div class="history-sub">'
        +   '<span class="history-src">' + (x.r.source === 'portal' ? 'Portal request' : 'Support request') + '</span> &middot; '
        +   '<span class="history-date">' + fmtTime(x.r.created_at) + '</span>'
        + '</div>'
        + '</div>';
    }).join('');

    var totalPastCount = (ctx.orders || []).length;
    var isExpanded = !!S.orderExpanded;
    var orderNum = o.id || t.order_id;
    var stageLabel = o.stage ? (STAGE_LABELS[o.stage] || o.stage) : '';

    return '<div class="desk-card desk-order-card' + (isExpanded ? ' is-expanded' : ' is-collapsed') + '" id="DeskOrderCard">'
      // Clickable Order History Bar (goes down and shows details on click)
      + '<div class="desk-card-head desk-collapsible-bar" onclick="DESK.toggleOrderHistory()" role="button" tabindex="0" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DESK.toggleOrderHistory();}" title="Click to ' + (isExpanded ? 'collapse' : 'expand') + ' order details">'
      +   '<div class="desk-card-title">'
      +     '<span class="desk-head-icon">&#128230;</span> Order History'
      +     '<span class="desk-collapse-hint">' + (isExpanded ? 'Click to collapse' : 'Click to expand') + '</span>'
      +   '</div>'
      +   '<div class="desk-order-bar-actions">'
      +     (orderNum ? '<span class="desk-order-chip">#' + esc(orderNum) + '</span>' : '')
      +     (stageLabel ? '<span class="desk-pill stage">' + esc(stageLabel) + '</span>' : '')
      +     (o.total != null ? '<span class="desk-order-chip price">' + money(o.total) + '</span>' : '')
      +     '<span class="desk-collapse-arrow">&#9662;</span>'
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
      // Past Order History Subsection (hidden when only 1 order exists and no returns/exchanges)
      +   (totalPastCount > 1 || reqs.length > 0 ? (
            '<div class="desk-past-orders-section">'
            + '<div class="desk-section-subhead">Customer Order &amp; Request History <span class="desk-muted">(' + totalPastCount + ' recorded)</span></div>'
            + (reqRows ? '<div class="desk-sub-section-title">Returns &amp; Exchanges</div><div class="desk-history-list">' + reqRows + '</div>' : '')
            + (pastOrders ? '<div class="desk-sub-section-title" style="margin-top:10px">Past Orders</div><div class="desk-history-list">' + pastOrders + '</div>' : '')
            + '</div>'
          ) : '')
      +   '</div>'
      + '</div>';
  }

  // ── 4. Unified Conversation & Issue Details Card (Interactive Dialogue Look) ──
  function issueAndConversationCard(d, t) {
    var images = t.images || [];
    var imagesHtml = images.length ? (
      '<div class="desk-proof-section">'
      + '<div class="desk-section-subhead">&#128247; Proof &amp; Attachments <span class="desk-muted">(' + images.length + ' image' + (images.length > 1 ? 's' : '') + ')</span></div>'
      + '<div class="desk-imggrid">'
      +   images.map(function (u) {
            return '<div class="desk-proof-thumb" onclick="DESK.lightbox(\'' + esc(u) + '\')" title="Click to enlarge"><img src="' + esc(u) + '" alt="proof"><span class="zoom-icon">&#128269;</span></div>';
          }).join('')
      + '</div>'
      + '</div>'
    ) : '';

    var approveHtml = d.requestKey ? approveCard(d, t) : '';

    var rawThread = Array.isArray(t.thread) ? t.thread : [];
    var notes = Array.isArray(t.notes) ? t.notes : [];

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

    var problemText = t.message ? esc(t.message) : '<em>No issue description message recorded.</em>';
    var problemMeta = '';
    if (t.preference) {
      problemMeta += '<div class="desk-bubble-detail"><strong>Requested Preference:</strong> ' + esc(t.preference) + '</div>';
    }
    if (t.new_address) {
      problemMeta += '<div class="desk-bubble-detail"><strong>Requested New Address:</strong> &#128205; ' + esc(t.new_address) + '</div>';
    }
    if (t.video_url) {
      problemMeta += '<div class="desk-bubble-detail">&#127916; <strong>Unboxing Video Proof Attached</strong></div>';
    }
    if (imagesHtml) {
      problemMeta += imagesHtml;
    }

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
    rawThread.forEach(function (m) {
      if (hasProblemInThread && m.role === 'customer' && m.text && m.text.trim() === (t.message || '').trim()) {
        return;
      }
      if (m.kind === 'event') {
        threadHtml += '<div class="desk-ev"><span class="ev-dot">&bull;</span> ' + esc(m.text) + ' &middot; ' + fmtTime(m.at) + '</div>';
      } else if (m.role === 'customer') {
        threadHtml += '<div class="desk-msg-row cust-row">'
          + '<div class="desk-chat-avatar cust" title="' + esc(custName) + '">' + esc(custInitials) + '</div>'
          + '<div class="desk-msg-content">'
          +   '<div class="desk-msg-sender">'
          +     '<span class="sender-name">' + esc(custName) + '</span>'
          +     '<span class="sender-pill">Customer</span>'
          +     '<span class="sender-time">' + fmtTime(m.at) + '</span>'
          +   '</div>'
          +   '<div class="desk-msg-bubble cust-bubble">'
          +     '<div class="bubble-text">' + esc(m.text) + '</div>'
          +   '</div>'
          + '</div>'
          + '</div>';
      } else {
        var agentName = esc(m.agentId || 'Support Team');
        var agentInitials = agentName.split(' ').map(function (w) { return w[0]; }).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'ST';
        threadHtml += '<div class="desk-msg-row agent-row">'
          + '<div class="desk-msg-content agent-content">'
          +   '<div class="desk-msg-sender agent-sender">'
          +     '<span class="sender-time">' + fmtTime(m.at) + '</span>'
          +     (m.ask ? '<span class="desk-tag ask-tag">Asked Customer</span> ' : '')
          +     '<span class="sender-pill agent-pill">Support Team</span>'
          +     '<span class="sender-name">' + agentName + '</span>'
          +   '</div>'
          +   '<div class="desk-msg-bubble agent-bubble">'
          +     '<div class="bubble-text">' + esc(m.text) + '</div>'
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
        +     '<span>&#128274; Internal Team Note (Team Only &middot; Hidden from customer)</span>'
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
        +     '<button class="desk-mode mode-note' + (S.composer.mode === 'note' ? ' active' : '') + '" onclick="DESK.setMode(\'note\')">&#128274; Internal Note</button>'
        +   '</div>'
        +   (canned.length ? '<select class="desk-select desk-canned-select" onchange="DESK.useCanned(this.value)"><option value="">&plusmn; Insert Saved Reply\u2026</option>'
        +     canned.map(function (c) { return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>'; }).join('') + '</select>' : '')
        + '</div>'
        + '<textarea id="DeskMsg" class="desk-composer-textarea" placeholder="' + esc(placeholder) + '" oninput="DESK.setMsg(this.value)">' + esc(S.composer.text) + '</textarea>'
        + '<div class="desk-composer-actions">'
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
      +   '<div class="desk-card-title"><span class="desk-head-icon">&#128172;</span> Conversation</div>'
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
    var inner = '';
    if (d.requestNote) inner += '<div class="req-note">' + esc(d.requestNote) + '</div>';
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
      + '<div class="desk-approve-head"><span class="badge">&#9889; Action Required</span><span class="req-title">' + esc(d.requestLabel) + '</span></div>'
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
      +   '<div class="desk-card-title"><span class="desk-head-icon">&#128200;</span> Economic Cost &amp; Risk</div>'
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
      + (econ.tip ? '<div class="desk-tip">&#128161; <strong>Tip:</strong> ' + esc(econ.tip) + '</div>' : '')
      + '</div>';
  }


  // ---------- composer actions ----------
  function setMode(m) { S.composer.mode = m; S.composer.text = ''; renderDetail(); }
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
    if (!text) { toast('Message is empty', true); return; }
    var path = S.composer.mode === 'note' ? '/note' : (S.composer.mode === 'ask' ? '/ask' : '/reply');
    api('/api/support/admin/tickets/' + t.id + path, { method: 'POST', body: { text: text } })
      .then(function () {
        S.composer.text = '';
        loadDetail(t.id);
        refreshStats();
      })
      .catch(function (e) { toast(e.message, true); });
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
    var tabs = [['sla', 'SLA'], ['teams', 'Teams'], ['canned', 'Saved replies'], ['templates', 'Resolutions'], ['cost', 'Cost & risk'], ['whitelist', 'Access']];
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
    } else if (S.modal.tab === 'whitelist') {
      html += '<div class="desk-set-sub">Only these phone numbers see the Help &amp; Tickets tab in the customer account. Add the number with country code (e.g. 919876543210).</div>'
        + '<div class="row" style="display:flex;gap:8px;margin-bottom:14px">'
        + '<input id="WlPhone" class="desk-input" placeholder="919876543210" style="flex:0 0 200px;margin-bottom:0">'
        + '<input id="WlNote" class="desk-input" placeholder="Note (optional)" style="flex:1;margin-bottom:0">'
        + '<button class="desk-btn" onclick="DESK.addWl()">Add</button></div>'
        + '<div id="WlList"><div class="desk-loading"><span class="desk-spin"></span>Loading\u2026</div></div>';
      loadWhitelist();
    }
    el.innerHTML = html;
  }
  function cf(id, label, val) {
    return '<div><label>' + label + '</label><input id="Cf' + id + '" type="number" step="any" value="' + (val != null ? val : '') + '"></div>';
  }
  function loadWhitelist() {
    api('/api/support/admin/whitelist').then(function (d) {
      var el = $('WlList');
      if (!el) return;
      el.innerHTML = (d.whitelist || []).map(function (w) {
        return '<div class="desk-set-item"><div class="row">'
          + '<input type="text" value="+' + esc(w.phone) + '" disabled style="max-width:160px;font-family:monospace">'
          + '<input type="text" value="' + esc(w.note || '') + '" disabled placeholder="">'
          + '<button class="desk-btn-plain" onclick="DESK.delWl(\'' + esc(w.phone) + '\')">Remove</button>'
          + '</div></div>';
      }).join('') || '<div class="desk-set-sub">No phones whitelisted yet.</div>';
    }).catch(function (e) { toast(e.message, true); });
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
  function addWl() {
    var ph = ($('WlPhone') || {}).value, note = ($('WlNote') || {}).value;
    if (!ph) return;
    api('/api/support/admin/whitelist', { method: 'POST', body: { phone: ph, note: note } })
      .then(function () { toast('Phone whitelisted'); loadWhitelist(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function delWl(ph) {
    api('/api/support/admin/whitelist/' + encodeURIComponent(ph), { method: 'DELETE' })
      .then(function () { toast('Phone removed'); loadWhitelist(); })
      .catch(function (e) { toast(e.message, true); });
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
  function lightbox(url) {
    var lb = document.createElement('div');
    lb.className = 'desk-lightbox';
    lb.innerHTML = '<img src="' + esc(url) + '">';
    function closeLb() {
      document.removeEventListener('keydown', onLbKey);
      if (lb) { lb.remove(); lb = null; }
    }
    function onLbKey(e) { if (e.key === 'Escape') closeLb(); }
    lb.onclick = closeLb;
    document.addEventListener('keydown', onLbKey);
    document.body.appendChild(lb);
  }

  // ---------- exports / boot ----------
  window.DESK = {
    login: login, logout: logout, setStatus: setStatus, setFilter: setFilter,
    select: select, backToQueue: backToQueue, patchTicket: patchTicket,
    toggleCustomerInfo: toggleCustomerInfo,
    toggleOrderHistory: toggleOrderHistory,
    setMode: setMode, setMsg: setMsg, useCanned: useCanned, sendComposer: sendComposer,
    openResolve: openResolve, pickResolution: pickResolution, confirmResolve: confirmResolve,
    agentReopen: agentReopen, approve: approve, decline: decline,
    openSettings: openSettings, setTab: setTab, saveSla: saveSla, saveTeams: saveTeams,
    addTeam: addTeam, delTeam: delTeam, addCanned: addCanned, delCanned: delCanned, saveCanned: saveCanned,
    saveTemplates: saveTemplates, saveCost: saveCost, addWl: addWl, delWl: delWl,
    closeModal: closeModal, syncOrders: syncOrders, lightbox: lightbox
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (S.token) bootDesk(); else showLogin();
    });
  } else {
    if (S.token) bootDesk(); else showLogin();
  }
})();
