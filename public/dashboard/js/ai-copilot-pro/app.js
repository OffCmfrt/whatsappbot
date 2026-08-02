/**
 * AI Copilot Pro — App Shell
 *
 * Handles authentication, sidebar navigation, section routing,
 * and provides shared utilities (apiFetch, token management) to all sections.
 */
(function () {
    'use strict';

    const API = '/api/admin';

    // ── Shared state ──
    window.CopilotPro = {
        token: null,
        currentSection: 'chat',
        modelInfo: null,
        usageToday: 0
    };
    const CP = window.CopilotPro;

    // ── Auth helpers ──
    function getToken() {
        return localStorage.getItem('authToken');
    }

    async function apiFetch(path, method = 'GET', body = null) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CP.token}` }
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${API}${path}`, opts);
        if (res.status === 401) { showLogin(); throw new Error('Session expired'); }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }
    CP.apiFetch = apiFetch;

    // ── Login ──
    function showLogin() {
        document.getElementById('copilotApp').style.display = 'none';
        document.getElementById('loginOverlay').style.display = 'flex';
    }

    function hideLogin() {
        document.getElementById('loginOverlay').style.display = 'none';
        document.getElementById('copilotApp').style.display = 'flex';
    }

    async function doLogin(e) {
        e.preventDefault();
        const username = document.getElementById('loginUser').value.trim();
        const password = document.getElementById('loginPass').value;
        try {
            const res = await fetch(`${API}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok || !data.token) throw new Error(data.error || 'Login failed');
            localStorage.setItem('authToken', data.token);
            CP.token = data.token;
            hideLogin();
            initApp();
        } catch (err) {
            document.getElementById('loginError').textContent = err.message;
        }
    }

    // ── Navigation ──
    const SECTION_TITLES = {
        chat: 'Chat', conversations: 'Conversations', training: 'Training', actions: 'Actions',
        analytics: 'Analytics', workflows: 'Workflows'
    };

    function switchSection(name) {
        if (!SECTION_TITLES[name]) return;
        CP.currentSection = name;
        document.querySelectorAll('.nav-btn[data-section]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.section === name);
        });
        document.querySelectorAll('.section-page').forEach(page => {
            page.classList.toggle('active', page.id === `section-${name}`);
        });
        document.getElementById('sectionTitle').textContent = SECTION_TITLES[name];
        // Close mobile sidebar
        document.getElementById('sidebar').classList.remove('mobile-open');
        document.getElementById('sidebarOverlay').classList.remove('show');
        // Fire section init
        const evt = new CustomEvent('copilot-section-activate', { detail: { section: name } });
        document.dispatchEvent(evt);
    }

    // ── Top bar info ──
    async function loadTopBarInfo() {
        try {
            const data = await apiFetch('/ai/usage?days=1');
            const cfg = { provider: data.provider || 'ai', model: data.model || '' };
            CP.modelInfo = cfg;
            document.getElementById('modelBadge').textContent = `${cfg.provider}/${cfg.model}`.substring(0, 24);
            const todayCount = data.totals?.requests || 0;
            CP.usageToday = todayCount;
            document.getElementById('usageBadge').textContent = todayCount > 0 ? `${todayCount} requests today` : '';
        } catch (e) { /* non-critical */ }
    }

    // ── Init ──
    function initApp() {
        // Nav clicks
        document.querySelectorAll('.nav-btn[data-section]').forEach(btn => {
            btn.addEventListener('click', () => switchSection(btn.dataset.section));
        });
        // Mobile toggle
        document.getElementById('mobileToggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('mobile-open');
            document.getElementById('sidebarOverlay').classList.toggle('show');
        });
        document.getElementById('sidebarOverlay').addEventListener('click', () => {
            document.getElementById('sidebar').classList.remove('mobile-open');
            document.getElementById('sidebarOverlay').classList.remove('show');
        });
        // Handle hash routing
        const hash = location.hash.replace('#', '');
        if (SECTION_TITLES[hash]) switchSection(hash);
        window.addEventListener('hashchange', () => {
            const h = location.hash.replace('#', '');
            if (SECTION_TITLES[h]) switchSection(h);
        });
        loadTopBarInfo();
        // Init first section
        switchSection(CP.currentSection);
    }

    // ── Bootstrap ──
    function bootstrap() {
        CP.token = getToken();
        if (!CP.token) {
            showLogin();
            document.getElementById('loginForm').addEventListener('submit', doLogin);
        } else {
            hideLogin();
            initApp();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
