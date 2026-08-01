// ==========================================
// OFFCOMFRT - Shoppers Hub AI Copilot v2 (PRO)
// Redirects to the new full-screen AI Copilot Pro.
// Kept for backward compatibility with Shopify CDN cache.
// ==========================================
(function () {
    'use strict';

    // Find the base URL of this script (served from Shopify CDN)
    // and derive the new pro script URL from the same origin
    const currentScripts = document.querySelectorAll('script[src*="shoppers-ai-copilot"]');
    let baseUrl = '';
    currentScripts.forEach(function(s) {
        const src = s.src;
        // e.g. https://cdn.shopify.com/s/files/.../assets/shoppers-ai-copilot.js?v=123
        baseUrl = src.replace('shoppers-ai-copilot.js', 'shoppers-ai-copilot-pro.js');
    });

    // Fallback URL if we can't detect the base
    if (!baseUrl) {
        baseUrl = '/assets/shoppers-ai-copilot-pro.js';
    }

    // Remove old copilot DOM if it already started rendering
    const oldFab = document.getElementById('aiCopilotFab');
    if (oldFab) oldFab.remove();
    const oldPanel = document.getElementById('aiCopilotPanel');
    if (oldPanel) oldPanel.remove();

    // Load the new pro copilot
    const script = document.createElement('script');
    script.src = baseUrl;
    script.onload = function() {
        console.log('[AI Copilot] Pro version loaded successfully');
    };
    script.onerror = function() {
        console.warn('[AI Copilot] Pro version failed to load from CDN, trying direct path');
        const fallback = document.createElement('script');
        fallback.src = '/assets/shoppers-ai-copilot-pro.js?v=' + Date.now();
        document.head.appendChild(fallback);
    };
    document.head.appendChild(script);

})();
