/**
 * AI Copilot Pro — Workflows Section
 *
 * Visual rule builder: "When [trigger] then [AI action]"
 * CRUD for automation rules with toggle on/off.
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'workflows';
    let initialized = false;

    const TRIGGERS = {
        new_ticket: { label: 'New ticket created', icon: '&#x1F4E9;', fields: [] },
        stale_ticket: { label: 'Ticket unresolved for X hours', icon: '&#x23F0;', fields: [{ key: 'thresholdHours', label: 'Hours threshold', type: 'number', default: 48 }] },
        vip_message: { label: 'Message from VIP customer', icon: '&#x2B50;', fields: [{ key: 'vipPhones', label: 'VIP phones (comma-sep)', type: 'text', default: '' }] },
        shipment_delivered: { label: 'Shipment delivered', icon: '&#x1F4E6;', fields: [] },
        cart_abandoned: { label: 'New abandoned cart', icon: '&#x1F6D2;', fields: [{ key: 'minAmount', label: 'Min cart amount', type: 'number', default: 0 }] }
    };

    const ACTIONS = {
        auto_reply: { label: 'Send auto-reply (WhatsApp)', icon: '&#x1F4AC;', fields: [{ key: 'message', label: 'Reply message', type: 'textarea', default: 'Thank you for reaching out! Our team will get back to you shortly.' }] },
        update_ticket: { label: 'Update ticket status', icon: '&#x2705;', fields: [{ key: 'status', label: 'New status', type: 'select', options: ['resolved', 'closed', 'open'], default: 'resolved' }] },
        notify_admin: { label: 'Notify admin', icon: '&#x1F514;', fields: [{ key: 'message', label: 'Notification message', type: 'text', default: 'Workflow triggered — please review.' }] },
        book_shipment: { label: 'Book shipment', icon: '&#x1F69A;', fields: [{ key: 'carrier', label: 'Carrier', type: 'select', options: ['delhivery', 'shiprocket'], default: 'delhivery' }] },
        create_broadcast: { label: 'Create broadcast draft', icon: '&#x1F4E2;', fields: [
            { key: 'title', label: 'Campaign title', type: 'text', default: 'Auto campaign' },
            { key: 'message', label: 'Message', type: 'textarea', default: '' },
            { key: 'segment', label: 'Segment', type: 'select', options: ['all', 'pending_orders', 'delivered'], default: 'all' }
        ]}
    };

    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
    #section-workflows { padding: 24px; gap: 20px; overflow-y: auto; }
    .wf-header { display: flex; justify-content: space-between; align-items: center; }
    .wf-list { display: flex; flex-direction: column; gap: 12px; }
    .wf-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: flex; gap: 16px; align-items: flex-start; }
    .wf-card.disabled { opacity: .5; }
    .wf-card-body { flex: 1; }
    .wf-card-name { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .wf-card-rule { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 8px; flex-wrap: wrap; }
    .wf-chip { padding: 4px 10px; border-radius: 16px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
    .wf-chip.trigger { background: rgba(99,102,241,.12); color: var(--accent-hover); }
    .wf-chip.action { background: rgba(34,197,94,.12); color: var(--success); }
    .wf-arrow { color: var(--text-muted); font-size: 16px; }
    .wf-meta { font-size: 11px; color: var(--text-muted); }
    .wf-card-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .wf-card-actions button { background: var(--bg-input); border: 1px solid var(--border); color: var(--text-secondary); padding: 6px 10px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; }
    .wf-card-actions button:hover { background: rgba(255,255,255,.1); color: var(--text-primary); }
    .wf-card-actions button.del:hover { color: var(--danger); }

    /* Editor modal */
    .wf-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 200; display: flex; align-items: center; justify-content: center; }
    .wf-modal { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; width: 520px; max-width: 90vw; max-height: 85vh; overflow-y: auto; }
    .wf-modal h3 { margin-bottom: 16px; }
    .wf-form-group { margin-bottom: 14px; }
    .wf-form-group label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px; font-weight: 500; }
    .wf-form-group textarea { min-height: 80px; }
    .wf-form-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
    `;
    document.head.appendChild(style);

    // ── Render ──
    function render() {
        const root = document.getElementById('section-workflows');
        root.innerHTML = `
        <div class="wf-header">
            <div>
                <h3 style="font-size:16px;font-weight:600;">Automation Workflows</h3>
                <p style="font-size:13px;color:var(--text-muted);margin-top:4px;">Define rules: when a trigger fires, the AI performs an action automatically.</p>
            </div>
            <button class="btn-primary" id="wfNewBtn">+ New Workflow</button>
        </div>
        <div class="wf-list" id="wfList"><span class="loading-spinner"></span> Loading…</div>`;

        document.getElementById('wfNewBtn').addEventListener('click', () => openEditor());
        loadWorkflows();
    }

    let cachedWorkflows = [];

    async function loadWorkflows() {
        const list = document.getElementById('wfList');
        if (!list) return;
        try {
            const data = await CP.apiFetch('/ai/workflows');
            cachedWorkflows = data.workflows || [];
            if (!cachedWorkflows.length) {
                list.innerHTML = '<div class="empty-state"><p style="font-size:14px;">No workflows yet. Create your first automation rule.</p></div>';
                return;
            }
            list.innerHTML = '';
            cachedWorkflows.forEach(wf => list.appendChild(renderWorkflowCard(wf)));
        } catch (e) {
            list.innerHTML = `<div style="color:var(--danger);">${e.message}</div>`;
        }
    }

    function renderWorkflowCard(wf) {
        const trigger = TRIGGERS[wf.trigger_type] || { label: wf.trigger_type, icon: '?' };
        const action = ACTIONS[wf.action_type] || { label: wf.action_type, icon: '?' };
        const card = document.createElement('div');
        card.className = `wf-card${wf.enabled ? '' : ' disabled'}`;
        const config = typeof wf.trigger_config === 'string' ? JSON.parse(wf.trigger_config) : (wf.trigger_config || {});
        const actionConfig = typeof wf.action_config === 'string' ? JSON.parse(wf.action_config) : (wf.action_config || {});

        card.innerHTML = `
        <div class="wf-card-body">
            <div class="wf-card-name">${escapeHtml(wf.name)}</div>
            <div class="wf-card-rule">
                <span class="wf-chip trigger">${trigger.icon} ${trigger.label}</span>
                <span class="wf-arrow">&rarr;</span>
                <span class="wf-chip action">${action.icon} ${action.label}</span>
            </div>
            <div class="wf-meta">Fired ${wf.fire_count || 0} times${wf.last_fired_at ? ` · Last: ${new Date(wf.last_fired_at).toLocaleDateString()}` : ''}</div>
        </div>
        <div class="wf-card-actions">
            <button data-act="toggle">${wf.enabled ? 'Disable' : 'Enable'}</button>
            <button data-act="edit">Edit</button>
            <button class="del" data-act="delete">Delete</button>
        </div>`;

        card.querySelector('[data-act="toggle"]').onclick = async () => {
            await CP.apiFetch(`/ai/workflows/${wf.id}`, 'PUT', { enabled: !wf.enabled });
            loadWorkflows();
        };
        card.querySelector('[data-act="edit"]').onclick = () => openEditor(wf);
        card.querySelector('[data-act="delete"]').onclick = async () => {
            if (!confirm('Delete this workflow?')) return;
            await CP.apiFetch(`/ai/workflows/${wf.id}`, 'DELETE');
            card.remove();
        };
        return card;
    }

    function openEditor(existing = null) {
        const overlay = document.createElement('div');
        overlay.className = 'wf-overlay';
        const isEdit = !!existing;
        const triggerConfig = existing ? (typeof existing.trigger_config === 'string' ? JSON.parse(existing.trigger_config) : existing.trigger_config || {}) : {};
        const actionConfig = existing ? (typeof existing.action_config === 'string' ? JSON.parse(existing.action_config) : existing.action_config || {}) : {};

        overlay.innerHTML = `
        <div class="wf-modal">
            <h3>${isEdit ? 'Edit' : 'New'} Workflow</h3>
            <div class="wf-form-group">
                <label>Name</label>
                <input class="input-field" id="wfName" value="${escapeHtml(existing?.name || '')}" placeholder="e.g. Auto-reply to new tickets">
            </div>
            <div class="wf-form-group">
                <label>Trigger</label>
                <select class="input-field" id="wfTrigger">
                    ${Object.entries(TRIGGERS).map(([k, v]) => `<option value="${k}" ${existing?.trigger_type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
            </div>
            <div id="wfTriggerFields"></div>
            <div class="wf-form-group">
                <label>Action</label>
                <select class="input-field" id="wfAction">
                    ${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}" ${existing?.action_type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
            </div>
            <div id="wfActionFields"></div>
            <div class="wf-form-btns">
                <button class="btn-secondary" id="wfCancel">Cancel</button>
                <button class="btn-primary" id="wfSave">${isEdit ? 'Update' : 'Create'}</button>
            </div>
        </div>`;

        document.body.appendChild(overlay);

        function renderTriggerFields() {
            const type = document.getElementById('wfTrigger').value;
            const fields = TRIGGERS[type]?.fields || [];
            const container = document.getElementById('wfTriggerFields');
            container.innerHTML = fields.map(f => `
            <div class="wf-form-group">
                <label>${f.label}</label>
                <input class="input-field" data-key="${f.key}" value="${triggerConfig[f.key] ?? f.default ?? ''}" type="${f.type === 'number' ? 'number' : 'text'}">
            </div>`).join('');
        }

        function renderActionFields() {
            const type = document.getElementById('wfAction').value;
            const fields = ACTIONS[type]?.fields || [];
            const container = document.getElementById('wfActionFields');
            container.innerHTML = fields.map(f => {
                if (f.type === 'select') {
                    return `<div class="wf-form-group"><label>${f.label}</label><select class="input-field" data-key="${f.key}">${f.options.map(o => `<option value="${o}" ${actionConfig[f.key] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
                } else if (f.type === 'textarea') {
                    return `<div class="wf-form-group"><label>${f.label}</label><textarea class="input-field" data-key="${f.key}">${escapeHtml(actionConfig[f.key] ?? f.default ?? '')}</textarea></div>`;
                }
                return `<div class="wf-form-group"><label>${f.label}</label><input class="input-field" data-key="${f.key}" value="${escapeHtml(actionConfig[f.key] ?? f.default ?? '')}" type="${f.type === 'number' ? 'number' : 'text'}"></div>`;
            }).join('');
        }

        renderTriggerFields();
        renderActionFields();

        document.getElementById('wfTrigger').addEventListener('change', renderTriggerFields);
        document.getElementById('wfAction').addEventListener('change', renderActionFields);

        overlay.querySelector('#wfCancel').onclick = () => overlay.remove();
        overlay.querySelector('#wfSave').onclick = async () => {
            const name = document.getElementById('wfName').value.trim();
            const trigger_type = document.getElementById('wfTrigger').value;
            const action_type = document.getElementById('wfAction').value;
            const tFields = {};
            document.querySelectorAll('#wfTriggerFields [data-key]').forEach(el => {
                tFields[el.dataset.key] = el.type === 'number' ? parseFloat(el.value) || 0 : el.value;
            });
            const aFields = {};
            document.querySelectorAll('#wfActionFields [data-key]').forEach(el => {
                aFields[el.dataset.key] = el.value;
            });
            const body = {
                name: name || `${TRIGGERS[trigger_type].label} → ${ACTIONS[action_type].label}`,
                trigger_type,
                trigger_config: tFields,
                action_type,
                action_config: aFields,
                enabled: true
            };
            try {
                if (isEdit) {
                    await CP.apiFetch(`/ai/workflows/${existing.id}`, 'PUT', body);
                } else {
                    await CP.apiFetch('/ai/workflows', 'POST', body);
                }
                overlay.remove();
                loadWorkflows();
            } catch (e) {
                alert(e.message);
            }
        };
    }

    function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    // ── Lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
        }
    });
})();
