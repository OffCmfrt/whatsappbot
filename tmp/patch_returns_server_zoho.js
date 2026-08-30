/**
 * One-time patch: wire the returns server to push real exchanged products
 * to the Zoho middleware (/webhooks/zoho/exchange) when an exchange is
 * finalized. Applies two exact-string replacements to
 * exchange-return-tracking-main/server.js.
 */
const fs = require('fs');
const PATH = '/Users/sunny/Downloads/OFFCOMFRT/exchange-return-tracking-main/server.js';

let src = fs.readFileSync(PATH, 'utf8');

function replaceOnce(src, oldStr, newStr, label) {
    const count = src.split(oldStr).length - 1;
    if (count !== 1) {
        console.error(`❌ ${label}: expected 1 occurrence, found ${count}`);
        process.exit(1);
    }
    console.log(`✅ ${label}: anchor unique, replacing`);
    return src.replace(oldStr, newStr);
}

// 1. Add notifyZohoExchange() right after the WHATSAPP BOT INTEGRATION header
const OLD1 = `// ==================== WHATSAPP BOT INTEGRATION ====================

// ── Meta Template Definition: Return/Exchange Approval ──`;
const NEW1 = `// ==================== WHATSAPP BOT INTEGRATION ====================

// ── Zoho middleware bridge ─────────────────────────────────
// When an exchange is finalized (forward/replacement shipment created), push
// the REAL original + exchanged products to the WhatsApp bot middleware so
// Zoho Books reflects what was actually returned/exchanged — not the
// original order selection. Fire-and-forget: never blocks approval.
async function notifyZohoExchange(requestDetails, items) {
    const botUrl = process.env.WHATSAPP_BOT_URL || 'http://localhost:3000';
    const internalToken = process.env.WHATSAPP_INTERNAL_TOKEN || '';
    const payload = {
        order_id: String(requestDetails.orderNumber || ''),
        original_items: (items || []).map(i => ({
            title: i.name || i.title || '',
            sku: i.sku || '',
            quantity: parseInt(i.quantity || 1),
            price: parseFloat(i.paidPrice || i.price || 0)
        })),
        exchanged_items: (items || []).map(i => ({
            title: i.replacementProductTitle || i.name || i.title || '',
            sku: i.replacementSku || i.sku || '',
            quantity: parseInt(i.quantity || 1),
            variant: i.replacementVariant || i.variant || ''
        }))
    };
    const res = await fetch(botUrl.replace(/\\/$/, '') + '/webhooks/zoho/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': internalToken },
        body: JSON.stringify(payload)
    });
    console.log('[' + requestDetails.requestId + '] 📒 Zoho exchange notify → ' + res.status);
    return res.status;
}

// ── Meta Template Definition: Return/Exchange Approval ──`;

// 2. Call it after the approval status update (fire-and-forget)
const OLD2 = `        const request = await updateRequestStatus(requestId, {
            ...updates,
            adminNotes: adminNotes
        });

        res.json({ success: true, message: 'Request approved successfully', request });`;
const NEW2 = `        const request = await updateRequestStatus(requestId, {
            ...updates,
            adminNotes: adminNotes
        });

        // Zoho middleware: reflect the real exchanged products (fire-and-forget)
        if (requestDetails.type === 'exchange') {
            let zohoNotifyItems = requestDetails.items;
            if (typeof zohoNotifyItems === 'string') {
                try { zohoNotifyItems = JSON.parse(zohoNotifyItems); } catch (e) { zohoNotifyItems = []; }
            }
            notifyZohoExchange(requestDetails, Array.isArray(zohoNotifyItems) ? zohoNotifyItems : [])
                .catch(e => console.warn('[' + requestId + '] Zoho exchange notify failed: ' + e.message));
        }

        res.json({ success: true, message: 'Request approved successfully', request });`;

// The returns server file uses CRLF line endings — convert anchors to match.
const crlf = (s) => s.replace(/\n/g, '\r\n');
src = replaceOnce(src, crlf(OLD1), crlf(NEW1), 'notifyZohoExchange definition');
src = replaceOnce(src, crlf(OLD2), crlf(NEW2), 'approval hook');
fs.writeFileSync(PATH, src);
console.log('✅ Patched', PATH);
