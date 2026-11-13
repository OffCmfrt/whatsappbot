const { dbAdapter } = require('../database/db');

// ============================================================
// SupportService — website customer support tickets
// Ticket CRUD, issue taxonomy + stage eligibility, risk/econ
// analysis, admin settings, and the Shopify order cache.
// All writes go to the shared support_tickets table (the same
// table WhatsApp tickets use); rows raised from the storefront
// carry channel='website' so both surfaces stay separable.
// ============================================================

// ---------- Issue taxonomy (ported from the reference spec) ----------
// subs: [key, label, highPriorityFlag?]
const REASONS = [
    { id: 'order', label: 'Order confirmation & changes', hint: 'Confirm, edit, cancel or pay online', team: 'calling', subs: [
        ['no_confirm', "Didn't get the WhatsApp confirmation"], ['edit', 'Change size, colour or quantity'],
        ['cancel', 'Cancel my order'], ['prepay', 'Pay online instead of cash on delivery'],
        ['cancelled_wrongly', 'Order cancelled without my request', 1], ['duplicate', 'Placed the same order twice'], ['other', 'Other']
    ] },
    { id: 'delivery', label: 'Delivery & address', hint: 'Address, delays, tracking, delivery attempts', team: 'logistics', subs: [
        ['address_change', 'Change the delivery address'], ['reship_new', 'Send to a different address (new order)'],
        ['pay_reship', 'Pay online and send to a new address'],
        ['not_shipped', 'Order not shipped yet'], ['delayed', 'Delivery delayed beyond the expected date'],
        ['tracking_stuck', "Tracking isn't updating"], ['delivered_not_received', 'Marked delivered but not received', 1],
        ['no_attempt', "Courier didn't attempt delivery", 1], ['courier_extra', 'Courier asked for extra money', 1], ['other', 'Other']
    ] },
    { id: 'product', label: 'Problem with the product', hint: 'Wrong, damaged or missing items', team: 'returns', proof: true, subs: [
        ['wrong_product', 'Received a different product', 1], ['wrong_size', 'Received the wrong size'],
        ['damaged', 'Damaged, torn or stained', 1], ['defect', 'Defect in stitching, print or colour'],
        ['missing', 'Item missing from the parcel', 1], ['tampered', 'Parcel was open or tampered with', 1], ['other', 'Other']
    ] },
    { id: 'fit', label: 'Size & fit', hint: 'Too small, too large, size chart', team: 'returns', subs: [
        ['small', 'Too small'], ['large', 'Too large'], ['chart', "Fit doesn't match the size chart"],
        ['fabric', "Fabric or feel isn't as described"], ['other', 'Other']
    ] },
    { id: 'return', label: 'Return or exchange', hint: 'Start one, or track a pickup or exchange', team: 'returns', subs: [
        ['return_credit', 'Return for store credit'], ['exchange_req', 'Exchange for another size or product'],
        ['pickup_not_scheduled', 'Pickup not scheduled yet'], ['pickup_missed', "Pickup agent didn't come"],
        ['exchange_not_received', 'Exchange not received after pickup', 1], ['exchange_stuck', 'Exchange stuck on "Scheduled"'],
        ['qc_rejected', 'Return rejected after quality check'], ['other', 'Other']
    ] },
    { id: 'credit', label: 'Store credit & payments', hint: 'Credit codes, charges, COD amount', team: 'escalation', subs: [
        ['credit_missing', 'Store credit code not received'], ['credit_invalid', "Store credit code isn't working"],
        ['charged_no_order', 'Charged but no order was placed', 1], ['cod_wrong', 'Charged the wrong COD amount'],
        ['refund_original', 'Want the money back to my original payment method'], ['other', 'Other']
    ] },
    { id: 'other', label: 'Something else', hint: 'Anything not listed here', team: 'chat', subs: [['other', 'Other']] }
];

// Sub-issues the desk approves rather than just answers
const REQUESTS = {
    'order/cancel': 'Cancel order', 'order/edit': 'Edit order', 'order/prepay': 'Convert COD to prepaid',
    'delivery/address_change': 'Change delivery address', 'delivery/reship_new': 'New order to a new address',
    'delivery/pay_reship': 'Prepay, then new order to a new address',
    'return/return_credit': 'Return for store credit', 'return/exchange_req': 'Exchange'
};

const ADDRESS_SUBS = ['address_change', 'reship_new', 'pay_reship'];
const PREFS = [
    ['exchange', 'Exchange for another size or product'],
    ['replacement', 'Replacement of the same item'],
    ['credit', 'Store credit']
];

// Request context notes shown to the customer on the raise form
const REQUEST_NOTES = {
    cancel: (o) => o.payment === 'COD' ? "We'll cancel the order before it ships. Nothing to pay."
        : "We'll cancel the order before it ships and confirm how your payment is settled.",
    edit: () => 'Tell us the new size, colour or quantity below. Changes are possible only until the order ships.',
    prepay: () => "We'll send a secure payment link on WhatsApp. Once paid, the order becomes prepaid, and you can redirect it to a new address even after it ships.",
    address_change: () => "We'll update the address before your order ships.",
    reship_new: () => "Your current parcel will come back to us, and we'll dispatch the same items to this new address as a new order. You won't be charged again.",
    pay_reship: () => "Cash-on-delivery orders can't be redirected. We'll send a payment link first; once it's paid, we dispatch a new order to this address and the current parcel comes back to us.",
    return_credit: () => "We'll schedule a Delhivery pickup. After quality check, you get store credit as a code titled with your order number.",
    exchange_req: () => "Tell us the size or product you want below. We'll schedule a Delhivery pickup and dispatch the exchange after quality check."
};

const STAGES = {
    unshipped: 'Not shipped', shipped: 'In transit', delivered: 'Delivered', exchange: 'Exchange in progress',
    return: 'Return pickup scheduled', cancelled: 'Cancelled', rto: 'Returning to us (RTO)', out_for_delivery: 'Out for delivery'
};

const DAY = 86400000;

// ---------- helpers ----------
const reasonOf = (id) => REASONS.find(r => r.id === id);
const subOf = (rid, sid) => (reasonOf(rid)?.subs || []).find(s => s[0] === sid);
const orderTotal = (o) => (o.items || []).reduce((a, i) => a + i.q * i.p, 0);

// Normalize any Indian phone string to 91XXXXXXXXXX
function normalizePhone(raw) {
    if (!raw) return '';
    let d = String(raw).replace(/\D/g, '');
    if (d.length === 10) d = '91' + d;
    if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1);
    if (d.length === 12 && d.startsWith('91')) return d;
    if (d.length > 12 && d.startsWith('0091')) return d.slice(4);
    return d;
}

