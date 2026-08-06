/**
 * OFFCOMFRT Support Widget — Self-contained with inline CSS
 * All styles are injected via <style> tag — no external CSS file needed.
 */

(function () {
    'use strict';

    // ---------- Configuration ----------
    var config = window.__offcomfrt_widget || {};
    var API_URL = (config.apiUrl || '').replace(/\/$/, '');
    var BRAND_NAME = config.brandName || 'OFFCOMFRT';
    var CUSTOMER_NAME = config.customerName || '';
    var CUSTOMER_EMAIL = config.customerEmail || '';
    var CUSTOMER_PHONE = config.customerPhone || '';

    // ---------- Session Management ----------
    var sessionId = sessionStorage.getItem('offcomfrt_session');
    if (!sessionId) {
        sessionId = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 8);
        sessionStorage.setItem('offcomfrt_session', sessionId);
    }

    var isOpen = false;
    var isTyping = false;

    // Clear old chat history
    var storedVersion = sessionStorage.getItem('offcomfrt_version');
    if (storedVersion !== '3') {
        sessionStorage.removeItem('offcomfrt_chat');
        sessionStorage.setItem('offcomfrt_version', '3');
    }

    var chatHistory = JSON.parse(sessionStorage.getItem('offcomfrt_chat') || '[]');

    // ---------- Inject CSS ----------
    function injectStyles() {
        if (document.getElementById('offcomfrt-styles')) return;
        var style = document.createElement('style');
        style.id = 'offcomfrt-styles';
        style.textContent = [
            /* Reset */
            '#offcomfrt-widget *,#offcomfrt-widget *::before,#offcomfrt-widget *::after{box-sizing:border-box;margin:0;padding:0}',

            /* Floating Button */
            '#offcomfrt-widget-btn{position:fixed;bottom:28px;right:28px;width:62px;height:62px;border-radius:50%;background:linear-gradient(145deg,#1a1a1a,#000);border:2px solid rgba(255,255,255,0.08);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(0,0,0,0.35),0 2px 8px rgba(0,0,0,0.2);z-index:99998;transition:all 0.35s cubic-bezier(0.34,1.56,0.64,1);animation:offcomfrt-float 3s ease-in-out infinite}',
            '@keyframes offcomfrt-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
            '#offcomfrt-widget-btn:hover{transform:scale(1.08) translateY(-2px);box-shadow:0 12px 40px rgba(0,0,0,0.4)}',
            '#offcomfrt-widget-btn:active{transform:scale(0.95)}',
            '#offcomfrt-widget-btn svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

            /* Widget Container */
            '#offcomfrt-widget{position:fixed;bottom:28px;right:28px;width:420px;height:700px;max-height:calc(100vh - 56px);background:#fff;border-radius:24px;border:2px solid #000;box-shadow:0 32px 100px rgba(0,0,0,0.25),0 12px 40px rgba(0,0,0,0.15);z-index:99999;display:flex;flex-direction:column;overflow:hidden;font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;transform:translateY(16px) scale(0.92);pointer-events:none;transition:all 0.4s cubic-bezier(0.16,1,0.3,1)}',
            '#offcomfrt-widget.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all}',

            /* Header */
            '.offcomfrt-header{background:linear-gradient(135deg,#0a0a0a,#1a1a1a 50%,#0a0a0a);color:#fff;padding:24px 22px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;position:relative;overflow:hidden}',
            '.offcomfrt-header-brand{display:flex;align-items:center;gap:14px}',
            '.offcomfrt-header-avatar{width:48px;height:48px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;position:relative;box-shadow:0 2px 8px rgba(0,0,0,0.3);overflow:hidden;border:2px solid rgba(255,255,255,0.2)}',
            '.offcomfrt-header-avatar img{width:100%;height:100%;object-fit:cover}',
            '.offcomfrt-header-avatar::after{content:"";position:absolute;bottom:2px;right:2px;width:10px;height:10px;background:#22c55e;border-radius:50%;border:2px solid #0a0a0a;box-shadow:0 0 8px rgba(34,197,94,0.5)}',
            '.offcomfrt-header-info{display:flex;flex-direction:column;gap:3px}',
            '.offcomfrt-header-title{font-size:18px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase}',
            '.offcomfrt-header-subtitle{font-size:13px;opacity:0.7;font-weight:500;display:flex;align-items:center;gap:6px}',
            '.offcomfrt-header-subtitle::before{content:"";width:6px;height:6px;background:#22c55e;border-radius:50%;display:inline-block}',
            '.offcomfrt-header-close{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.1);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.25s ease}',
            '.offcomfrt-header-close:hover{background:rgba(255,255,255,0.2);transform:rotate(90deg)}',
            '.offcomfrt-header-close svg{width:18px;height:18px;stroke:#fff;stroke-width:2;stroke-linecap:round}',

            /* Chat Area */
            '.offcomfrt-chat{flex:1;overflow-y:auto;padding:24px 16px;display:flex;flex-direction:column;gap:16px;scroll-behavior:smooth;background:#fafafa;min-height:0}',
            '.offcomfrt-chat::-webkit-scrollbar{width:6px}',
            '.offcomfrt-chat::-webkit-scrollbar-track{background:transparent}',
            '.offcomfrt-chat::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:3px}',

            /* Messages */
            '#offcomfrt-widget .offcomfrt-msg-wrapper{display:flex;flex-direction:column;gap:4px;animation:offcomfrt-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);padding:0 8px;margin:0 8px;width:calc(100% - 16px)}',
            '#offcomfrt-widget .offcomfrt-align-left{align-items:flex-start}',
            '#offcomfrt-widget .offcomfrt-align-right{align-items:flex-end}',
            '@keyframes offcomfrt-slideUp{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}',
            '.offcomfrt-msg{padding:16px 20px;border-radius:20px;font-size:14px;line-height:1.65;word-wrap:break-word;letter-spacing:0.01em}',
            '.offcomfrt-msg-bot{align-self:flex-start;background:#fff;color:#1a1a1a;border-bottom-left-radius:8px;border:1px solid #e0e0e0;box-shadow:0 2px 8px rgba(0,0,0,0.06)}',
            '.offcomfrt-msg-user{align-self:flex-end;background:linear-gradient(135deg,#1a1a1a,#000);color:#fff;border-bottom-right-radius:8px;border:1px solid #000;box-shadow:0 4px 12px rgba(0,0,0,0.2)}',

            /* Quick Actions */
            '.offcomfrt-actions{display:flex;flex-wrap:wrap;gap:10px;padding:0 16px 12px;flex-shrink:0}',
            '.offcomfrt-chip{padding:10px 18px;border-radius:24px;border:1.5px solid rgba(0,0,0,0.15);background:#fff;color:#1a1a1a;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;transition:all 0.25s cubic-bezier(0.34,1.56,0.64,1);letter-spacing:0.01em}',
            '.offcomfrt-chip:hover{background:#000;color:#fff;border-color:#000;transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.15)}',
            '.offcomfrt-chip:active{transform:translateY(0) scale(0.96)}',

            /* Input Area */
            '.offcomfrt-input-area{padding:14px 16px 16px;border-top:2px solid #000;display:flex;align-items:center;gap:12px;flex-shrink:0;background:#fff}',
            '.offcomfrt-input{flex:1;border:1.5px solid rgba(0,0,0,0.12);border-radius:28px;padding:12px 18px;font-size:14px;font-family:inherit;outline:none;transition:all 0.2s ease;background:#f8f9fa;color:#1a1a1a;min-height:44px;width:100%}',
            '.offcomfrt-input:focus{border-color:rgba(0,0,0,0.3);background:#fff;box-shadow:0 0 0 4px rgba(0,0,0,0.06)}',
            '.offcomfrt-input::placeholder{color:#aaa}',
            '.offcomfrt-send-btn{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#1a1a1a,#000);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.25s cubic-bezier(0.34,1.56,0.64,1);flex-shrink:0;box-shadow:0 4px 12px rgba(0,0,0,0.2)}',
            '.offcomfrt-send-btn:hover{transform:scale(1.08)}',
            '.offcomfrt-send-btn:active{transform:scale(0.92)}',
            '.offcomfrt-send-btn svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

            /* Powered By */
            '.offcomfrt-powered{text-align:center;padding:10px;font-size:10px;color:#999;letter-spacing:0.5px;flex-shrink:0;font-weight:600;text-transform:uppercase;background:#fff;border-top:1px solid #e5e5e5}',

            /* Typing Indicator */
            '.offcomfrt-typing{display:flex;gap:5px;padding:16px 20px;background:#fff;border-radius:20px;border-bottom-left-radius:8px;border:1px solid #e0e0e0;box-shadow:0 2px 8px rgba(0,0,0,0.06);align-self:flex-start}',
            '.offcomfrt-typing-dot{width:7px;height:7px;border-radius:50%;background:#999;animation:offcomfrt-bounce 1.4s ease-in-out infinite}',
            '.offcomfrt-typing-dot:nth-child(2){animation-delay:0.2s}',
            '.offcomfrt-typing-dot:nth-child(3){animation-delay:0.4s}',
            '@keyframes offcomfrt-bounce{0%,60%,100%{transform:translateY(0);opacity:0.5}30%{transform:translateY(-6px);opacity:1}}',

            /* Tracking Card */
            '.offcomfrt-tracking-card{background:#fff;border:1px solid #e0e0e0;border-radius:16px;padding:20px;margin:4px 0;box-shadow:0 4px 16px rgba(0,0,0,0.06);animation:offcomfrt-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '.offcomfrt-tracking-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #f0f0f0}',
            '.offcomfrt-tracking-carrier{font-size:11px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.8px}',
            '.offcomfrt-tracking-status{font-size:11px;font-weight:600;padding:5px 12px;border-radius:12px;text-transform:uppercase;letter-spacing:0.5px}',
            '.offcomfrt-status-delivered{background:#dcfce7;color:#16a34a}',
            '.offcomfrt-status-transit{background:#dbeafe;color:#2563eb}',
            '.offcomfrt-status-unknown{background:#f3f4f6;color:#6b7280}',
            '.offcomfrt-tracking-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f5f5f5}',
            '.offcomfrt-tracking-row:last-child{border-bottom:none}',
            '.offcomfrt-tracking-row span:first-child{font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px}',
            '.offcomfrt-tracking-row span:last-child{font-size:13px;font-weight:500;color:#1a1a1a;text-align:right}',
            '.offcomfrt-tracking-link{display:block;text-align:center;margin-top:16px;padding:12px;background:#f8f9fa;border-radius:12px;color:#1a1a1a;text-decoration:none;font-size:13px;font-weight:600;transition:all 0.2s ease;border:1px solid #e5e5e5}',
            '.offcomfrt-tracking-link:hover{background:#000;color:#fff;border-color:#000}',
            '.offcomfrt-timeline-title{font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:0.8px;margin-top:16px}',
            '.offcomfrt-timeline{margin-top:10px}',
            '.offcomfrt-timeline-item{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #f7f7f7}',
            '.offcomfrt-timeline-item:last-child{border-bottom:none}',
            '.offcomfrt-timeline-dot{width:8px;height:8px;border-radius:50%;background:#1a1a1a;margin-top:4px;flex-shrink:0}',
            '.offcomfrt-timeline-activity{font-size:13px;font-weight:500;color:#1a1a1a}',
            '.offcomfrt-timeline-meta{font-size:11px;color:#999;margin-top:2px}',

            /* Ticket Form */
            '.offcomfrt-ticket-form{background:#fff;border:1px solid #e0e0e0;border-radius:16px;padding:20px;margin:4px 0;box-shadow:0 4px 16px rgba(0,0,0,0.06);animation:offcomfrt-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '.offcomfrt-ticket-form h4{font-size:15px;font-weight:700;margin-bottom:16px;color:#1a1a1a}',
            '.offcomfrt-form-group{margin-bottom:12px}',
            '.offcomfrt-form-group label{display:block;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}',
            '.offcomfrt-ticket-form input,.offcomfrt-ticket-form textarea{width:100%;border:1.5px solid #e5e5e5;border-radius:12px;padding:12px 16px;font-size:13px;font-family:inherit;outline:none;transition:all 0.2s ease;background:#f8f9fa;color:#1a1a1a}',
            '.offcomfrt-ticket-form input:focus,.offcomfrt-ticket-form textarea:focus{border-color:#000;background:#fff;box-shadow:0 0 0 3px rgba(0,0,0,0.06)}',
            '.offcomfrt-ticket-form textarea{resize:vertical;min-height:80px}',
            '.offcomfrt-form-submit{width:100%;padding:14px;background:linear-gradient(135deg,#1a1a1a,#000);color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;transition:all 0.25s;letter-spacing:0.5px;margin-top:4px}',
            '.offcomfrt-form-submit:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,0.2)}',
            '.offcomfrt-form-submit:active{transform:translateY(0) scale(0.98)}',
            '.offcomfrt-form-submit:disabled{opacity:0.6;cursor:not-allowed;transform:none}',

            /* Ticket Confirmation */
            '.offcomfrt-ticket-confirmation{background:#fff;border:1px solid #e0e0e0;border-radius:16px;padding:28px 24px;margin:4px 0;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.06);animation:offcomfrt-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '.offcomfrt-ticket-confirm-icon{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#dcfce7,#bbf7d0);display:flex;align-items:center;justify-content:center;margin:0 auto 16px}',
            '.offcomfrt-ticket-confirm-icon svg{width:26px;height:26px;stroke:#16a34a;stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round}',
            '.offcomfrt-ticket-confirmation h4{font-size:17px;font-weight:700;margin-bottom:8px;color:#1a1a1a}',
            '.offcomfrt-ticket-confirmation p{font-size:13px;color:#666;margin-bottom:16px;line-height:1.5}',
            '.offcomfrt-ticket-number{display:inline-block;background:#f3f4f6;padding:8px 16px;border-radius:8px;font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:16px;font-family:"SF Mono",Monaco,monospace}',
            '.offcomfrt-whatsapp-btn{display:inline-flex;align-items:center;gap:8px;padding:14px 24px;background:#25d366;color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;transition:all 0.25s;box-shadow:0 4px 12px rgba(37,211,102,0.3)}',
            '.offcomfrt-whatsapp-btn:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(37,211,102,0.4)}',
            '.offcomfrt-whatsapp-btn svg{width:18px;height:18px;fill:currentColor}',

            /* Rich Message Formatting */
            '.offcomfrt-msg-bot strong{font-weight:700}',
            '.offcomfrt-msg-bot em{font-style:italic}',
            '.offcomfrt-msg-bot ul,.offcomfrt-msg-bot ol{margin:6px 0;padding-left:18px}',
            '.offcomfrt-msg-bot li{margin:2px 0}',
            '.offcomfrt-msg-bot br+br{display:none}',

            /* Return/Exchange Status Card */
            '.offcomfrt-return-card{background:#fff;border:1px solid #e0e0e0;border-radius:16px;padding:20px;margin:4px 0;box-shadow:0 4px 16px rgba(0,0,0,0.06);animation:offcomfrt-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '.offcomfrt-return-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #f0f0f0}',
            '.offcomfrt-return-type{font-size:11px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.8px}',
            '.offcomfrt-return-status{font-size:11px;font-weight:600;padding:5px 12px;border-radius:12px;text-transform:uppercase;letter-spacing:0.5px}',
            '.offcomfrt-return-approved{background:#dcfce7;color:#16a34a}',
            '.offcomfrt-return-pending{background:#fef3c7;color:#d97706}',
            '.offcomfrt-return-rejected{background:#fee2e2;color:#dc2626}',
            '.offcomfrt-return-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f5f5f5;font-size:13px}',
            '.offcomfrt-return-row:last-child{border-bottom:none}',
            '.offcomfrt-return-row .label{color:#999;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}',
            '.offcomfrt-return-row .value{color:#1a1a1a;font-weight:500}',

            /* Resolution Card */
            '.offcomfrt-resolution-card{background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1px solid #bbf7d0;border-radius:16px;padding:24px;margin:4px 0;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.06);animation:offcomfrt-slideUp 0.35s cubic-bezier(0.16,1,0.3,1);width:100%}',
            '.offcomfrt-resolution-icon{width:44px;height:44px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;margin:0 auto 12px}',
            '.offcomfrt-resolution-icon svg{width:22px;height:22px;stroke:#fff;stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round}',
            '.offcomfrt-resolution-card h4{font-size:15px;font-weight:700;color:#16a34a;margin-bottom:6px}',
            '.offcomfrt-resolution-card p{font-size:13px;color:#4b5563;line-height:1.5}',

            /* Mobile */
            '@media(max-width:480px){',
            '#offcomfrt-widget{bottom:0;right:0;left:0;width:100%;height:90vh;max-height:750px;border-radius:24px 24px 0 0;border:none;border-top:2px solid #000;box-shadow:0 -12px 48px rgba(0,0,0,0.2)}',
            '#offcomfrt-widget-btn{bottom:20px;right:20px;width:56px;height:56px}',
            '.offcomfrt-header{padding:20px 16px}',
            '.offcomfrt-chat{padding:20px 12px;gap:14px}',
            '#offcomfrt-widget .offcomfrt-msg-wrapper{padding:0 6px;margin:0 6px;width:calc(100% - 12px)}',
            '.offcomfrt-actions{padding:0 12px 10px}',
            '.offcomfrt-input-area{padding:12px 12px 14px}',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }

    // ---------- DOM Creation ----------

    function createWidget() {
        injectStyles();

        // Floating button
        var btn = document.createElement('button');
        btn.id = 'offcomfrt-widget-btn';
        btn.setAttribute('aria-label', 'Open support chat');
        btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        btn.addEventListener('click', toggleWidget);
        document.body.appendChild(btn);

        // Widget container
        var widget = document.createElement('div');
        widget.id = 'offcomfrt-widget';
        widget.innerHTML =
            '<div class="offcomfrt-header">' +
                '<div class="offcomfrt-header-brand">' +
                    '<div class="offcomfrt-header-avatar">' +
                        '<img src="' + API_URL + '/widget/logo.jpg" alt="' + BRAND_NAME + '" />' +
                    '</div>' +
                    '<div class="offcomfrt-header-info">' +
                        '<span class="offcomfrt-header-title">' + BRAND_NAME + '</span>' +
                        '<span class="offcomfrt-header-subtitle">Online now</span>' +
                    '</div>' +
                '</div>' +
                '<button class="offcomfrt-header-close" aria-label="Close">' +
                    '<svg viewBox="0 0 24 24">' +
                        '<line x1="18" y1="6" x2="6" y2="18"/>' +
                        '<line x1="6" y1="6" x2="18" y2="18"/>' +
                    '</svg>' +
                '</button>' +
            '</div>' +
            '<div class="offcomfrt-chat" id="offcomfrt-chat"></div>' +
            '<div class="offcomfrt-actions" id="offcomfrt-actions"></div>' +
            '<div class="offcomfrt-input-area">' +
                '<input type="text" class="offcomfrt-input" id="offcomfrt-input" placeholder="Type a message..." autocomplete="off" />' +
                '<button class="offcomfrt-send-btn" id="offcomfrt-send-btn" aria-label="Send">' +
                    '<svg viewBox="0 0 24 24">' +
                        '<line x1="22" y1="2" x2="11" y2="13"/>' +
                        '<polygon points="22 2 15 22 11 13 2 9 22 2"/>' +
                    '</svg>' +
                '</button>' +
            '</div>' +
            '<div class="offcomfrt-powered">Powered by ' + BRAND_NAME + '</div>';

        document.body.appendChild(widget);

        // Event listeners
        widget.querySelector('.offcomfrt-header-close').addEventListener('click', closeWidget);
        widget.querySelector('#offcomfrt-send-btn').addEventListener('click', handleSend);
        widget.querySelector('#offcomfrt-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });

        // Restore chat history or show welcome
        if (chatHistory.length > 0) {
            chatHistory.forEach(function (msg) {
                if (msg.type === 'bot') addBotMessage(msg.text, false);
                else if (msg.type === 'user') addUserMessage(msg.text, false);
                else if (msg.type === 'tracking') addTrackingCard(msg.data, false);
                else if (msg.type === 'return') addReturnCard(msg.data, false);
                else if (msg.type === 'resolution') addResolutionCard(msg.data, false);
                else if (msg.type === 'ticket') addTicketConfirmation(msg.data, false);
            });
            scrollToBottom();
            if (chatHistory.length <= 2) {
                showQuickActions();
            }
        } else {
            showWelcome();
        }
    }

    // ---------- Widget Open/Close ----------

    function toggleWidget() {
        if (isOpen) closeWidget();
        else openWidget();
    }

    function openWidget() {
        var widget = document.getElementById('offcomfrt-widget');
        var btn = document.getElementById('offcomfrt-widget-btn');
        widget.classList.add('open');
        btn.style.display = 'none';
        isOpen = true;
        setTimeout(function () {
            document.getElementById('offcomfrt-input').focus();
        }, 300);
    }

    function closeWidget() {
        var widget = document.getElementById('offcomfrt-widget');
        var btn = document.getElementById('offcomfrt-widget-btn');
        widget.classList.remove('open');
        btn.style.display = 'flex';
        isOpen = false;
    }

    // ---------- Welcome & Quick Actions ----------

    function showWelcome() {
        addBotMessage('Hey there! Welcome to ' + BRAND_NAME + '. I\'m here to help with your orders, returns, or any questions. How can I assist you today?');
        showQuickActions();
    }

    function showQuickActions() {
        var actionsEl = document.getElementById('offcomfrt-actions');
        actionsEl.innerHTML = '';
        var actions = [
            { label: 'Track Order', action: 'track' },
            { label: 'Return / Exchange', action: 'return_exchange' },
            { label: 'Return Policy', action: 'return_policy' },
            { label: 'Report Issue', action: 'report_issue' },
            { label: 'Cancel Order', action: 'cancel_order' },
            { label: 'Talk to Support', action: 'support' }
        ];
        actions.forEach(function (a) {
            var chip = document.createElement('button');
            chip.className = 'offcomfrt-chip';
            chip.textContent = a.label;
            chip.addEventListener('click', function () {
                handleQuickAction(a.action);
            });
            actionsEl.appendChild(chip);
        });
    }

    function hideQuickActions() {
        document.getElementById('offcomfrt-actions').innerHTML = '';
    }

    function handleQuickAction(action) {
        hideQuickActions();
        if (action === 'track') {
            addBotMessage('Sure! Please enter your order number (e.g. 42000).');
            setInputPlaceholder('Enter your order number...');
        } else if (action === 'return_policy') {
            addUserMessage('What is your return policy?');
            sendToAI('What is your return policy?');
        } else if (action === 'return_exchange') {
            addBotMessage('I can help with returns and exchanges. Please share your order number so I can check eligibility.');
            setInputPlaceholder('Enter your order #...');
        } else if (action === 'report_issue') {
            addBotMessage('Sorry to hear about the issue! Please describe what happened and your order number, and I\'ll help resolve it.');
            setInputPlaceholder('Describe the issue...');
        } else if (action === 'cancel_order') {
            addBotMessage('I can help with order cancellation. Please share your order number.');
            setInputPlaceholder('Enter order # to cancel...');
        } else if (action === 'support') {
            showTicketForm();
        }
    }

    function setInputPlaceholder(text) {
        document.getElementById('offcomfrt-input').placeholder = text;
    }

    // ---------- Message Handling ----------

    function handleSend() {
        var input = document.getElementById('offcomfrt-input');
        var text = input.value.trim();
        if (!text || isTyping) return;

        input.value = '';
        addUserMessage(text);
        hideQuickActions();
        setInputPlaceholder('Type a message...');

        if (/^#?\d{4,}$/.test(text.replace(/\s/g, ''))) {
            trackOrder(text);
        } else {
            sendToAI(text);
        }
    }

    function addUserMessage(text, save) {
        var chat = document.getElementById('offcomfrt-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'offcomfrt-msg-wrapper offcomfrt-align-right';
        var msg = document.createElement('div');
        msg.className = 'offcomfrt-msg offcomfrt-msg-user';
        msg.textContent = text;
        wrapper.appendChild(msg);
        chat.appendChild(wrapper);
        scrollToBottom();
        if (save !== false) {
            chatHistory.push({ type: 'user', text: text });
            saveChatHistory();
        }
    }

    function addBotMessage(text, save) {
        var chat = document.getElementById('offcomfrt-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'offcomfrt-msg-wrapper offcomfrt-align-left';
        var msg = document.createElement('div');
        msg.className = 'offcomfrt-msg offcomfrt-msg-bot';
        msg.innerHTML = formatBotMessage(text);
        wrapper.appendChild(msg);
        chat.appendChild(wrapper);
        scrollToBottom();
        if (save !== false) {
            chatHistory.push({ type: 'bot', text: text });
            saveChatHistory();
        }
    }

    /**
     * Convert simple markdown-like formatting to HTML:
     * **bold** → <strong>, *italic* → <em>,
     * - item → <li> (grouped into <ul>),
     * \n → <br>
     */
    function formatBotMessage(text) {
        if (!text) return '';
        var escaped = escapeHtml(text);
        // Bold: **text**
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic: *text*
        escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Lists: lines starting with "- "
        var lines = escaped.split('\n');
        var html = '';
        var inList = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^- (.+)$/.test(line)) {
                if (!inList) { html += '<ul>'; inList = true; }
                html += '<li>' + line.replace(/^- /, '') + '</li>';
            } else {
                if (inList) { html += '</ul>'; inList = false; }
                html += line;
                if (i < lines.length - 1) html += '<br>';
            }
        }
        if (inList) html += '</ul>';
        return html;
    }

    function showTyping() {
        isTyping = true;
        var chat = document.getElementById('offcomfrt-chat');
        var typing = document.createElement('div');
        typing.className = 'offcomfrt-typing';
        typing.id = 'offcomfrt-typing';
        typing.innerHTML = '<div class="offcomfrt-typing-dot"></div><div class="offcomfrt-typing-dot"></div><div class="offcomfrt-typing-dot"></div>';
        chat.appendChild(typing);
        scrollToBottom();
    }

    function hideTyping() {
        isTyping = false;
        var typing = document.getElementById('offcomfrt-typing');
        if (typing) typing.remove();
    }

    // ---------- AI Chat ----------

    function sendToAI(message) {
        showTyping();
        fetch(API_URL + '/api/widget/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId, message: message })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                hideTyping();
                if (data.reply) {
                    addBotMessage(data.reply);
                }
                // Handle rich card responses from the AI
                if (data.cardType === 'return' && data.cardData) {
                    addReturnCard(data.cardData);
                } else if (data.cardType === 'resolution' && data.cardData) {
                    addResolutionCard(data.cardData);
                }
                if (data.suggestedAction === 'create_ticket') {
                    showTicketSuggestion();
                }
            })
            .catch(function (err) {
                hideTyping();
                console.error('[offcomfrt] chat error:', err);
                addBotMessage('Sorry, something went wrong. Please try again or reach out on WhatsApp.');
            });
    }

    function showTicketSuggestion() {
        var chat = document.getElementById('offcomfrt-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'offcomfrt-msg-wrapper offcomfrt-align-left';
        var msg = document.createElement('div');
        msg.className = 'offcomfrt-msg offcomfrt-msg-bot';
        msg.innerHTML = 'Would you like to speak with a human agent? <button class="offcomfrt-chip" id="offcomfrt-suggest-ticket-btn" style="margin-left:6px;font-size:11px;padding:4px 12px;">Create Ticket</button>';
        wrapper.appendChild(msg);
        chat.appendChild(wrapper);
        scrollToBottom();
        document.getElementById('offcomfrt-suggest-ticket-btn').addEventListener('click', showTicketForm);
    }

    // ---------- Order Tracking ----------

    function trackOrder(query) {
        showTyping();
        var body = { sessionId: sessionId };
        var cleaned = query.replace(/\s/g, '');
        if (/^#?\d{4,9}$/.test(cleaned)) {
            // Order ID (4-5 digit OFFCOMFRT order numbers) — AWB resolved internally
            body.orderId = cleaned.replace(/^#/, '');
        } else if (/^\d{10,}$/.test(cleaned)) {
            body.awb = cleaned;
            body.orderId = cleaned;
        } else {
            body.orderId = query;
        }

        fetch(API_URL + '/api/widget/track-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                hideTyping();
                if (data.error) {
                    addBotMessage(data.error);
                    addBotMessage('You can also try a different order number, or talk to our support team.');
                    showQuickActions();
                } else {
                    addTrackingCard(data);
                    // Let the AI know tracking just happened so follow-up
                    // questions ("is it out for delivery?") share the context.
                    notifyAIOfTracking(data);
                }
            })
            .catch(function (err) {
                hideTyping();
                console.error('[offcomfrt] tracking error:', err);
                addBotMessage('Unable to fetch tracking info right now. Please try again later.');
            });
    }

    /**
     * Silently record the direct-tracking exchange into the AI session so
     * follow-up questions ("when will it arrive?") know the order + status
     * without asking the customer for the order number again.
     */
    function notifyAIOfTracking(data) {
        var orderId = String(data.orderId || '').replace(/^#/, '').trim();
        var summary = 'Tracking shown for order ' + (orderId || 'the customer\'s order')
            + ': ' + (data.status || 'Unknown') + ' via ' + (data.carrierName || 'carrier') + '.';
        fetch(API_URL + '/api/widget/context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: sessionId,
                userMessage: orderId ? 'Track order ' + orderId : 'Track my order',
                botMessage: summary,
                entities: /^\d{3,6}$/.test(orderId) ? { orderId: orderId } : {}
            })
        }).catch(function () { /* non-critical — never block the UI on this */ });
    }

    function addTrackingCard(data, save) {
        var chat = document.getElementById('offcomfrt-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'offcomfrt-msg-wrapper offcomfrt-align-left';

        var card = document.createElement('div');
        card.className = 'offcomfrt-tracking-card';

        var statusText = data.status || 'Unknown';
        var statusClass = 'offcomfrt-status-unknown';
        if (/delivered/i.test(statusText)) statusClass = 'offcomfrt-status-delivered';
        else if (/transit|shipped|dispatched|in.?transit|out.?for.?delivery/i.test(statusText)) statusClass = 'offcomfrt-status-transit';

        var carrierName = data.carrierName || 'Carrier';
        if (carrierName.toUpperCase() === 'SHIPROCKET') carrierName = 'Shiprocket';
        else if (carrierName.toUpperCase() === 'DELHIVERY') carrierName = 'Delhivery';
        else if (carrierName.toUpperCase() === 'EKART') carrierName = 'Ekart';

        var html = '<div class="offcomfrt-tracking-card-header">';
        html += '<span class="offcomfrt-tracking-carrier">' + escapeHtml(carrierName) + '</span>';
        html += '<span class="offcomfrt-tracking-status ' + statusClass + '">' + escapeHtml(statusText) + '</span>';
        html += '</div>';

        if (data.orderId) {
            html += '<div class="offcomfrt-tracking-row"><span>Order Number</span><span>' + escapeHtml(data.orderId) + '</span></div>';
        }
        if (data.awb) {
            html += '<div class="offcomfrt-tracking-row"><span>AWB Number</span><span>' + escapeHtml(data.awb) + '</span></div>';
        }
        if (data.location) {
            html += '<div class="offcomfrt-tracking-row"><span>Current Location</span><span>' + escapeHtml(data.location) + '</span></div>';
        }
        if (data.shippedDate) {
            html += '<div class="offcomfrt-tracking-row"><span>Shipped Date</span><span>' + escapeHtml(data.shippedDate) + '</span></div>';
        }
        if (data.expectedDelivery) {
            html += '<div class="offcomfrt-tracking-row"><span>Expected Delivery</span><span>' + escapeHtml(data.expectedDelivery) + '</span></div>';
        }
        if (data.deliveredDate) {
            html += '<div class="offcomfrt-tracking-row"><span>Delivered Date</span><span>' + escapeHtml(data.deliveredDate) + '</span></div>';
        }
        if (data.note) {
            html += '<div class="offcomfrt-tracking-row"><span></span><span style="color:#666;font-style:italic;font-size:12px;">' + escapeHtml(data.note) + '</span></div>';
        }

        // Shipment timeline (most recent scans first)
        if (data.timeline && data.timeline.length) {
            html += '<div class="offcomfrt-timeline-title">Shipment Timeline</div>';
            html += '<div class="offcomfrt-timeline">';
            var items = data.timeline.slice();
            items.sort(function (a, b) { return (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0); });
            items = items.slice(0, 8);
            items.forEach(function (t) {
                var label = t.activity || t.status || 'Update';
                var meta = [t.date, t.location].filter(Boolean).join(' &middot; ');
                html += '<div class="offcomfrt-timeline-item">';
                html += '<div class="offcomfrt-timeline-dot"></div>';
                html += '<div class="offcomfrt-timeline-text">';
                html += '<div class="offcomfrt-timeline-activity">' + escapeHtml(label) + '</div>';
                if (meta) html += '<div class="offcomfrt-timeline-meta">' + escapeHtml(meta) + '</div>';
                html += '</div></div>';
            });
            html += '</div>';
        }

        if (data.trackingUrl) {
            html += '<a href="' + escapeHtml(data.trackingUrl) + '" target="_blank" class="offcomfrt-tracking-link">Track Live &rarr;</a>';
        }

        card.innerHTML = html;
        wrapper.appendChild(card);
        chat.appendChild(wrapper);
        scrollToBottom();

        if (save !== false) {
            chatHistory.push({ type: 'tracking', data: data });
            saveChatHistory();
        }
    }

    // ---------- Return/Exchange Status Card ----------

    function addReturnCard(data, save) {
        var chat = document.getElementById('offcomfrt-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'offcomfrt-msg-wrapper offcomfrt-align-left';

        var card = document.createElement('div');
        card.className = 'offcomfrt-return-card';

        var statusText = data.status || 'Pending';
        var statusClass = 'offcomfrt-return-pending';
        if (/approved|completed|picked.?up/i.test(statusText)) statusClass = 'offcomfrt-return-approved';
        else if (/rejected|denied|cancelled/i.test(statusText)) statusClass = 'offcomfrt-return-rejected';

        var typeLabel = data.type || 'Return';

        var html = '<div class="offcomfrt-return-card-header">';
        html += '<span class="offcomfrt-return-type">' + escapeHtml(typeLabel) + '</span>';
        html += '<span class="offcomfrt-return-status ' + statusClass + '">' + escapeHtml(statusText) + '</span>';
        html += '</div>';

        if (data.orderId) {
            html += '<div class="offcomfrt-return-row"><span class="label">Order</span><span class="value">#' + escapeHtml(data.orderId) + '</span></div>';
        }
        if (data.returnId) {
            html += '<div class="offcomfrt-return-row"><span class="label">Return ID</span><span class="value">' + escapeHtml(data.returnId) + '</span></div>';
        }
        if (data.reason) {
            html += '<div class="offcomfrt-return-row"><span class="label">Reason</span><span class="value">' + escapeHtml(data.reason) + '</span></div>';
        }
        if (data.refundAmount) {
            html += '<div class="offcomfrt-return-row"><span class="label">Refund</span><span class="value" style="color:#16a34a;font-weight:700;">' + escapeHtml(data.refundAmount) + '</span></div>';
        }
        if (data.eta) {
            html += '<div class="offcomfrt-return-row"><span class="label">Expected</span><span class="value">' + escapeHtml(data.eta) + '</span></div>';
        }
        if (data.note) {
            html += '<div class="offcomfrt-return-row"><span class="label"></span><span class="value" style="color:#666;font-style:italic;font-size:12px;">' + escapeHtml(data.note) + '</span></div>';
        }

        card.innerHTML = html;
        wrapper.appendChild(card);
        chat.appendChild(wrapper);
        scrollToBottom();

        if (save !== false) {
            chatHistory.push({ type: 'return', data: data });
            saveChatHistory();
        }
    }

    // ---------- Resolution Confirmation Card ----------

    function addResolutionCard(data, save) {
        var chat = document.getElementById('offcomfrt-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'offcomfrt-msg-wrapper offcomfrt-align-left';

        var card = document.createElement('div');
        card.className = 'offcomfrt-resolution-card';

        var html = '<div class="offcomfrt-resolution-icon">' +
            '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>' +
            '</div>';
        html += '<h4>' + escapeHtml(data.title || 'Issue Resolved') + '</h4>';
        if (data.description) {
            html += '<p>' + escapeHtml(data.description) + '</p>';
        }
        if (data.reference) {
            html += '<div style="margin-top:12px;font-size:12px;color:#6b7280;">Reference: <strong>' + escapeHtml(data.reference) + '</strong></div>';
        }

        card.innerHTML = html;
        wrapper.appendChild(card);
        chat.appendChild(wrapper);
        scrollToBottom();

        if (save !== false) {
            chatHistory.push({ type: 'resolution', data: data });
            saveChatHistory();
        }
    }

    // ---------- Ticket Creation ----------

    function showTicketForm() {
        hideQuickActions();
        var chat = document.getElementById('offcomfrt-chat');
        var form = document.createElement('div');
        form.className = 'offcomfrt-ticket-form';
        form.id = 'offcomfrt-ticket-form';
        form.innerHTML =
            '<h4>Contact Support</h4>' +
            '<div class="offcomfrt-form-group">' +
                '<label>Name</label>' +
                '<input type="text" id="offcomfrt-t-name" value="' + escapeHtml(CUSTOMER_NAME) + '" placeholder="Your name" />' +
            '</div>' +
            '<div class="offcomfrt-form-group">' +
                '<label>Phone</label>' +
                '<input type="tel" id="offcomfrt-t-phone" value="' + escapeHtml(CUSTOMER_PHONE) + '" placeholder="+91..." />' +
            '</div>' +
            '<div class="offcomfrt-form-group">' +
                '<label>Email (optional)</label>' +
                '<input type="email" id="offcomfrt-t-email" value="' + escapeHtml(CUSTOMER_EMAIL) + '" placeholder="you@example.com" />' +
            '</div>' +
            '<div class="offcomfrt-form-group">' +
                '<label>Issue</label>' +
                '<textarea id="offcomfrt-t-message" placeholder="Describe your issue..."></textarea>' +
            '</div>' +
            '<button class="offcomfrt-form-submit" id="offcomfrt-t-submit">Submit Ticket</button>';
        chat.appendChild(form);
        scrollToBottom();

        document.getElementById('offcomfrt-t-submit').addEventListener('click', submitTicket);
    }

    function submitTicket() {
        var name = document.getElementById('offcomfrt-t-name').value.trim();
        var phone = document.getElementById('offcomfrt-t-phone').value.trim();
        var email = document.getElementById('offcomfrt-t-email').value.trim();
        var message = document.getElementById('offcomfrt-t-message').value.trim();

        if (!message) { alert('Please describe your issue.'); return; }
        if (!phone && !email) { alert('Please provide your phone number or email.'); return; }

        var submitBtn = document.getElementById('offcomfrt-t-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';

        fetch(API_URL + '/api/widget/ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, phone: phone, email: email, message: message })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var form = document.getElementById('offcomfrt-ticket-form');
                if (form) form.remove();

                if (data.success) {
                    addTicketConfirmation({
                        ticketNumber: data.ticketNumber,
                        whatsappLink: data.whatsappLink
                    });
                } else {
                    addBotMessage('Sorry, could not create the ticket. Please try again.');
                }
            })
            .catch(function (err) {
                console.error('[offcomfrt] ticket error:', err);
                submitBtn.disabled = false;
                submitBtn.textContent = 'Submit Ticket';
                addBotMessage('Something went wrong. Please try again.');
            });
    }

    function addTicketConfirmation(data, save) {
        var chat = document.getElementById('offcomfrt-chat');
        var wrapper = document.createElement('div');
        wrapper.className = 'offcomfrt-msg-wrapper offcomfrt-align-left';

        var confirm = document.createElement('div');
        confirm.className = 'offcomfrt-ticket-confirmation';
        confirm.innerHTML =
            '<div class="offcomfrt-ticket-confirm-icon">' +
                '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>' +
            '</div>' +
            '<h4>Ticket Created</h4>' +
            '<p>Your support ticket has been received.</p>' +
            '<div class="offcomfrt-ticket-number">' + escapeHtml(data.ticketNumber) + '</div>' +
            '<br/><br/>' +
            '<a href="' + escapeHtml(data.whatsappLink) + '" target="_blank" class="offcomfrt-whatsapp-btn">' +
                '<svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0 0 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"/></svg>' +
                'Continue on WhatsApp' +
            '</a>';
        wrapper.appendChild(confirm);
        chat.appendChild(wrapper);
        scrollToBottom();

        if (save !== false) {
            chatHistory.push({ type: 'ticket', data: data });
            saveChatHistory();
        }
    }

    // ---------- Utilities ----------

    function scrollToBottom() {
        var chat = document.getElementById('offcomfrt-chat');
        if (chat) {
            setTimeout(function () {
                chat.scrollTop = chat.scrollHeight;
            }, 50);
        }
    }

    function saveChatHistory() {
        if (chatHistory.length > 20) {
            chatHistory = chatHistory.slice(-20);
        }
        sessionStorage.setItem('offcomfrt_chat', JSON.stringify(chatHistory));
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
