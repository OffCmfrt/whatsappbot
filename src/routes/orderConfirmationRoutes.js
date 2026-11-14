const express = require('express');
const router = express.Router();
const { dbAdapter } = require('../database/db');
const { getPhoneVariations, normalizePhone } = require('../utils/validators');
const { invalidateCache } = require('../utils/cache');
const whatsappService = require('../services/whatsappService');
const SupportSync = require('../services/supportSync');

// ============================================================
// Website mirror of the WhatsApp post-purchase confirmation flow
// (Confirm Order / Cancel Order / Edit Details quick replies in
// messageHandler.js). Mounted at /api/order-confirmation and
// consumed by the Shopify order detail page.
//
// Auth model: same claim-as-customer pattern as the support tab —
// the signed-in storefront phone is injected by Liquid and echoed
// back with the order number; an action only ever touches the
// store_shoppers row whose phone AND order number both match.
// Like the WhatsApp buttons, actions stop once the order ships.
// ============================================================

// '#66132' / '66132' / 'ORD-66132' all identify the same order
function orderDigits(raw) {
    return String(raw == null ? '' : raw).replace(/\D/g, '');
}

// Resolve the ONE store_shoppers row for this phone + order number.
// Returns null when nothing matches; ownership is proven by the match itself.
async function findShopperRow(phone, digits) {
    const variations = getPhoneVariations(phone);
    const rows = await dbAdapter.query(
        `SELECT id, order_id, status, confirmed_by, cancel_reason, payment_method,
                customer_message, response_count, last_response_at, updated_at, created_at
         FROM store_shoppers
         WHERE phone = ANY(?)
           AND REGEXP_REPLACE(COALESCE(order_id, ''), '[^0-9]', '', 'g') = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [variations, digits]
    );
    return rows?.[0] || null;
}

// Fail-closed shipped check — same rule as messageHandler.isOrderShipped:
// a DB hiccup must never let an action through on a shipped order.
async function isOrderShipped(orderId) {
    try {
        const rows = await dbAdapter.query(
            `SELECT 1 FROM orders WHERE order_id = ? AND (awb IS NOT NULL OR status = 'shipped') LIMIT 1`,
            [orderId]
        );
        return !!(rows && rows.length > 0);
    } catch (err) {
        console.error('[OrderConfirmWeb] shipped check failed, treating as shipped:', err.message);
        return true;
    }
}

function publicState(row, shipped) {
    return {
        found: true,
        orderId: row.order_id,
        status: row.status || 'pending',
        confirmedBy: row.confirmed_by || null,
        cancelReason: row.cancel_reason || null,
        paymentMethod: row.payment_method || null,
        responseCount: row.response_count || 0,
        lastResponseAt: row.last_response_at || null,
        updatedAt: row.updated_at || null,
        orderPlacedAt: row.created_at || null,
        lastEdit: extractLastEdit(row.customer_message),
        shipped,
        canAct: !shipped
    };
}

// ============================================================
// Structured edit requests
//
// Address / consignee phone / email are applied DIRECTLY on the
// Shopify order via REST (same write the desk's address-change
// approval uses). Line-item changes CANNOT be applied via API —
// Shopify restricts orderEdit* to public apps and this store's
// custom token is rejected app-wide — so item edits are handed to
// ops exactly the way the desk does it: a 'customer-edit-requested'
// tag plus a structured note line, with the full JSON request kept
// in the store_shoppers message log for the hub.
// ============================================================

const EDIT_JSON_MARKER = 'EDIT_REQUEST_JSON:';

function extractLastEdit(customerMessage) {
    if (!customerMessage) return null;
    const idx = String(customerMessage).lastIndexOf(EDIT_JSON_MARKER);
    if (idx === -1) return null;
    const line = String(customerMessage).slice(idx + EDIT_JSON_MARKER.length).split('\n')[0];
    try { return JSON.parse(line); } catch { return null; }
}

// Live Shopify order by number — also our last-second fulfillment gate:
// hub rows can lag, Shopify cannot.
async function findLiveOrder(digits) {
    const data = await SupportSync.shopifyREST(`orders.json?name=${encodeURIComponent(digits)}&status=any&limit=1`);
    return (data.orders || [])[0] || null;
}

function clean(v, max) {
    return String(v == null ? '' : v).trim().slice(0, max || 120);
}

// Whitelist + sanitize the address block the customer submitted
function sanitizeAddress(raw) {
    const a = raw || {};
    return {
        name: clean(a.name, 80),
        phone: clean(a.phone, 20).replace(/[^0-9+\s-]/g, ''),
        address1: clean(a.address1, 200),
        address2: clean(a.address2, 200),
        city: clean(a.city, 80),
        province: clean(a.province, 80),
        zip: clean(a.zip, 12).replace(/[^0-9A-Za-z\s-]/g, ''),
        country: clean(a.country, 60)
    };
}

// Diff submitted values against the live Shopify order. Returns the
// merged shipping_address + scalars to PUT, plus a human summary.
function buildOrderUpdate(order, changes) {
    const current = order.shipping_address || {};
    const next = sanitizeAddress(changes.address);
    const shipping = { ...current };
    const applied = [];
    const fields = ['name', 'phone', 'address1', 'address2', 'city', 'province', 'zip', 'country'];
    let addressChanged = false;
    fields.forEach((f) => {
        if (!next[f]) return; // empty = untouched, never blank a field out
        if (String(current[f] == null ? '' : current[f]).trim() !== next[f]) {
            shipping[f] = f === 'name' ? next[f] : next[f];
            addressChanged = true;
        }
    });
    if (addressChanged) {
        if (shipping.name) {
            const parts = shipping.name.split(/\s+/);
            shipping.first_name = parts.shift() || '';
            shipping.last_name = parts.join(' ') || shipping.last_name || '';
        }
        applied.push('delivery address');
        if (next.phone && String(current.phone || '').trim() !== next.phone) applied.push('consignee phone');
    }

    const body = { id: order.id };
    if (addressChanged) body.shipping_address = shipping;

    // Order-level contact phone/email are separate scalars
    const nextPhone = clean(changes.phone, 20).replace(/[^0-9+\s-]/g, '');
    if (nextPhone && String(order.phone || '').replace(/\D/g, '') !== nextPhone.replace(/\D/g, '')) {
        body.phone = nextPhone;
        applied.push('order phone');
    }
    const nextEmail = clean(changes.email, 120);
    if (nextEmail && String(order.email || '').trim().toLowerCase() !== nextEmail.toLowerCase()) {
        body.email = nextEmail;
        applied.push('contact email');
    }
    return { body, applied };
}

// Structured item-change lines for the Shopify note (ops hand-applies them)
function buildItemNote(orderName, items, adds) {
    const lines = items.map((it, i) => {
        const parts = [];
        if (it.remove) parts.push('REMOVE');
        else {
            if (it.variantChanged) parts.push(`variant \u2192 ${it.toVariantTitle}`);
            if (it.qtyChanged) parts.push(`qty ${it.fromQty} \u2192 ${it.toQty}`);
        }
        return `  ${i + 1}. ${it.title}: ${parts.join(', ')}`;
    });
    (adds || []).forEach((ad) => {
        lines.push(`  ${lines.length + 1}. ${ad.title}${ad.variantTitle ? ` (${ad.variantTitle})` : ''}: ADD x${ad.quantity} \u2014 from live catalog, price \u20b9${ad.price}`);
    });
    return `Website edit request ${orderName} (items, apply manually):\n${lines.join('\n')}`;
}

// Resolve requested catalog adds against the LIVE Shopify catalog so the team
// always sees canonical titles/prices. Falls back to the client-submitted
// values (clamped) when the catalog lookup fails — the request is still logged.
async function resolveAdds(rawAdds) {
    const list = (Array.isArray(rawAdds) ? rawAdds : []).slice(0, 10);
    if (!list.length) return [];
    let catalog = null;
    try {
        const shopifyService = require('../services/shopifyService');
        catalog = await shopifyService.getProductCatalog();
    } catch (err) {
        console.warn('[OrderConfirmWeb] catalog lookup for adds failed:', err.message);
    }
    const resolved = [];
    for (const raw of list) {
        const quantity = Math.min(10, Math.max(1, parseInt(raw && raw.quantity, 10) || 1));
        const variantId = String((raw && raw.variantId) || '').replace(/\D/g, '');
        if (!variantId && !(raw && raw.title)) continue;
        let match = null;
        if (catalog && catalog.length) {
            outer: for (const p of catalog) {
                for (const v of (p.variants || [])) {
                    if (String(v.id) === variantId) { match = { p, v }; break outer; }
                }
            }
        }
        if (match) {
            resolved.push({
                title: clean(match.p.title, 150),
                variantTitle: clean(match.v.title, 120),
                price: Math.round((parseFloat(match.v.price) || 0) * 100) / 100,
                variantId,
                productId: String((raw && raw.productId) || match.p.id || '').replace(/\D/g, '') || null,
                inStock: !!match.v.available && (match.v.inventory > 0 || match.v.available),
                quantity
            });
        } else {
            const fallback = {
                title: clean(raw && raw.title, 150),
                variantTitle: clean(raw && raw.variantTitle, 120),
                price: Math.min(999999, Math.max(0, parseFloat(raw && raw.price) || 0)),
                variantId,
                productId: String((raw && raw.productId) || '').replace(/\D/g, '') || null,
                quantity
            };
            if (fallback.title) resolved.push(fallback);
        }
    }
    return resolved;
}

// ── GET /catalog?phone=&order= — sellable Shopify catalog for the edit panel's
// "add item" picker. Gated on the same phone + order-number claim as the other
// endpoints so the store's own catalog isn't served to anonymous callers. ──
router.get('/catalog', async (req, res) => {
    try {
        const phone = normalizePhone(req.query.phone || '');
        const digits = orderDigits(req.query.order);
        if (!phone || phone.length < 10 || !digits) {
            return res.status(400).json({ error: 'phone and order are required' });
        }
        const row = await findShopperRow(phone, digits);
        if (!row) return res.status(404).json({ error: 'Order not found for this account' });
        if (await isOrderShipped(row.order_id)) {
            return res.status(409).json({ error: 'Order already shipped', shipped: true });
        }
        const shopifyService = require('../services/shopifyService');
        const catalog = await shopifyService.getProductCatalog();
        // Lean shape for the storefront picker: only products with at least one
        // sellable variant, only the fields the picker renders.
        const products = [];
        for (const p of catalog) {
            const variants = (p.variants || [])
                .filter(v => v.available)
                .map(v => ({
                    id: String(v.id),
                    title: v.title || '',
                    price: parseFloat(v.price) || 0,
                    stock: Math.max(0, parseInt(v.inventory, 10) || 0)
                }));
            if (!variants.length) continue;
            products.push({
                id: String(p.id),
                title: p.title,
                type: p.product_type || '',
                image: p.image || null,
                variants
            });
        }
        res.json({ success: true, products });
    } catch (error) {
        console.error('[OrderConfirmWeb] catalog error:', error.message);
        res.status(500).json({ error: 'Failed to load the product catalog' });
    }
});

// ── GET /status?phone=&order= — current confirmation state for one order ──
router.get('/status', async (req, res) => {
    try {
        const phone = normalizePhone(req.query.phone || '');
        const digits = orderDigits(req.query.order);
        if (!phone || phone.length < 10 || !digits) {
            return res.status(400).json({ error: 'phone and order are required' });
        }
        const row = await findShopperRow(phone, digits);
        if (!row) return res.json({ found: false });
        const shipped = await isOrderShipped(row.order_id);
        res.json(publicState(row, shipped));
    } catch (error) {
        console.error('[OrderConfirmWeb] status error:', error.message);
        res.status(500).json({ error: 'Failed to load confirmation status' });
    }
});

// ── POST /action { phone, order, action, note?, changes? } ── mirror of the WA buttons ──
// action: confirm | cancel | edit | revert (revert = undo the previous response)
// 'edit' additionally accepts structured changes: { address, phone, email, items[] }
const ACTIONS = {
    confirm: {
        status: 'confirmed',
        message: 'Customer confirmed order via Website',
        ack: (id) => `✅ *Order Confirmed*\n\n▫️ *Order ID:* ${id}\n▫️ Thank you for confirming your order.\n▫️ We are processing it and will notify you once it has been shipped.`
    },
    cancel: {
        status: 'cancelled',
        cancelReason: 'AUTO',
        message: 'Customer requested cancellation via Website',
        ack: (id) => `❌ *Order Cancellation*\n\n▫️ *Order ID:* ${id}\n▫️ Order Cancellation Request Received.\n▫️ Our team will process the cancellation.\n▫️ If the order has not been shipped yet, it will be cancelled shortly.`
    },
    edit: {
        status: 'edit_details',
        message: 'Customer requested edits via Website',
        ack: (id) => `✏️ *Edit Request Received*\n\n▫️ *Order ID:* ${id}\n▫️ Our team will review your edit request and apply it before the order ships.`
    },
    revert: {
        status: 'pending',
        clearCancelReason: true,
        message: 'Customer reverted their response via Website',
        ack: (id) => `↩️ *Response Reverted*\n\n▫️ *Order ID:* ${id}\n▫️ Your previous confirmation/cancellation response has been reverted.\n▫️ You can Confirm, Cancel or Edit again until the order ships.`
    }
};

router.post('/action', async (req, res) => {
    try {
        const { action, note } = req.body || {};
        const phone = normalizePhone(req.body && req.body.phone);
        const digits = orderDigits(req.body && req.body.order);
        if (!phone || phone.length < 10 || !digits) {
            return res.status(400).json({ error: 'phone and order are required' });
        }
        const spec = ACTIONS[action];
        if (!spec) return res.status(400).json({ error: 'Unknown action' });

        const row = await findShopperRow(phone, digits);
        if (!row) return res.status(404).json({ error: 'Order not found for this account' });

        // Actions close the moment the order ships — same rule as WhatsApp
        if (await isOrderShipped(row.order_id)) {
            return res.status(409).json({ error: 'Order already shipped', shipped: true });
        }

        const now = new Date().toISOString();
        const flatNote = String(note || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
        let messageLine = flatNote && action === 'edit'
            ? `${spec.message}: ${flatNote}`
            : spec.message;
        let editOutcome = null;
        let ackOverride = null;

        // ── Structured edit: apply contact changes directly, route item
        // changes to ops (Shopify blocks orderEdit* for this custom token) ──
        if (action === 'edit') {
            const changes = req.body.changes || {};
            const items = (Array.isArray(changes.items) ? changes.items : []).slice(0, 20)
                .map((it) => ({
                    title: clean(it.title, 150),
                    remove: !!it.remove,
                    variantChanged: !!it.variantChanged && !it.remove,
                    toVariantTitle: clean(it.toVariantTitle, 120),
                    qtyChanged: !!it.qtyChanged && !it.remove,
                    fromQty: Math.max(0, parseInt(it.fromQty) || 0),
                    toQty: Math.min(50, Math.max(0, parseInt(it.toQty) || 0))
                }))
                .filter((it) => it.title && (it.remove || it.variantChanged || it.qtyChanged));

            // New items picked from the live Shopify catalog (title/price are
            // re-resolved server-side, never trusted from the browser)
            const adds = await resolveAdds(changes.adds);

            const hasContact = !!(changes.address || changes.phone || changes.email);
            if (!items.length && !adds.length && !hasContact && !flatNote) {
                return res.status(400).json({ error: 'Nothing to change' });
            }

            const warnings = [];
            const applied = [];
            let liveOrder = null;
            try {
                liveOrder = await findLiveOrder(orderDigits(row.order_id));
            } catch (shopErr) {
                console.warn('[OrderConfirmWeb] live Shopify lookup failed:', shopErr.message);
                warnings.push('Could not verify live Shopify status — the request is recorded for the team.');
            }

            if (liveOrder && liveOrder.fulfillment_status === 'fulfilled') {
                // Hub lagged — Shopify is authoritative, close the window now
                return res.status(409).json({ error: 'Order already fulfilled', shipped: true });
            }

            const updates = [];
            if (liveOrder && hasContact) {
                const built = buildOrderUpdate(liveOrder, changes);
                applied.push(...built.applied);
                if (built.applied.length) updates.push({ order: built.body });
            }

            if (liveOrder && (items.length || adds.length)) {
                // Hand items to ops the desk way: tag + structured note line
                const tags = String(liveOrder.tags || '').split(',').map(t => t.trim()).filter(Boolean);
                if (!tags.includes('customer-edit-requested')) tags.push('customer-edit-requested');
                const noteLine = buildItemNote(liveOrder.name, items, adds);
                updates.push({
                    order: {
                        id: liveOrder.id,
                        tags: tags.join(', '),
                        note: [liveOrder.note, noteLine].filter(Boolean).join('\n')
                    }
                });
                applied.push('item changes'); // recorded on the order; the team executes the swap
            }

            for (const payload of updates) {
                try {
                    await SupportSync.shopifyREST(`orders/${payload.order.id}.json`, {
                        method: 'PUT',
                        body: JSON.stringify(payload)
                    });
                } catch (putErr) {
                    const detail = putErr.response?.data?.errors
                        ? JSON.stringify(putErr.response.data.errors).slice(0, 200)
                        : putErr.message;
                    console.error('[OrderConfirmWeb] Shopify PUT failed:', detail);
                    warnings.push(`Shopify write rejected (${detail}). The request is still logged for our team.`);
                }
            }
            if (!liveOrder && (items.length || adds.length || hasContact)) {
                warnings.push('Order not found live in Shopify — the request is recorded for the team.');
            }

            editOutcome = {
                applied: applied.filter(a => a !== 'item changes'),
                routedToTeam: [
                    ...items.map(it => ({
                        title: it.title,
                        change: it.remove ? 'remove' : [it.variantChanged ? `variant → ${it.toVariantTitle}` : null, it.qtyChanged ? `qty ${it.fromQty} → ${it.toQty}` : null].filter(Boolean).join(', ')
                    })),
                    ...adds.map(ad => ({
                        title: `${ad.title}${ad.variantTitle ? ` (${ad.variantTitle})` : ''}`,
                        change: `add x${ad.quantity}`
                    }))
                ],
                warnings
            };
            messageLine += `\n${EDIT_JSON_MARKER}${JSON.stringify({
                at: now,
                address: changes.address ? sanitizeAddress(changes.address) : null,
                phone: clean(changes.phone, 20) || null,
                email: clean(changes.email, 120) || null,
                items: items.map(it => ({
                    title: it.title, remove: it.remove,
                    toVariantTitle: it.variantChanged ? it.toVariantTitle : null,
                    qty: it.qtyChanged ? it.toQty : null
                })),
                adds: adds.map(ad => ({
                    title: ad.title, variantTitle: ad.variantTitle || '',
                    price: ad.price, quantity: ad.quantity,
                    variantId: ad.variantId || null, productId: ad.productId || null
                })),
                note: flatNote || null,
                outcome: editOutcome
            })}`;

            // Queue the structured request for Shoppers Hub (one row per edit
            // submission that touches items). Best effort — never fail the
            // customer's action on a queue write.
            if (items.length || adds.length) {
                try {
                    const summaryParts = [];
                    items.forEach((it) => {
                        summaryParts.push(it.remove ? `Remove ${it.title}`
                            : [it.variantChanged ? `${it.title} → ${it.toVariantTitle}` : null,
                               it.qtyChanged ? `${it.title} qty ${it.fromQty} → ${it.toQty}` : null].filter(Boolean).join('; '));
                    });
                    adds.forEach((ad) => summaryParts.push(`Add ${ad.title}${ad.variantTitle ? ` (${ad.variantTitle})` : ''} x${ad.quantity}`));
                    await dbAdapter.insert('order_item_requests', {
                        shopper_id: String(row.id),
                        order_id: row.order_id,
                        phone,
                        request: JSON.stringify({
                            items: items.map(it => ({
                                title: it.title, remove: it.remove,
                                toVariantTitle: it.variantChanged ? it.toVariantTitle : null,
                                qty: it.qtyChanged ? it.toQty : null
                            })),
                            adds: adds.map(ad => ({
                                title: ad.title, variantTitle: ad.variantTitle || '',
                                price: ad.price, quantity: ad.quantity,
                                variantId: ad.variantId || null, productId: ad.productId || null
                            })),
                            note: flatNote || null
                        }),
                        summary: summaryParts.filter(Boolean).join(' · ').slice(0, 500)
                    });
                } catch (qErr) {
                    console.error('[OrderConfirmWeb] item request queue write failed:', qErr.message);
                }
            }

            // Detailed WhatsApp ack: tell them exactly what moved where
            const ackLines = [];
            if (editOutcome.applied.length) ackLines.push(`▫️ *Applied instantly:* ${editOutcome.applied.join(', ')}`);
            if (editOutcome.routedToTeam.length) ackLines.push(`▫️ *Sent to our team for item changes:* ${editOutcome.routedToTeam.map(i => i.title).join('; ').slice(0, 200)}`);
            if (editOutcome.warnings.length) ackLines.push(`▫️ ${editOutcome.warnings[0]}`);
            // Local per-request ack — never mutate the shared ACTIONS spec
            ackOverride = `✏️ *Edit Request — Order ${row.order_id}*\n\n${ackLines.join('\n') || '▫️ Your edit request has been recorded.'}\n▫️ Changes stay open until the order ships.`;
        }

        const cancelReasonClause = spec.cancelReason
            ? `cancel_reason = '${spec.cancelReason}',`
            : spec.clearCancelReason
                ? `cancel_reason = NULL,`
                : '';
        await dbAdapter.query(
            `UPDATE store_shoppers
             SET status = ?,
                 updated_at = ?,
                 confirmed_by = 'website',
                 ${cancelReasonClause}
                 customer_message = COALESCE(customer_message || '\n---\n', '') || ?,
                 response_count = COALESCE(response_count, 0) + 1,
                 last_response_at = ?
             WHERE id = ?`,
            [spec.status, now, messageLine, now, row.id]
        );

        // Clear shoppers cache so the hub reflects the change immediately
        invalidateCache('shoppers');

        // Echo the same acknowledgment the WhatsApp buttons send (best effort —
        // a closed 24h WA session must never fail the website action)
        try {
            await whatsappService.sendMessage(phone, ackOverride || spec.ack(row.order_id));
        } catch (waErr) {
            console.warn('[OrderConfirmWeb] WhatsApp ack skipped:', waErr.message);
        }

        const shipped = await isOrderShipped(row.order_id);
        const updated = await findShopperRow(phone, digits);
        res.json({ success: true, state: publicState(updated || row, shipped), edit: editOutcome });
    } catch (error) {
        console.error('[OrderConfirmWeb] action error:', error.message);
        res.status(500).json({ error: 'Failed to record your response' });
    }
});

module.exports = router;
