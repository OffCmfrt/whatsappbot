// Bidirectional live-carrier reconciliation to fix both directions of damage
// caused by the underscored-RTO mapping bug (fixed in 4a43adb):
//
// Direction A (undo damage from RTO_OFD/RTO_NDR/RTO_LOCK being mis-mapped as
// forward): rows currently in a FORWARD status (in_transit / out_for_delivery
// / shipped) whose LIVE carrier now reports an underscored RTO form must be
// reset back to 'rto_initiated'. This includes the 17 rows reset-stuck-rto.js
// falsely healed, plus any production-cron damage since e4341eb deployed.
//
// Direction B (fix the user-facing bug the whole effort started with): rows
// currently rto / rto_initiated whose LIVE carrier clearly reports FORWARD
// movement get healed to in_transit. Mirror the orders row so the hub RTO
// pill clears.
//
// Both directions write DB directly (bypass the sync pipeline) so no Zoho
// credit note re-fires and no OFD WhatsApp template goes out on correction.
require('dotenv').config();
const { dbAdapter } = require('./src/database/db');
const { mapCarrierStatus } = require('./src/services/shipmentSyncService');
const { getAdapter } = require('./src/services/carriers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FORWARD = ['out_for_delivery'];
// Damage signature is specifically out_for_delivery — the buggy mapper turned
// 'RTO_OFD' live strings into 'out_for_delivery' (and nothing else; RTO_NDR
// and RTO_LOCK previously fell through to null and caused no damage). So we
// scan ONLY out_for_delivery rows updated within the damage window.
const SCAN_START = new Date('2026-10-26T12:00:00Z');

async function trackWithRetry(adapter, awb) {
    let result = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            result = await adapter.track(awb);
            if (result && result.success) return result;
        } catch (e) {
            result = { success: false, error: e.message };
        }
        await sleep(1200 * attempt);
    }
    return result;
}

function isLiveUnderscoredRto(liveStr) {
    const s = (liveStr || '').toLowerCase();
    // The bug signature: currentStatus string contains an underscored RTO
    // code we now map correctly (post-4a43adb) but that mapCarrierStatus used
    // to miss. If live is any RTO-family label, that's the case.
    return /(^|[^a-z])rto[_\s]/i.test(s) || s === 'rto' || s.startsWith('rto_');
}

(async () => {
    // Direction A: out_for_delivery rows whose live is underscored-RTO
    // (specific damage class from the RTO_OFD mis-mapping).
    const a_rows = await dbAdapter.query(
        `SELECT id, order_id, awb, carrier, status FROM shipments
         WHERE status IN (${FORWARD.map(() => '?').join(',')})
           AND awb IS NOT NULL AND awb <> ''
           AND updated_at >= ?
         ORDER BY updated_at DESC`,
        [...FORWARD, SCAN_START]
    );
    console.log(`[A] scanning ${a_rows.length} forward-status rows for RTO damage...`);

    let reverted = 0, skippedA = 0, failA = 0;
    for (const s of a_rows) {
        const ad = getAdapter(s.carrier); if (!ad) { skippedA++; continue; }
        const res = await trackWithRetry(ad, s.awb);
        if (!res || !res.success) { failA++; await sleep(200); continue; }
        const live = res.data.currentStatus;
        if (!isLiveUnderscoredRto(live)) { await sleep(200); continue; }
        const mapped = mapCarrierStatus(live, res.data.statusType);
        if (!mapped || !String(mapped).startsWith('rto')) { await sleep(200); continue; }
        await dbAdapter.query(
            `UPDATE shipments SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [mapped, s.id]
        );
        await dbAdapter.query(
            `UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND awb=?`,
            [mapped, s.order_id, s.awb]
        );
        console.log(`REVERT #${s.id} (${s.order_id}) "${s.status}" → "${mapped}" live="${live}"`);
        reverted++;
        await sleep(250);
    }
    console.log(`[A] done. reverted=${reverted} skipped(no adapter)=${skippedA} failed=${failA}`);

    // Direction B: rto_initiated rows only. Sample verification showed the
    // plain 'rto' population is essentially all genuine (0 false positives in
    // 25 older-than-30d + 0 in within-30d), while rto_initiated had a ~16%
    // false rate — so scan that whole bucket regardless of age.
    const b_rows = await dbAdapter.query(
        `SELECT id, order_id, awb, carrier, status FROM shipments
         WHERE status = 'rto_initiated'
           AND awb IS NOT NULL AND awb <> ''
         ORDER BY updated_at ASC`
    );
    console.log(`[B] scanning ${b_rows.length} rto_initiated rows for false positives...`);

    let healed = 0, keptB = 0, failB = 0, mirrorOrders = 0;
    for (const s of b_rows) {
        const ad = getAdapter(s.carrier); if (!ad) { keptB++; continue; }
        const res = await trackWithRetry(ad, s.awb);
        if (!res || !res.success) { failB++; await sleep(200); continue; }
        const live = res.data.currentStatus;
        const mapped = mapCarrierStatus(live, res.data.statusType);
        // Genuine RTO / unknown — leave alone (with the fixed mapper, RTO_OFD
        // now correctly classifies as rto_initiated, not out_for_delivery)
        if (!mapped || String(mapped).startsWith('rto') || mapped === 'cancelled' || mapped === 'failed') {
            keptB++; await sleep(200); continue;
        }
        if (!(mapped === 'in_transit' || mapped === 'out_for_delivery' || mapped === 'delivered' || mapped === 'shipped')) {
            keptB++; await sleep(200); continue;
        }
        const target = (mapped === 'delivered' || mapped === 'out_for_delivery') ? mapped : 'in_transit';
        await dbAdapter.query(
            `UPDATE shipments SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [target, s.id]
        );
        const oRes = await dbAdapter.query(
            `UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND awb=? AND status LIKE 'rto%' RETURNING order_id`,
            [target, s.order_id, s.awb]
        );
        if (oRes && oRes.length) mirrorOrders++;
        console.log(`HEAL #${s.id} (${s.order_id}) "${s.status}" → "${target}" live="${live}"`);
        healed++;
        await sleep(250);
    }
    console.log(`[B] done. healed=${healed} kept(genuine)=${keptB} failed=${failB} ordersMirrored=${mirrorOrders}`);
    console.log(`\nTotal: reverted=${reverted} healed=${healed} ordersMirrored=${mirrorOrders}`);
    process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
