/**
 * AI Copilot Pro — Training Section
 *
 * Learned replies manager with quality scoring, table view, inline editing,
 * bulk actions, CSV/JSON import, test retrieval mode, expanded AI behavior
 * settings, and conversation-to-training pipeline.
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'training';
    let initialized = false;
    let selectedIds = new Set();
    let currentTab = 'replies'; // replies | golden | settings | test

    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
    #section-training { padding: 24px; gap: 20px; overflow-y: auto; }
    .training-tabs { display: flex; gap: 4px; background: var(--bg-secondary); border-radius: var(--radius); padding: 4px; width: fit-content; }
    .training-tab { padding: 8px 16px; border-radius: var(--radius-sm); border: none; background: transparent; color: var(--text-secondary); font-size: 13px; font-weight: 500; cursor: pointer; }
    .training-tab.active { background: var(--accent); color: #fff; }
    .training-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .training-toolbar .input-field { max-width: 300px; }
    .training-table-wrap { overflow-x: auto; flex: 1; }
    .training-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .training-table th { text-align: left; padding: 10px 12px; background: var(--bg-secondary); color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1; }
    .training-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; max-width: 300px; }
    .training-table tr:hover td { background: var(--bg-input); }
    .training-table .q-cell { font-weight: 500; color: var(--text-primary); word-break: break-word; }
    .training-table .a-cell { color: var(--text-secondary); word-break: break-word; font-size: 12.5px; }
    .training-table .num-cell { text-align: center; color: var(--text-muted); font-size: 12px; }
    .training-table .actions-cell { white-space: nowrap; }
    .training-table .actions-cell button { background: none; border: none; color: var(--text-muted); padding: 4px 6px; font-size: 12px; cursor: pointer; border-radius: 4px; }
    .training-table .actions-cell button:hover { background: var(--bg-input); color: var(--text-primary); }
    .training-table input[type="checkbox"] { accent-color: var(--accent); }
    .training-bulk-bar { display: none; padding: 10px 16px; background: var(--accent-bg); border-radius: var(--radius-sm); align-items: center; gap: 10px; font-size: 13px; }
    .training-bulk-bar.show { display: flex; }
    .training-bulk-bar button { padding: 6px 12px; border-radius: var(--radius-sm); border: none; font-size: 12px; font-weight: 600; cursor: pointer; }
    .placeholder-var { background: rgba(99,102,241,.2); color: var(--accent-hover); padding: 1px 6px; border-radius: 4px; font-size: 12px; font-family: monospace; }

    /* Quality score badge */
    .quality-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; }
    .quality-high { background: rgba(34,197,94,.12); color: #22c55e; }
    .quality-mid { background: rgba(245,158,11,.12); color: #f59e0b; }
    .quality-low { background: rgba(239,68,68,.12); color: #ef4444; }
    .tr-row-high td { border-left: 3px solid rgba(34,197,94,.3); }
    .tr-row-mid td { border-left: 3px solid rgba(245,158,11,.2); }
    .tr-row-low td { border-left: 3px solid rgba(239,68,68,.2); }

    /* Test mode */
    .test-panel { display: flex; flex-direction: column; gap: 16px; }
    .test-input-row { display: flex; gap: 10px; }
    .test-input-row .input-field { flex: 1; }
    .test-results { display: flex; flex-direction: column; gap: 10px; }
    .test-result-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
    .test-result-q { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
    .test-result-a { color: var(--text-secondary); font-size: 13px; }
    .test-result-score { font-size: 11px; color: var(--text-muted); margin-top: 6px; }

    /* Settings */
    .settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .setting-item { display: flex; align-items: center; justify-content: space-between; padding: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); }
    .setting-label { font-size: 13px; font-weight: 500; }
    .setting-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .toggle-switch { position: relative; width: 44px; height: 24px; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; inset: 0; background: var(--bg-input); border-radius: 24px; cursor: pointer; transition: .2s; border: 1px solid var(--border); }
    .toggle-slider:before { content: ''; position: absolute; height: 18px; width: 18px; left: 2px; bottom: 2px; background: var(--text-muted); border-radius: 50%; transition: .2s; }
    .toggle-switch input:checked + .toggle-slider { background: var(--accent-bg); border-color: var(--accent); }
    .toggle-switch input:checked + .toggle-slider:before { transform: translateX(20px); background: var(--accent); }
    .setting-input { width: 80px; text-align: center; }
    .setting-select { width: 120px; font-size: 12px; padding: 6px 8px; }

    /* Import modal */
    .import-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 200; display: flex; align-items: center; justify-content: center; }
    .import-modal { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; width: 480px; max-width: 90vw; max-height: 80vh; overflow-y: auto; }
    .import-modal h3 { margin-bottom: 12px; }
    .import-modal textarea { width: 100%; min-height: 200px; }
    .import-modal .btns { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
    `;
    document.head.appendChild(style);

    // ── Render ──
    function render() {
        const root = document.getElementById('section-training');
        root.innerHTML = `
        <div class="training-tabs">
            <button class="training-tab active" data-tab="replies">Learned Replies</button>
            <button class="training-tab" data-tab="golden">Golden Examples</button>
            <button class="training-tab" data-tab="test">Test Mode</button>
            <button class="training-tab" data-tab="settings">AI Settings</button>
        </div>
        <div id="trainingContent"></div>`;

        root.querySelectorAll('.training-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                root.querySelectorAll('.training-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentTab = tab.dataset.tab;
                renderTab();
            });
        });
        renderTab();

        // Check if we were sent here from conversations with a prefill
        checkPrefill();
    }

    function renderTab() {
        const content = document.getElementById('trainingContent');
        if (!content) return;
        switch (currentTab) {
            case 'replies': renderReplies(content); break;
            case 'golden': renderGolden(content); break;
            case 'test': renderTest(content); break;
            case 'settings': renderSettings(content); break;
        }
    }

    // ── Learned Replies ──
    async function renderReplies(container) {
        container.innerHTML = `
        <div class="training-toolbar">
            <input class="input-field" id="trSearch" placeholder="Search replies…">
            <button class="btn-primary" id="trAddBtn">+ Add Example</button>
            <button class="btn-secondary" id="trImportBtn">Import CSV/JSON</button>
            <button class="btn-secondary" id="trExportBtn">Export</button>
        </div>
        <div class="training-bulk-bar" id="trBulkBar">
            <span id="trBulkCount">0 selected</span>
            <button class="btn-secondary" id="trBulkPin">Pin</button>
            <button class="btn-secondary" id="trBulkUnpin">Unpin</button>
            <button class="btn-danger" id="trBulkDelete">Delete</button>
        </div>
        <div class="training-table-wrap">
            <table class="training-table">
                <thead><tr>
                    <th style="width:30px;"><input type="checkbox" id="trSelectAll"></th>
                    <th>Question Pattern</th>
                    <th>Approved Reply</th>
                    <th style="width:70px;">Quality</th>
                    <th style="width:60px;">Uses</th>
                    <th style="width:60px;">Boost</th>
                    <th style="width:60px;">Pinned</th>
                    <th style="width:140px;">Actions</th>
                </tr></thead>
                <tbody id="trBody"><tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted);"><span class="loading-spinner"></span> Loading…</td></tr></tbody>
            </table>
        </div>`;

        let searchTimer;
        document.getElementById('trSearch').addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => loadReplies(), 350);
        });
        document.getElementById('trAddBtn').addEventListener('click', showAddDialog);
        document.getElementById('trImportBtn').addEventListener('click', showImportDialog);
        document.getElementById('trExportBtn').addEventListener('click', exportReplies);
        document.getElementById('trSelectAll').addEventListener('change', toggleSelectAll);
        document.getElementById('trBulkPin').addEventListener('click', () => bulkAction('pin'));
        document.getElementById('trBulkUnpin').addEventListener('click', () => bulkAction('unpin'));
        document.getElementById('trBulkDelete').addEventListener('click', () => bulkAction('delete'));
        loadReplies();
    }

    let cachedReplies = [];

    /**
     * Compute a quality score (0-100) for a learned reply based on:
     * - uses (higher = better, capped at 20 uses = max score)
     * - resolved_boost (direct multiplier)
     * - recency (updated_at within 30 days = full, 60 days = half, older = low)
     * - pinned (small bonus)
     */
    function computeQualityScore(r) {
        let score = 0;
        // Uses component: 0-35 points (log scale, max at 20 uses)
        const useScore = Math.min(35, Math.log2(1 + (r.uses || 0)) * 7);
        score += useScore;
        // Resolved boost: 0-30 points
        score += Math.min(30, (r.resolved_boost || 0) * 3);
        // Recency: 0-25 points
        if (r.updated_at) {
            const daysAgo = (Date.now() - new Date(r.updated_at).getTime()) / 86400000;
            if (daysAgo < 30) score += 25;
            else if (daysAgo < 60) score += 15;
            else if (daysAgo < 90) score += 8;
        } else {
            score += 5;
        }
        // Pinned bonus: 0-10 points
        if (r.pinned) score += 10;
        return Math.min(100, Math.round(score));
    }

    async function loadReplies() {
        const search = document.getElementById('trSearch')?.value || '';
        const body = document.getElementById('trBody');
        if (!body) return;
        try {
            const data = await CP.apiFetch(`/ai/learned?search=${encodeURIComponent(search)}`);
            cachedReplies = data.learned || [];
            selectedIds.clear();
            updateBulkBar();
            if (!cachedReplies.length) {
                body.innerHTML = '<tr><td colspan="8" class="empty-state"><p>No learned replies yet. They appear automatically as your team replies to customers.</p></td></tr>';
                return;
            }
            body.innerHTML = '';
            cachedReplies.forEach(r => body.appendChild(renderReplyRow(r)));
        } catch (e) {
            body.innerHTML = `<tr><td colspan="8" style="color:var(--danger);text-align:center;padding:16px;">${e.message}</td></tr>`;
        }
    }

    function renderReplyRow(r) {
        const tr = document.createElement('tr');
        tr.dataset.id = r.id;
        const quality = computeQualityScore(r);
        const qClass = quality >= 70 ? 'quality-high' : quality >= 40 ? 'quality-mid' : 'quality-low';
        const rowClass = quality >= 70 ? 'tr-row-high' : quality >= 40 ? 'tr-row-mid' : 'tr-row-low';
        tr.className = rowClass;

        tr.innerHTML = `
        <td><input type="checkbox" class="tr-check" data-id="${r.id}"></td>
        <td class="q-cell">${highlightVars(escapeHtml(r.customer_question))}</td>
        <td class="a-cell">${escapeHtml(r.agent_reply).substring(0, 200)}${r.agent_reply.length > 200 ? '…' : ''}</td>
        <td class="num-cell"><span class="quality-badge ${qClass}">${quality}</span></td>
        <td class="num-cell">${r.uses}</td>
        <td class="num-cell">${r.resolved_boost || 0}</td>
        <td class="num-cell">${r.pinned ? '&#x1F4CC;' : ''}</td>
        <td class="actions-cell">
            <button title="Edit" data-act="edit">Edit</button>
            <button title="${r.pinned ? 'Unpin' : 'Pin'}" data-act="pin">${r.pinned ? 'Unpin' : 'Pin'}</button>
            <button title="Retire" data-act="retire" style="color:var(--warning);">Retire</button>
            <button title="Delete" data-act="delete" style="color:var(--danger);">Del</button>
        </td>`;
        tr.querySelector('[data-act="edit"]').onclick = () => editReply(r);
        tr.querySelector('[data-act="pin"]').onclick = async () => {
            await CP.apiFetch(`/ai/learned/${r.id}`, 'PUT', { pinned: !r.pinned });
            loadReplies();
        };
        tr.querySelector('[data-act="retire"]').onclick = async () => {
            if (!confirm('Retire this learned reply? It will be unpinned and its boost set to 0.')) return;
            await CP.apiFetch(`/ai/learned/${r.id}`, 'PUT', { pinned: false, resolved_boost: 0 });
            loadReplies();
        };
        tr.querySelector('[data-act="delete"]').onclick = async () => {
            if (!confirm('Delete this learned reply?')) return;
            await CP.apiFetch(`/ai/learned/${r.id}`, 'DELETE');
            tr.remove();
        };
        tr.querySelector('.tr-check').addEventListener('change', (e) => {
            if (e.target.checked) selectedIds.add(r.id); else selectedIds.delete(r.id);
            updateBulkBar();
        });
        return tr;
    }

    function highlightVars(text) {
        return text.replace(/\{\{(\w+)\}\}/g, '<span class="placeholder-var">{{$1}}</span>');
    }

    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function updateBulkBar() {
        const bar = document.getElementById('trBulkBar');
        const count = document.getElementById('trBulkCount');
        if (!bar || !count) return;
        bar.classList.toggle('show', selectedIds.size > 0);
        count.textContent = `${selectedIds.size} selected`;
    }

    function toggleSelectAll(e) {
        document.querySelectorAll('.tr-check').forEach(cb => {
            cb.checked = e.target.checked;
            const id = parseInt(cb.dataset.id);
            if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
        });
        updateBulkBar();
    }

    async function bulkAction(action) {
        if (!selectedIds.size) return;
        const ids = [...selectedIds];
        if (action === 'delete' && !confirm(`Delete ${ids.length} replies?`)) return;
        for (const id of ids) {
            try {
                if (action === 'pin') await CP.apiFetch(`/ai/learned/${id}`, 'PUT', { pinned: true });
                else if (action === 'unpin') await CP.apiFetch(`/ai/learned/${id}`, 'PUT', { pinned: false });
                else if (action === 'delete') await CP.apiFetch(`/ai/learned/${id}`, 'DELETE');
            } catch (e) { /* continue */ }
        }
        selectedIds.clear();
        loadReplies();
    }

    async function editReply(r) {
        const q = prompt('Customer question pattern:', r.customer_question);
        if (q === null) return;
        const a = prompt('Approved reply:', r.agent_reply);
        if (a === null) return;
        try {
            await CP.apiFetch(`/ai/learned/${r.id}`, 'PUT', { question: q, reply: a });
            loadReplies();
        } catch (e) { alert(e.message); }
    }

    function showAddDialog(prefillQ, prefillA) {
        const q = prompt('Customer question pattern (use {{order_id}}, {{name}} for variables):', prefillQ || '');
        if (!q) return;
        const a = prompt('Ideal approved reply:', prefillA || '');
        if (!a) return;
        CP.apiFetch('/ai/learned', 'POST', { question: q, reply: a, pinned: true })
            .then(() => loadReplies())
            .catch(e => alert(e.message));
    }

    /**
     * Check if we arrived from the Conversations section with prefill data.
     */
    function checkPrefill() {
        try {
            const params = new URLSearchParams(location.hash.split('?')[1] || '');
            const prefillQ = params.get('prefill_q');
            const prefillA = params.get('prefill_a');
            if (prefillQ && prefillA) {
                // Clean the URL
                history.replaceState(null, '', location.hash.split('?')[0]);
                setTimeout(() => showAddDialog(decodeURIComponent(prefillQ), decodeURIComponent(prefillA)), 300);
            }
        } catch (e) { /* ignore */ }
    }

    function showImportDialog() {
        const overlay = document.createElement('div');
        overlay.className = 'import-overlay';
        overlay.innerHTML = `
        <div class="import-modal">
            <h3>Import Learned Replies</h3>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Paste JSON array of {question, reply} objects, or CSV with question,reply columns.</p>
            <textarea class="input-field" id="importData" placeholder='[{"question":"Where is my order?","reply":"Let me check {{order_id}} for you…"}]'></textarea>
            <div class="btns">
                <button class="btn-secondary" id="importCancel">Cancel</button>
                <button class="btn-primary" id="importSubmit">Import</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#importCancel').onclick = () => overlay.remove();
        overlay.querySelector('#importSubmit').onclick = async () => {
            const raw = overlay.querySelector('#importData').value.trim();
            let items = [];
            try {
                items = JSON.parse(raw);
            } catch {
                const lines = raw.split('\n').filter(l => l.trim());
                const header = lines[0].toLowerCase();
                const startIdx = header.includes('question') ? 1 : 0;
                for (let i = startIdx; i < lines.length; i++) {
                    const parts = lines[i].split(',');
                    if (parts.length >= 2) {
                        items.push({ question: parts[0].trim().replace(/^"|"$/g, ''), reply: parts.slice(1).join(',').trim().replace(/^"|"$/g, '') });
                    }
                }
            }
            if (!items.length) { alert('No valid items found'); return; }
            try {
                const data = await CP.apiFetch('/ai/learned/import', 'POST', { items });
                overlay.remove();
                alert(`Imported ${data.imported} replies${data.errors?.length ? ` (${data.errors.length} errors)` : ''}`);
                loadReplies();
            } catch (e) { alert(e.message); }
        };
    }

    function exportReplies() {
        const json = JSON.stringify(cachedReplies.map(r => ({ question: r.customer_question, reply: r.agent_reply, pinned: !!r.pinned })), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'learned-replies.json'; a.click();
        URL.revokeObjectURL(url);
    }

    // ── Golden Examples ──
    function renderGolden(container) {
        container.innerHTML = `
        <div class="card">
            <div class="card-header"><h3>Golden Examples</h3><button class="btn-primary" id="goldenAdd">+ Add Golden Example</button></div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Hand-curated, pinned examples with variable placeholders. These always rank first in AI retrieval.</p>
            <div id="goldenList" style="display:flex;flex-direction:column;gap:10px;"><span class="loading-spinner"></span> Loading…</div>
        </div>`;
        document.getElementById('goldenAdd').onclick = () => showAddDialog();
        loadGolden();
    }

    async function loadGolden() {
        const list = document.getElementById('goldenList');
        if (!list) return;
        try {
            const data = await CP.apiFetch('/ai/learned?search=&limit=50');
            const golden = (data.learned || []).filter(r => r.pinned);
            if (!golden.length) {
                list.innerHTML = '<div class="empty-state"><p>No golden examples yet. Pin learned replies or add new ones.</p></div>';
                return;
            }
            list.innerHTML = '';
            golden.forEach(r => {
                const quality = computeQualityScore(r);
                const qClass = quality >= 70 ? 'quality-high' : quality >= 40 ? 'quality-mid' : 'quality-low';
                const card = document.createElement('div');
                card.className = 'card';
                card.style.marginBottom = '0';
                card.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:start;">
                    <div style="flex:1;">
                        <div style="font-weight:600;font-size:13px;margin-bottom:6px;">${highlightVars(escapeHtml(r.customer_question))}</div>
                        <div style="color:var(--text-secondary);font-size:13px;">${highlightVars(escapeHtml(r.agent_reply))}</div>
                        <div style="display:flex;gap:10px;align-items:center;margin-top:6px;">
                            <span style="font-size:11px;color:var(--text-muted);">Used ${r.uses} times</span>
                            <span class="quality-badge ${qClass}">Quality: ${quality}</span>
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;">
                        <button class="btn-secondary" style="padding:4px 10px;font-size:12px;" data-act="edit">Edit</button>
                        <button class="btn-secondary" style="padding:4px 10px;font-size:12px;color:var(--danger);" data-act="del">Delete</button>
                    </div>
                </div>`;
                card.querySelector('[data-act="edit"]').onclick = () => editReply(r).then(() => loadGolden());
                card.querySelector('[data-act="del"]').onclick = async () => {
                    if (!confirm('Delete?')) return;
                    await CP.apiFetch(`/ai/learned/${r.id}`, 'DELETE');
                    loadGolden();
                };
                list.appendChild(card);
            });
        } catch (e) {
            list.innerHTML = `<div style="color:var(--danger);">${e.message}</div>`;
        }
    }

    // ── Test Mode ──
    function renderTest(container) {
        container.innerHTML = `
        <div class="card test-panel">
            <h3>Test Retrieval</h3>
            <p style="font-size:13px;color:var(--text-muted);">Type a customer question to see which learned examples the AI would retrieve and use for generating replies.</p>
            <div class="test-input-row">
                <input class="input-field" id="testQuestion" placeholder="e.g. Where is my order #1234?">
                <button class="btn-primary" id="testBtn">Test</button>
            </div>
            <div class="test-results" id="testResults"></div>
        </div>`;
        document.getElementById('testBtn').onclick = runTest;
        document.getElementById('testQuestion').addEventListener('keydown', e => {
            if (e.key === 'Enter') runTest();
        });
    }

    async function runTest() {
        const q = document.getElementById('testQuestion').value.trim();
        if (!q) return;
        const results = document.getElementById('testResults');
        results.innerHTML = '<span class="loading-spinner"></span> Searching…';
        try {
            const data = await CP.apiFetch(`/ai/learned/test?question=${encodeURIComponent(q)}`);
            const examples = data.examples || [];
            if (!examples.length) {
                results.innerHTML = '<div class="empty-state"><p>No matching examples found. Try adding more learned replies.</p></div>';
                return;
            }
            results.innerHTML = '';
            examples.forEach((ex, i) => {
                const card = document.createElement('div');
                card.className = 'test-result-card';
                card.innerHTML = `
                <div style="font-size:11px;color:var(--accent-hover);margin-bottom:4px;">Match #${i + 1}</div>
                <div class="test-result-q">${highlightVars(escapeHtml(ex.q))}</div>
                <div class="test-result-a">${highlightVars(escapeHtml(ex.a))}</div>
                <div class="test-result-score">Used ${ex.uses} times</div>`;
                results.appendChild(card);
            });
        } catch (e) {
            results.innerHTML = `<div style="color:var(--danger);">${e.message}</div>`;
        }
    }

    // ── AI Settings (Expanded) ──
    function renderSettings(container) {
        container.innerHTML = `
        <div style="margin-bottom:12px;font-size:13px;color:var(--text-muted);">Configure AI behavior for the customer chatbot and admin copilot.</div>
        <div class="settings-grid">
            <!-- Existing settings -->
            <div class="setting-item">
                <div><div class="setting-label">AI Copilot Enabled</div><div class="setting-desc">Master toggle for all AI features</div></div>
                <label class="toggle-switch"><input type="checkbox" id="setCopilotOn" checked><span class="toggle-slider"></span></label>
            </div>
            <div class="setting-item">
                <div><div class="setting-label">AI Learning</div><div class="setting-desc">Auto-learn from agent replies</div></div>
                <label class="toggle-switch"><input type="checkbox" id="setLearningOn" checked><span class="toggle-slider"></span></label>
            </div>
            <div class="setting-item">
                <div><div class="setting-label">Daily Chat Limit</div><div class="setting-desc">Max AI chat requests per admin per day</div></div>
                <input class="input-field setting-input" type="number" id="setDailyLimit" value="200">
            </div>
            <div class="setting-item">
                <div><div class="setting-label">Daily Suggestion Limit</div><div class="setting-desc">Max reply suggestions per day (shared)</div></div>
                <input class="input-field setting-input" type="number" id="setSuggestLimit" value="100">
            </div>

            <!-- New Phase 5 settings -->
            <div class="setting-item">
                <div><div class="setting-label">Customer Chatbot</div><div class="setting-desc">Enable AI auto-responses for widget & WhatsApp customers</div></div>
                <label class="toggle-switch"><input type="checkbox" id="setChatbotOn" checked><span class="toggle-slider"></span></label>
            </div>
            <div class="setting-item">
                <div><div class="setting-label">Sentiment Auto-Escalation</div><div class="setting-desc">Auto-escalate tickets when customer sentiment is frustrated</div></div>
                <label class="toggle-switch"><input type="checkbox" id="setSentEscOn" checked><span class="toggle-slider"></span></label>
            </div>
            <div class="setting-item">
                <div><div class="setting-label">Min Confidence Threshold</div><div class="setting-desc">Below this %, AI will escalate instead of auto-responding</div></div>
                <input class="input-field setting-input" type="number" id="setMinConf" value="60" min="0" max="100" step="5">
            </div>
            <div class="setting-item">
                <div><div class="setting-label">Default Language</div><div class="setting-desc">Preferred language for AI responses</div></div>
                <select class="input-field setting-select" id="setDefLang">
                    <option value="auto">Auto-detect</option>
                    <option value="en">English</option>
                    <option value="hi">Hindi</option>
                </select>
            </div>
            <div class="setting-item">
                <div><div class="setting-label">Max Auto-Response Rounds</div><div class="setting-desc">Max AI replies before escalating to human</div></div>
                <input class="input-field setting-input" type="number" id="setMaxRounds" value="5" min="1" max="20">
            </div>
            <div class="setting-item" style="grid-column: 1 / -1;">
                <div style="flex:1;"><div class="setting-label">Widget Welcome Message</div><div class="setting-desc">Custom greeting shown when customers open the chat widget</div></div>
                <input class="input-field" type="text" id="setWelcomeMsg" value="" placeholder="Hey there! How can I help you today?" style="width:300px;margin-top:8px;">
            </div>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;">
            <button class="btn-primary" id="setSaveBtn">Save Settings</button>
            <span id="setSaveStatus" style="font-size:12px;color:var(--text-muted);align-self:center;"></span>
        </div>`;

        loadSettings();
        document.getElementById('setSaveBtn').addEventListener('click', saveSettings);
    }

    async function loadSettings() {
        try {
            const data = await CP.apiFetch('/ai/usage');
            // Settings are loaded from system_settings via the usage endpoint
            // In production, a dedicated GET /ai/settings endpoint would populate these
        } catch (e) { /* use defaults */ }
    }

    async function saveSettings() {
        const btn = document.getElementById('setSaveBtn');
        const status = document.getElementById('setSaveStatus');
        btn.textContent = 'Saving…';
        status.textContent = '';
        try {
            await CP.apiFetch('/ai/settings', 'PUT', {
                ai_admin_copilot_enabled: document.getElementById('setCopilotOn').checked ? 'true' : 'false',
                ai_learning_enabled: document.getElementById('setLearningOn').checked ? 'true' : 'false',
                ai_daily_admin_limit: document.getElementById('setDailyLimit').value,
                ai_suggest_reply_daily_limit: document.getElementById('setSuggestLimit').value,
                // New settings
                ai_customer_chatbot_enabled: document.getElementById('setChatbotOn').checked ? 'true' : 'false',
                ai_sentiment_auto_escalation: document.getElementById('setSentEscOn').checked ? 'true' : 'false',
                ai_min_confidence_threshold: document.getElementById('setMinConf').value,
                ai_default_language: document.getElementById('setDefLang').value,
                ai_max_auto_rounds: document.getElementById('setMaxRounds').value,
                ai_widget_welcome_message: document.getElementById('setWelcomeMsg').value
            });
            btn.textContent = 'Saved!';
            status.textContent = 'All settings saved successfully.';
            status.style.color = 'var(--success)';
            setTimeout(() => { btn.textContent = 'Save Settings'; status.textContent = ''; }, 3000);
        } catch (e) {
            btn.textContent = 'Error';
            status.textContent = e.message;
            status.style.color = 'var(--danger)';
        }
    }

    // ── Lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
            else {
                renderTab();
                checkPrefill();
            }
        }
    });
})();
