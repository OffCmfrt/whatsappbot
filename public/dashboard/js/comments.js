// ===================================
// Instagram Comments Center
// Page logic: filters, list, detail panel, actions.
// Uses global apiFetch() from main.js. Defines local showToast().
// ===================================

window.CommentsCenter = (() => {

    // ─── Constants ────────────────────────────────────────

    const INTENTS = [
        'greeting', 'order_tracking', 'return', 'exchange', 'refund',
        'delivery_issue', 'damaged_product', 'wrong_product', 'shipping',
        'payment', 'cancellation', 'product_question', 'size_question', 'faq',
        'creator_collaboration', 'ugc', 'gifting', 'affiliate', 'wholesale',
        'business_enquiry', 'human_support', 'complaint', 'sensitive_issue',
        'spam', 'positive_message', 'unknown'
    ];

    const STATUS_META = {
        new:            { label: 'New',          cls: 'igc-badge-status-new' },
        needs_review:   { label: 'Needs Review', cls: 'igc-badge-status-review' },
        needs_human:    { label: 'Needs Human',  cls: 'igc-badge-status-human' },
        dm_started:     { label: 'DM Started',   cls: 'igc-badge-status-dm' },
        ticket_created: { label: 'Ticket',       cls: 'igc-badge-status-ticket' },
        auto_replied:   { label: 'Auto-Replied', cls: 'igc-badge-status-auto' },
        resolved:       { label: 'Resolved',     cls: 'igc-badge-status-resolved' },
        ignored:        { label: 'Ignored',      cls: 'igc-badge-status-ignored' },
        spam:           { label: 'Spam',         cls: 'igc-badge-status-spam' }
    };

    const IG_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>';

    // ─── State ────────────────────────────────────────────

    let page = 1;
    let total = 0;
    let limit = 50;
    let totalPages = 1;
    let currentDetail = null;   // full comment object shown in modal
    let replyMode = null;       // null | 'public' | 'private'
    let searchDebounce = null;
    let intentsPopulated = false;

    // ─── Toast helper ─────────────────────────────────────
    // showToast() is not defined in main.js; provide a local implementation
    // using the same pm-toast CSS class already used by flashCopied().
    function showToast(message, type = 'info') {
        const el = document.createElement('div');
        el.className = 'pm-toast';
        el.textContent = message;
        if (type === 'error') el.style.background = '#e74c3c';
        else if (type === 'success') el.style.background = '#27ae60';
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('pm-toast-show'));
        setTimeout(() => { el.classList.remove('pm-toast-show'); setTimeout(() => el.remove(), 300); }, 2200);
    }

    // ─── Public API ───────────────────────────────────────

    async function load() {
        closeDetail();
        await Promise.all([loadStats(), loadComments()]);
    }

    // ─── Stats ────────────────────────────────────────────

    async function loadStats() {
        try {
            const data = await apiFetch('/ig-comments/stats');
            const s = data?.stats || {};
            setText('igcStatTotal', s.total ?? 0);
            setText('igcStatNew', (s.byStatus?.new) || 0);
            setText('igcStatAttention', s.needsAttention ?? 0);
            setText('igcStatDm', (s.byStatus?.dm_started) || 0);
            setText('igcStatTickets', (s.byStatus?.ticket_created) || 0);
            setText('igcStatSpam', (s.byStatus?.spam) || 0);
        } catch (error) {
            console.error('[Comments] stats failed:', error);
        }
    }

    // ─── List ─────────────────────────────────────────────

    async function loadComments() {
        const listEl = document.getElementById('igCommentsList');
        if (!listEl) return;

        try {
            listEl.innerHTML = '<div class="igc-empty">Loading comments...</div>';

            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', String(limit));

            const status = document.getElementById('igcStatusFilter')?.value || 'all';
            const intent = document.getElementById('igcIntentFilter')?.value || 'all';
            const search = document.getElementById('igcSearchInput')?.value?.trim() || '';
            const dateFrom = document.getElementById('igcDateFrom')?.value || '';
            const dateTo = document.getElementById('igcDateTo')?.value || '';

            if (status !== 'all') params.set('status', status);
            if (intent !== 'all') params.set('intent', intent);
            if (search) params.set('search', search);
            if (dateFrom) params.set('date_from', dateFrom);
            if (dateTo) params.set('date_to', dateTo);

            const data = await apiFetch(`/ig-comments?${params.toString()}`);

            total = data?.meta?.total || 0;
            page = data?.meta?.page || page;
            limit = data?.meta?.limit || limit;
            totalPages = Math.max(1, Math.ceil(total / limit));

            const comments = data?.comments || [];
            if (comments.length === 0) {
                listEl.innerHTML = '<div class="igc-empty">No comments match these filters.</div>';
            } else {
                listEl.innerHTML = comments.map(renderRow).join('');
            }

            updatePagination();
        } catch (error) {
            console.error('[Comments] load failed:', error);
            listEl.innerHTML = '<div class="igc-empty">Failed to load comments. Is the migration applied?</div>';
        }
    }

    function renderRow(c) {
        const status = STATUS_META[c.status] || { label: c.status, cls: 'igc-badge-status-review' };
        const username = c.ig_username ? `@${c.ig_username}` : (c.ig_user_id || 'unknown');
        const truncated = (c.comment_text || '').length > 80
            ? (c.comment_text || '').substring(0, 80) + '\u2026'
            : (c.comment_text || '');

        const flags = [];
        if (c.dm_started) flags.push('<span class="igc-flag igc-flag-dm">DM</span>');
        if (c.ticket_id) flags.push('<span class="igc-flag igc-flag-ticket">Ticket</span>');
        if (c.public_reply_sent) flags.push('<span class="igc-flag igc-flag-replied">Replied</span>');

        return `
            <div class="igc-row" data-id="${c.id}">
                <div class="igc-col igc-col-user">
                    <span class="igc-col-icon">${IG_ICON}</span>
                    <span class="igc-col-username">${escapeHtml(username)}</span>
                </div>
                <div class="igc-col igc-col-comment">
                    <span class="igc-col-text" title="${escapeHtml(c.comment_text || '')}">${escapeHtml(truncated)}</span>
                </div>
                <div class="igc-col igc-col-intent">
                    <span class="igc-badge igc-badge-intent">${escapeHtml(intentLabel(c.detected_intent))}</span>
                    ${confidenceBadge(c.confidence)}
                </div>
                <div class="igc-col igc-col-status">
                    <span class="igc-badge ${status.cls}">${status.label}</span>
                </div>
                <div class="igc-col igc-col-flags">
                    ${flags.join('') || '<span class="igc-col-empty">\u2014</span>'}
                </div>
                <div class="igc-col igc-col-time">
                    <span class="igc-col-timestamp">${timeAgo(c.created_at)}</span>
                </div>
            </div>`;
    }

    function confidenceBadge(conf) {
        if (conf === null || conf === undefined) return '';
        const pct = Math.round(parseFloat(conf) * 100);
        return `<span class="igc-badge igc-badge-conf">${pct}%</span>`;
    }

    function updatePagination() {
        const info = document.getElementById('igcPageInfo');
        const prev = document.getElementById('igcPrevBtn');
        const next = document.getElementById('igcNextBtn');
        if (info) info.textContent = `Page ${page} of ${totalPages} (${total} total)`;
        if (prev) prev.disabled = page <= 1;
        if (next) next.disabled = page >= totalPages;
    }

    // ─── Detail Panel ─────────────────────────────────────

    async function openDetail(id) {
        try {
            const data = await apiFetch(`/ig-comments/${id}`);
            if (!data?.success || !data?.comment) {
                showToast('Comment not found', 'info');
                return;
            }
            currentDetail = data.comment;
            replyMode = null;
            renderDetail();
            document.getElementById('igCommentDetailModal')?.classList.add('active');
        } catch (error) {
            console.error('[Comments] detail failed:', error);
            showToast('Failed to load comment detail', 'info');
        }
    }

    function closeDetail() {
        document.getElementById('igCommentDetailModal')?.classList.remove('active');
        currentDetail = null;
        replyMode = null;
    }

    function renderDetail() {
        const c = currentDetail;
        if (!c) return;

        const body = document.getElementById('igCommentDetailBody');
        const footer = document.getElementById('igCommentDetailFooter');
        if (!body || !footer) return;

        const username = c.ig_username ? `@${c.ig_username}` : 'Unknown user';
        const profileLink = c.ig_username
            ? `https://instagram.com/${c.ig_username}`
            : null;
        const status = STATUS_META[c.status] || { label: c.status, cls: 'igc-badge-status-review' };

        body.innerHTML = `
            <div class="igc-detail-section">
                <div class="igc-detail-label">Commenter</div>
                <div class="igc-detail-grid">
                    <div class="igc-detail-item"><span class="igc-detail-key">Username</span><span class="igc-detail-val">${profileLink
                        ? `<a class="igc-link" href="${escapeHtml(profileLink)}" target="_blank" rel="noopener">${escapeHtml(username)}</a>`
                        : escapeHtml(username)}</span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">User ID</span><span class="igc-detail-val igc-mono">${escapeHtml(c.ig_user_id || '—')}</span></div>
                </div>
            </div>

            <div class="igc-detail-section">
                <div class="igc-detail-label">Comment</div>
                <div class="igc-detail-quote">${escapeHtml(c.comment_text || '')}</div>
                <div class="igc-detail-grid" style="margin-top:10px;">
                    <div class="igc-detail-item"><span class="igc-detail-key">Comment ID</span><span class="igc-detail-val igc-mono">${escapeHtml(c.comment_id || '—')}</span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Posted</span><span class="igc-detail-val">${c.comment_timestamp ? formatDate(c.comment_timestamp) : '—'}</span></div>
                </div>
            </div>

            <div class="igc-detail-section">
                <div class="igc-detail-label">Post</div>
                <div class="igc-detail-grid">
                    <div class="igc-detail-item"><span class="igc-detail-key">Media ID</span><span class="igc-detail-val igc-mono">${escapeHtml(c.media_id || '—')}</span></div>
                </div>
            </div>

            <div class="igc-detail-section">
                <div class="igc-detail-label">Intelligence</div>
                <div class="igc-detail-grid">
                    <div class="igc-detail-item"><span class="igc-detail-key">Intent</span><span class="igc-detail-val"><strong>${escapeHtml(intentLabel(c.detected_intent))}</strong></span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Confidence</span><span class="igc-detail-val"><strong>${confidencePct(c.confidence)}</strong></span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Sentiment</span><span class="igc-detail-val"><strong>${escapeHtml(c.sentiment || 'neutral')}</strong></span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Status</span><span class="igc-detail-val"><span class="igc-badge ${status.cls}">${status.label}</span></span></div>
                </div>
            </div>

            <div class="igc-detail-section">
                <div class="igc-detail-label">Automation</div>
                <div class="igc-detail-grid">
                    <div class="igc-detail-item"><span class="igc-detail-key">Action</span><span class="igc-detail-val"><strong>${escapeHtml(c.automation_action || 'none')}</strong></span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Public reply</span><span class="igc-detail-val"><strong>${c.public_reply_sent ? 'Yes' : 'No'}</strong></span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Private reply</span><span class="igc-detail-val"><strong>${c.private_reply_sent ? 'Yes' : 'No'}</strong></span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">DM started</span><span class="igc-detail-val"><strong>${c.dm_started ? 'Yes' : 'No'}</strong></span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Handled by</span><span class="igc-detail-val"><strong>${escapeHtml(c.handled_by || '—')}</strong></span></div>
                </div>
            </div>

            <div class="igc-detail-section">
                <div class="igc-detail-label">Linked Records</div>
                <div class="igc-detail-grid">
                    <div class="igc-detail-item"><span class="igc-detail-key">Ticket</span><span class="igc-detail-val">${c.ticket_number
                        ? `<strong>${escapeHtml(c.ticket_number)}</strong> <span class="igc-time">(${escapeHtml(c.ticket_status || 'open')})</span>`
                        : '<strong>None</strong>'}</span></div>
                    <div class="igc-detail-item"><span class="igc-detail-key">Conversation</span><span class="igc-detail-val"><strong>${c.conversation_id ? `#${c.conversation_id}` : 'None'}</strong></span></div>
                </div>
            </div>
        `;

        renderActionsFooter();
    }

    function renderActionsFooter() {
        const footer = document.getElementById('igCommentDetailFooter');
        const c = currentDetail;
        if (!footer || !c) return;

        const buttons = [
            '<button class="btn btn-primary" data-igc-action="reply">Reply (Public)</button>',
            '<button class="btn btn-secondary" data-igc-action="private">Private Reply</button>',
            '<button class="btn btn-secondary" data-igc-action="open-dm">Open DM</button>'
        ];

        if (!c.ticket_id) {
            buttons.push('<button class="btn btn-secondary" data-igc-action="ticket">Create Ticket</button>');
        }
        if (c.status !== 'resolved') {
            buttons.push('<button class="btn btn-secondary" data-igc-action="resolve">Resolve</button>');
        }
        if (c.status !== 'ignored') {
            buttons.push('<button class="btn btn-secondary" data-igc-action="ignore">Ignore</button>');
        }
        if (c.status !== 'spam') {
            buttons.push('<button class="btn btn-secondary" data-igc-action="spam">Mark Spam</button>');
        }

        footer.innerHTML = `<div class="igc-actions">${buttons.join('')}</div>`;
    }

    function renderReplyFooter(mode) {
        const footer = document.getElementById('igCommentDetailFooter');
        if (!footer) return;

        const placeholder = mode === 'public'
            ? 'Write a public reply — visible to everyone on the post...'
            : 'Write a private reply — sent as a DM to the commenter...';

        footer.innerHTML = `
            <div style="width: 100%;">
                <textarea id="igcReplyText" class="igc-reply-textarea" placeholder="${placeholder}"></textarea>
                <div class="igc-actions" style="justify-content: flex-end;">
                    <button class="btn btn-secondary" data-igc-action="cancel-reply">Cancel</button>
                    <button class="btn btn-primary" data-igc-action="send-reply">Send</button>
                </div>
            </div>`;
        document.getElementById('igcReplyText')?.focus();
    }

    // ─── Actions ──────────────────────────────────────────

    async function sendReply() {
        const c = currentDetail;
        const text = document.getElementById('igcReplyText')?.value?.trim();
        if (!c || !text) {
            showToast('Write a reply first', 'info');
            return;
        }

        const endpoint = replyMode === 'public' ? 'reply' : 'private-reply';
        try {
            const data = await apiFetch(`/ig-comments/${c.id}/${endpoint}`, { method: 'POST', body: { text } });
            if (data?.success) {
                showToast(replyMode === 'public' ? 'Public reply posted' : 'Private reply sent', 'success');
                replyMode = null;
                await refreshAfterAction(c.id);
            } else {
                showToast(data?.error === 'api_failed'
                    ? 'Instagram API rejected the reply'
                    : `Failed: ${data?.error || 'unknown error'}`, 'info');
            }
        } catch (error) {
            console.error('[Comments] reply failed:', error);
            showToast('Reply failed — try again', 'info');
        }
    }

    async function runAction(action) {
        const c = currentDetail;
        if (!c) return;

        try {
            if (action === 'ticket') {
                const data = await apiFetch(`/ig-comments/${c.id}/create-ticket`, { method: 'POST' });
                if (data?.success) {
                    showToast(data.existing
                        ? `Ticket already exists: ${data.ticketNumber}`
                        : `Ticket created: ${data.ticketNumber}`, 'success');
                    await refreshAfterAction(c.id);
                } else {
                    showToast(`Failed: ${data?.error || 'unknown error'}`, 'info');
                }
                return;
            }

            if (action === 'open-dm') {
                const data = await apiFetch(`/ig-comments/${c.id}/open-dm`, { method: 'POST' });
                if (data?.success) {
                    showToast(`DM sent via ${data.via === 'dm' ? 'direct message' : 'private reply'}`, 'success');
                    await refreshAfterAction(c.id);
                } else {
                    showToast(data?.error === 'dm_blocked'
                        ? 'DM blocked — messaging window expired and private reply unavailable'
                        : `Failed: ${data?.error || 'unknown error'}`, 'info');
                }
                return;
            }

            // ignore / spam / resolve
            const data = await apiFetch(`/ig-comments/${c.id}/${action}`, { method: 'POST' });
            if (data?.success) {
                showToast(action === 'ignore' ? 'Marked ignored' : action === 'spam' ? 'Marked spam' : 'Marked resolved', 'success');
                closeDetail();
                await Promise.all([loadStats(), loadComments()]);
            } else {
                showToast(`Failed: ${data?.error || 'unknown error'}`, 'info');
            }
        } catch (error) {
            console.error('[Comments] action failed:', error);
            showToast('Action failed — try again', 'info');
        }
    }

    async function refreshAfterAction(commentId) {
        await Promise.all([loadStats(), loadComments()]);
        // Reload the detail view with fresh data
        try {
            const data = await apiFetch(`/ig-comments/${commentId}`);
            if (data?.success && data?.comment) {
                currentDetail = data.comment;
                renderDetail();
            }
        } catch (e) { /* modal may have been closed */ }
    }

    // ─── Event Wiring ─────────────────────────────────────

    function bind() {
        document.getElementById('igcRefreshBtn')?.addEventListener('click', load);

        document.getElementById('igcStatusFilter')?.addEventListener('change', () => { page = 1; loadComments(); });
        document.getElementById('igcIntentFilter')?.addEventListener('change', () => { page = 1; loadComments(); });
        document.getElementById('igcDateFrom')?.addEventListener('change', () => { page = 1; loadComments(); });
        document.getElementById('igcDateTo')?.addEventListener('change', () => { page = 1; loadComments(); });

        document.getElementById('igcSearchInput')?.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => { page = 1; loadComments(); }, 300);
        });

        document.getElementById('igcPrevBtn')?.addEventListener('click', () => {
            if (page > 1) { page--; loadComments(); }
        });
        document.getElementById('igcNextBtn')?.addEventListener('click', () => {
            if (page < totalPages) { page++; loadComments(); }
        });

        // Row click → detail
        document.getElementById('igCommentsList')?.addEventListener('click', (e) => {
            const row = e.target.closest('.igc-row');
            if (row?.dataset.id) openDetail(parseInt(row.dataset.id, 10));
        });

        // Footer action buttons
        document.getElementById('igCommentDetailFooter')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-igc-action]');
            if (!btn) return;
            const action = btn.dataset.igcAction;

            switch (action) {
                case 'reply':
                case 'private':
                    replyMode = action === 'reply' ? 'public' : 'private';
                    renderReplyFooter(replyMode);
                    break;
                case 'cancel-reply':
                    replyMode = null;
                    renderActionsFooter();
                    break;
                case 'send-reply':
                    sendReply();
                    break;
                case 'ticket':
                case 'open-dm':
                case 'ignore':
                case 'spam':
                case 'resolve':
                    runAction(action);
                    break;
            }
        });
    }

    // ─── Helpers ──────────────────────────────────────────

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function intentLabel(intent) {
        if (!intent) return 'unknown';
        return String(intent).replace(/_/g, ' ');
    }

    function confidencePct(conf) {
        if (conf === null || conf === undefined) return '—';
        return `${Math.round(parseFloat(conf) * 100)}%`;
    }

    function timeAgo(dateStr) {
        if (!dateStr) return '';
        const then = new Date(dateStr).getTime();
        if (isNaN(then)) return '';
        const diff = Date.now() - then;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(dateStr).toLocaleDateString('en-IN');
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN');
    }

    // ─── Init ─────────────────────────────────────────────

    function populateIntentFilter() {
        if (intentsPopulated) return;
        const select = document.getElementById('igcIntentFilter');
        if (!select) return;
        for (const intent of INTENTS) {
            const opt = document.createElement('option');
            opt.value = intent;
            opt.textContent = intentLabel(intent);
            select.appendChild(opt);
        }
        intentsPopulated = true;
    }

    document.addEventListener('DOMContentLoaded', () => {
        populateIntentFilter();
        bind();
    });

    return { load };

})();
