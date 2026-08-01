/**
 * AI Copilot Pro — Actions Section
 *
 * Batch operations panel: bulk ticket updates, bulk WhatsApp, broadcast creator,
 * batch shipment booking, and smart ticket triage.
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'actions';
    let initialized = false;

    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
    #section-actions { padding: 24px; gap: 20px; overflow-y: auto; }
    .actions-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
    .action-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; display: flex; flex-direction: column; }
    .action-card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .action-card-header .icon { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
    .action-card-header h3 { font-size: 14px; font-weight: 600; }
    .action-card-header p { font-size: 12px; color: var(--text-muted); margin: 0; }
    .action-form { display: flex; flex-direction: column; gap: 10px; flex: 1; }
    .action-form label { font-size: 12px; color: var(--text-muted); font-weight: 500; }
    .action-form .row { display: flex; gap: 8px; }
    .action-form .row > * { flex: 1; }
    .action-result { margin-top: 12px; padding: 10px; border-radius: var(--radius-sm); font-size: 13px; display: none; }
    .action-result.show { display: block; }
    .action-result.success { background: rgba(34,197,94,.1); color: var(--success); border: 1px solid rgba(34,197,94,.2); }
    .action-result.error { background: rgba(239,68,68,.1); color: var(--danger); border: 1px solid rgba(239,68,68,.2); }
    .action-result.info { background: var(--accent-bg); color: var(--accent-hover); border: 1px solid rgba(99,102,241,.2); }

    /* Triage results */
    .triage-results { margin-top: 12px; }
    .triage-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .triage-cat { padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .triage-ticket { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--bg-input); border-radius: var(--radius-sm); margin-bottom: 6px; font-size: 12.5px; }
    .triage-ticket .cat { font-weight: 600; min-width: 100px; }
    .triage-ticket .pri { font-size: 11px; }
    `;
    document.head.appendChild(style);

    // ── Render ──
    function render() {
        const root = document.getElementById('section-actions');
        root.innerHTML = `
        <div class="actions-grid">
            <!-- Batch Ticket Update -->
            <div class="action-card">
                <div class="action-card-header">
                    <div class="icon" style="background:rgba(99,102,241,.12);color:var(--accent-hover);">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                    </div>
                    <div><h3>Batch Update Tickets</h3><p>Resolve, close, or reopen multiple tickets at once</p></div>
                </div>
                <div class="action-form">
                    <div>
                        <label>Method</label>
                        <select class="input-field" id="batchTicketMethod">
                            <option value="filter">By filter (all matching tickets)</option>
                            <option value="ids">By ticket IDs</option>
                        </select>
                    </div>
                    <div id="batchTicketFilter">
                        <label>Filter by status</label>
                        <select class="input-field" id="batchTicketStatus">
                            <option value="open">Open</option>
                            <option value="resolved">Resolved</option>
                            <option value="closed">Closed</option>
                        </select>
                    </div>
                    <div id="batchTicketIds" style="display:none;">
                        <label>Ticket IDs (comma-separated)</label>
                        <input class="input-field" id="batchTicketIdList" placeholder="12, 15, 18">
                    </div>
                    <div>
                        <label>Set status to</label>
                        <select class="input-field" id="batchTicketNewStatus">
                            <option value="resolved">Resolved</option>
                            <option value="closed">Closed</option>
                            <option value="open">Open</option>
                        </select>
                    </div>
                    <button class="btn-primary" id="batchTicketExec">Execute via AI</button>
                    <div class="action-result" id="batchTicketResult"></div>
                </div>
            </div>

            <!-- Bulk WhatsApp -->
            <div class="action-card">
                <div class="action-card-header">
                    <div class="icon" style="background:rgba(34,197,94,.12);color:var(--success);">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    </div>
                    <div><h3>Bulk WhatsApp Message</h3><p>Send the same message to a segment or list of numbers</p></div>
                </div>
                <div class="action-form">
                    <div>
                        <label>Audience</label>
                        <select class="input-field" id="bulkWaAudience">
                            <option value="open_tickets">Customers with open tickets</option>
                            <option value="pending_carts">Customers with abandoned carts</option>
                            <option value="all_customers">All customers (max 50)</option>
                            <option value="custom">Custom phone numbers</option>
                        </select>
                    </div>
                    <div id="bulkWaCustom" style="display:none;">
                        <label>Phone numbers (comma-separated)</label>
                        <input class="input-field" id="bulkWaPhones" placeholder="+919876543210, +919876543211">
                    </div>
                    <div>
                        <label>Message</label>
                        <textarea class="input-field" id="bulkWaMsg" rows="3" placeholder="Type your message…"></textarea>
                    </div>
                    <button class="btn-primary" id="bulkWaExec">Send via AI (requires confirmation)</button>
                    <div class="action-result" id="bulkWaResult"></div>
                </div>
            </div>

            <!-- Smart Triage -->
            <div class="action-card">
                <div class="action-card-header">
                    <div class="icon" style="background:rgba(245,158,11,.12);color:var(--warning);">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    </div>
                    <div><h3>Smart Ticket Triage</h3><p>AI analyzes open tickets and groups by category and priority</p></div>
                </div>
                <div class="action-form">
                    <button class="btn-primary" id="triageExec">Analyze Open Tickets</button>
                    <div class="triage-results" id="triageResults"></div>
                </div>
            </div>

            <!-- Batch Shipments -->
            <div class="action-card">
                <div class="action-card-header">
                    <div class="icon" style="background:rgba(139,92,246,.12);color:#a78bfa;">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                    </div>
                    <div><h3>Batch Book Shipments</h3><p>Book courier shipments for multiple shopper orders</p></div>
                </div>
                <div class="action-form">
                    <div>
                        <label>Shopper Order IDs (comma-separated)</label>
                        <input class="input-field" id="batchShipIds" placeholder="id1, id2, id3">
                    </div>
                    <div>
                        <label>Carrier</label>
                        <select class="input-field" id="batchShipCarrier">
                            <option value="delhivery">Delhivery</option>
                            <option value="shiprocket">Shiprocket</option>
                        </select>
                    </div>
                    <button class="btn-secondary" id="batchShipLoad" style="margin-bottom:4px;">Load Pending Orders</button>
                    <button class="btn-primary" id="batchShipExec">Book Shipments via AI</button>
                    <div class="action-result" id="batchShipResult"></div>
                </div>
            </div>

            <!-- Broadcast Creator -->
            <div class="action-card">
                <div class="action-card-header">
                    <div class="icon" style="background:rgba(236,72,153,.12);color:#f472b6;">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                    </div>
                    <div><h3>Broadcast Campaign Draft</h3><p>Create a broadcast campaign draft via AI</p></div>
                </div>
                <div class="action-form">
                    <div>
                        <label>Campaign Title</label>
                        <input class="input-field" id="bcTitle" placeholder="e.g. Diwali Sale Announcement">
                    </div>
                    <div>
                        <label>Message</label>
                        <textarea class="input-field" id="bcMsg" rows="3" placeholder="Broadcast message text…"></textarea>
                    </div>
                    <div>
                        <label>Segment</label>
                        <select class="input-field" id="bcSegment">
                            <option value="all">All customers</option>
                            <option value="pending_orders">Pending orders</option>
                            <option value="delivered">Delivered</option>
                        </select>
                    </div>
                    <button class="btn-primary" id="bcExec">Create Draft via AI</button>
                    <div class="action-result" id="bcResult"></div>
                </div>
            </div>
        </div>`;

        bindEvents();
    }

    function bindEvents() {
        // Toggle batch ticket method
        document.getElementById('batchTicketMethod').addEventListener('change', (e) => {
            document.getElementById('batchTicketFilter').style.display = e.target.value === 'filter' ? '' : 'none';
            document.getElementById('batchTicketIds').style.display = e.target.value === 'ids' ? '' : 'none';
        });
        // Toggle bulk WA custom
        document.getElementById('bulkWaAudience').addEventListener('change', (e) => {
            document.getElementById('bulkWaCustom').style.display = e.target.value === 'custom' ? '' : 'none';
        });

        // Batch tickets
        document.getElementById('batchTicketExec').addEventListener('click', async () => {
            const result = document.getElementById('batchTicketResult');
            const method = document.getElementById('batchTicketMethod').value;
            const newStatus = document.getElementById('batchTicketNewStatus').value;
            let prompt;
            if (method === 'ids') {
                const ids = document.getElementById('batchTicketIdList').value.trim();
                if (!ids) { showResult(result, 'error', 'Enter ticket IDs'); return; }
                prompt = `Batch update tickets ${ids} to status "${newStatus}"`;
            } else {
                const filterStatus = document.getElementById('batchTicketStatus').value;
                prompt = `Batch update all "${filterStatus}" tickets to "${newStatus}"`;
            }
            showResult(result, 'info', 'Sending to AI copilot…');
            try {
                const data = await CP.apiFetch('/ai/chat', 'POST', { message: prompt });
                if (data.pendingAction) {
                    showResult(result, 'info', `Action prepared: ${data.pendingAction.summary}. Confirm it in the Chat section.`);
                } else {
                    showResult(result, 'success', data.reply || 'Done.');
                }
            } catch (e) { showResult(result, 'error', e.message); }
        });

        // Bulk WhatsApp
        document.getElementById('bulkWaExec').addEventListener('click', async () => {
            const result = document.getElementById('bulkWaResult');
            const audience = document.getElementById('bulkWaAudience').value;
            const msg = document.getElementById('bulkWaMsg').value.trim();
            if (!msg) { showResult(result, 'error', 'Enter a message'); return; }
            let phones = audience;
            if (audience === 'custom') {
                phones = document.getElementById('bulkWaPhones').value.trim();
                if (!phones) { showResult(result, 'error', 'Enter phone numbers'); return; }
            }
            showResult(result, 'info', 'Sending to AI copilot for confirmation…');
            try {
                const data = await CP.apiFetch('/ai/chat', 'POST', { message: `Bulk send WhatsApp to "${phones}": ${msg}` });
                if (data.pendingAction) {
                    showResult(result, 'info', `Action prepared: ${data.pendingAction.summary}. Confirm it in the Chat section.`);
                } else {
                    showResult(result, 'success', data.reply || 'Done.');
                }
            } catch (e) { showResult(result, 'error', e.message); }
        });

        // Triage
        document.getElementById('triageExec').addEventListener('click', async () => {
            const container = document.getElementById('triageResults');
            container.innerHTML = '<span class="loading-spinner"></span> Analyzing…';
            try {
                const data = await CP.apiFetch('/ai/chat', 'POST', { message: 'Triage and categorize all open tickets by category and priority' });
                container.innerHTML = '';
                const pre = document.createElement('div');
                pre.className = 'action-result info show';
                pre.textContent = data.reply || 'Analysis complete.';
                container.appendChild(pre);
            } catch (e) {
                container.innerHTML = `<div class="action-result error show">${e.message}</div>`;
            }
        });

        // Batch shipments
        document.getElementById('batchShipLoad').addEventListener('click', async () => {
            const result = document.getElementById('batchShipResult');
            showResult(result, 'info', 'Loading pending orders…');
            try {
                const data = await CP.apiFetch('/ai/chat', 'POST', { message: 'Show me pending shipments that need booking' });
                showResult(result, 'info', data.reply || 'Loaded.');
            } catch (e) { showResult(result, 'error', e.message); }
        });
        document.getElementById('batchShipExec').addEventListener('click', async () => {
            const result = document.getElementById('batchShipResult');
            const ids = document.getElementById('batchShipIds').value.trim();
            const carrier = document.getElementById('batchShipCarrier').value;
            if (!ids) { showResult(result, 'error', 'Enter shopper order IDs'); return; }
            showResult(result, 'info', 'Sending to AI copilot…');
            try {
                const data = await CP.apiFetch('/ai/chat', 'POST', { message: `Batch book ${carrier} shipments for shopper IDs: ${ids}` });
                if (data.pendingAction) {
                    showResult(result, 'info', `Action prepared: ${data.pendingAction.summary}. Confirm in Chat.`);
                } else {
                    showResult(result, 'success', data.reply || 'Done.');
                }
            } catch (e) { showResult(result, 'error', e.message); }
        });

        // Broadcast
        document.getElementById('bcExec').addEventListener('click', async () => {
            const result = document.getElementById('bcResult');
            const title = document.getElementById('bcTitle').value.trim();
            const msg = document.getElementById('bcMsg').value.trim();
            const segment = document.getElementById('bcSegment').value;
            if (!title || !msg) { showResult(result, 'error', 'Title and message are required'); return; }
            showResult(result, 'info', 'Creating draft…');
            try {
                const data = await CP.apiFetch('/ai/chat', 'POST', { message: `Create a broadcast draft titled "${title}" with message: ${msg} for segment "${segment}"` });
                if (data.pendingAction) {
                    showResult(result, 'info', `Draft prepared: ${data.pendingAction.summary}. Confirm in Chat.`);
                } else {
                    showResult(result, 'success', data.reply || 'Draft created.');
                }
            } catch (e) { showResult(result, 'error', e.message); }
        });
    }

    function showResult(el, type, text) {
        el.className = `action-result show ${type}`;
        el.textContent = text;
    }

    // ── Lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
        }
    });
})();
