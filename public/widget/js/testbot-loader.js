/**
 * OFFCOMFRT Test Bot Loader
 *
 * Embed this script on any page to add the test bot floating widget:
 *   <script src="https://your-bot-server.onrender.com/widget/js/testbot-loader.js" defer></script>
 *
 * Optional: set window.__offcomfrt_testbot BEFORE this script loads to pass config:
 *   <script>
 *     window.__offcomfrt_testbot = {
 *       apiUrl: 'https://your-bot-server.onrender.com',
 *       brandName: 'OFFCOMFRT',
 *       customerName: 'John Doe',
 *       customerPhone: '+919876543210',
 *       triggerText: 'Need Help?',           // clickable text trigger (omit to disable)
 *       triggerPosition: 'bottom-right'       // bottom-right | bottom-left | top-right | top-left
 *     };
 *   </script>
 */

(function () {
    'use strict';

    // Guard against duplicate loader execution (e.g. multiple <script> tags)
    if (window.__offcomfrt_tb_loader_loaded) return;
    window.__offcomfrt_tb_loader_loaded = true;

    // Determine base URL from this script's own src attribute
    var scripts = document.getElementsByTagName('script');
    var thisScript = null;
    for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].src && scripts[i].src.indexOf('testbot-loader.js') !== -1) {
            thisScript = scripts[i];
            break;
        }
    }

    var baseUrl = '';
    if (thisScript) {
        baseUrl = thisScript.src.replace(/\/widget\/js\/testbot-loader\.js.*$/, '');
    }

    // Merge with any pre-existing config
    window.__offcomfrt_testbot = window.__offcomfrt_testbot || {};
    if (!window.__offcomfrt_testbot.apiUrl && baseUrl) {
        window.__offcomfrt_testbot.apiUrl = baseUrl;
    }

    // Load Archive Narrow font (skip if already loaded by main widget)
    if (!document.querySelector('link[href*="fonts.googleapis.com/css2?family=Archive"]')) {
        var fontLink = document.createElement('link');
        fontLink.rel = 'stylesheet';
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Archive+Narrow:wght@400;500;600;700&display=swap';
        document.head.appendChild(fontLink);
    }

    // Load test bot JS (all CSS is inlined)
    var jsScript = document.createElement('script');
    jsScript.src = baseUrl + '/widget/js/testbot.js?v=' + Date.now();
    jsScript.defer = true;
    document.body.appendChild(jsScript);

})();