function stageLabel(o) {
    switch (o.stage) {
        case 'unshipped': return o.confirmed === false ? 'Awaiting your confirmation' : 'Confirmed, packing';
        case 'delivered': return 'Delivered ' + (o.deliveredAt ? new Date(o.deliveredAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
        default: return STAGES[o.stage] || o.stage;
    }
}

// ---------- eligibility: what a customer may request at each order stage ----------
function elig(o, rid, sid) {
    const st = o.stage, cod = o.payment === 'COD';
    const ok = { ok: true }, no = why => ({ ok: false, why }), hide = { ok: false, hide: true };
    const W = o.returnWindowDays || 7;
    if (sid === 'other' || rid === 'other') return (st === 'rto') ? no('This parcel is returning to us. Use your replacement order for anything else.') : ok;
    if (st === 'rto') return no('This parcel is returning to us. Your replacement order has its own help options.');
    if (st === 'cancelled' && !(sid === 'cancelled_wrongly' || ['charged_no_order', 'refund_original', 'credit_missing', 'credit_invalid'].includes(sid)))
        return no('This order is cancelled.');
    switch (rid + '/' + sid) {
        case 'order/no_confirm': case 'order/duplicate':
            return st === 'unshipped' ? ok : no('Your order has already shipped.');
        case 'order/edit':
            if (st === 'unshipped') return ok;
            return st === 'shipped' ? no("Already shipped, so it can't be edited. Once delivered, you can request an exchange.")
                : no('Delivered orders can be exchanged instead. Choose Return or exchange.');
        case 'order/cancel':
            if (st === 'unshipped') return ok;
            if (st === 'shipped') return no(cod ? "Can't cancel once shipped. You can decline the parcel when the courier arrives."
                : "Can't cancel once shipped. After delivery, you can return it for store credit.");
            return no("Delivered orders can't be cancelled. Request a return for store credit within " + W + ' days of delivery.');
        case 'order/prepay':
            if (!cod) return no('This order is already paid online.');
            return (st === 'unshipped' || st === 'shipped') ? ok : no('Payment was collected on delivery.');
        case 'order/cancelled_wrongly':
            return st === 'cancelled' ? ok : no('Only for cancelled orders.');
        case 'delivery/address_change':
            if (st === 'unshipped') return ok;
            if (st === 'shipped') return no('The address can\'t be changed once shipped. Choose "Send to a different address" instead.');
            return no('This order has been delivered.');
        case 'delivery/reship_new':
            if (st === 'unshipped') return no('Not shipped yet, so just change the delivery address instead.');
            if (st !== 'shipped') return no('Only for orders that are in transit.');
            return cod ? no('Only for prepaid orders. Choose "Pay online and send to a new address" instead.') : ok;
        case 'delivery/pay_reship':
            return (st === 'shipped' && cod) ? ok : hide;
        case 'delivery/not_shipped':
            return st === 'unshipped' ? ok : no('Your order has already shipped.');
        case 'delivery/delayed': case 'delivery/tracking_stuck': case 'delivery/no_attempt':
            return st === 'shipped' ? ok : (st === 'unshipped' ? no('Not shipped yet. Tracking starts once it ships.') : no('This order has been delivered.'));
        case 'delivery/delivered_not_received':
            if (st !== 'delivered') return no('Only for orders marked delivered.');
            return (Date.now() - new Date(o.deliveredAt).getTime() <= (o.dnrReportDays || 3) * DAY) ? ok
                : no('This has to be reported within ' + (o.dnrReportDays || 3) + ' days of delivery.');
        case 'delivery/courier_extra':
            return (st === 'shipped' || st === 'delivered') ? ok : no('Not shipped yet.');
        case 'return/return_credit': case 'return/exchange_req':
            if (inWindow(o, W)) return ok;
            if (st === 'delivered') return no('The ' + W + '-day return window for this order has closed.');
            if (st === 'exchange' || st === 'return') return no('A return or exchange is already in progress.');
            return no('Available once the order is delivered.');
        case 'return/pickup_not_scheduled': case 'return/pickup_missed': case 'return/qc_rejected':
        case 'return/exchange_not_received': case 'return/exchange_stuck':
            return (st === 'exchange' || st === 'return') ? ok : no('Only when a return or exchange is in progress.');
        case 'credit/cod_wrong':
            return (cod && st === 'delivered') ? ok : no(cod ? 'Only after a COD order is delivered.' : 'This order was paid online.');
        case 'credit/credit_missing': case 'credit/credit_invalid': case 'credit/refund_original':
            return ['delivered', 'exchange', 'return', 'cancelled'].includes(st) ? ok : no('Only after a return or cancellation.');
        case 'credit/charged_no_order': return ok;
    }
    if (rid === 'product' || rid === 'fit') {
        if (inWindow(o, W) || (st === 'exchange' && rid === 'product')) return ok;
        if (st === 'delivered') return no('The ' + W + '-day window to report this has closed.');
        if (st === 'exchange' || st === 'return') return no('A return or exchange is already in progress.');
        return no('Available once the order is delivered.');
    }
    return ok;
}

function inWindow(o, W) {
    return o.stage === 'delivered' && o.deliveredAt && (Date.now() - new Date(o.deliveredAt).getTime() <= (W || 7) * DAY);
}

// Whether a whole reason category has any usable sub-issue on this order
function reasonElig(o, R) {
    if (R.id === 'other') return elig(o, 'other', 'other');
    const real = R.subs.filter(s => s[0] !== 'other').map(s => elig(o, R.id, s[0])).filter(e => !e.hide);
    if (real.some(e => e.ok)) return { ok: true };
    const msg = (R.id === 'product' || R.id === 'fit' || R.id === 'return') ? real[0].why
        : R.id === 'order' && o.stage !== 'cancelled' && o.stage !== 'rto' ? elig(o, 'order', 'cancel').why
            : o.stage === 'cancelled' ? 'This order is cancelled.' : o.stage === 'rto' ? real[0].why
                : "Nothing here applies to an order that's " + (STAGES[o.stage] || o.stage).toLowerCase() + '.';
    return { ok: false, why: msg };
}

// Build the full customer-facing taxonomy with per-order eligibility resolved
function raiseCatalog(order) {
    if (!order) {
        return {
            reasons: REASONS.map(r => ({
                id: r.id, label: r.label, hint: r.hint,
                subs: r.subs.map(s => ({ key: s[0], label: s[1], proof: !!s[2] }))
            })),
            prefs: PREFS
        };
    }
    const o = { ...order, returnWindowDays: order.returnWindowDays };
    // Evaluated per-order request context notes (what happens after approval)
    const requestNotes = {};
    Object.keys(REQUEST_NOTES).forEach(k => { requestNotes[k] = REQUEST_NOTES[k](o); });
    const reasons = REASONS.map(R => {
        const re = reasonElig(o, R);
        if (!re.ok) return { id: R.id, label: R.label, hint: R.hint, locked: true, why: re.why, subs: [] };
        return {
            id: R.id, label: R.label, hint: R.hint, locked: false, proof: !!R.proof,
            subs: R.subs.map(s => {
                const e = elig(o, R.id, s[0]);
                return { key: s[0], label: s[1], proof: !!s[2], locked: !e.ok && !e.hide, hidden: !!e.hide, why: e.why || '' };
            })
        };
    });
    return { reasons, prefs: PREFS, stages: STAGES, requestNotes };
}

// ---------- settings ----------
async function getSetting(key) {
    const rows = await dbAdapter.query('SELECT value FROM support_settings WHERE key = ?', [key]);
    return rows.length ? rows[0].value : null;
}

async function getAllSettings() {
    const rows = await dbAdapter.query('SELECT key, value FROM support_settings');
    const out = {};
    rows.forEach(r => { out[r.key] = r.value; });
    return out;
}

async function putSetting(key, value) {
    await dbAdapter.run(
        `INSERT INTO support_settings (key, value, updated_at)
         VALUES (?, ?::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [key, JSON.stringify(value ?? null)]
    );
    return true;
}

// Fill {order}/{courier}/{awb}/{amount} placeholders in a template
function fillTemplate(tpl, t, order) {
    const o = order || {};
    return String(tpl || '')
        .replace(/\{order\}/g, t.orderId || t.order_id || '')
        .replace(/\{courier\}/g, o.courier || 'the courier')
        .replace(/\{awb\}/g, o.awb || 'on file')
        .replace(/\{amount\}/g, '\u20B9' + Math.round(Number(orderTotal(o)) || 0).toLocaleString('en-IN'));
}

// ---------- risk & economics (desk side) ----------
function riskOf(ticket, order, costCfg, ticketCount) {
    const f = []; let s = 0;
    const C = costCfg || {};
    if (order.payment === 'COD') { s += 2; f.push('Cash on delivery'); }
    if (orderTotal(order) >= (C.high_value || 2500)) { s += 1; f.push('High order value'); }
    if ((ticket.history && ticket.history.rto > 0)) { s += 1; f.push(ticket.history.rto + ' past RTO of ' + (ticket.history.orders || '?') + ' orders'); }
    if (ADDRESS_SUBS.includes(ticket.sub) && order.stage !== 'unshipped') { s += 2; f.push('Address change after dispatch'); }
    if (['delivered_not_received', 'missing', 'tampered', 'wrong_product'].includes(ticket.sub)) { s += 2; f.push('Claim needs proof (POD, unboxing video)'); }
    if (ticket.sub === 'cancel' && order.payment === 'COD') { s += 1; f.push('COD cancellation'); }
    if ((ticket.reopen_count || 0) > 0) { s += 1; f.push('Reopened ticket'); }
    if ((ticketCount || 0) > 2) { s += 1; f.push(ticketCount + ' tickets from this customer'); }
    return { level: s >= 4 ? 'High' : s >= 2 ? 'Medium' : 'Low', factors: f.length ? f : ['No risk flags'] };
}

function econOf(ticket, order, costCfg) {
    const C = costCfg || {};
    const v = orderTotal(order);
    const fwd = C.fwd_ship || 75, rto = C.rto_ship || 75, rev = C.reverse_pickup || 90, pack = C.packing || 20;
    const rtoLoss = fwd + rto;
    const expCOD = (C.rto_rate_cod || 0.25) * rtoLoss + (C.cod_fee || 35);
    const expPre = (C.rto_rate_prepaid || 0.05) * rtoLoss;
    const rows = []; let tip = '';
    switch (ticket.sub) {
        case 'cancel':
            rows.push(['Approve cancellation now', 0, 'Nothing has shipped. Stock goes straight back to the shelf.']);
            rows.push(['Ship it anyway', rtoLoss + pack, 'Customer is likely to refuse. Forward + RTO + packing lost.']);
            tip = 'Cancel before the label is created; every hour of delay risks a manifested parcel.'; break;
        case 'edit':
            rows.push(['Edit before dispatch', 0, 'Update the order in Shopify before the label is created.']);
            rows.push(['Exchange after delivery', rev + fwd + pack, 'Reverse pickup plus a fresh dispatch.']);
            tip = 'Editing pre-dispatch is the cheapest fix there is.'; break;
        case 'address_change':
            rows.push(['Update address before dispatch', 0, order.payment === 'COD' ? 'Verify on a call first: COD address changes carry higher RTO risk.' : 'Prepaid, low risk.']);
            tip = order.payment === 'COD' ? "Ask the calling team to confirm the new address and the customer's intent to accept COD." : 'Safe to approve.'; break;
        case 'reship_new': case 'pay_reship':
            rows.push(['Courier address update (same city or PIN only)', 0, 'Raise with the courier. Works only within the same delivery hub.']);
            rows.push(['New order to new address', rto + fwd + pack, 'RTO on the original + forward and packing for the new one. Original stock returns after QC.']);
            rows.push(['Decline', rto, 'Parcel will likely RTO anyway and the sale is lost.']);
            tip = order.payment === 'COD' ? 'Collect payment first. Never dispatch a second parcel against an unpaid COD order.' : 'Approve only after confirming the original will be marked RTO, so two parcels are not out for one payment.'; break;
        case 'prepay':
            rows.push(['Stay on COD (expected loss)', expCOD, Math.round((C.rto_rate_cod || 0.25) * 100) + '% RTO rate plus COD fee.']);
            rows.push(['Convert to prepaid (expected loss)', expPre, Math.round((C.rto_rate_prepaid || 0.05) * 100) + '% RTO rate, no COD fee.']);
            tip = 'Converting saves about \u20B9' + Math.max(0, Math.round(expCOD - expPre)).toLocaleString('en-IN') + ' in expected cost on this order.'; break;
        case 'return_credit': case 'exchange_req':
            rows.push(['Reverse pickup (Delhivery)', rev, ticket.sub === 'exchange_req' ? 'Plus a forward dispatch of \u20B9' + (fwd + pack) + ' for the replacement.' : 'Revenue is kept as store credit.']);
            tip = 'Schedule after the photos and reason look genuine; QC on arrival decides the credit.'; break;
        case 'delivered_not_received': case 'missing': case 'tampered':
            rows.push(['Reship after verification', fwd + pack + v, 'Product value plus shipping. Raise a claim with the courier to recover it.']);
            tip = "Check the courier's proof of delivery and the packing video before approving anything."; break;
        default:
            rows.push(['Order value', v, order.payment || '']);
            rows.push(['Expected RTO exposure', order.payment === 'COD' ? expCOD : expPre, order.payment === 'COD' ? 'COD order' : 'Prepaid order']);
    }
    return { rows, tip };
}

// ---------- SLA ----------
function slaOf(ticket, slaCfg) {
    if (ticket.status !== 'open') return null;
    const high = ticket.priority === 'high';
    const hours = high ? (slaCfg?.high_hours ?? 4) : (slaCfg?.normal_hours ?? 12);
    const base = ticket.last_customer_at || ticket.created_at;
    const due = new Date(base).getTime() + hours * 3600000;
    const left = due - Date.now();
    const dur = (ms) => { ms = Math.abs(ms); const m = Math.round(ms / 60000); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); if (h < 48) return h + 'd'; return Math.floor(h / 24) + 'd'; };
    return { bad: left < 0, label: left < 0 ? 'Overdue by ' + dur(left) : 'Due in ' + dur(left) };
}

// ---------- ticket numbering ----------
// TKT-<order>[-N] — deterministic, one open ticket per order enforced elsewhere
function ticketBase(orderId) {
    return 'TKT-' + String(orderId || '').replace(/[^0-9A-Za-z]/g, '');
}

async function nextTicketNumber(orderId) {
    const base = ticketBase(orderId);
    const rows = await dbAdapter.query(
        'SELECT ticket_number FROM support_tickets WHERE ticket_number LIKE ?',
        [base + '%']
    );
    const taken = new Set(rows.map(r => r.ticket_number));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 200; n++) {
        if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
    return `${base}-${Date.now()}`;
}

// ---------- order cache ----------
function mapCachedOrder(row) {
    if (!row) return null;
    const json = row.order_json || {};
    const items = (json.line_items || []).map(i => ({
        n: i.name || i.title, v: [i.variant_title].filter(Boolean).join(', ') || '', q: i.quantity || 1, p: Number(i.price || 0),
        img: i.image || ''
    }));
    // Stage preference: cache column wins, but replacement bookkeeping may override
    let stage = row.stage || 'unshipped';
    return {
        id: row.order_id,
        placed: row.placed_at ? new Date(row.placed_at).getTime() : Date.now(),
        stage, confirmed: stage !== 'unshipped' ? true : (json.confirmed !== false),
        payment: row.payment || (json.gateway && json.gateway[0] || 'Prepaid'),
        courier: row.courier || '', awb: row.awb || '',
        address: row.address || (json.shipping_address ? [json.shipping_address.address1, json.shipping_address.address2, json.shipping_address.city, json.shipping_address.province, json.shipping_address.zip].filter(Boolean).join(', ') : ''),
        deliveredAt: row.delivered_at ? new Date(row.delivered_at).getTime() : null,
        items, total: Number(row.total || orderTotal({ items })),
        replacedBy: row.replaced_by || null, replacements: row.replacements || 0,
        isNew: !!json.isNew, customerKey: row.customer_phone, paidVia: json.paid_via || null
    };
}

// Columns mapCachedOrder actually reads — kept explicit so the hottest customer
// query never drags along columns added later by accident.
const CACHE_READ_COLS = [
    'order_id', 'customer_phone', 'placed_at', 'stage', 'payment', 'courier', 'awb',
    'address', 'delivered_at', 'total', 'replaced_by', 'replacements', 'order_json'
].join(', ');

// ---------- order context (Shoppers Hub customer-context) ----------
// Order status truth comes from the same customer-context aggregation the
// Shoppers Hub chat sidebar renders (store_shoppers + orders tracking +
// local/portal returns and exchanges). The webhook cache is only a merge
// source for desk bookkeeping, so the support flow works with zero Shopify
// webhooks and an empty cache, and agents never see a stage that differs
// from the hub.
const normOrderId = v => String(v || '').replace(/^#/, '').trim();

function parseHubItems(itemsJson) {
    try {
        const parsed = JSON.parse(itemsJson || '[]');
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch { return []; }
}

// store_shoppers/orders status -> support stage. Unknown hub statuses pass
// through verbatim when the support STAGES map already labels them.
function hubStage(row, openReturns, openExchanges) {
    const s = String(row.shopper_status || '').toLowerCase();
    const s2 = String(row.order_status || '').toLowerCase();
    // The orders table carries the carrier truth (rto/failed) even when the
    // shopper row still says confirmed, so check both statuses.
    const anyRto = [s, s2].some(x => x.startsWith('rto') || x === 'failed' || x === 'untrackable');
    const shippedLike = ['shipped', 'in_transit', 'scheduled', 'pickup_booked', 'pickup_scheduled'].includes(s) || s2 === 'shipped';
    let stage;
    if (s === 'cancelled' || s2 === 'cancelled') stage = 'cancelled';
    else if (anyRto) stage = 'rto';
    else if (s === 'delivered' || s2 === 'delivered') stage = 'delivered';
    else if (s === 'out_for_delivery' || s2 === 'out_for_delivery') stage = 'out_for_delivery';
    else if (shippedLike || (s === 'confirmed' && row.awb)) stage = 'shipped';
    else if (s === 'pending' || s === 'confirmed' || !s) stage = 'unshipped';
    else if (STAGES[s]) stage = s;
    else stage = 'unshipped';
    // A live return/exchange request outranks the plain delivery status, the
    // same rule supportSync.computeStage applies for the cache.
    if (stage === 'shipped' || stage === 'delivered' || stage === 'out_for_delivery') {
        if (openExchanges) stage = 'exchange';
        else if (openReturns) stage = 'return';
    }
    return stage;
}

const HUB_CLOSED_RE = /^(closed|cancelled|completed|refunded|rejected|returned|failed)$/;
function hubExtrasFor(ctx, orderId) {
    const id = normOrderId(orderId);
    const row = (ctx.orders || []).find(o => normOrderId(o.order_id) === id) || null;
    const isOpen = r => !HUB_CLOSED_RE.test(String(r.status || '').toLowerCase());
    const openReturns = (ctx.returns || []).filter(r => normOrderId(r.order_id || r.order_number) === id && isOpen(r));
    const openExchanges = (ctx.exchanges || []).filter(r => normOrderId(r.order_id || r.order_number) === id && isOpen(r));
    const stage = row ? hubStage(row, openReturns.length, openExchanges.length) : null;
    return { row, stage, openReturns, openExchanges };
}

// Full order from the hub row alone (order not in the cache at all).
function orderFromHub(r, extras) {
    const items = parseHubItems(r.items_json).map(i => ({
        n: i.name || i.title || 'Item', v: i.variant_title || i.size || '', q: Number(i.quantity) || 1, p: Number(i.price || 0),
        img: i.image_url || i.image || ''
    }));
    const ts = v => { const t = v ? new Date(v).getTime() : NaN; return Number.isNaN(t) ? null : t; };
    return {
        id: normOrderId(r.order_id),
        placed: ts(r.created_at) || Date.now(),
        stage: extras.stage,
        confirmed: String(r.status || '') !== 'pending',
        payment: /cod|cash/i.test(String(r.payment_method || '')) ? 'COD' : (r.payment_method || 'Prepaid'),
        courier: r.courier_name || '', awb: r.awb || '',
        address: r.address || '',
        deliveredAt: ts(r.delivered_at),
        items, total: Number(r.order_total || 0) || items.reduce((a, i) => a + i.q * i.p, 0),
        replacedBy: null, replacements: 0, isNew: false,
        customerKey: normalizePhone(r.phone) || null, paidVia: r.payment_method || null,
        hubSourced: true,
        hubStatus: r.status || null,
        openReturns: extras.openReturns.length, openExchanges: extras.openExchanges.length
    };
}

// Overlay hub truth on a cache/live-shaped order. The hub carries the fresher
// status; the cache keeps the desk bookkeeping (replacements, Shopify id).
function applyHub(order, extras) {
    if (!order) return order;
    const r = extras.row || {};
    if (extras.stage) {
        // the cache may know about an RTO the hub rows do not flag
        if (!(extras.stage === 'shipped' && order.stage === 'rto')) order.stage = extras.stage;
    }
    if (r.awb) order.awb = String(r.awb);
    if (r.courier_name) order.courier = String(r.courier_name);
    if (r.delivered_at && !order.deliveredAt) {
        const t = new Date(r.delivered_at).getTime();
        if (!Number.isNaN(t)) order.deliveredAt = t;
    }
    if (extras.row && (Number(r.order_total) || 0) && !Number(order.total)) order.total = Number(r.order_total);
    order.replacedBy = order.replacedBy || null;
    order.replacements = order.replacements || 0;
    order.hubStatus = r.status || order.hubStatus || null;
    order.hubSourced = true;
    order.openReturns = extras.openReturns.length;
    order.openExchanges = extras.openExchanges.length;
    return order;
}

async function contextFor(phone) {
    try {
        const CustomerContext = require('./customerContextService');
        return await CustomerContext.buildCached(phone);
    } catch (e) {
        console.warn('[Support] customer context unavailable:', e.message);
        return null;
    }
}

async function listOrdersByPhone(phone) {
    const ctx = await contextFor(phone);
    let byId = {};
    try {
        const rows = await dbAdapter.query(
            `SELECT ${CACHE_READ_COLS} FROM support_order_cache WHERE customer_phone = ?
             ORDER BY placed_at DESC LIMIT 50`,
            [phone]
        );
        rows.forEach(r => { byId[normOrderId(r.order_id)] = r; });
    } catch (e) { /* table may not be migrated yet — the hub alone is enough */ }

    if (ctx) {
        const out = [];
        const seen = new Set();
        for (const r of (ctx.orders || [])) {
            const id = normOrderId(r.order_id);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const extras = hubExtrasFor(ctx, id);
            const row = byId[id];
            out.push(row ? applyHub(mapCachedOrder(row), extras) : orderFromHub(r, extras));
        }
        // Cache rows the hub does not know (e.g. replaced orders) still show
        Object.entries(byId).forEach(([id, row]) => { if (!seen.has(id)) out.push(mapCachedOrder(row)); });
        out.sort((a, b) => (b.placed || 0) - (a.placed || 0));
        return out;
    }
    return Object.values(byId).map(mapCachedOrder).sort((a, b) => (b.placed || 0) - (a.placed || 0));
}

// ---------- product thumbnails for the storefront order picker ----------
// Hub items_json and pre-projection cache rows carry no image URL, so fill
// missing item thumbnails from the same cached Shopify product catalog the
// Shoppers Hub picker uses, matched on product title. The catalog call rides
// the service's 10-min cache; on a cold cache we wait only a small budget and
// let the fetch finish in the background, so a customer never pays catalog
// build time — the next page load picks up the warmed map.
const CATALOG_IMG_BUDGET = 1500;
const SIZE_SUFFIX_RE = /\s*[-\u2013]\s*(?:xxs|xs|s|m|l|xl|xxl|xxxl|free size|one size)$/i;
// Titles drift in spacing, not letters: catalog says "HENLEY - 001 ( B )",
// line items say "HENLEY - 001 (B) - XS" — collapse paren padding and
// whitespace runs so both sides land on the same key.
const canonTitle = t => String(t || '').toLowerCase()
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ').trim();
let catalogImgInFlight = null;

async function attachItemImages(orders = []) {
    if (!orders.some(o => (o.items || []).some(i => !i.img && i.n))) return orders;
    const Shopify = require('./shopifyService');
    // One shared in-flight build: concurrent cold requests piggyback on it
    // instead of each stampeding the Shopify products API.
    if (!catalogImgInFlight) {
        catalogImgInFlight = Shopify.getProductCatalog().catch(() => null)
            .finally(() => { catalogImgInFlight = null; });
    }
    let timer;
    const budget = new Promise(res => { timer = setTimeout(() => res(null), CATALOG_IMG_BUDGET); if (timer.unref) timer.unref(); });
    const catalog = await Promise.race([catalogImgInFlight, budget]);
    clearTimeout(timer);
    if (!catalog || !catalog.length) return orders;
    const byTitle = new Map();
    catalog.forEach(p => {
        const t = canonTitle(p.title);
        if (t && p.image && !byTitle.has(t)) byTitle.set(t, p.image);
    });
    const lookup = (name) => {
        const k = canonTitle(name);
        if (!k) return '';
        if (byTitle.has(k)) return byTitle.get(k);
        const stripped = k.replace(SIZE_SUFFIX_RE, '');
        if (stripped && byTitle.has(stripped)) return byTitle.get(stripped);
        // line-item names sometimes append size/colour after the product title
        for (const t of byTitle.keys()) {
            if (k.startsWith(t + ' ') || k.startsWith(t + ' -') || k.startsWith(t + '\u2013')) return byTitle.get(t);
        }
        return '';
    };
    orders.forEach(o => (o.items || []).forEach(i => {
        if (!i.img && i.n) i.img = lookup(i.n);
    }));
    return orders;
}

// One order with the hub context merged when the customer's phone is known
// (the catalog and desk routes pass it). Falls back to the cache, then to a
// live Shopify read, so nothing here needs the webhook cache to have run.
async function getOrderByNumber(orderId, phone) {
    const id = normOrderId(orderId);
    if (phone) {
        const ctx = await contextFor(phone);
        const extras = ctx && hubExtrasFor(ctx, id);
        if (extras && extras.row) {
            let row = null;
            try {
                const rows = await dbAdapter.query(
                    `SELECT ${CACHE_READ_COLS} FROM support_order_cache WHERE order_id = ?`, [id]
                );
                row = rows[0] || null;
            } catch (e) { /* no cache table yet — the hub row is enough */ }
            return applyHub(row ? mapCachedOrder(row) : orderFromHub(extras.row, extras), extras);
        }
    }
    try {
        const rows = await dbAdapter.query(
            `SELECT ${CACHE_READ_COLS} FROM support_order_cache WHERE order_id = ?`,
            [id]
        );
        if (rows.length) return mapCachedOrder(rows[0]);
    } catch (e) { /* table may not be migrated yet — fall through to live */ }
    try {
        const SupportSync = require('./supportSync');
        const row = await SupportSync.fetchLiveOrder(id);
        return mapCachedOrder(row);
    } catch (e) {
        console.error('[Support] live order fetch failed:', e.message);
        return null;
    }
}

// Columns the cache may be patched on (whitelisted so the SET clause is never user input)
const CACHE_PATCH_COLS = new Set([
    'customer_phone', 'customer_name', 'customer_email', 'order_json', 'stage', 'payment',
    'courier', 'awb', 'address', 'total', 'placed_at', 'delivered_at', 'synced_at',
    'replaced_by', 'replacements'
]);

async function patchCachedOrder(orderId, patch = {}) {
    const cols = Object.keys(patch).filter(k => CACHE_PATCH_COLS.has(k));
    if (!cols.length) return true;
    const sets = cols.map(c => `${c} = ?${c === 'order_json' ? '::jsonb' : ''}`).join(', ');
    const params = cols.map(c => (c === 'order_json' ? JSON.stringify(patch[c] ?? null) : patch[c]));
    await dbAdapter.run(
        `UPDATE support_order_cache SET ${sets}, synced_at = CURRENT_TIMESTAMP WHERE order_id = ?`,
        [...params, String(orderId)]
    );
    return true;
}

// Customer history aggregates — from the hub context when available (same
// numbers the Shoppers Hub shows), cache counts as the supplement.
async function customerHistory(phone, ctx) {
    const p = normalizePhone(phone);
    ctx = ctx || await contextFor(p);
    const history = { orders: 0, delivered: 0, rto: 0 };
    if (ctx) {
        history.orders = (ctx.orders || []).length;
        (ctx.orders || []).forEach(o => {
            const st = hubStage(o, 0, 0);
            if (st === 'delivered') history.delivered++;
            if (st === 'rto') history.rto++;
        });
        return history;
    }
    const rows = await dbAdapter.query(
        'SELECT stage FROM support_order_cache WHERE customer_phone = ? ORDER BY placed_at DESC LIMIT 100',
        [p]
    );
    history.orders = rows.length;
    rows.forEach(r => {
        if (r.stage === 'delivered') history.delivered++;
        if (r.stage === 'rto') history.rto++;
    });
    return history;
}

// Raw cache rows for the desk (order_id keyed)
async function cacheRowsFor(orderIds = []) {
    if (!orderIds.length) return [];
    const placeholders = orderIds.map(() => '?').join(', ');
    return await dbAdapter.query(
        `SELECT order_id, stage, payment, courier, awb, total FROM support_order_cache WHERE order_id IN (${placeholders})`,
        orderIds
    );
}

// The desk only needs the numeric Shopify id from the cache row, so pull that one
// field rather than the stored order projection.
async function getCacheRow(orderId) {
    const rows = await dbAdapter.query(
        "SELECT order_id, order_json->>'id' AS shopify_id FROM support_order_cache WHERE order_id = ?",
        [String(orderId)]
    );
    return rows[0] || null;
}

// Recent cache rows for the desk order-cache browser
async function listOrderCache(limit = 100) {
    return await dbAdapter.query(
        `SELECT order_id, customer_phone, customer_name, stage, payment, courier, awb, total, placed_at, synced_at
         FROM support_order_cache ORDER BY placed_at DESC LIMIT ${Number(limit) || 100}`
    );
}

// ---------- whitelist ----------
async function isWhitelisted(phone) {
    const p = normalizePhone(phone);
    if (!p) return false;
    const rows = await dbAdapter.query('SELECT 1 FROM support_whitelist WHERE phone = ?', [p]);
    return rows.length > 0;
}

async function listWhitelist() {
    return await dbAdapter.query('SELECT * FROM support_whitelist ORDER BY created_at DESC');
}

async function addWhitelist(phone, addedBy, note) {
    const p = normalizePhone(phone);
    if (!p || p.length < 12) throw new Error('Valid 10-digit Indian phone required');
    await dbAdapter.run(
        `INSERT INTO support_whitelist (phone, added_by, note)
         VALUES (?, ?, ?)
         ON CONFLICT (phone) DO UPDATE SET added_by = EXCLUDED.added_by, note = EXCLUDED.note`,
        [p, addedBy || 'admin', note || null]
    );
    return p;
}

async function removeWhitelist(phone) {
    const p = normalizePhone(phone);
    await dbAdapter.run('DELETE FROM support_whitelist WHERE phone = ?', [p]);
    // Access revoked: their cached orders have no consumer left, so drop them
    await dbAdapter.run('DELETE FROM support_order_cache WHERE customer_phone = ?', [p]);
    return true;
}

// ---------- ticket CRUD ----------
// Columns the desk / customer flows may write, in insert order
const TICKET_INSERT_COLS = [
    'ticket_number', 'customer_phone', 'customer_name', 'customer_email', 'message', 'order_id',
    'reason', 'reason_label', 'sub', 'sub_label', 'other_text', 'preference', 'contact_via',
    'new_address', 'video_url', 'priority', 'team', 'status', 'channel', 'source',
    'history', 'thread', 'notes', 'has_images', 'last_customer_at', 'created_at', 'updated_at'
];
const TICKET_JSON_COLS = new Set(['history', 'thread', 'notes']);

const TICKET_PATCH_COLS = new Set([
    ...TICKET_INSERT_COLS,
    'assigned_to', 'first_response_at', 'last_agent_at', 'resolution_type', 'resolution_label',
    'resolution_at', 'resolution_by', 'csat', 'reopen_count', 'payment_link', 'payment_link_id',
    'is_read', 'portal_id', 'follow_up_at', 'follow_up_note'
]);

// Shared SQL builders: JSON columns are stringified and cast, everything else binds as-is
function ticketValues(data) {
    const params = [];
    TICKET_INSERT_COLS.forEach(c => {
        const v = data[c];
        params.push(TICKET_JSON_COLS.has(c) ? JSON.stringify(v ?? null) : (v === undefined ? null : v));
    });
    return params;
}

async function listTicketsByPhone(phone) {
    // Same trimmed column set as the desk queue: notes/history stay in the database
    return await dbAdapter.query(
        `SELECT ${QUEUE_COLS} FROM support_tickets WHERE customer_phone = ? AND channel = 'website'
         ORDER BY updated_at DESC LIMIT 100`,
        [normalizePhone(phone)]
    );
}

async function countTicketsByPhone(phone) {
    const rows = await dbAdapter.query(
        "SELECT COUNT(*)::int AS n FROM support_tickets WHERE customer_phone = ? AND channel = 'website'",
        [normalizePhone(phone)]
    );
    return rows[0]?.n || 0;
}

async function getTicket(id) {
    const rows = await dbAdapter.query('SELECT * FROM support_tickets WHERE id = ?', [id]);
    return rows[0] || null;
}

async function getTicketByNumber(ticketNumber) {
    const rows = await dbAdapter.query('SELECT * FROM support_tickets WHERE ticket_number = ?', [ticketNumber]);
    return rows[0] || null;
}

// Existing OPEN ticket for an order (one open ticket per order rule)
async function openTicketForOrder(orderId) {
    const rows = await dbAdapter.query(
        "SELECT * FROM support_tickets WHERE order_id = ? AND status <> 'closed' ORDER BY created_at DESC LIMIT 1",
        [String(orderId)]
    );
    return rows[0] || null;
}

// ---------- auto-routing (desk "portal_routing" setting) ----------
// When enabled in Desk settings, a freshly created ticket is dropped straight
// into the active shift portal carrying the fewest open tickets (oldest
// portal wins ties), respecting each portal's max_tickets cap. Portals with no
// shift window are treated as always-on. Shift windows are matched in IST, the
// same timezone the Command dashboard analytics use. Never throws — routing
// must not break ticket creation.
function istMinutesOf(dateLike) {
    const d = new Date(dateLike);
    if (isNaN(d)) return null;
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000); // UTC+5:30
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function shiftWindowCovers(mins, start, end) {
    if (!start || !end) return true; // no window = always active
    const [sh, sm] = String(start).split(':').map(Number);
    const [eh, em] = String(end).split(':').map(Number);
    if ([sh, sm, eh, em].some(n => !Number.isFinite(n))) return true;
    const s = sh * 60 + sm, e = eh * 60 + em;
    // Overnight windows (e.g. 17:00-01:00) wrap around midnight
    return s <= e ? (mins >= s && mins < e) : (mins >= s || mins < e);
}

async function autoRouteTicket(created) {
    try {
        const cfg = await getSetting('portal_routing');
        if (!cfg || cfg.enabled !== true) return created;
        const portals = await dbAdapter.query(
            "SELECT id, name, type, config, shift_start, shift_end, max_tickets FROM support_portals WHERE is_active = true AND type IN ('time_based', 'auto')"
        );
        if (!portals.length) return created;
        const mins = istMinutesOf(created.created_at || new Date());
        const candidates = portals.filter(p => {
            let start = p.shift_start, end = p.shift_end;
            if (p.type === 'time_based') {
                try {
                    const c = p.config ? (typeof p.config === 'string' ? JSON.parse(p.config) : p.config) : {};
                    if (c.time_start || c.time_end) { start = c.time_start; end = c.time_end; }
                } catch { /* fall back to the shift columns */ }
            }
            return mins == null || shiftWindowCovers(mins, start, end);
        });
        if (!candidates.length) return created;
        const ids = candidates.map(p => p.id);
        const counts = await dbAdapter.query(
            `SELECT portal_id, COUNT(*)::int AS open_cnt FROM support_tickets
             WHERE portal_id IN (${ids.map(() => '?').join(',')}) AND status = 'open' GROUP BY portal_id`,
            ids
        );
        const openMap = {};
        counts.forEach(r => { openMap[r.portal_id] = r.open_cnt; });
        let best = null, bestCount = Infinity;
        for (const p of candidates) {
            const c = openMap[p.id] || 0;
            if (p.max_tickets && c >= p.max_tickets) continue; // portal is full
            if (c < bestCount || (c === bestCount && best && p.id < best.id)) {
                best = p; bestCount = c;
            }
        }
        if (!best) return created;
        const thread = Array.isArray(created.thread) ? created.thread : [];
        thread.push({ kind: 'event', text: 'Auto-routed to ' + best.name + ' (shift portal, least load)', at: Date.now() });
        const updated = await updateTicket(created.id, { portal_id: best.id, thread });
        return updated || created;
    } catch (e) {
        console.warn('[Support] auto-route skipped:', e.message);
        return created;
    }
}

async function createTicket(payload) {
    const now = Date.now();
    const thread = [{ kind: 'event', text: payload.requestLabel ? 'Request raised: ' + payload.requestLabel : 'Ticket raised', at: now }];
    if (payload.desc && payload.desc.trim()) thread.push({ role: 'customer', text: payload.desc.trim(), at: now + 1 });
    const ticketNumber = await nextTicketNumber(payload.orderId);
    const data = {
        ticket_number: ticketNumber,
        customer_phone: payload.customerPhone,
        customer_name: payload.customerName,
        customer_email: payload.customerEmail || null,
        message: (payload.desc || '').slice(0, 5000) || payload.subLabel || payload.reasonLabel || 'Support request',
        order_id: String(payload.orderId),
        reason: payload.reason,
        reason_label: payload.reasonLabel,
        sub: payload.sub,
        sub_label: payload.subLabel,
        other_text: payload.otherText || null,
        preference: payload.preference || null,
        contact_via: payload.contactVia || 'whatsapp',
        new_address: payload.address || null,
        video_url: payload.video || null,
        priority: payload.priority || 'normal',
        team: payload.team || (reasonOf(payload.reason) || {}).team || 'chat',
        status: 'open',
        channel: 'website',
        source: 'website',
        history: payload.history || null,
        thread,
        notes: [],
        has_images: (payload.images || []).length > 0,
        last_customer_at: new Date(now).toISOString(),
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString()
    };
    const placeholders = TICKET_INSERT_COLS.map(c => `?${TICKET_JSON_COLS.has(c) ? '::jsonb' : ''}`).join(', ');
    const rows = await dbAdapter.query(
        `INSERT INTO support_tickets (${TICKET_INSERT_COLS.join(', ')})
         VALUES (${placeholders}) RETURNING *`,
        ticketValues(data)
    );
    const created = rows[0];
    // Attach images
    if (created && (payload.images || []).length) {
        for (const url of payload.images) {
            await dbAdapter.run('INSERT INTO ticket_attachments (ticket_id, image_url) VALUES (?, ?)', [created.id, url]);
        }
    }
    // Auto-pilot: drop the ticket into the live shift portal when enabled
    if (created && !payload.portalId) return await autoRouteTicket(created);
    return created;
}

async function updateTicket(id, patch = {}) {
    const cols = Object.keys(patch).filter(k => TICKET_PATCH_COLS.has(k));
    if (!cols.length) return await getTicket(id);
    const sets = cols.map(c => `${c} = ?${TICKET_JSON_COLS.has(c) ? '::jsonb' : ''}`).join(', ');
    const params = cols.map(c => (TICKET_JSON_COLS.has(c) ? JSON.stringify(patch[c] ?? null) : patch[c]));
    const rows = await dbAdapter.query(
        `UPDATE support_tickets SET ${sets} WHERE id = ? RETURNING *`,
        [...params, id]
    );
    return rows[0] || null;
}

// ---------- attachments ----------
async function listTicketImages(ticketId) {
    const rows = await dbAdapter.query(
        'SELECT image_url FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC',
        [ticketId]
    );
    return rows.map(r => r.image_url);
}

// ---------- desk queue ----------
// Trimmed ticket shape for list/preview responses (thread stripped out)
function publicTicket(t) {
    if (!t) return null;
    const thread = Array.isArray(t.thread) ? t.thread : [];
    const lastMsg = [...thread].reverse().find(m => m.kind !== 'event');
    return {
        id: t.id, ticket_number: t.ticket_number, order_id: t.order_id,
        reason: t.reason, reason_label: t.reason_label, sub: t.sub, sub_label: t.sub_label,
        status: t.status, priority: t.priority, team: t.team,
        created_at: t.created_at, updated_at: t.updated_at,
        resolution_type: t.resolution_type, resolution_label: t.resolution_label, resolution_at: t.resolution_at,
        csat: t.csat, reopen_count: t.reopen_count || 0,
        preview: lastMsg ? { role: lastMsg.role, text: String(lastMsg.text || '').slice(0, 140), at: lastMsg.at } : null
    };
}

// Queue rows only ever read these columns; history/notes are large JSONB blobs
// that the detail view fetches separately, so they stay out of the list query.
const QUEUE_COLS = [
    'id', 'ticket_number', 'order_id', 'reason', 'reason_label', 'sub', 'sub_label',
    'status', 'priority', 'team', 'created_at', 'updated_at', 'last_customer_at',
    'resolution_type', 'resolution_label', 'resolution_at', 'csat', 'reopen_count',
    'thread', 'customer_name', 'customer_phone', 'channel', 'source', 'has_images'
].join(', ');

// The desk's default "website" lane is the storefront Help & Tickets (accounts)
// section only. The website chat widget raises tickets through createWidgetTicket,
// which shares channel='website' (and for the testbot even source='website'), so
// widget tickets are told apart by their 'WDG-' ticket-number prefix — every
// widget path uses it, while account tickets are numbered from the order id.
// Choosing whatsapp/instagram narrows normally; channel='all' deliberately keeps
// widget tickets visible so nothing becomes unreachable from the desk.
const DESK_WEBSITE_COND = "channel = 'website' AND ticket_number NOT LIKE 'WDG-%'";

// Customer-safe detail projection. The desk row carries internal columns
// (notes, assigned_to, the customer snapshot in history) that must never be
// serialised to the storefront, and trimming them also shrinks the response.
function customerTicket(t) {
    if (!t) return null;
    return {
        id: t.id, ticket_number: t.ticket_number, order_id: t.order_id,
        status: t.status, priority: t.priority,
        reason: t.reason, reason_label: t.reason_label, sub: t.sub, sub_label: t.sub_label,
        other_text: t.other_text, message: t.message, preference: t.preference,
        contact_via: t.contact_via, new_address: t.new_address, video_url: t.video_url,
        created_at: t.created_at, updated_at: t.updated_at,
        resolution_label: t.resolution_label, resolution_at: t.resolution_at,
        csat: t.csat, reopen_count: t.reopen_count || 0,
        payment_link: t.payment_link || null,
        thread: Array.isArray(t.thread) ? t.thread : []
    };
}

// Builds the filtered list query in SQL (the app has no REST filter builder).
async function deskQueryTickets(filters = {}) {
    const conditions = [];
    const params = [];
    const ch = filters.channel === 'all' ? null : (filters.channel || 'website');
    if (ch === 'website') { conditions.push(DESK_WEBSITE_COND); }
    else if (ch) { conditions.push('channel = ?'); params.push(ch); }
    if (filters.status && filters.status !== 'all') { conditions.push('status = ?'); params.push(filters.status); }
    if (filters.team) { conditions.push('team = ?'); params.push(filters.team); }
    if (filters.priority) { conditions.push('priority = ?'); params.push(filters.priority); }
    if (filters.reason) { conditions.push('reason = ?'); params.push(filters.reason); }
    if (filters.q) {
        const term = `%${String(filters.q).trim().replace(/[%_]/g, '')}%`;
        conditions.push('(ticket_number ILIKE ? OR order_id ILIKE ? OR customer_name ILIKE ? OR customer_phone ILIKE ?)');
        params.push(term, term, term, term);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    let order;
    if (filters.status === 'awaiting') order = 'last_customer_at ASC NULLS LAST';
    else if (filters.status === 'closed') order = 'resolution_at DESC NULLS LAST';
    else order = "CASE WHEN priority = 'high' THEN 0 ELSE 1 END ASC, last_customer_at ASC NULLS LAST";

    return await dbAdapter.query(
        `SELECT ${QUEUE_COLS} FROM support_tickets ${where} ORDER BY ${order} LIMIT 200`,
        params
    );
}

// KPI bar as a single aggregate query. Shipping the newest 2000 rows to the API
// every 30s (as this used to) is the most expensive thing the desk did; Postgres
// answers the same numbers with one row.
// SLA breach mirrors slaOf: open tickets past (last_customer_at || created_at) +
// the priority's hour budget.
async function deskStatsAgg(slaCfg = {}, channel = 'website', requestPairs = []) {
    const ch = channel === 'all' ? null : channel;
    const params = [
        Number(slaCfg.high_hours ?? 4),
        Number(slaCfg.normal_hours ?? 12)
    ];

    const pairs = (requestPairs || []).filter(p => Array.isArray(p) && p.length === 2);
    let requestsExpr = '0';
    if (pairs.length) {
        requestsExpr = `COUNT(*) FILTER (WHERE status <> 'closed' AND (reason, sub) IN (${pairs.map(() => '(?, ?)').join(', ')}))`;
        pairs.forEach(p => params.push(p[0], p[1]));
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    params.push(todayStart.toISOString());

    const conditions = [];
    if (ch === 'website') { conditions.push(DESK_WEBSITE_COND); }
    else if (ch) { conditions.push('channel = ?'); params.push(ch); }

    const rows = await dbAdapter.query(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE status = 'awaiting')::int AS awaiting,
            COUNT(*) FILTER (WHERE status = 'open'
                AND COALESCE(last_customer_at, created_at)
                    + make_interval(hours => CASE WHEN priority = 'high' THEN ?::int ELSE ?::int END)
                    < now())::int AS sla,
            ${requestsExpr}::int AS requests,
            COUNT(*) FILTER (WHERE status = 'closed' AND resolution_at >= ?::timestamp)::int AS closed_today,
            ROUND(AVG(csat) FILTER (WHERE csat > 0), 1)::float AS avg_csat
         FROM support_tickets ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}`,
        params
    );
    const r = rows[0] || {};
    return {
        open: r.open || 0,
        awaiting: r.awaiting || 0,
        sla: r.sla || 0,
        requests: Number(r.requests) || 0,
        closedToday: r.closed_today || 0,
        avgCsat: r.avg_csat == null ? null : Number(r.avg_csat)
    };
}

module.exports = {
    REASONS, REQUESTS, ADDRESS_SUBS, PREFS, REQUEST_NOTES, STAGES, DAY,
    normalizePhone, stageLabel, elig, reasonElig, raiseCatalog, inWindow, orderTotal,
    getSetting, getAllSettings, putSetting, fillTemplate,
    riskOf, econOf, slaOf, ticketBase, nextTicketNumber,
    listOrdersByPhone, getOrderByNumber, patchCachedOrder, customerHistory, mapCachedOrder, cacheRowsFor, getCacheRow, listOrderCache,
    contextFor, normOrderId, attachItemImages,
    isWhitelisted, listWhitelist, addWhitelist, removeWhitelist,
    listTicketsByPhone, countTicketsByPhone, getTicket, getTicketByNumber, openTicketForOrder,
    createTicket, updateTicket, listTicketImages, deskQueryTickets, deskStatsAgg, publicTicket, customerTicket
};
