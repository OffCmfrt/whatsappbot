/**
 * OFFCOMFRT Test Bot Widget — Button-driven interactive flow
 * Self-contained with inline CSS. Pure monochrome, no emojis, highly premium.
 *
 * Flow:
 *   Welcome → [Track Order] [Return/Exchange] [Track Your Request] [Contact Support]
 *   Each button drives a minimal-input, button-guided conversation.
 */

(function () {
    'use strict';

    // ---------- Configuration ----------
    var config = window.__offcomfrt_testbot || window.__offcomfrt_widget || {};
    var API_URL = (config.apiUrl || '').replace(/\/$/, '');
    var BRAND_NAME = config.brandName || 'OFFCOMFRT';
    var CUSTOMER_NAME = config.customerName || '';
    var CUSTOMER_PHONE = config.customerPhone || '';

    // Clickable text trigger config
    var TRIGGER_TEXT = config.triggerText || '';  // e.g. 'Need Help?'
    var TRIGGER_POSITION = config.triggerPosition || 'bottom-right'; // bottom-right | bottom-left | top-right | top-left

    // ---------- Session ----------
    // Guard against duplicate initialization (e.g. loader + direct <script> tag)
    if (window.__offcomfrt_tb_initialized) return;
    window.__offcomfrt_tb_initialized = true;

    // Persistent visitor ID (survives tab close — links all sessions from same browser)
    var visitorId = localStorage.getItem('offcomfrt_tb_visitor');
    if (!visitorId) {
        visitorId = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 10);
        localStorage.setItem('offcomfrt_tb_visitor', visitorId);
    }

    var sessionId = sessionStorage.getItem('offcomfrt_tb_session');
    var welcomeShown = sessionStorage.getItem('offcomfrt_tb_welcome') === '1';
    if (!sessionId) {
        sessionId = 'tb_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 8);
        sessionStorage.setItem('offcomfrt_tb_session', sessionId);
        // Fresh session — welcome will be shown below
    }

    var isOpen = false;
    var isTyping = false;
    var flowState = 'idle';
    var flowContext = {};
    var widgetEventQueue = Promise.resolve();

    // ---------- Admin override polling ----------
    var lastMessageId = 0;
    var pollTimer = null;
    var POLL_INTERVAL = 5000; // 5 seconds

    function startPolling() {
        stopPolling();
        // Initial fetch to set baseline
        pollAdminMessages(true);
        pollTimer = setInterval(function() { pollAdminMessages(false); }, POLL_INTERVAL);
    }
    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function pollAdminMessages(isInitial) {
        if (!sessionId) return;
        var url = API_URL + '/api/widget/poll?sessionId=' + encodeURIComponent(sessionId) + '&afterId=' + lastMessageId;
        fetch(url)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (!data.messages || !data.messages.length) return;
                data.messages.forEach(function(m) {
                    if (m.id > lastMessageId) lastMessageId = m.id;
                    if (m.sender === 'admin') {
                        addAdminMessage(m.content);
                    }
                });
            })
            .catch(function() { /* silent */ });
    }

    function addAdminMessage(text) {
        var chat = document.getElementById('oftb-chat');
        if (!chat) return;
        var wrapper = document.createElement('div');
        wrapper.className = 'oftb-msg-wrap oftb-align-left';
        var msg = document.createElement('div');
        msg.className = 'oftb-msg oftb-msg-admin';
        msg.innerHTML = '<div class="oftb-admin-label">Support Team</div>' + escapeHtml(text).replace(/\n/g, '<br>');
        wrapper.appendChild(msg);
        chat.appendChild(wrapper);
        scrollToBottom();
    }

    // ---------- Inject CSS ----------
    function injectStyles() {
        if (document.getElementById('offcomfrt-tb-styles')) return;

        // Load Archive Narrow from Google Fonts
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Archive+Narrow:wght@400;500;600;700&display=swap';
        document.head.appendChild(link);

        var style = document.createElement('style');
        style.id = 'offcomfrt-tb-styles';
        style.textContent = [
            '#offcomfrt-tb *,#offcomfrt-tb *::before,#offcomfrt-tb *::after{box-sizing:border-box}',

            /* Floating Button */
            '#offcomfrt-tb-btn{position:fixed;bottom:28px;right:28px;width:62px;height:62px;border-radius:50%;background:linear-gradient(145deg,#111,#000);border:1px solid rgba(255,255,255,0.06);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(0,0,0,0.4),0 2px 8px rgba(0,0,0,0.2);z-index:99998;transition:all 0.35s cubic-bezier(0.34,1.56,0.64,1);animation:oftb-float 3s ease-in-out infinite}',
            '@keyframes oftb-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
            '#offcomfrt-tb-btn:hover{transform:scale(1.08) translateY(-2px);box-shadow:0 12px 40px rgba(0,0,0,0.5)}',
            '#offcomfrt-tb-btn:active{transform:scale(0.95)}',
            '#offcomfrt-tb-btn svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}',

            /* Widget Container */
            '#offcomfrt-tb{position:fixed;bottom:28px;right:28px;width:420px;height:700px;max-height:calc(100vh - 56px);background:#fff;border-radius:20px;border:1px solid #000;box-shadow:0 32px 100px rgba(0,0,0,0.2),0 12px 40px rgba(0,0,0,0.1);z-index:99999;display:flex;flex-direction:column;overflow:hidden;font-family:"Archive Narrow",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;transform:translateY(16px) scale(0.92);pointer-events:none;transition:all 0.4s cubic-bezier(0.16,1,0.3,1)}',
            '#offcomfrt-tb.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all}',

            /* Header */
            '#offcomfrt-tb .oftb-header{background:linear-gradient(135deg,#0a0a0a,#111 50%,#0a0a0a);color:#fff;padding:22px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;position:relative;overflow:hidden}',
            '#offcomfrt-tb .oftb-header::after{content:"";position:absolute;bottom:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent)}',
            '#offcomfrt-tb .oftb-header-brand{display:flex;align-items:center;gap:14px}',
            '#offcomfrt-tb .oftb-header-avatar{width:44px;height:44px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;position:relative;box-shadow:0 2px 8px rgba(0,0,0,0.3);overflow:hidden;border:1px solid rgba(255,255,255,0.15)}',
            '#offcomfrt-tb .oftb-header-avatar img{width:100%;height:100%;object-fit:cover}',
            '#offcomfrt-tb .oftb-header-info{display:flex;flex-direction:column;gap:2px}',
            '#offcomfrt-tb .oftb-header-title{font-size:16px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase}',
            '#offcomfrt-tb .oftb-header-subtitle{font-size:11px;opacity:0.5;font-weight:500;letter-spacing:0.5px;text-transform:uppercase}',
            '#offcomfrt-tb .oftb-header-close{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.25s ease}',
            '#offcomfrt-tb .oftb-header-close:hover{background:rgba(255,255,255,0.12);transform:rotate(90deg)}',
            '#offcomfrt-tb .oftb-header-close svg{width:16px;height:16px;stroke:#fff;stroke-width:1.5;stroke-linecap:round}',

            /* Chat Area */
            '#offcomfrt-tb .oftb-chat{flex:1;overflow-y:auto;padding:24px 16px 20px;display:flex;flex-direction:column;gap:14px;scroll-behavior:smooth;background:#fafafa;min-height:0}',
            '#offcomfrt-tb .oftb-chat::-webkit-scrollbar{width:4px}',
            '#offcomfrt-tb .oftb-chat::-webkit-scrollbar-track{background:transparent}',
            '#offcomfrt-tb .oftb-chat::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.1);border-radius:2px}',

            /* Messages */
            '#offcomfrt-tb .oftb-msg-wrap{display:flex;flex-direction:column;gap:4px;animation:oftb-slideUp 0.35s cubic-bezier(0.16,1,0.3,1)}',
            '#offcomfrt-tb .oftb-align-left{align-items:flex-start}',
            '#offcomfrt-tb .oftb-align-right{align-items:flex-end}',
            '@keyframes oftb-slideUp{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}',
            '#offcomfrt-tb .oftb-msg{padding:14px 18px;border-radius:18px;font-size:13.5px;line-height:1.65;word-wrap:break-word;letter-spacing:0.01em;max-width:88%}',
            '#offcomfrt-tb .oftb-msg-bot{align-self:flex-start;background:#fff;color:#1a1a1a;border-bottom-left-radius:6px;border:1px solid #e8e8e8;box-shadow:0 1px 4px rgba(0,0,0,0.04)}',
            '#offcomfrt-tb .oftb-msg-user{align-self:flex-end;background:linear-gradient(135deg,#1a1a1a,#000);color:#fff;border-bottom-right-radius:6px;border:none;box-shadow:0 2px 8px rgba(0,0,0,0.15)}',
            '#offcomfrt-tb .oftb-msg-admin{align-self:flex-start;background:linear-gradient(135deg,#f0f4ff,#e8edff);color:#1a1a2e;border-bottom-left-radius:6px;border:1px solid #c7d2fe;box-shadow:0 2px 8px rgba(99,102,241,0.1);max-width:85%}',
            '#offcomfrt-tb .oftb-admin-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6366f1;margin-bottom:4px}',

            /* Inline Button Row */
            '#offcomfrt-tb .oftb-btn-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;animation:oftb-slideUp 0.35s cubic-bezier(0.16,1,0.3,1)}',
            '#offcomfrt-tb .oftb-btn{padding:10px 20px;border-radius:100px;border:1px solid rgba(0,0,0,0.12);background:#fff;color:#1a1a1a;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;transition:all 0.25s cubic-bezier(0.34,1.56,0.64,1);letter-spacing:0.03em;white-space:nowrap}',
            '#offcomfrt-tb .oftb-btn:hover{background:#000;color:#fff;border-color:#000;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.15)}',
            '#offcomfrt-tb .oftb-btn:active{transform:translateY(0) scale(0.97)}',
            '#offcomfrt-tb .oftb-btn-primary{background:linear-gradient(135deg,#1a1a1a,#000);color:#fff;border-color:#000}',
            '#offcomfrt-tb .oftb-btn-primary:hover{background:linear-gradient(135deg,#2a2a2a,#111);box-shadow:0 4px 16px rgba(0,0,0,0.2)}',

            /* Input Area */
            '#offcomfrt-tb .oftb-input-area{padding:14px 14px 16px;border-top:1px solid #000;display:flex;align-items:center;gap:10px;flex-shrink:0;background:#fff}',
            '#offcomfrt-tb .oftb-input{flex:1;border:1px solid rgba(0,0,0,0.1);border-radius:100px;padding:11px 18px;font-size:13px;font-family:inherit;outline:none;transition:all 0.2s ease;background:#f8f9fa;color:#1a1a1a;min-height:42px;width:100%}',
            '#offcomfrt-tb .oftb-input:focus{border-color:rgba(0,0,0,0.25);background:#fff;box-shadow:0 0 0 3px rgba(0,0,0,0.04)}',
            '#offcomfrt-tb .oftb-input::placeholder{color:#aaa;font-weight:400}',
            '#offcomfrt-tb .oftb-send-btn{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#1a1a1a,#000);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.25s cubic-bezier(0.34,1.56,0.64,1);flex-shrink:0}',
            '#offcomfrt-tb .oftb-send-btn:hover{transform:scale(1.06)}',
            '#offcomfrt-tb .oftb-send-btn:active{transform:scale(0.92)}',
            '#offcomfrt-tb .oftb-send-btn svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}',

            /* Powered By */
            '#offcomfrt-tb .oftb-powered{text-align:center;padding:8px;font-size:9px;color:#bbb;letter-spacing:1px;flex-shrink:0;font-weight:600;text-transform:uppercase;background:#fff;border-top:1px solid #f0f0f0}',

            /* Typing Indicator */
            '#offcomfrt-tb .oftb-typing{display:flex;gap:4px;padding:14px 18px;background:#fff;border-radius:18px;border-bottom-left-radius:6px;border:1px solid #e8e8e8;align-self:flex-start}',
            '#offcomfrt-tb .oftb-typing-dot{width:6px;height:6px;border-radius:50%;background:#bbb;animation:oftb-bounce 1.4s ease-in-out infinite}',
            '#offcomfrt-tb .oftb-typing-dot:nth-child(2){animation-delay:0.2s}',
            '#offcomfrt-tb .oftb-typing-dot:nth-child(3){animation-delay:0.4s}',
            '@keyframes oftb-bounce{0%,60%,100%{transform:translateY(0);opacity:0.4}30%{transform:translateY(-5px);opacity:1}}',

            /* Tracking Card — monochrome */
            '#offcomfrt-tb .oftb-tracking-card{background:#fff;border:1px solid #e0e0e0;border-radius:14px;padding:18px;margin:4px 0;box-shadow:0 2px 8px rgba(0,0,0,0.04);animation:oftb-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '#offcomfrt-tb .oftb-tracking-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #f0f0f0}',
            '#offcomfrt-tb .oftb-tracking-carrier{font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px}',
            '#offcomfrt-tb .oftb-tracking-status{font-size:10px;font-weight:700;padding:4px 10px;border-radius:100px;text-transform:uppercase;letter-spacing:0.8px}',
            '#offcomfrt-tb .oftb-status-delivered{background:#1a1a1a;color:#fff}',
            '#offcomfrt-tb .oftb-status-transit{background:#e5e5e5;color:#1a1a1a}',
            '#offcomfrt-tb .oftb-status-pending{background:#fff3cd;color:#856404}',
            '#offcomfrt-tb .oftb-status-unknown{background:#f3f4f6;color:#999}',
            '#offcomfrt-tb .oftb-tracking-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f5f5f5}',
            '#offcomfrt-tb .oftb-tracking-row:last-child{border-bottom:none}',
            '#offcomfrt-tb .oftb-tracking-row span:first-child{font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:0.8px}',
            '#offcomfrt-tb .oftb-tracking-row span:last-child{font-size:13px;font-weight:500;color:#1a1a1a;text-align:right}',
            '#offcomfrt-tb .oftb-tracking-link{display:block;text-align:center;margin-top:14px;padding:11px;background:#f8f9fa;border-radius:10px;color:#1a1a1a;text-decoration:none;font-size:12px;font-weight:700;transition:all 0.2s ease;border:1px solid #e5e5e5;letter-spacing:0.5px;text-transform:uppercase}',
            '#offcomfrt-tb .oftb-tracking-link:hover{background:#000;color:#fff;border-color:#000}',
            '#offcomfrt-tb .oftb-timeline-title{font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:1px;margin-top:14px}',
            '#offcomfrt-tb .oftb-timeline{margin-top:8px}',
            '#offcomfrt-tb .oftb-timeline-item{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid #f7f7f7}',
            '#offcomfrt-tb .oftb-timeline-item:last-child{border-bottom:none}',
            '#offcomfrt-tb .oftb-timeline-dot{width:6px;height:6px;border-radius:50%;background:#1a1a1a;margin-top:5px;flex-shrink:0}',
            '#offcomfrt-tb .oftb-timeline-activity{font-size:12.5px;font-weight:500;color:#1a1a1a}',
            '#offcomfrt-tb .oftb-timeline-meta{font-size:10px;color:#bbb;margin-top:1px;letter-spacing:0.3px}',

            /* Return Status Card — monochrome */
            '#offcomfrt-tb .oftb-return-card{background:#fff;border:1px solid #e0e0e0;border-radius:14px;padding:18px;margin:4px 0;box-shadow:0 2px 8px rgba(0,0,0,0.04);animation:oftb-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '#offcomfrt-tb .oftb-return-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #f0f0f0}',
            '#offcomfrt-tb .oftb-return-type{font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px}',
            '#offcomfrt-tb .oftb-return-status{font-size:10px;font-weight:700;padding:4px 10px;border-radius:100px;text-transform:uppercase;letter-spacing:0.8px}',
            '#offcomfrt-tb .oftb-return-approved{background:#1a1a1a;color:#fff}',
            '#offcomfrt-tb .oftb-return-pending{background:#f0f0f0;color:#666}',
            '#offcomfrt-tb .oftb-return-rejected{background:#e5e5e5;color:#333}',
            '#offcomfrt-tb .oftb-return-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:13px}',
            '#offcomfrt-tb .oftb-return-row:last-child{border-bottom:none}',
            '#offcomfrt-tb .oftb-return-row .label{color:#bbb;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;font-weight:600}',
            '#offcomfrt-tb .oftb-return-row .value{color:#1a1a1a;font-weight:500}',

            /* WhatsApp Continue Button */
            '#offcomfrt-tb .oftb-whatsapp-btn{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:12px 24px;background:#25D366;color:#fff;border-radius:100px;text-decoration:none;font-size:12px;font-weight:700;font-family:inherit;letter-spacing:0.3px;transition:all 0.25s ease;border:none;cursor:pointer}',
            '#offcomfrt-tb .oftb-whatsapp-btn:hover{background:#1ebe5d;transform:translateY(-1px);box-shadow:0 4px 16px rgba(37,211,102,0.3)}',
            '#offcomfrt-tb .oftb-whatsapp-btn svg{width:18px;height:18px;fill:#fff;flex-shrink:0}',

            /* Ticket Confirmation — monochrome */
            '#offcomfrt-tb .oftb-ticket-confirm{background:#fff;border:1px solid #e0e0e0;border-radius:14px;padding:28px 24px;margin:4px 0;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.04);animation:oftb-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '#offcomfrt-tb .oftb-ticket-confirm-icon{width:48px;height:48px;border-radius:50%;background:#1a1a1a;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}',
            '#offcomfrt-tb .oftb-ticket-confirm-icon svg{width:22px;height:22px;stroke:#fff;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}',
            '#offcomfrt-tb .oftb-ticket-confirm h4{font-size:15px;font-weight:700;margin-bottom:6px;color:#1a1a1a;letter-spacing:0.5px}',
            '#offcomfrt-tb .oftb-ticket-confirm p{font-size:12px;color:#999;margin-bottom:16px;line-height:1.5;letter-spacing:0.3px}',
            '#offcomfrt-tb .oftb-ticket-number{display:inline-block;background:#f5f5f5;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#1a1a1a;margin-bottom:16px;font-family:"SF Mono",Monaco,monospace;letter-spacing:0.5px}',

            /* Rich Message Formatting */
            '#offcomfrt-tb .oftb-msg-bot strong{font-weight:700}',
            '#offcomfrt-tb .oftb-msg-bot em{font-style:italic}',

            /* Clickable Text Trigger — inline class (place anywhere in theme) */
            '.offcomfrt-open-chat{cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-family:"Archive Narrow",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#1a1a1a;background:#fff;padding:10px 22px;border-radius:100px;border:1px solid #000;box-shadow:0 4px 20px rgba(0,0,0,0.12),0 1px 4px rgba(0,0,0,0.08);transition:all 0.3s cubic-bezier(0.34,1.56,0.64,1);white-space:nowrap;user-select:none;-webkit-user-select:none;text-decoration:none;line-height:1}',
            '.offcomfrt-open-chat:hover{background:#000;color:#fff;transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,0,0,0.18)}',
            '.offcomfrt-open-chat:active{transform:translateY(0) scale(0.96)}',

            /* Clickable Text Trigger — fixed position (auto-created via config) */
            '#offcomfrt-tb-trigger{position:fixed;z-index:99998;cursor:pointer;font-family:"Archive Narrow",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#1a1a1a;background:#fff;padding:10px 22px;border-radius:100px;border:1px solid #000;box-shadow:0 4px 20px rgba(0,0,0,0.12),0 1px 4px rgba(0,0,0,0.08);transition:all 0.3s cubic-bezier(0.34,1.56,0.64,1);white-space:nowrap;user-select:none;-webkit-user-select:none}',
            '#offcomfrt-tb-trigger:hover{background:#000;color:#fff;transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,0,0,0.18)}',
            '#offcomfrt-tb-trigger:active{transform:translateY(0) scale(0.96)}',
            '#offcomfrt-tb-trigger.pos-bottom-right{bottom:100px;right:28px}',
            '#offcomfrt-tb-trigger.pos-bottom-left{bottom:100px;left:28px}',
            '#offcomfrt-tb-trigger.pos-top-right{top:28px;right:28px}',
            '#offcomfrt-tb-trigger.pos-top-left{top:28px;left:28px}',

            /* Mobile */
            '@media(max-width:480px){',
            '#offcomfrt-tb{bottom:0;right:0;left:0;width:100%;height:90vh;max-height:750px;border-radius:20px 20px 0 0;border:none;border-top:1px solid #000;box-shadow:0 -12px 48px rgba(0,0,0,0.15)}',
            '#offcomfrt-tb-btn{bottom:20px;right:20px;width:56px;height:56px}',
            '#offcomfrt-tb-trigger.pos-bottom-right{bottom:86px;right:20px}',
            '#offcomfrt-tb-trigger.pos-bottom-left{bottom:86px;left:20px}',
            '#offcomfrt-tb-trigger.pos-top-right{top:20px;right:20px}',
            '#offcomfrt-tb-trigger.pos-top-left{top:20px;left:20px}',
            '#offcomfrt-tb .oftb-header{padding:18px 14px}',
            '#offcomfrt-tb .oftb-chat{padding:18px 12px 14px;gap:12px}',
            '#offcomfrt-tb .oftb-input-area{padding:12px 12px 14px}',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }

    // ---------- Inline Trigger Binding (Shopify theme placement) ----------
    function bindInlineTrigger(el) {
        if (el.getAttribute('data-offcomfrt-bound')) return;
        el.setAttribute('data-offcomfrt-bound', '1');
        el.setAttribute('role', 'button');
        if (!el.getAttribute('tabindex')) el.setAttribute('tabindex', '0');
        el.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleWidget();
        });
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWidget(); }
        });
    }

    function bindInlineTriggers() {
        var els = document.querySelectorAll('.offcomfrt-open-chat');
        for (var i = 0; i < els.length; i++) bindInlineTrigger(els[i]);
    }

    function watchInlineTriggers() {
        if (typeof MutationObserver === 'undefined') return;
        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var nodes = mutations[i].addedNodes;
                if (!nodes || !nodes.length) continue;
                for (var j = 0; j < nodes.length; j++) {
                    var node = nodes[j];
                    if (node.nodeType !== 1) continue; // element only
                    if (node.classList && node.classList.contains('offcomfrt-open-chat')) bindInlineTrigger(node);
                    // also check children
                    var children = node.querySelectorAll ? node.querySelectorAll('.offcomfrt-open-chat') : [];
                    for (var k = 0; k < children.length; k++) bindInlineTrigger(children[k]);
                }
            }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    // ---------- DOM Creation ----------
    function createWidget() {
        injectStyles();

        var btn = document.createElement('button');
        btn.id = 'offcomfrt-tb-btn';
        btn.setAttribute('aria-label', 'Open support');
        btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        btn.addEventListener('click', toggleWidget);
        document.body.appendChild(btn);

        // Clickable text trigger (optional — only if triggerText is configured)
        var trigger = null;
        if (TRIGGER_TEXT) {
            trigger = document.createElement('div');
            trigger.id = 'offcomfrt-tb-trigger';
            trigger.textContent = TRIGGER_TEXT;
            trigger.className = 'pos-' + TRIGGER_POSITION;
            trigger.setAttribute('role', 'button');
            trigger.setAttribute('tabindex', '0');
            trigger.setAttribute('aria-label', TRIGGER_TEXT);
            trigger.addEventListener('click', toggleWidget);
            trigger.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWidget(); }
            });
            document.body.appendChild(trigger);
        }

        // Auto-bind any .offcomfrt-open-chat elements already in the DOM (Shopify theme placement)
        bindInlineTriggers();
        // Watch for dynamically added .offcomfrt-open-chat elements (SPA / lazy sections)
        watchInlineTriggers();

        var widget = document.createElement('div');
        widget.id = 'offcomfrt-tb';
        widget.innerHTML =
            '<div class="oftb-header">' +
                '<div class="oftb-header-brand">' +
                    '<div class="oftb-header-avatar">' +
                        '<img src="' + (API_URL + '/widget/logo.jpg') + '" alt="' + BRAND_NAME + '" />' +
                    '</div>' +
                    '<div class="oftb-header-info">' +
                        '<span class="oftb-header-title">' + BRAND_NAME + '</span>' +
                        '<span class="oftb-header-subtitle">Support</span>' +
                    '</div>' +
                '</div>' +
                '<button class="oftb-header-close" aria-label="Close">' +
                    '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
                '</button>' +
            '</div>' +
            '<div class="oftb-chat" id="oftb-chat"></div>' +
            '<div class="oftb-input-area">' +
                '<input type="text" class="oftb-input" id="oftb-input" placeholder="Type a message..." autocomplete="off" />' +
                '<button class="oftb-send-btn" id="oftb-send-btn" aria-label="Send">' +
                    '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
                '</button>' +
            '</div>' +
            '<div class="oftb-powered">' + BRAND_NAME + '</div>';

        document.body.appendChild(widget);

        widget.querySelector('.oftb-header-close').addEventListener('click', closeWidget);
        widget.querySelector('#oftb-send-btn').addEventListener('click', handleSend);
        widget.querySelector('#oftb-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
        });

        showWelcome();
    }

    // ---------- Open / Close ----------
    function toggleWidget() { if (isOpen) closeWidget(); else openWidget(); }
    function openWidget() {
        document.getElementById('offcomfrt-tb').classList.add('open');
        document.getElementById('offcomfrt-tb-btn').style.display = 'none';
        var trig = document.getElementById('offcomfrt-tb-trigger');
        if (trig) trig.style.display = 'none';
        isOpen = true;
        startPolling();
        setTimeout(function () { document.getElementById('oftb-input').focus(); }, 300);
    }
    function closeWidget() {
        document.getElementById('offcomfrt-tb').classList.remove('open');
        document.getElementById('offcomfrt-tb-btn').style.display = 'flex';
        var trig = document.getElementById('offcomfrt-tb-trigger');
        if (trig) trig.style.display = '';
        isOpen = false;
        stopPolling();
    }

    // ---------- Welcome ----------
    function showWelcome() {
        var greeting = CUSTOMER_NAME ? 'Welcome back, ' + CUSTOMER_NAME + '.' : 'Welcome to ' + BRAND_NAME + '.';
        // Render the welcome in the DOM but never persist it to the DB.
        // A session is only registered once the customer actually interacts
        // (sends a message or clicks a button).
        addBotMessage(
            greeting + '\n\nHow can we assist you today?',
            [
                { label: 'Track Order', action: 'track_order' },
                { label: 'Return / Exchange', action: 'file_return' },
                { label: 'Track Your Request', action: 'track_request' },
                { label: 'Contact Support', action: 'contact_support' }
            ],
            false  // never persist welcome — session starts on first customer action
        );
        if (!welcomeShown) {
            welcomeShown = true;
            sessionStorage.setItem('offcomfrt_tb_welcome', '1');
        }
        flowState = 'idle';
    }

    // ---------- Message Helpers ----------
    // Widget-only interactions do not pass through the AI route, so save them
    // separately for the admin conversation replay. AI replies opt out because
    // the server persists their text, token usage, and any card payload itself.
    function recordWidgetEvent(sender, content, richContent) {
        if (!sessionId || !content) return;
        widgetEventQueue = widgetEventQueue
            .catch(function () { /* keep the event queue usable after a failed request */ })
            .then(function () {
                return fetch(API_URL + '/api/widget/event', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: sessionId, visitorId: visitorId, sender: sender, content: content, richContent: richContent || null })
                });
            });
    }

    function addBotMessage(text, buttons, persist) {
        var chat = document.getElementById('oftb-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'oftb-msg-wrap oftb-align-left';
        var msg = document.createElement('div');
        msg.className = 'oftb-msg oftb-msg-bot';
        msg.innerHTML = formatBotMessage(text);
        wrapper.appendChild(msg);

        if (buttons && buttons.length) {
            var row = document.createElement('div');
            row.className = 'oftb-btn-row';
            buttons.forEach(function (b) {
                var btn = document.createElement('button');
                btn.className = 'oftb-btn' + (b.primary ? ' oftb-btn-primary' : '');
                btn.textContent = b.label;
                btn.addEventListener('click', function () {
                    var siblings = row.querySelectorAll('.oftb-btn');
                    for (var i = 0; i < siblings.length; i++) { siblings[i].disabled = true; siblings[i].style.opacity = '0.35'; siblings[i].style.cursor = 'default'; }
                    btn.style.opacity = '1';
                    btn.style.background = '#000';
                    btn.style.color = '#fff';
                    btn.style.borderColor = '#000';
                    handleButtonAction(b.action);
                });
                row.appendChild(btn);
            });
            wrapper.appendChild(row);
        }

        chat.appendChild(wrapper);
        scrollToBottom();
        // Bot messages never create sessions — only customer actions do.
        // AI chat is persisted server-side; cards call recordWidgetEvent directly.
        if (persist === true) recordWidgetEvent('bot', text);
    }

    function addUserMessage(text) {
        var chat = document.getElementById('oftb-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'oftb-msg-wrap oftb-align-right';
        var msg = document.createElement('div');
        msg.className = 'oftb-msg oftb-msg-user';
        msg.textContent = text;
        wrapper.appendChild(msg);
        chat.appendChild(wrapper);
        scrollToBottom();
    }

    function formatBotMessage(text) {
        if (!text) return '';
        var escaped = escapeHtml(text);
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
        return escaped.replace(/\n/g, '<br>');
    }

    function showTyping() {
        isTyping = true;
        var chat = document.getElementById('oftb-chat');
        var typing = document.createElement('div');
        typing.className = 'oftb-typing';
        typing.id = 'oftb-typing';
        typing.innerHTML = '<div class="oftb-typing-dot"></div><div class="oftb-typing-dot"></div><div class="oftb-typing-dot"></div>';
        chat.appendChild(typing);
        scrollToBottom();
    }
    function hideTyping() {
        isTyping = false;
        var t = document.getElementById('oftb-typing');
        if (t) t.remove();
    }

    function setInputPlaceholder(text) { document.getElementById('oftb-input').placeholder = text; }
    function setInputMode(mode) {
        var input = document.getElementById('oftb-input');
        if (mode === 'order') { input.type = 'tel'; input.placeholder = 'Enter order number...'; }
        else { input.type = 'text'; input.placeholder = 'Type a message...'; }
    }

    // ---------- Button Action Router ----------
    function handleButtonAction(action) {
        var actionLabels = {
            track_order: 'Track Order', file_return: 'Return / Exchange', track_request: 'Track Your Request',
            contact_support: 'Contact Support', create_support_ticket: 'Create Ticket', retry_support: 'Try Another Question',
            main_menu: 'Menu', return_home: 'Menu', open_return_url: 'Open Return Portal', open_exchange_url: 'Open Exchange Page'
        };
        recordWidgetEvent('customer', actionLabels[action] || String(action || '').replace(/^support_/, '').replace(/_/g, ' '));
        if (action === 'open_return_url') {
            addUserMessage('Open Return Portal');
            window.open('https://www.offcomfrt.in/pages/return', '_blank');
            addBotMessage('Return portal opened. Complete your return there and we will process it within 24 to 48 hours.', [
                { label: 'Back to Menu', action: 'main_menu' }
            ]);
            flowState = 'idle'; return;
        }
        if (action === 'open_exchange_url') {
            addUserMessage('Open Exchange Page');
            window.open('https://www.offcomfrt.in/pages/exchange', '_blank');
            addBotMessage('Exchange portal opened. Complete your exchange there.', [
                { label: 'Back to Menu', action: 'main_menu' }
            ]);
            flowState = 'idle'; return;
        }
        if (action && action.indexOf('support_') === 0) {
            var topic = action.replace('support_', '').replace(/_/g, ' ');
            flowContext.supportTopic = topic;
            addUserMessage(topic);
            flowState = 'awaiting_support_message';
            addBotMessage('I will try to help you right away. Please describe your issue briefly.');
            setInputPlaceholder('Describe your issue...');
            return;
        }
        if (action === 'track_order') startTrackOrder();
        else if (action === 'file_return') startFileReturn();
        else if (action === 'track_request') startTrackRequest();
        else if (action === 'contact_support') startContactSupport();
        else if (action === 'create_support_ticket') startCreateTicket();
        else if (action === 'retry_support') retrySupportQuestion();
        else if (action === 'main_menu' || action === 'return_home') showMainMenuAgain();
        else if (action === 'track_another') startTrackOrder();
    }

    function showMainMenuAgain() {
        flowState = 'idle';
        flowContext = {};
        setInputMode('text');
        addBotMessage('How else can we help you?', [
            { label: 'Track Order', action: 'track_order' },
            { label: 'Return / Exchange', action: 'file_return' },
            { label: 'Track Your Request', action: 'track_request' },
            { label: 'Contact Support', action: 'contact_support' }
        ]);
    }

    // ========== FLOW 1: TRACK ORDER ==========
    function startTrackOrder() {
        flowState = 'awaiting_order_id';
        flowContext = {};
        setInputMode('order');
        addBotMessage('Please enter your *order number*.\n\nYou can find it in your confirmation email or SMS.', [
            { label: 'Back to Menu', action: 'main_menu' }
        ]);
    }

    // ---------- Entity Extraction Helper ----------
    function parseOrderOrTracking(text) {
        if (!text) return null;
        var str = String(text).trim();

        // 1. Return/exchange request ID: REQ-1234 to REQ-123456
        var reqMatch = str.match(/\b(REQ-\d{4,6})\b/i);
        if (reqMatch) return { type: 'request', id: reqMatch[1].toUpperCase() };

        // 2. AWB number (10 to 16 digits)
        var awbMatch = str.match(/\b(\d{10,16})\b/);
        if (awbMatch) return { type: 'awb', id: awbMatch[1] };

        // 3. Order ID: matches #53388, Order #53388, 53388 order status, or standalone 4-6 digits
        var orderMatch = str.match(/#(\d{4,6})/i)
            || str.match(/\b(?:ORD|ORDER)[-_ #]?(\d{4,6})\b/i)
            || str.match(/\b(\d{4,6})\b/)
            || str.match(/(\d{4,6})/);
        if (orderMatch) return { type: 'order', id: orderMatch[1] };

        return null;
    }

    function doTrackOrder(orderInput, persist) {
        if (persist !== false) recordWidgetEvent('customer', String(orderInput));
        flowState = 'tracking';
        showTyping();

        var parsed = parseOrderOrTracking(orderInput);
        var targetId = parsed ? parsed.id : String(orderInput || '').replace(/\s/g, '');
        var body = { sessionId: sessionId, visitorId: visitorId };

        if ((parsed && parsed.type === 'awb') || /^\d{10,}$/.test(targetId)) {
            body.awb = targetId;
            body.orderId = targetId;
        } else {
            body.orderId = targetId;
        }

        fetch(API_URL + '/api/widget/track-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            hideTyping();
            if (data.error) {
                addBotMessage(data.error, [
                    { label: 'Try Another', action: 'track_order', primary: true },
                    { label: 'Menu', action: 'main_menu' }
                ]);
            } else {
                addTrackingCard(data);
                addBotMessage('Anything else?', [
                    { label: 'Track Another', action: 'track_order', primary: true },
                    { label: 'Return / Exchange', action: 'file_return' },
                    { label: 'Menu', action: 'main_menu' }
                ]);
            }
            setInputMode('text');
            flowState = 'idle';
        })
        .catch(function () {
            hideTyping();
            addBotMessage('Unable to fetch tracking right now. Please try again later.', [
                { label: 'Try Again', action: 'track_order', primary: true },
                { label: 'Menu', action: 'main_menu' }
            ]);
            setInputMode('text');
            flowState = 'idle';
        });
    }

    // ========== FLOW 2: RETURN / EXCHANGE (Direct Page Redirects) ==========
    function startFileReturn() {
        flowState = 'idle';
        addBotMessage(
            'Visit our dedicated pages to submit your return or exchange request.\n\n' +
            'Requests must be made within *2 days of delivery*.',
            [
                { label: 'Return Page', action: 'open_return_url', primary: true },
                { label: 'Exchange Page', action: 'open_exchange_url' },
                { label: 'Menu', action: 'main_menu' }
            ]
        );
    }

    // ========== FLOW 3: TRACK YOUR REQUEST ==========
    function startTrackRequest() {
        flowState = 'awaiting_request_track_id';
        flowContext = {};
        setInputMode('text');
        addBotMessage('Enter your *order number* or *request ID* (e.g. REQ-12345) to check your return or exchange request status.', [
            { label: 'Back to Menu', action: 'main_menu' }
        ]);
    }
    
    function doTrackRequest(input, persist) {
        if (persist !== false) recordWidgetEvent('customer', String(input));
        flowState = 'tracking_request';
        showTyping();

        // Detect if user entered a REQ-XXXX request ID or an order number
        var parsed = parseOrderOrTracking(input);
        var payload = {};
        if (parsed && parsed.type === 'request') {
            payload.requestId = parsed.id;
        } else if (parsed && parsed.type === 'order') {
            payload.orderId = parsed.id;
        } else {
            payload.orderId = String(input).replace(/^#/, '').replace(/\s/g, '').trim();
        }

        fetch(API_URL + '/api/widget/track-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            hideTyping();
            if (data.error) {
                addBotMessage(data.error, [
                    { label: 'Try Again', action: 'track_request', primary: true },
                    { label: 'Menu', action: 'main_menu' }
                ]);
            } else if (data.requests && data.requests.length > 0) {
                data.requests.forEach(function (req) {
                    addRequestCard(req);
                });
                addBotMessage('Anything else?', [
                    { label: 'Track Another', action: 'track_request', primary: true },
                    { label: 'Return / Exchange', action: 'file_return' },
                    { label: 'Menu', action: 'main_menu' }
                ]);
            } else {
                var label = payload.requestId || ('#' + payload.orderId);
                addBotMessage(
                    'No return or exchange request found for *' + label + '*.\n\n' +
                    'You can submit a request on our pages.',
                    [
                        { label: 'Return Page', action: 'open_return_url', primary: true },
                        { label: 'Exchange Page', action: 'open_exchange_url' },
                        { label: 'Menu', action: 'main_menu' }
                    ]
                );
            }
            setInputMode('text');
            flowState = 'idle';
        })
        .catch(function () {
            hideTyping();
            addBotMessage('Unable to check right now. Please try again later.', [
                { label: 'Try Again', action: 'track_request', primary: true },
                { label: 'Menu', action: 'main_menu' }
            ]);
            setInputMode('text');
            flowState = 'idle';
        });
    }

    // ========== FLOW 4: CONTACT SUPPORT ==========
    var MAX_AI_ATTEMPTS = 3; // Keep conversing for 3 replies before showing Create Ticket

    function startContactSupport() {
        flowState = 'awaiting_ticket_order_id';
        flowContext = {};
        flowContext.aiAttempts = 0;
        setInputMode('order');
        addBotMessage('Please enter your *order number* so we can pull up your details.', [
            { label: 'Back to Menu', action: 'main_menu' }
        ]);
    }

    // After AI tries to resolve and user wants to escalate directly
    function startCreateTicket() {
        if (flowContext.orderId) {
            // Already have order ID from this session — go straight to issue description
            flowState = 'awaiting_ticket_message';
            addBotMessage('Please describe your issue briefly and we will create a support ticket for you.', [
                { label: 'Back to Menu', action: 'main_menu' }
            ]);
            setInputPlaceholder('Describe your issue...');
        } else {
            flowState = 'awaiting_ticket_order_id';
            setInputMode('order');
            addBotMessage('Let me pull up your order first. Please enter your *order number*.', [
                { label: 'Back to Menu', action: 'main_menu' }
            ]);
        }
    }

    // User wants to ask another question to the AI
    function retrySupportQuestion() {
        flowState = 'awaiting_support_message';
        addBotMessage('Sure, go ahead — describe your question and I will try to help.');
        setInputPlaceholder('Type your question...');
    }

    function doResolveWithAI(message) {
        flowState = 'resolving_with_ai';
        flowContext.aiAttempts = (flowContext.aiAttempts || 0) + 1;
        showTyping();

        fetch(API_URL + '/api/widget/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: sessionId,
                visitorId: visitorId,
                message: (flowContext.orderId ? '[Order #' + flowContext.orderId + '] ' : '') + '[' + (flowContext.supportTopic || 'General') + '] ' + message
            })
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            hideTyping();
            var aiReply = data.reply || 'I was unable to process your request.';
            var aiSaysCreateTicket = data.suggestedAction === 'create_ticket';
            var attempts = flowContext.aiAttempts || 0;
            var exhaustedAttempts = attempts >= MAX_AI_ATTEMPTS;

            // Only offer Create Ticket after exhausting all AI attempts (ignore AI's create_ticket signal until then)
            if (exhaustedAttempts) {
                var escalationMsg = aiReply;
                escalationMsg += '\n\nIt seems I am not able to fully resolve this. Would you like to create a support ticket so our team can assist you directly?';
                addBotMessage(escalationMsg, [
                    { label: 'Create Ticket', action: 'create_support_ticket', primary: true },
                    { label: 'Try Another Question', action: 'retry_support' },
                    { label: 'Menu', action: 'main_menu' }
                ], false);
            } else {
                addBotMessage(aiReply, [
                    { label: 'Try Another Question', action: 'retry_support', primary: true },
                    { label: 'Menu', action: 'main_menu' }
                ], false);
            }
            setInputMode('text');
            flowState = 'idle';
        })
        .catch(function () {
            hideTyping();
            var attempts = flowContext.aiAttempts || 0;
            if (attempts >= MAX_AI_ATTEMPTS) {
                addBotMessage('I could not connect to our support assistant. Would you like to create a ticket instead?', [
                    { label: 'Create Ticket', action: 'create_support_ticket', primary: true },
                    { label: 'Menu', action: 'main_menu' }
                ]);
            } else {
                addBotMessage('I had trouble processing that. Could you rephrase or try another question?', [
                    { label: 'Try Another Question', action: 'retry_support', primary: true },
                    { label: 'Menu', action: 'main_menu' }
                ]);
            }
            setInputMode('text');
            flowState = 'idle';
        });
    }

    function doCreateSupportTicket(message) {
        recordWidgetEvent('customer', String(message));
        flowState = 'creating_ticket';
        showTyping();

        var ticketMessage = '[Website] [' + (flowContext.supportTopic || 'General') + '] ' + message;
        
        // Use looked-up customer details from order, fallback to widget config
        var ticketName = flowContext.customerName || CUSTOMER_NAME || 'Customer';
        var ticketPhone = flowContext.customerPhone || CUSTOMER_PHONE || '';
        var ticketEmail = flowContext.customerEmail || '';

        fetch(API_URL + '/api/widget/ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: ticketName,
                phone: ticketPhone,
                email: ticketEmail,
                message: ticketMessage,
                orderId: flowContext.orderId || null,
                source: 'website',
                sessionId: sessionId,
                visitorId: visitorId
            })
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            hideTyping();
            if (data.success) {
                addTicketConfirmation(data);
            } else {
                addBotMessage('Could not create the ticket. Please try again.', [
                    { label: 'Try Again', action: 'contact_support', primary: true },
                    { label: 'Menu', action: 'main_menu' }
                ]);
            }
            setInputMode('text');
            flowState = 'idle';
        })
        .catch(function () {
            hideTyping();
            addBotMessage('Something went wrong. Please try again.', [
                { label: 'Menu', action: 'main_menu' }
            ]);
            setInputMode('text');
            flowState = 'idle';
        });
    }

    // ---------- Cards ----------
    function addTrackingCard(data) {
        var chat = document.getElementById('oftb-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'oftb-msg-wrap oftb-align-left';
        var card = document.createElement('div');
        card.className = 'oftb-tracking-card';

        var statusText = data.status || 'Unknown';
        var statusClass = 'oftb-status-unknown';
        if (/delivered/i.test(statusText)) statusClass = 'oftb-status-delivered';
        else if (/transit|shipped|dispatched|in.?transit|out.?for.?delivery/i.test(statusText)) statusClass = 'oftb-status-transit';
        else if (/pending|unfulfilled|confirm/i.test(statusText)) statusClass = 'oftb-status-pending';

        var carrierName = data.carrierName || 'Carrier';
        var html = '<div class="oftb-tracking-card-header">';
        html += '<span class="oftb-tracking-carrier">' + escapeHtml(carrierName) + '</span>';
        html += '<span class="oftb-tracking-status ' + statusClass + '">' + escapeHtml(statusText) + '</span>';
        html += '</div>';

        if (data.orderId) html += '<div class="oftb-tracking-row"><span>Order</span><span>#' + escapeHtml(data.orderId) + '</span></div>';
        if (data.awb) html += '<div class="oftb-tracking-row"><span>AWB</span><span>' + escapeHtml(data.awb) + '</span></div>';
        if (data.location) html += '<div class="oftb-tracking-row"><span>Location</span><span>' + escapeHtml(data.location) + '</span></div>';
        if (data.expectedDelivery) html += '<div class="oftb-tracking-row"><span>Expected</span><span>' + escapeHtml(data.expectedDelivery) + '</span></div>';
        if (data.deliveredDate) html += '<div class="oftb-tracking-row"><span>Delivered</span><span>' + escapeHtml(data.deliveredDate) + '</span></div>';
        if (data.note) html += '<div class="oftb-tracking-row"><span></span><span style="color:#999;font-style:italic;font-size:11px;">' + escapeHtml(data.note) + '</span></div>';

        if (data.timeline && data.timeline.length) {
            html += '<div class="oftb-timeline-title">Timeline</div><div class="oftb-timeline">';
            var items = data.timeline.slice().sort(function (a, b) { return (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0); }).slice(0, 6);
            items.forEach(function (t) {
                var label = t.activity || t.status || 'Update';
                var meta = [t.date, t.location].filter(Boolean).join(' \u00B7 ');
                html += '<div class="oftb-timeline-item"><div class="oftb-timeline-dot"></div><div><div class="oftb-timeline-activity">' + escapeHtml(label) + '</div>';
                if (meta) html += '<div class="oftb-timeline-meta">' + escapeHtml(meta) + '</div>';
                html += '</div></div>';
            });
            html += '</div>';
        }
        if (data.trackingUrl) html += '<a href="' + escapeHtml(data.trackingUrl) + '" target="_blank" class="oftb-tracking-link">Track Live</a>';

        card.innerHTML = html;
        wrapper.appendChild(card);
        chat.appendChild(wrapper);
        scrollToBottom();
        recordWidgetEvent('bot', 'Order tracking update', { type: 'tracking', data: data });
    }

    function addRequestCard(req) {
        var chat = document.getElementById('oftb-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'oftb-msg-wrap oftb-align-left';
        var card = document.createElement('div');
        card.className = 'oftb-return-card';

        var statusText = req.status || 'Pending';
        var statusClass = 'oftb-return-pending';
        if (/approved|completed|picked.?up|in_transit/i.test(statusText)) statusClass = 'oftb-return-approved';
        else if (/rejected|denied|cancelled/i.test(statusText)) statusClass = 'oftb-return-rejected';

        var typeText = req.type === 'exchange' ? 'Exchange' : 'Return';
        var html = '<div class="oftb-return-card-header">';
        html += '<span class="oftb-return-type">' + escapeHtml(typeText) + '</span>';
        html += '<span class="oftb-return-status ' + statusClass + '">' + escapeHtml(statusText) + '</span>';
        html += '</div>';

        if (req.request_id) html += '<div class="oftb-return-row"><span class="label">Request ID</span><span class="value">' + escapeHtml(req.request_id) + '</span></div>';
        if (req.order_number) html += '<div class="oftb-return-row"><span class="label">Order</span><span class="value">#' + escapeHtml(req.order_number) + '</span></div>';
        if (req.reason) html += '<div class="oftb-return-row"><span class="label">Reason</span><span class="value">' + escapeHtml(req.reason) + '</span></div>';
        if (req.created_at) {
            var date = new Date(req.created_at);
            var dateStr = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            html += '<div class="oftb-return-row"><span class="label">Requested</span><span class="value">' + escapeHtml(dateStr) + '</span></div>';
        }

        if (req.items && req.items.length > 0) {
            html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #f0f0f0;">';
            html += '<div style="font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">Items</div>';
            req.items.forEach(function (item) {
                var itemName = item.name || item.title || 'Item';
                var itemVariant = item.variant || '';
                var itemQty = item.quantity || 1;
                html += '<div style="font-size:12px;color:#1a1a1a;padding:4px 0;">';
                html += escapeHtml(itemName);
                if (itemVariant) html += ' <span style="color:#999;font-size:11px;">(' + escapeHtml(itemVariant) + ')</span>';
                html += ' <span style="color:#bbb;font-size:11px;">x' + itemQty + '</span>';
                html += '</div>';
            });
            html += '</div>';
        }

        card.innerHTML = html;
        wrapper.appendChild(card);
        chat.appendChild(wrapper);
        scrollToBottom();
        recordWidgetEvent('bot', (typeText || 'Return') + ' request update', { type: 'return_request', data: req });
    }

    function addTicketConfirmation(data) {
        var chat = document.getElementById('oftb-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'oftb-msg-wrap oftb-align-left';
        var el = document.createElement('div');
        el.className = 'oftb-ticket-confirm';

        var html =
            '<div class="oftb-ticket-confirm-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>' +
            '<h4>Ticket Created</h4>' +
            '<p>Please continue on WhatsApp.</p>' +
            '<div class="oftb-ticket-number">' + escapeHtml(data.ticketNumber) + '</div>';

        if (data.whatsappLink) {
            html += '<a href="' + escapeHtml(data.whatsappLink) + '" target="_blank" class="oftb-whatsapp-btn">' +
                '<svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0 0 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"/></svg>' +
                'Continue on WhatsApp</a>';
        }

        el.innerHTML = html;
        wrapper.appendChild(el);
        chat.appendChild(wrapper);
        scrollToBottom();
        recordWidgetEvent('bot', 'Support ticket created: ' + (data.ticketNumber || ''), { type: 'ticket', data: data });

        setTimeout(function () {
            addBotMessage('Anything else we can help with?', [
                { label: 'Track Order', action: 'track_order' },
                { label: 'Return / Exchange', action: 'file_return' },
                { label: 'Menu', action: 'main_menu' }
            ]);
        }, 400);
    }

    // ---------- Input Handling ----------
    function handleSend() {
        var input = document.getElementById('oftb-input');
        var text = input.value.trim();
        if (!text || isTyping) return;
        input.value = '';

        if (flowState === 'awaiting_ticket_order_id') {
            addUserMessage(text);
            var parsedTicket = parseOrderOrTracking(text);
            if (parsedTicket && parsedTicket.type === 'order') {
                recordWidgetEvent('customer', text);
                var cleaned = parsedTicket.id;
                flowContext.orderId = cleaned;
                
                // Lookup customer details from order number
                showTyping();
                fetch(API_URL + '/api/widget/lookup-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId: cleaned })
                })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    hideTyping();
                    if (data.success && data.name) {
                        flowContext.customerName = data.name;
                        flowContext.customerPhone = data.phone || '';
                        flowContext.customerEmail = data.email || '';
                    }
                    // Now ask for the topic
                    flowState = 'awaiting_support_topic';
                    setInputMode('text');
                    var greeting = flowContext.customerName ? 'Thanks, ' + flowContext.customerName + '. ' : 'Got it. ';
                    addBotMessage(greeting + 'Order *#' + cleaned + '*. What do you need help with?', [
                        { label: 'Order Issue', action: 'support_order_issue' },
                        { label: 'Product Question', action: 'support_product' },
                        { label: 'Delivery Problem', action: 'support_delivery' },
                        { label: 'Other', action: 'support_other' }
                    ]);
                })
                .catch(function () {
                    hideTyping();
                    // Lookup failed, continue without customer details
                    flowState = 'awaiting_support_topic';
                    setInputMode('text');
                    addBotMessage('Got it — Order *#' + cleaned + '*. What do you need help with?', [
                        { label: 'Order Issue', action: 'support_order_issue' },
                        { label: 'Product Question', action: 'support_product' },
                        { label: 'Delivery Problem', action: 'support_delivery' },
                        { label: 'Other', action: 'support_other' }
                    ]);
                });
            } else {
                // Customer typed an issue description without an explicit order number
                flowContext.supportTopic = 'General';
                flowState = 'awaiting_support_message';
                doResolveWithAI(text);
            }
        } else if (flowState === 'awaiting_order_id') {
            addUserMessage(text);
            var parsedOrder = parseOrderOrTracking(text);
            if (parsedOrder) {
                recordWidgetEvent('customer', text);
                if (parsedOrder.type === 'request') {
                    doTrackRequest(parsedOrder.id, false);
                } else {
                    doTrackOrder(parsedOrder.id, false);
                }
            } else {
                // Free-text/question in order tracking — let AI handle it instead of hard rejecting
                if (typeof flowContext.aiAttempts !== 'number') {
                    flowContext = { aiAttempts: 0 };
                }
                doResolveWithAI(text);
            }
        } else if (flowState === 'awaiting_request_track_id') {
            addUserMessage(text);
            var parsedReq = parseOrderOrTracking(text);
            if (parsedReq) {
                recordWidgetEvent('customer', text);
                doTrackRequest(parsedReq.id, false);
            } else {
                recordWidgetEvent('customer', text);
                addBotMessage('Please enter a valid *order number* or *request ID* (e.g. REQ-12345).', [
                    { label: 'Back to Menu', action: 'main_menu' }
                ]);
            }
        } else if (flowState === 'awaiting_support_message') {
            addUserMessage(text);
            doResolveWithAI(text);
        } else if (flowState === 'awaiting_ticket_message') {
            addUserMessage(text);
            doCreateSupportTicket(text);
        } else {
            addUserMessage(text);
            var parsedIdle = parseOrderOrTracking(text);
            if (parsedIdle) {
                recordWidgetEvent('customer', text);
                if (parsedIdle.type === 'request') {
                    doTrackRequest(parsedIdle.id, false);
                } else {
                    doTrackOrder(parsedIdle.id, false);
                }
            } else {
                // Free-text in idle state — continue the AI conversation instead of showing the menu
                if (typeof flowContext.aiAttempts !== 'number') {
                    flowContext = { aiAttempts: 0 };
                }
                doResolveWithAI(text);
            }
        }
    }

    // ---------- Utilities ----------
    function scrollToBottom() {
        var chat = document.getElementById('oftb-chat');
        if (chat) setTimeout(function () { chat.scrollTop = chat.scrollHeight; }, 50);
    }
    function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ---------- Initialize ----------
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createWidget);
    } else {
        createWidget();
    }

})();
