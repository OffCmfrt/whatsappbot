/**
 * OFFCOMFRT Widget Loader
 *
 * Single script to embed in Shopify theme. Injects the widget CSS and JS
 * from the bot server into the page.
 *
 * Usage (Shopify theme or any HTML page):
 *   <script src="https://your-bot-server.onrender.com/widget/loader.js" defer></script>
 *
 * Optional: set window.__offcomfrt_widget BEFORE this script loads to pass config:
 *   <script>
 *     window.__offcomfrt_widget = {
 *       apiUrl: 'https://your-bot-server.onrender.com',
 *       brandName: 'OFFCOMFRT',
 *       customerName: 'John Doe',
 *       customerEmail: 'john@example.com',
 *       customerPhone: '+919876543210'
 *     };
 *   </script>
 */

(function () {
    'use strict';

    // Determine the base URL from the script's own src attribute
    var scripts = document.getElementsByTagName('script');
    var thisScript = null;
    for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].src && scripts[i].src.indexOf('loader.js') !== -1) {
            thisScript = scripts[i];
            break;
        }
    }

    var baseUrl = '';
    if (thisScript) {
        // Extract base URL: everything before /widget/loader.js
        baseUrl = thisScript.src.replace(/\/widget\/loader\.js.*$/, '');
    }

    // Merge with any pre-existing config
    window.__offcomfrt_widget = window.__offcomfrt_widget || {};
    if (!window.__offcomfrt_widget.apiUrl && baseUrl) {
        window.__offcomfrt_widget.apiUrl = baseUrl;
    }

    // Load Inter font
    if (!document.querySelector('link[href*="fonts.googleapis.com/css2?family=Inter"]')) {
        var fontLink = document.createElement('link');
        fontLink.rel = 'stylesheet';
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
        document.head.appendChild(fontLink);
    }

    // Load widget JS (all CSS is inlined inside widget.js — no separate CSS file needed)
    var jsScript = document.createElement('script');
    jsScript.src = baseUrl + '/widget/js/widget.js?v=' + Date.now();
    jsScript.defer = true;
    document.body.appendChild(jsScript);

})();
